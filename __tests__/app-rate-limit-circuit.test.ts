import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const redis = {
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    return "OK";
  }),
  del: vi.fn(async (key: string) => {
    store.delete(key);
    return 1;
  }),
};

vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => redis,
}));

import {
  clearAppRateLimit,
  getAppRateLimitState,
  isMetaAppRateLimitError,
  tripAppRateLimit,
} from "../lib/meta/app-rate-limit-circuit";
import { RateLimitError } from "../lib/meta/client";

describe("app rate limit circuit", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it("opens then reports remaining time", async () => {
    const until = Date.now() + 60_000;
    const state = await tripAppRateLimit("test", until);
    expect(state.limited).toBe(true);
    const again = await getAppRateLimitState();
    expect(again.limited).toBe(true);
    if (again.limited) expect(again.resumeAt).toBe(until);
  });

  it("extends an already-open circuit when a later until is provided", async () => {
    await tripAppRateLimit("first", Date.now() + 10_000);
    const later = Date.now() + 90_000;
    const state = await tripAppRateLimit("second", later);
    expect(state.limited).toBe(true);
    if (state.limited) expect(state.resumeAt).toBe(later);
  });

  it("clears after expiry and on explicit clear", async () => {
    await tripAppRateLimit("expired", Date.now() - 1_000);
    expect(await getAppRateLimitState()).toEqual({ limited: false });
    await tripAppRateLimit("live", Date.now() + 30_000);
    await clearAppRateLimit();
    expect(await getAppRateLimitState()).toEqual({ limited: false });
  });

  it("detects Meta rate-limit errors", () => {
    expect(
      isMetaAppRateLimitError(
        new RateLimitError("Application request limit reached", undefined, undefined, 4)
      )
    ).toBe(true);
    expect(isMetaAppRateLimitError(new Error("boom"))).toBe(false);
  });
});
