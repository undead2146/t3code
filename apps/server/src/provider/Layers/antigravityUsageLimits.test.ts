import { describe, expect, it } from "@effect/vitest";

import {
  ANTIGRAVITY_LIMIT_CONSTANTS,
  ANTIGRAVITY_WINDOW_IDS,
  makeAntigravityUsageLimits,
  makeAntigravityUsageLimitsUpdate,
} from "./antigravityUsageLimits.ts";

describe("antigravityUsageLimits", () => {
  it("builds initial limits with session and daily windows", () => {
    const limits = makeAntigravityUsageLimits();
    expect(limits.windows).toHaveLength(2);

    const session = limits.windows.find((w) => w.id === ANTIGRAVITY_WINDOW_IDS.SESSION);
    expect(session).toBeDefined();
    expect(session?.kind).toBe("session");
    expect(session?.label).toBe("Session");
    expect(session?.windowDurationMins).toBe(ANTIGRAVITY_LIMIT_CONSTANTS.SESSION_MINS);
    expect(session?.usedPercent).toBe(0);
    expect(session?.resetsAt).toBeDefined();

    const daily = limits.windows.find((w) => w.id === ANTIGRAVITY_WINDOW_IDS.DAILY);
    expect(daily).toBeDefined();
    expect(daily?.kind).toBe("weekly");
    expect(daily?.label).toBe("Daily");
    expect(daily?.windowDurationMins).toBe(ANTIGRAVITY_LIMIT_CONSTANTS.DAILY_MINS);
    expect(daily?.usedPercent).toBe(0);
    expect(daily?.resetsAt).toBeDefined();
  });

  it("calculates accurate used percentages from tokens used", () => {
    const limits = makeAntigravityUsageLimits({
      sessionTokensUsed: 125_000,
      sessionTokenLimit: 250_000,
      dailyTokensUsed: 500_000,
      dailyTokenLimit: 1_000_000,
    });

    const session = limits.windows.find((w) => w.id === ANTIGRAVITY_WINDOW_IDS.SESSION);
    expect(session?.usedPercent).toBe(50);

    const daily = limits.windows.find((w) => w.id === ANTIGRAVITY_WINDOW_IDS.DAILY);
    expect(daily?.usedPercent).toBe(50);
  });

  it("creates updates with rateLimited flag setting 100%", () => {
    const update = makeAntigravityUsageLimitsUpdate({
      rateLimited: true,
      sessionResetsAt: "2026-09-06T20:00:00.000Z",
    });

    const session = update.windows.find((w) => w.id === ANTIGRAVITY_WINDOW_IDS.SESSION);
    expect(session?.usedPercent).toBe(100);
    expect(session?.resetsAt).toBe("2026-09-06T20:00:00.000Z");

    const daily = update.windows.find((w) => w.id === ANTIGRAVITY_WINDOW_IDS.DAILY);
    expect(daily?.usedPercent).toBe(100);
  });
});
