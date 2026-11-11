import { describe, expect, it } from "vitest";
import { parseAppUsageHeader } from "../lib/meta/app-rate-limit-circuit";

describe("parseAppUsageHeader", () => {
  it("reads the max of the three Meta meters", () => {
    const usage = parseAppUsageHeader(
      JSON.stringify({ call_count: 20, total_time: 88, total_cputime: 15 })
    );
    expect(usage).toEqual({
      call_count: 20,
      total_time: 88,
      total_cputime: 15,
      maxPct: 88,
    });
  });

  it("returns null for missing or invalid headers", () => {
    expect(parseAppUsageHeader(null)).toBeNull();
    expect(parseAppUsageHeader("not-json")).toBeNull();
  });
});
