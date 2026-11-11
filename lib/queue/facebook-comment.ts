/**
 * Facebook Page comment → Messenger private-reply processor.
 * Simpler than the IG path: text / link-button private reply + optional public reply.
 * Opening-DM postbacks and follow-gating are IG-only for now.
 */
import { DelayedError, type Job } from "bullmq";
import {
  getDMQueue,
  type ProcessCommentJob,
} from "@/lib/queue/client";
import { prisma } from "@/lib/db/client";
import {
  claimCommentDelivery,
  MAX_COMMENT_SEND_ATTEMPTS,
  recordCommentSendAttempt,
} from "@/lib/queue/comment-delivery";
import {
  createFacebookContext,
  hasFacebookCredentials,
} from "@/lib/facebook/context";
import {
  getFacebookMessengerParticipantName,
  resolveFacebookCommenterByCommentId,
  sendFacebookCommentReply,
  sendFacebookPrivateReply,
  sendFacebookPrivateReplyWithLinkButton,
} from "@/lib/meta/facebook-messages";
import {
  classifySendError,
  hasLegacyUnconfirmedDelivery,
  isDeliveryUnconfirmed,
} from "@/lib/instagram/delivery-errors";
import {
  getAppRateLimitState,
  isMetaAppRateLimitError,
  tripAppRateLimit,
} from "@/lib/meta/app-rate-limit-circuit";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { reserveDMSlot, releaseDMSlot } from "@/lib/utils/rate-limiter";
import {
  releaseWorkspaceDMReservation,
  reserveWorkspaceDMSend,
} from "@/lib/billing/usage";
import {
  buildTrackedUrl,
  renderMessageWithTracking,
  renderMessageWithoutLink,
} from "@/lib/tracking/message";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import { hashRecipientId } from "@/lib/tracking/server";
import { RateLimitError } from "@/lib/meta/client";

async function parkUntilRateLimitClears(
  job: Job<ProcessCommentJob>,
  resumeAt: number
): Promise<void> {
  if (!job.token) {
    throw new RateLimitError(
      "Meta application rate limit; job has no lock token to delay"
    );
  }
  const spreadMs = Math.floor(Math.random() * 10 * 60_000);
  await job.moveToDelayed(resumeAt + spreadMs, job.token);
  throw new DelayedError();
}

