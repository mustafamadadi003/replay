/**
 * Comment reconciliation (polling safety net).
 *
 * Instagram webhooks are best-effort and never fire for a large class of
 * comments (collapsed "load more" comments, non-follower / low-signal accounts,
 * anything Instagram filters). Those comments are otherwise invisible: never
 * replied to, never DM'd.
 *
 * This sweep is deliberately narrow. For each active campaign it looks only at
 * that campaign's post, only at recent comments, and acts on a comment ONLY when
 * both are true:
 *   1. the comment matches the campaign keyword, and
 *   2. DmLog shows it is not already fully handled (SENT / public reply / skip).
 * Graph comment reads are capped tightly and skipped entirely while the DM
 * queue is busy — re-listing hundreds of comments every few minutes was burning
 * Meta app usage far faster than the sends themselves.
 *
 * It runs on an interval in the worker process because Vercel's free crons only
 * fire once a day. Matching and sending reuse the worker's processComment, so
 * rate limiting and logging behave exactly as for webhook-delivered comments.
 *
 * Known limitation, handled not fixed: comments removed by Instagram's Hidden
 * Words / spam filter may not be returned by the Graph API at all. Disable that
 * filter on the account to widen results.
 */

import { MAX_COMMENT_SEND_ATTEMPTS } from "@/lib/queue/comment-delivery";
import { hasLegacyUnconfirmedDelivery } from "@/lib/instagram/delivery-errors";
import { prisma } from "@/lib/db/client";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import {
  getRecentMediaComments,
  getUserMedia,
  MetaApiError,
  type InstagramComment,
} from "@/lib/instagram/provider";
import {
  createInstagramContext,
  type InstagramContext,
} from "@/lib/instagram/provider";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import {
  getAppRateLimitState,
  isMetaAppRateLimitError,
  tripAppRateLimit,
} from "@/lib/meta/app-rate-limit-circuit";

// Default lookback for "any post" campaigns. Without Meta webhooks (common on
// fresh Railway deploys), poll is the only path — 6h was too short and missed
// real keyword comments on older posts in the recent feed.
const LOOKBACK_HOURS = Number(process.env.COMMENT_POLL_LOOKBACK_HOURS ?? 48);
// Prefer a short specific-post window for steady-state polling. Deep backlog
// should come from webhooks + PENDING requeue, not re-reading days of comments.
const SPECIFIC_POST_LOOKBACK_HOURS = Number(
  process.env.COMMENT_POLL_SPECIFIC_LOOKBACK_HOURS ?? 48
);
// Hard cap across the whole campaign per sweep (not per media).
const MAX_NEW_PER_SWEEP = Number(process.env.COMMENT_POLL_MAX_PER_SWEEP ?? 5);
// For "any post" campaigns, how many recent posts to scan. Topsii-style
// accounts post often; 3 left keyword comments on older tiles invisible.
const RECENT_MEDIA_LIMIT = Number(process.env.COMMENT_POLL_MEDIA_LIMIT ?? 15);
// Cap Graph comments pulled per media in one sweep (≈1 page at limit=50).
const MAX_COMMENTS_PER_MEDIA = Number(
  process.env.COMMENT_POLL_MAX_COMMENTS_PER_MEDIA ?? 50
);

interface SweepStat {
  campaign: string;
  keywords: string;
  matched: number;
  alreadyReplied: number;
  enqueued: number;
  errors: string[];
}

