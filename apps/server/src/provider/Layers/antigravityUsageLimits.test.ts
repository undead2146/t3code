import { beforeEach, describe, expect, it } from "@effect/vitest";

import {
  ANTIGRAVITY_LIMIT_CONSTANTS,
  ANTIGRAVITY_WINDOW_IDS,
  makeAntigravityUsageLimits,
  makeAntigravityUsageLimitsUpdate,
  parseAntigravityQuotaPayload,
  resetAntigravityLiveQuotaCacheForTesting,
  setAntigravityLiveQuotaCacheForTesting,
} from "./antigravityUsageLimits.ts";

describe("antigravityUsageLimits", () => {
  beforeEach(() => {
    resetAntigravityLiveQuotaCacheForTesting();
  });

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

  it("calculates accurate used percentages from tokens used in fallback mode", () => {
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

  it("correctly parses Google Cloud Code fetchAvailableModels payload", () => {
    const samplePayload = {
      models: {
        "gemini-3.1-pro-high": {
          displayName: "Gemini 3.1 Pro (High)",
          model: "gemini-3.1-pro-high",
          quotaInfo: {
            remainingFraction: 0.85,
            resetTime: "2026-09-07T15:00:00Z",
          },
        },
        "claude-sonnet-4-6": {
          displayName: "Claude Sonnet 4.6 (Thinking)",
          model: "claude-sonnet-4-6",
          quotaInfo: {
            remainingFraction: 0.6,
            resetTime: "2026-09-07T14:30:00Z",
          },
        },
        "gemini-3-flash": {
          displayName: "Gemini 3 Flash",
          model: "gemini-3-flash",
          quotaInfo: {
            remainingFraction: 1.0,
            resetTime: "2026-09-08T00:00:00Z",
          },
        },
      },
    };

    const parsed = parseAntigravityQuotaPayload(samplePayload, "2026-09-07T10:00:00.000Z");
    expect(parsed).not.toBeNull();
    expect(parsed?.checkedAt).toBe("2026-09-07T10:00:00.000Z");

    // Session quota should prefer Claude Sonnet
    expect(parsed?.sessionQuota?.modelId).toBe("claude-sonnet-4-6");
    expect(parsed?.sessionQuota?.remainingFraction).toBe(0.6);
    expect(parsed?.sessionQuota?.usedPercent).toBe(40); // (1 - 0.6) * 100
    expect(parsed?.sessionQuota?.resetsAt).toBe("2026-09-07T14:30:00Z");

    // Daily quota tracks Flash
    expect(parsed?.dailyQuota?.modelId).toBe("gemini-3-flash");
    expect(parsed?.dailyQuota?.remainingFraction).toBe(1.0);
    expect(parsed?.dailyQuota?.usedPercent).toBe(0); // (1 - 1.0) * 100
    expect(parsed?.dailyQuota?.resetsAt).toBe("2026-09-08T00:00:00Z");
  });

  it("builds limits and updates from live Google quota data", () => {
    const liveQuota = {
      checkedAt: "2026-09-07T10:00:00.000Z",
      sessionQuota: {
        modelId: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        remainingFraction: 0.75,
        usedPercent: 25,
        resetsAt: "2026-09-07T15:00:00Z",
      },
      dailyQuota: {
        modelId: "gemini-3-flash",
        label: "Gemini 3 Flash",
        remainingFraction: 0.9,
        usedPercent: 10,
        resetsAt: "2026-09-08T00:00:00Z",
      },
      models: [
        {
          modelId: "claude-sonnet-4-6",
          label: "Claude Sonnet 4.6",
          remainingFraction: 0.75,
          usedPercent: 25,
          resetsAt: "2026-09-07T15:00:00Z",
        },
      ],
    };

    setAntigravityLiveQuotaCacheForTesting(liveQuota);

    const limits = makeAntigravityUsageLimits();
    const session = limits.windows.find((w) => w.id === ANTIGRAVITY_WINDOW_IDS.SESSION);
    expect(session?.usedPercent).toBe(25);
    expect(session?.resetsAt).toBe("2026-09-07T15:00:00Z");

    const daily = limits.windows.find((w) => w.id === ANTIGRAVITY_WINDOW_IDS.DAILY);
    expect(daily?.usedPercent).toBe(10);
    expect(daily?.resetsAt).toBe("2026-09-08T00:00:00Z");

    // Also verify mid-turn update preserves the real quota instead of token counts
    const update = makeAntigravityUsageLimitsUpdate({
      sessionTokensUsed: 50_000,
    });
    const updatedSession = update.windows.find((w) => w.id === ANTIGRAVITY_WINDOW_IDS.SESSION);
    expect(updatedSession?.usedPercent).toBe(25);
    expect(updatedSession?.resetsAt).toBe("2026-09-07T15:00:00Z");
  });
});
