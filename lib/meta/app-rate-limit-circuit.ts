/**
 * Meta application-level rate-limit circuit breaker.
 *
 * When Graph returns code 4 / 17 / 368 ("Application request limit reached"),
 * continuing to call Meta only pushes the unblock clock forward. This module
 * records a cool-down in Redis so workers and the comment poller pause API
 * traffic, then resume automatically when the window expires.
 */

import { getRedisConnection } from "@/lib/queue/client";

const REDIS_KEY = "meta:app_rate_limit:until";

export function getAppRateLimitBackoffMs(): number {
  // Total Time lockouts often need ~45–60 minutes; default a bit longer than
  // the dashboard tip so we do not re-open into another code-4 spike.
  return Number(process.env.META_APP_RATE_LIMIT_BACKOFF_MS ?? 60 * 60 * 1000);
}

/** Preemptive pause when X-App-Usage approaches the ceiling (before code 4). */
export function getAppUsageSoftLimitPct(): number {
  return Number(process.env.META_APP_USAGE_SOFT_LIMIT_PCT ?? 65);
}

export function getAppUsageSoftBackoffMs(): number {
  return Number(process.env.META_APP_USAGE_SOFT_BACKOFF_MS ?? 30 * 60 * 1000);
}

export type AppUsageSnapshot = {
  call_count: number;
  total_time: number;
  total_cputime: number;
  maxPct: number;
};

export function parseAppUsageHeader(
  headerValue: string | null
): AppUsageSnapshot | null {
  if (!headerValue) return null;
  try {
    const parsed = JSON.parse(headerValue) as {
      call_count?: number;
      total_time?: number;
      total_cputime?: number;
    };
    const call_count = Number(parsed.call_count ?? 0);
    const total_time = Number(parsed.total_time ?? 0);
    const total_cputime = Number(parsed.total_cputime ?? 0);
    return {
      call_count,
      total_time,
      total_cputime,
      maxPct: Math.max(call_count, total_time, total_cputime),
    };
  } catch {
    return null;
  }
}

/**
 * Read Meta's X-App-Usage and open the circuit early when any meter (especially
 * total_time) nears the soft limit — so we stop before hard code-4 lockouts.
 */
export async function noteMetaAppUsageFromResponse(
  response: Response
): Promise<AppUsageSnapshot | null> {
  const usage = parseAppUsageHeader(response.headers.get("x-app-usage"));
  if (!usage) return null;
  const soft = getAppUsageSoftLimitPct();
  if (usage.maxPct >= soft) {
    await tripAppRateLimit(
      `X-App-Usage soft-limit hit: max=${usage.maxPct}% (call=${usage.call_count} time=${usage.total_time} cpu=${usage.total_cputime}) soft=${soft}%`,
      Date.now() + getAppUsageSoftBackoffMs()
    );
  }
  return usage;
}

export type AppRateLimitState =
  | { limited: false }
  | { limited: true; resumeAt: number; remainingMs: number };

export async function getAppRateLimitState(): Promise<AppRateLimitState> {
  const raw = await getRedisConnection().get(REDIS_KEY);
  if (!raw) return { limited: false };
  const resumeAt = Number(raw);
  if (!Number.isFinite(resumeAt) || resumeAt <= Date.now()) {
    await getRedisConnection().del(REDIS_KEY).catch(() => {});
    return { limited: false };
  }
  return {
    limited: true,
    resumeAt,
    remainingMs: resumeAt - Date.now(),
  };
}

export async function isAppRateLimited(): Promise<boolean> {
  return (await getAppRateLimitState()).limited;
}

/**
 * Open the circuit until `untilMs` (default: now + backoff). Extending an
 * already-open circuit is allowed — a fresh Meta 4 while cooling down should
 * push the resume time out, not ignore the new hit.
 */
export async function tripAppRateLimit(
  reason = "Meta application rate limit",
  untilMs = Date.now() + getAppRateLimitBackoffMs()
): Promise<Extract<AppRateLimitState, { limited: true }>> {
  const redis = getRedisConnection();
  const existing = Number((await redis.get(REDIS_KEY)) ?? 0);
  const resumeAt = Math.max(existing, untilMs);
  const ttlSec = Math.max(1, Math.ceil((resumeAt - Date.now()) / 1000));
  await redis.set(REDIS_KEY, String(resumeAt), "EX", ttlSec);
  console.warn(
    `[Meta Circuit] OPEN for ${ttlSec}s — ${reason}. Resume ~${new Date(resumeAt).toISOString()}`
  );
  return {
    limited: true,
    resumeAt,
    remainingMs: resumeAt - Date.now(),
  };
}

export async function clearAppRateLimit(): Promise<void> {
  await getRedisConnection().del(REDIS_KEY);
  console.log("[Meta Circuit] CLOSED — API traffic allowed again");
}

export function isMetaAppRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const message = "message" in error ? String(error.message) : "";
  const code =
    "code" in error && typeof (error as { code?: unknown }).code === "number"
      ? (error as { code: number }).code
      : undefined;
  if (name === "RateLimitError") return true;
  if (code === 4 || code === 17 || code === 368) return true;
  return /request limit reached|rate limit|too many calls/i.test(message);
}