export async function processFacebookComment(
  job: Job<ProcessCommentJob>
): Promise<void> {
  const {
    facebookPageId,
    commentId,
    commentText,
    commenterId,
    commenterName,
    mediaId,
    originalMediaId,
    alternateMediaIds,
  } = job.data;
  const requeueAttempt = job.data.requeueAttempt ?? 0;

  if (!facebookPageId) {
    throw new Error("facebookPageId required for Facebook comment jobs");
  }

  const postIds = [
    mediaId,
    ...(originalMediaId ? [originalMediaId] : []),
    ...(alternateMediaIds ?? []),
  ].filter(Boolean);

  const automations = await prisma.automation.findMany({
    where: {
      ...(job.data.accountConnectionId
        ? { facebookPageId: job.data.accountConnectionId }
        : {}),
      OR: [
        ...postIds.map((id) => ({ postId: id })),
        { matchAnyPost: true },
      ],
      isActive: true,
      facebookPage: { pageId: facebookPageId },
    },
    include: {
      facebookPage: true,
      workspace: true,
      trackedLinks: {
        select: { slug: true, label: true, destinationUrl: true },
        orderBy: TRACKED_LINK_ORDER,
      },
    },
    orderBy: { createdAt: "asc" },
  });

  for (const automation of automations) {
    if (!automation.facebookPage || !automation.facebookPageId) continue;

    const matchResult = automation.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(
          commentText,
          automation.keywords,
          automation.wholeWordMatch
        );
    if (!matchResult.matched) continue;

    const existingLog = await prisma.dmLog.findUnique({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId,
        },
      },
    });

    if (
      existingLog?.status === "FAILED" &&
      hasLegacyUnconfirmedDelivery(existingLog.errorMessage)
    ) {
      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: { dmDeliveryUnconfirmed: true },
      });
      existingLog.dmDeliveryUnconfirmed = true;
    }

    const alreadyDmd = existingLog?.status === "SENT";
    const alreadyPublicReplied = Boolean(existingLog?.publicReplySentAt);
    const needsDm =
      !alreadyDmd &&
      !existingLog?.dmDeliveryUnconfirmed &&
      (existingLog?.attempts ?? 0) < MAX_COMMENT_SEND_ATTEMPTS;

    if (existingLog?.status === "SKIPPED_PLAN_LIMIT") continue;
    if (
      !needsDm &&
      (alreadyPublicReplied ||
        existingLog?.publicReplyDeliveryUnconfirmed ||
        !automation.publicReplyEnabled)
    ) {
      continue;
    }

    if (!hasFacebookCredentials(automation.facebookPage)) {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        create: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          facebookPageId: automation.facebookPageId,
          commenterId,
          commenterName,
          commentText,
          commentId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "FAILED",
          errorMessage: "No Facebook Page access token available",
        },
        update: {
          status: "FAILED",
          errorMessage: "No Facebook Page access token available",
        },
      });
      continue;
    }

    let ctx;
    try {
      ctx = createFacebookContext(automation.facebookPage);
    } catch {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        create: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          facebookPageId: automation.facebookPageId,
          commenterId,
          commenterName,
          commentText,
          commentId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "FAILED",
          errorMessage: "Failed to decrypt Facebook Page access token",
        },
        update: {
          status: "FAILED",
          errorMessage: "Failed to decrypt Facebook Page access token",
        },
      });
      continue;
    }

    const realCommenterId =
      commenterId && !commenterId.startsWith("fb_user_") ? commenterId : null;

    await prisma.dmLog.upsert({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId,
        },
      },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        facebookPageId: automation.facebookPageId,
        commenterId,
        commenterName,
        commentText,
        commentId,
        matchedKeyword: matchResult.matchedKeyword,
        status: "PENDING",
      },
      update: {
        ...(commenterName
          ? {
              commenterName,
              ...(realCommenterId ? { commenterId: realCommenterId } : {}),
            }
          : {}),
      },
    });

    const replyPool =
      automation.publicReplyMessages.length > 0
        ? automation.publicReplyMessages
        : automation.publicReplyMessage
          ? [automation.publicReplyMessage]
          : [];

    if (
      automation.publicReplyEnabled &&
      replyPool.length > 0 &&
      !existingLog?.publicReplySentAt &&
      !existingLog?.publicReplyDeliveryUnconfirmed &&
      (await claimCommentDelivery(automation.id, commentId, "public"))
    ) {
      try {
        const chosen =
          replyPool[Math.floor(Math.random() * replyPool.length)] ?? "";
        await sendFacebookCommentReply(
          ctx.accessToken,
          commentId,
          chosen
        );
        await prisma.dmLog.update({
          where: {
            automationId_commentId: {
              automationId: automation.id,
              commentId,
            },
          },
          data: { publicReplySentAt: new Date(), publicReplyError: null },
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Public reply failed";
        await prisma.dmLog.update({
          where: {
            automationId_commentId: {
              automationId: automation.id,
              commentId,
            },
          },
          data: {
            publicReplyError: message,
            ...(isDeliveryUnconfirmed(error)
              ? { publicReplyDeliveryUnconfirmed: true }
              : {}),
          },
        });
      } finally {
        await recordCommentSendAttempt(automation.id, commentId);
      }
    }

    if (!needsDm) continue;

    const appLimit = await getAppRateLimitState();
    if (appLimit.limited) {
      await parkUntilRateLimitClears(job, appLimit.resumeAt);
    }

    let rateLimit: Awaited<ReturnType<typeof reserveDMSlot>> | null = null;
    let workspaceReserved = false;
    let usagePeriodStart: Date | null = null;

    try {
      if (!(await claimCommentDelivery(automation.id, commentId, "dm"))) {
        continue;
      }

      rateLimit = await reserveDMSlot(facebookPageId, requeueAttempt);
      if (!rateLimit.allowed) {
        if (rateLimit.shouldRequeue) {
          const queue = getDMQueue();
          await queue.add(
            "process-comment",
            {
              ...job.data,
              requeueAttempt: requeueAttempt + 1,
            },
            {
              delay: rateLimit.requeueDelayMs,
              jobId: `fb_comment_${facebookPageId}_${commentId}_retry_${requeueAttempt + 1}`,
            }
          );
        }
        continue;
      }

      const usage = await reserveWorkspaceDMSend(automation.workspaceId);
      if (!usage.allowed) {
        await prisma.dmLog.update({
          where: {
            automationId_commentId: {
              automationId: automation.id,
              commentId,
            },
          },
          data: {
            status: "SKIPPED_PLAN_LIMIT",
            errorMessage: `Monthly DM limit reached (${usage.limit})`,
          },
        });
        continue;
      }
      workspaceReserved = usage.reserved;
      usagePeriodStart = usage.periodStart;

      const recipientToken = hashRecipientId(commenterId);
      const tracked = automation.trackedLinks.map((link) => ({
        title: (link.label || automation.linkButtonLabel || "Open").slice(0, 20),
        url: buildTrackedUrl(link.slug, undefined, recipientToken),
      }));

      const bodyText = renderMessageWithTracking({
        message: automation.dmMessage,
        commenterName,
        trackedLinks: automation.trackedLinks,
        recipientToken,
      });

      await recordCommentSendAttempt(automation.id, commentId);

      const sendResult =
        tracked.length > 0
          ? await sendFacebookPrivateReplyWithLinkButton(
              ctx.accessToken,
              ctx.pageId,
              commentId,
              renderMessageWithoutLink({
                message: automation.dmMessage,
                commenterName,
              }) || "Here's your link:",
              tracked
            )
          : await sendFacebookPrivateReply(
              ctx.accessToken,
              ctx.pageId,
              commentId,
              bodyText
            );

      let resolvedId = commenterId;
      let resolvedName = commenterName;
      try {
        if (sendResult.recipient_id) {
          resolvedId = sendResult.recipient_id;
          const profile = await getFacebookMessengerParticipantName(
            ctx.accessToken,
            ctx.pageId,
            sendResult.recipient_id
          );
          if (profile?.name) {
            resolvedId = profile.id;
            resolvedName = profile.name;
          }
        }
        if (!resolvedName) {
          const byComment = await resolveFacebookCommenterByCommentId(
            ctx.accessToken,
            ctx.pageId,
            commentId
          );
          if (byComment?.name) {
            resolvedId = byComment.id;
            resolvedName = byComment.name;
          }
        }
      } catch (err) {
        console.warn(
          "[Facebook Comment] Could not resolve Messenger name:",
          err instanceof Error ? err.message : err
        );
      }

      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: {
          status: "SENT",
          dmSentAt: new Date(),
          errorMessage: null,
          dmDeliveryUnconfirmed: false,
          commenterId: resolvedId,
          ...(resolvedName ? { commenterName: resolvedName } : {}),
        },
      });
    } catch (error) {
      if (isMetaAppRateLimitError(error)) {
        const reason =
          error instanceof Error ? error.message : "Meta app rate limit";
        const tripped = await tripAppRateLimit(reason);
        if (workspaceReserved) {
          await releaseWorkspaceDMReservation(
            automation.workspaceId,
            usagePeriodStart
          );
        }
        if (rateLimit?.reserved) await releaseDMSlot(facebookPageId);
        await parkUntilRateLimitClears(job, tripped.resumeAt);
      }

      const classified = classifySendError(error);
      const unconfirmed = isDeliveryUnconfirmed(error);
      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: {
          status: unconfirmed ? "SENT" : "FAILED",
          ...(unconfirmed
            ? { dmSentAt: new Date(), dmDeliveryUnconfirmed: true }
            : { dmDeliveryUnconfirmed: false }),
          errorMessage:
            classified instanceof Error
              ? classified.message
              : String(classified),
        },
      });
      if (workspaceReserved && !unconfirmed) {
        await releaseWorkspaceDMReservation(
          automation.workspaceId,
          usagePeriodStart
        );
      }
      throw classified;
    } finally {
      if (rateLimit?.reserved) await releaseDMSlot(facebookPageId);
    }
  }
}