function errMessage(error: unknown): string {
  if (error instanceof MetaApiError)
    return `Meta ${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

/** One reconciliation pass across every active campaign. */
export async function reconcileComments(): Promise<void> {
  const circuit = await getAppRateLimitState();
  if (circuit.limited) {
    console.log(
      `[Comment Poll] Skipping sweep — Meta circuit open for ${Math.ceil(circuit.remainingMs / 60_000)} more min`
    );
    return;
  }

  // Soft capacity: an older campaign draining the queue must NOT starve newer
  // campaigns (e.g. Nama blocked forever while Salamkar backlog sends). Only
  // hard-skip Graph when the shared queue is deeply backed up.
  const queue = getDMQueue();
  const counts = await queue.getJobCounts("waiting", "active", "delayed");
  const inflight =
    (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
  const maxInflight = Number(process.env.COMMENT_POLL_SKIP_INFLIGHT_ABOVE ?? 25);
  if (inflight >= maxInflight) {
    console.log(
      `[Comment Poll] Skipping Graph comment list — queue deeply busy (waiting=${counts.waiting ?? 0} active=${counts.active ?? 0} delayed=${counts.delayed ?? 0} cap=${maxInflight})`
    );
    await requeueOrphanedPendingComments();
    return;
  }

  const automations = await prisma.automation.findMany({
    // Instagram reconciler only — Facebook Page campaigns use Page feed webhooks.
    where: {
      isActive: true,
      facebookPageId: null,
      instagramAccountId: { not: null },
    },
    // Newest first so a brand-new campaign is not stuck behind an old backlog.
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      postId: true,
      matchAnyPost: true,
      matchAnyWord: true,
      keywords: true,
      wholeWordMatch: true,
      publicReplyEnabled: true,
      workspaceId: true,
      createdAt: true,
      instagramAccount: {
        select: {
          id: true,
          instagramId: true,
          username: true,
          accessToken: true,
          provider: true,
          workspaceId: true,
          zernioAccountId: true,
        },
      },
    },
  });

  const anyPostLookbackMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
  const specificLookbackMs =
    Date.now() - SPECIFIC_POST_LOOKBACK_HOURS * 60 * 60 * 1000;
  const tokenCache = new Map<string, InstagramContext | null>();

  for (const automation of automations) {
    if (!automation.instagramAccount) continue;
    const igAutomation = {
      ...automation,
      instagramAccount: automation.instagramAccount,
    };
    // Specific-post campaigns must cover the whole reply window so no matching
    // comment is left behind. "Any post" stays short to avoid multi-post burns.
    const sinceMs = automation.postId
      ? specificLookbackMs
      : Math.max(anyPostLookbackMs, automation.createdAt.getTime());
    const stat = await sweepCampaign({
      automation: igAutomation,
      sinceMs: sinceMs,
      tokenCache: tokenCache,
    }).catch(
      (error): SweepStat => ({
        campaign: automation.name,
        keywords: automation.keywords.join(","),
        matched: 0,
        alreadyReplied: 0,
        enqueued: 0,
        errors: [errMessage(error)],
      })
    );
    await recordSweep(automation.workspaceId, stat);
  }

  // Meta's comment list often stops returning backlog items (hidden words,
  // pagination, owner-reply noise). PENDING rows can then sit forever with an
  // empty BullMQ queue. Re-drive a small oldest-first batch from the DB only
  // when the queue is idle so we do not stack on top of live jobs.
  await requeueOrphanedPendingComments();
}

/**
 * Re-enqueue orphaned PENDING DmLogs without another Meta comment listing.
 * Caps each pass to COMMENT_POLL_MAX_PER_SWEEP and no-ops while jobs are
 * already waiting/active/delayed.
 */
export async function requeueOrphanedPendingComments(): Promise<number> {
  const circuit = await getAppRateLimitState();
  if (circuit.limited) return 0;

  const queue = getDMQueue();
  const counts = await queue.getJobCounts("waiting", "active", "delayed");
  const inflight =
    (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
  // Never stack on top of live jobs. A previous "ignore inflight" switch
  // flooded the queue with duplicate process-comment jobs.
  if (inflight > 0) return 0;

  // Debounce: after a successful requeue, wait before adding another batch.
  const redis = getRedisConnection();
  const debounceKey = "meta:pending_requeue:debounce";
  if (await redis.get(debounceKey)) return 0;

  // Stale claim flags block reconciler + worker forever if the job vanished
  // from Redis. Release claims older than one hour so they can be retried.
  await prisma.dmLog.updateMany({
    where: {
      status: "PENDING",
      dmDeliveryUnconfirmed: true,
      updatedAt: { lt: new Date(Date.now() - 60 * 60_000) },
    },
    data: { dmDeliveryUnconfirmed: false, errorMessage: null },
  });

  const pending = await prisma.dmLog.findMany({
    where: {
      status: "PENDING",
      dmDeliveryUnconfirmed: false,
      attempts: { lt: MAX_COMMENT_SEND_ATTEMPTS },
      automation: { isActive: true },
    },
    orderBy: { createdAt: "asc" },
    take: MAX_NEW_PER_SWEEP,
    select: {
      commentId: true,
      commentText: true,
      commenterId: true,
      commenterName: true,
      automation: {
        select: {
          postId: true,
          instagramAccount: {
            select: { id: true, instagramId: true },
          },
        },
      },
    },
  });

  const pacingMs = Number(process.env.DM_SEND_PACING_MS ?? 30_000);
  let enqueued = 0;
  for (const row of pending) {
    const mediaId = row.automation.postId;
    if (!mediaId) continue;
    const account = row.automation.instagramAccount;
    if (!account) continue;
    await queue.add(
      "process-comment",
      {
        instagramAccountId: account.instagramId,
        accountConnectionId: account.id,
        commentId: row.commentId,
        commentText: row.commentText,
        commenterId: row.commenterId,
        commenterName: row.commenterName ?? undefined,
        mediaId,
        source: "POLLING",
      },
      { delay: enqueued * Math.max(0, pacingMs) }
    );
    enqueued += 1;
  }

  if (enqueued > 0) {
    const debounceSec = Math.max(
      60,
      Math.ceil((enqueued * Math.max(1000, pacingMs)) / 1000)
    );
    await redis.set(debounceKey, "1", "EX", debounceSec);
    console.log(
      `[Comment Poll] Requeued ${enqueued} orphaned PENDING from DB (queue was idle; debounce ${debounceSec}s)`
    );
  }
  return enqueued;
}

async function sweepCampaign({
  automation,
  sinceMs,
  tokenCache,
}: {
  automation: {
    id: string;
    name: string;
    postId: string | null;
    matchAnyPost: boolean;
    matchAnyWord: boolean;
    keywords: string[];
    wholeWordMatch: boolean;
    publicReplyEnabled: boolean;
    createdAt: Date;
    instagramAccount: {
      id: string;
      instagramId: string;
      username: string;
      accessToken: string;
      provider: "META" | "ZERNIO";
      workspaceId: string;
      zernioAccountId: string | null;
    };
  };
  sinceMs: number;
  tokenCache: Map<string, InstagramContext | null>;
}): Promise<SweepStat> {
  const account = automation.instagramAccount;
  const stat: SweepStat = {
    campaign: automation.name,
    keywords: automation.matchAnyWord
      ? "(any word)"
      : automation.keywords.join(","),
    matched: 0,
    alreadyReplied: 0,
    enqueued: 0,
    errors: [],
  };

  // Decrypt the account token once per sweep.
  let accessToken = tokenCache.get(account.id);
  if (accessToken === undefined) {
    try {
      accessToken = await createInstagramContext(account);
    } catch {
      accessToken = null;
    }
    tokenCache.set(account.id, accessToken);
  }
  if (!accessToken) {
    stat.errors.push("Failed to decrypt access token");
    return stat;
  }

  // Which media this campaign covers: its own post, or the recent feed if it
  // matches any post.
  const mediaIds: string[] = [];
  if (automation.postId) {
    mediaIds.push(automation.postId);
    mediaIds.push(...(await adMediaFor(automation.postId)));
  } else if (automation.matchAnyPost) {
    try {
      const media = await getUserMedia({
        context: accessToken,
        limit: RECENT_MEDIA_LIMIT,
      });
      mediaIds.push(...media.map((m) => m.id));
    } catch (error) {
      const message = errMessage(error);
      stat.errors.push(`Media list: ${message}`);
      if (isMetaAppRateLimitError(error)) {
        await tripAppRateLimit(message);
        return stat;
      }
    }
  }
  if (mediaIds.length === 0) return stat;

  const queue = getDMQueue();
  const candidates: Array<{
    comment: InstagramComment;
    mediaId: string;
  }> = [];

  for (const mediaId of mediaIds) {
    let comments: InstagramComment[];
    try {
      comments = await getRecentMediaComments({
        context: accessToken,
        mediaId: mediaId,
        sinceMs: sinceMs,
        max: MAX_COMMENTS_PER_MEDIA,
      });
    } catch (error) {
      const message = errMessage(error);
      stat.errors.push(`Comments ${mediaId}: ${message}`);
      // Trip the shared circuit and abort — more reads only deepen the lockout.
      if (isMetaAppRateLimitError(error)) {
        await tripAppRateLimit(message);
        break;
      }
      continue;
    }

    // Keep only comments that (a) aren't the account's own, (b) match the
    // keyword, and (c) have no reply from the account owner yet.
    for (const c of comments) {
      const authorId = c.from?.id;
      if (!authorId || authorId === account.instagramId) continue;

      const matched = automation.matchAnyWord
        ? true
        : matchKeywords(
            c.text ?? "",
            automation.keywords,
            automation.wholeWordMatch
          ).matched;
      if (!matched) continue;
      stat.matched += 1;
      // Dedup against owner public-replies used to require replies{from} on every
      // Graph page (very expensive). DmLog handling below is the source of truth.
      candidates.push({ comment: c, mediaId });
    }
  }

  if (candidates.length === 0) return stat;

  // Second guard against races: skip comments this campaign has already fully
  // handled. "Fully handled" depends on the campaign: if it posts a public
  // reply, the completion signal is publicReplySentAt (a DM alone is not
  // enough — the reply still has to land); otherwise a SENT DM is enough. This
  // is what lets a comment whose DM sent but whose public reply failed come
  // back and retry the reply.
  const logs = await prisma.dmLog.findMany({
    where: {
      automationId: automation.id,
      commentId: { in: candidates.map((c) => c.comment.id) },
    },
    select: {
      commentId: true,
      status: true,
      attempts: true,
      errorMessage: true,
      dmDeliveryUnconfirmed: true,
      publicReplySentAt: true,
      publicReplyDeliveryUnconfirmed: true,
      updatedAt: true,
    },
  });
  const rateLimitCoolDownMs = Number(
    process.env.META_APP_RATE_LIMIT_BACKOFF_MS ?? 50 * 60_000
  );
  const handledSet = new Set(
    logs
      .filter((log) => {
        // While Meta has the app throttled, do not re-enqueue the same comments
        // every sweep — that is what previously drove usage to 100%.
        if (
          /request limit reached|rate limit/i.test(log.errorMessage ?? "") &&
          Date.now() - log.updatedAt.getTime() < rateLimitCoolDownMs
        ) {
          return true;
        }
        // Rate-limit failures are retryable once the cool-down ends, even if
        // attempts already hit the normal send ceiling.
        if (
          log.status === "FAILED" &&
          /request limit reached|rate limit/i.test(log.errorMessage ?? "")
        ) {
          return false;
        }
        const dmStopped =
          log.status === "SENT" ||
          log.status === "SKIPPED_PLAN_LIMIT" ||
          log.dmDeliveryUnconfirmed ||
          log.attempts >= MAX_COMMENT_SEND_ATTEMPTS ||
          (log.status === "FAILED" &&
            hasLegacyUnconfirmedDelivery(log.errorMessage));
        const replyStopped =
          !automation.publicReplyEnabled ||
          log.publicReplySentAt ||
          log.publicReplyDeliveryUnconfirmed;
        return dmStopped && replyStopped;
      })
      .map((log) => log.commentId)
  );

  // Oldest first so the backlog drains from the first comments; new comments
  // still arrive via later sweeps. Capped for the whole campaign.
  const fresh = candidates
    .filter((c) => !handledSet.has(c.comment.id))
    .sort(
      (a, b) =>
        Date.parse(a.comment.timestamp) - Date.parse(b.comment.timestamp)
    )
    .slice(0, MAX_NEW_PER_SWEEP);

  for (const { comment: c, mediaId } of fresh) {
    // No deterministic jobId here: a retained completed/failed job from an
    // earlier sweep would otherwise be treated as a duplicate and silently
    // drop this add, so the comment would never be retried. Dedup is handled
    // above and by the worker's atomic, durable per-leg claims. Send attempts
    // are counted in DmLog across jobs, so a sweep cannot reset the budget.
    await queue.add("process-comment", {
      instagramAccountId: account.instagramId,
      accountConnectionId: account.id,
      commentId: c.id,
      commentText: c.text ?? "",
      commenterId: c.from!.id,
      commenterName: c.from?.username,
      mediaId,
      // When the sweep is looking at an ad, the campaign is bound to the post
      // the ad was made from: without this the worker matches nothing and
      // drops the comment, so the sweep would enqueue it again every five
      // minutes and never deliver it.
      originalMediaId:
        automation.postId && mediaId !== automation.postId
          ? automation.postId
          : undefined,
      source: "POLLING",
    });
    stat.enqueued += 1;
  }

  return stat;
}

/**
 * Ad copies of a post, as seen in webhooks already received.
 *
 * Boosting a post gives it a second media id: comments left on the ad arrive
 * with the ad's `media.id` and the post's id in `original_media_id`. The sweep
 * would otherwise only ever look at the post itself, so a comment Meta fails to
 * deliver on the ad is lost for good — exactly the case this safety net exists
 * for, and the one where volume is highest.
 *
 * The ad ids are recovered from the webhooks themselves rather than from the
 * ads API, which would need ads_management on top of the permissions the app
 * already asks for. The trade-off: an ad becomes visible to the sweep only once
 * a single comment on it has arrived. That is enough for the failure being
 * covered here, where some webhooks arrive and others do not.
 */
export async function adMediaFor(postId: string): Promise<string[]> {
  try {
    const rows = await prisma.$queryRaw<{ mediaId: string | null }[]>`
      SELECT DISTINCT change->'value'->'media'->>'id' AS "mediaId"
      FROM "WebhookEvent" w,
           jsonb_array_elements(w.payload::jsonb->'entry') entry,
           jsonb_array_elements(entry->'changes') change
      WHERE change->>'field' = 'comments'
        AND change->'value'->'media'->>'original_media_id' = ${postId}
        AND w."createdAt" > now() - interval '90 days'
    `;
    return rows
      .map((r) => r.mediaId)
      .filter((id): id is string => Boolean(id) && id !== postId);
  } catch {
    // A failure here must not stop the sweep: the post itself is still checked.
    return [];
  }
}

async function recordSweep(
  workspaceId: string,
  stat: SweepStat
): Promise<void> {
  // Only log when something happened or something went wrong.
  if (stat.enqueued === 0 && stat.errors.length === 0) return;

  await prisma.operationalEvent
    .create({
      data: {
        workspaceId,
        source: "SYSTEM",
        level: stat.errors.length > 0 ? "WARNING" : "INFO",
        message: `Comment sweep "${stat.campaign}" [${stat.keywords}]: ${stat.enqueued} enqueued, ${stat.matched} matched, ${stat.alreadyReplied} already replied`,
        payload: { ...stat },
      },
    })
    .catch(() => {});
}
