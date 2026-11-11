import { prisma } from "@/lib/db/client";

export const MAX_COMMENT_SEND_ATTEMPTS = 3;

// A durable, atomic claim precedes the external side effect. If the process
// crashes or the final log write fails, an uncertain send must not be repeated.
export async function claimCommentDelivery(
  automationId: string,
  commentId: string,
  leg: "dm" | "public",
): Promise<boolean> {
  const result = await prisma.dmLog.updateMany({
    where: {
      automationId,
      commentId,
      ...(leg === "dm"
        ? {
            status: { not: "SENT" as const },
            dmDeliveryUnconfirmed: false,
            attempts: { lt: MAX_COMMENT_SEND_ATTEMPTS },
          }
        : { publicReplySentAt: null, publicReplyDeliveryUnconfirmed: false }),
    },
    data:
      leg === "dm"
        ? {
            // Claim without burning a send attempt yet. Rate-limit / park paths
            // must not consume the 3-attempt budget or backlog stalls forever.
            dmDeliveryUnconfirmed: true,
            status: "PENDING",
            errorMessage: null,
          }
        : { publicReplyDeliveryUnconfirmed: true },
  });
  return result.count === 1;
}

/** Count a real Meta send attempt only after the request is about to go out. */
export async function recordCommentSendAttempt(
  automationId: string,
  commentId: string,
): Promise<void> {
  await prisma.dmLog.updateMany({
    where: {
      automationId,
      commentId,
      status: { not: "SENT" },
      attempts: { lt: MAX_COMMENT_SEND_ATTEMPTS },
    },
    data: { attempts: { increment: 1 } },
  });
}
