/**
 * Safety net for Facebook Page campaigns: list post comments via Graph API and
 * enqueue any keyword matches webhooks may have missed (including backlog).
 *
 * Requires the Page token to include `pages_read_user_content`.
 */
import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import { createFacebookContext } from "@/lib/facebook/context";
import {
  listFacebookPagePosts,
  listFacebookPostComments,
} from "@/lib/meta/facebook-messages";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import {
  getAppRateLimitState,
  isMetaAppRateLimitError,
  tripAppRateLimit,
} from "@/lib/meta/app-rate-limit-circuit";

const LOOKBACK_HOURS = Number(process.env.FB_COMMENT_LOOKBACK_HOURS ?? 24 * 14);
const MAX_PAGES_PER_POST = Number(process.env.FB_COMMENT_MAX_PAGES ?? 40);
/** Cap Graph feed reads for matchAnyPost campaigns (lean Meta usage). */
const ANY_POST_FEED_LIMIT = Number(process.env.FB_COMMENT_ANY_POST_LIMIT ?? 5);

export async function reconcileFacebookComments(): Promise<void> {
  const circuit = await getAppRateLimitState();
  if (circuit.limited) {
    console.log(
      `[FB Comment Poll] Skipping — Meta circuit open for ${Math.ceil(circuit.remainingMs / 60_000)} more min`
    );
    return;
  }

  const queue = getDMQueue();
  const counts = await queue.getJobCounts("waiting", "active", "delayed");
  const inflight =
    (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
  const maxInflight = Number(process.env.COMMENT_POLL_SKIP_INFLIGHT_ABOVE ?? 25);
  // Leave headroom so a long-running backlog (Salamkar) cannot block Graph
  // reads for every other Page campaign forever.
  const enqueueBudget = Math.max(
    0,
    Number(process.env.FB_COMMENT_POLL_ENQUEUE_BUDGET ?? 20) - inflight
  );
  if (inflight >= maxInflight || enqueueBudget === 0) {
    console.log(
      `[FB Comment Poll] Skipping Graph comment list — queue deeply busy (waiting=${counts.waiting ?? 0} active=${counts.active ?? 0} delayed=${counts.delayed ?? 0} cap=${maxInflight})`
    );
    return;
  }

  const campaigns = await prisma.automation.findMany({
    where: {
      isActive: true,
      facebookPageId: { not: null },
      OR: [{ postId: { not: null } }, { matchAnyPost: true }],
    },
    include: {
      facebookPage: true,
    },
    // Newest campaigns first — avoids permanent starvation behind old backfills.
    orderBy: { createdAt: "desc" },
  });

  const sinceMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
  const pacingMs = Number(process.env.DM_SEND_PACING_MS ?? 10_000);
  let enqueued = 0;
  // Fair share: do not let one Page consume the whole budget in one sweep.
  const perCampaignCap = Math.max(
    3,
    Math.ceil(enqueueBudget / Math.max(1, campaigns.length))
  );

  for (const automation of campaigns) {
    if (enqueued >= enqueueBudget) break;
    const page = automation.facebookPage;
    if (!page) continue;
    let campaignEnqueued = 0;

    let ctx;
    try {
      ctx = createFacebookContext(page);
    } catch (e) {
      console.warn(
        `[FB Comment Poll] Decrypt failed for ${page.name}:`,
        e instanceof Error ? e.message : e
      );
      continue;
    }

    // Specific post, or recent feed for matchAnyPost (webhook-less Railway).
    const targetPosts: Array<{ id: string; alternateIds: string[] }> = [];
    if (automation.postId) {
      const underscore = automation.postId.indexOf("_");
      const short =
        underscore > 0 ? automation.postId.slice(underscore + 1) : null;
      targetPosts.push({
        id: automation.postId,
        alternateIds: short ? [short] : [],
      });
    } else if (automation.matchAnyPost) {
      try {
        const feed = await listFacebookPagePosts(
          ctx.accessToken,
          page.pageId,
          ANY_POST_FEED_LIMIT
        );
        for (const post of feed) {
          if (!post.id) continue;
          targetPosts.push({ id: post.id, alternateIds: [] });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[FB Comment Poll] feed list failed for ${page.name}: ${message}`
        );
        if (isMetaAppRateLimitError(error)) {
          await tripAppRateLimit(message);
          return;
        }
        continue;
      }
    }
    if (!targetPosts.length) continue;

    for (const target of targetPosts) {
      if (enqueued >= enqueueBudget || campaignEnqueued >= perCampaignCap) break;

      const primaryPostId = target.id;
      let after: string | undefined;
      let pages = 0;

      try {
        do {
          const { comments, nextCursor } = await listFacebookPostComments(
            ctx.accessToken,
            primaryPostId,
            { limit: 50, after }
          );
          pages += 1;

          for (const comment of comments) {
            if (!comment.id) continue;
            // Page tokens sometimes omit `from` on older comments; private-reply
            // only needs comment_id, so keep a stable placeholder for logging.
            const commenterId =
              comment.from?.id?.trim() || `fb_user_${comment.id}`;
            if (commenterId === page.pageId) continue;

            const createdMs = comment.created_time
              ? Date.parse(comment.created_time)
              : NaN;
            if (Number.isFinite(createdMs) && createdMs < sinceMs) continue;
            // For matchAnyPost, ignore comments older than the campaign itself.
            if (
              automation.matchAnyPost &&
              !automation.postId &&
              Number.isFinite(createdMs) &&
              createdMs < automation.createdAt.getTime()
            ) {
              continue;
            }

            const text = comment.message ?? "";
            const match = automation.matchAnyWord
              ? { matched: true, matchedKeyword: null as string | null }
              : matchKeywords(
                  text,
                  automation.keywords,
                  automation.wholeWordMatch
                );
            if (!match.matched) continue;

            const existing = await prisma.dmLog.findUnique({
              where: {
                automationId_commentId: {
                  automationId: automation.id,
                  commentId: comment.id,
                },
              },
              select: { status: true },
            });

            // Already handled (including FAILED). Re-queueing FAILED every sweep
            // was why Pending stayed empty while DMs kept going — permanent Meta
            // errors like "cant reply to this activity" looped forever.
            if (existing) continue;

            // Record the keyword match immediately so campaign progress
            // (matched / sent / left) is accurate before the worker drains the queue.
            await prisma.dmLog.create({
              data: {
                workspaceId: automation.workspaceId,
                automationId: automation.id,
                facebookPageId: page.id,
                commenterId,
                commenterName: comment.from?.name ?? null,
                commentText: text,
                commentId: comment.id,
                matchedKeyword: match.matchedKeyword,
                status: "PENDING",
              },
            });

            if (enqueued >= enqueueBudget || campaignEnqueued >= perCampaignCap) {
              after = undefined;
              break;
            }

            try {
              await queue.add(
                "process-comment",
                {
                  channel: "facebook",
                  facebookPageId: page.pageId,
                  accountConnectionId: page.id,
                  commentId: comment.id,
                  commentText: text,
                  commenterId,
                  commenterName: comment.from?.name,
                  mediaId: primaryPostId,
                  alternateMediaIds: target.alternateIds,
                  source: "POLLING",
                },
                {
                  delay: enqueued * Math.max(0, pacingMs),
                  jobId: `fb_poll_${page.pageId}_${comment.id}`,
                }
              );
              enqueued += 1;
              campaignEnqueued += 1;
            } catch {
              // Duplicate jobId (already queued) — progress row still exists above.
            }
          }

          after = nextCursor;
        } while (
          after &&
          pages < MAX_PAGES_PER_POST &&
          enqueued < enqueueBudget &&
          campaignEnqueued < perCampaignCap
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[FB Comment Poll] ${automation.name} / ${primaryPostId}: ${message}`
        );
        if (isMetaAppRateLimitError(error)) {
          await tripAppRateLimit(message);
          return;
        }
        // Missing pages_read_user_content — surface once per sweep.
        if (
          /pages_read_user_content|Missing Permissions|#10|#200/i.test(message)
        ) {
          console.warn(
            "[FB Comment Poll] Token needs pages_read_user_content to backfill old comments. Webhooks still handle new ones."
          );
        }
      }
    }
  }

  if (enqueued > 0) {
    console.log(`[FB Comment Poll] Enqueued ${enqueued} Facebook comment jobs`);
  }
}
