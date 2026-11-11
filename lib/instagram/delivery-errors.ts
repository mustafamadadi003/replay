import {
  MetaApiError,
  RateLimitError,
  TokenExpiredError,
} from "@/lib/meta/client";
import {
  ZernioApiError,
  ZernioDeliveryUnconfirmedError,
} from "@/lib/zernio/client";

export class DeliveryUnconfirmedError extends Error {
  constructor(error: unknown) {
    const detail =
      error instanceof Error ? error.message : "Unknown send outcome";
    super(
      `Message delivery is unconfirmed; automatic retries stopped. Inspect the Instagram inbox before retrying. ${detail}`,
    );
    this.name = "DeliveryUnconfirmedError";
  }
}

export function isDeliveryUnconfirmed(
  error: unknown,
): error is DeliveryUnconfirmedError | ZernioDeliveryUnconfirmedError {
  return (
    error instanceof DeliveryUnconfirmedError ||
    error instanceof ZernioDeliveryUnconfirmedError
  );
}

// Only explicit rejections prove that no message was delivered. Meta code 1,
// ambiguous provider answers, and similar cases do not.
export function isConfirmedSendRejection(error: unknown): boolean {
  if (error instanceof RateLimitError || error instanceof TokenExpiredError)
    return true;
  if (error instanceof ZernioApiError)
    return error.code >= 400 && error.code < 500;
  return (
    error instanceof MetaApiError && [10, 100, 200, 551].includes(error.code)
  );
}

/**
 * Transient transport failures (Wi-Fi drop, DNS blip, connection reset). These
 * must be retried by BullMQ — treating them as "maybe delivered" permanently
 * stalls the backlog after a brief outage.
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  const name = error.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  if (error instanceof TypeError && /fetch|network/i.test(msg)) return true;
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|socket hang up|network|temporarily unavailable|Other side closed/i.test(
    msg
  );
}

export function classifySendError(error: unknown): unknown {
  if (isDeliveryUnconfirmed(error) || isConfirmedSendRejection(error)) {
    return error;
  }
  // Network blips and Meta "retry later" (code 2) are safe to retry.
  if (isTransientNetworkError(error)) return error;
  if (error instanceof MetaApiError && error.code === 2) return error;
  return new DeliveryUnconfirmedError(error);
}

// Old workers logged these uncertain Meta responses as retryable failures.
export function hasLegacyUnconfirmedDelivery(
  error: string | null | undefined,
): boolean {
  return Boolean(
    error &&
    /(?:MetaApiError (?:1|2|5\d\d):|\[code=(?:1|2|5\d\d)\b)/.test(error),
  );
}
