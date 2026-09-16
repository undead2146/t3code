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

  it("builds initial limits with session and weekly windows", () => {
    const limits = makeAntigravityUsageLimits();
    expect(limits.windows).toHaveLength(2);

    const session = limits.windows.find((w) => w.id === ANTIGRAVITY_WINDOW_IDS.SESSION);
    expect(session).toBeDefined();
    expect(session?.kind).toBe("session");
    expect(session?.label).toBe("Session");
    expect(session?.windowDurationMins).toBe(ANTIGRAVITY_LIMIT_CONSTANTS.SESSION_MINS);
    expect(session?.usedPercent).toBe(0);
    expect(session?.resetsAt).toBeDefined();

    const weekly = limits.windows.find((w) => w.id === ANTIGRAVITY_WINDOW_IDS.WEEKLY);
    expect(weekly).toBeDefined();
    expect(weekly?.kind).toBe("weekly");
    expect(weekly?.label).toBe("Weekly");
    expect(weekly?.windowDurationMins).toBe(ANTIGRAVITY_LIMIT_CONSTANTS.WEEKLY_MINS);
    expect(weekly?.usedPercent).toBe(0);
    expect(weekly?.resetsAt).toBeDefined();
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

    const weekly = limits.windows.find((w) => w.id === ANTIGRAVITY_WINDOW_IDS.WEEKLY);
    expect(weekly?.usedPercent).toBe(50);
  });

  it("creates updates with rateLimited flag setting 100%", () => {
    const update = makeAntigravityUsageLimitsUpdate({
      rateLimited: true,
      sessionResetsAt: "2026-09-06T20:00:00.000Z",
      weeklyResetsAt: "2026-09-13T20:00:00.000Z",
    });

    const session = update.windows.find((w) => w.id === ANTIGRAVITY_WINDOW_IDS.SESSION);
    expect(session?.usedPercent).toBe(100);
    expect(session?.resetsAt).toBe("2026-09-06T20:00:00.000Z");

    const weekly = update.windows.find((w) => w.id === ANTIGRAVITY_WINDOW_IDS.WEEKLY);
    expect(weekly?.usedPercent).toBe(100);
    expect(weekly?.resetsAt).toBe("2026-09-13T20:00:00.000Z");
  });

  it("correctly parses Google Cloud Code retrieveUserQuotaSummary payload", () => {
    const quotaSummaryPayload = {
      groups: [
        {
          displayName: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            {
              bucketId: "gemini-weekly",
              displayName: "Weekly Limit Remaining",
              window: "weekly",
              resetTime: "2026-09-10T10:41:32Z",
              description:
                "You have used some of your weekly limit, it will fully refresh in 1 day, 7 hours.",
              remainingFraction: 0.9624469,
            },
            {
              bucketId: "gemini-5h",
              displayName: "Five Hour Limit Remaining",
              window: "5h",
              resetTime: "2026-09-09T08:01:51Z",
              remainingFraction: 1,
            },
          ],
        },
        {
          displayName: "Claude and GPT models",
          description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          buckets: [
            {
              bucketId: "3p-weekly",
              displayName: "Weekly Limit Remaining",
              window: "weekly",
              resetTime: "2026-09-10T12:54:28Z",
              description:
                "You have used some of your weekly limit, it will fully refresh in 1 day, 9 hours.",
              remainingFraction: 0.9985625,
            },
            {
              bucketId: "3p-5h",
              displayName: "Five Hour Limit Remaining",
              window: "5h",
              resetTime: "2026-09-09T08:01:51Z",
              remainingFraction: 1,
            },
          ],
        },
      ],
    };

    const parsed = parseAntigravityQuotaPayload(
      quotaSummaryPayload,
      "2026-09-07T10:00:00.000Z",
      "user2146name@gmail.com",
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.checkedAt).toBe("2026-09-07T10:00:00.000Z");
    expect(parsed?.userEmail).toBe("user2146name@gmail.com");

    // Session quota tracks gemini-5h
    expect(parsed?.sessionQuota?.bucketId).toBe("gemini-5h");
    expect(parsed?.sessionQuota?.remainingFraction).toBe(1);
    expect(parsed?.sessionQuota?.usedPercent).toBe(0);
    expect(parsed?.sessionQuota?.resetsAt).toBe("2026-09-09T08:01:51Z");

    // Weekly quota tracks gemini-weekly
    expect(parsed?.weeklyQuota?.bucketId).toBe("gemini-weekly");
    expect(parsed?.weeklyQuota?.remainingFraction).toBe(0.9624469);
    expect(parsed?.weeklyQuota?.usedPercent).toBe(4); // (1 - 0.9624469) * 100 = ~3.75 -> 4
    expect(parsed?.weeklyQuota?.resetsAt).toBe("2026-09-10T10:41:32Z");

    // Buckets include all 4 buckets
    expect(parsed?.buckets).toHaveLength(4);
    const claudeWeekly = parsed?.buckets?.find((b) => b.bucketId === "3p-weekly");
    expect(claudeWeekly).toBeDefined();
    expect(claudeWeekly?.resetsAt).toBe("2026-09-10T12:54:28Z");
  });

  it("correctly parses fallback Google Cloud Code fetchAvailableModels payload", () => {
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

    // Weekly quota tracks Flash in fallback mode
    expect(parsed?.weeklyQuota?.modelId).toBe("gemini-3-flash");
    expect(parsed?.weeklyQuota?.remainingFraction).toBe(1.0);
    expect(parsed?.weeklyQuota?.usedPercent).toBe(0); // (1 - 1.0) * 100
    expect(parsed?.weeklyQuota?.resetsAt).toBe("2026-09-08T00:00:00Z");
  });

  it("builds limits and updates from live Google quota data", () => {
    const liveQuota = {
      checkedAt: "2026-09-07T10:00:00.000Z",
      sessionQuota: {
        bucketId: "gemini-5h",
        modelId: "gemini-5h",
        label: "Five Hour Limit Remaining",
        groupName: "Gemini Models",
        window: "5h",
        remainingFraction: 0.75,
        usedPercent: 25,
        resetsAt: "2026-09-07T15:00:00Z",
      },
      weeklyQuota: {
        bucketId: "gemini-weekly",
        modelId: "gemini-weekly",
        label: "Weekly Limit Remaining",
        groupName: "Gemini Models",
        window: "weekly",
        remainingFraction: 0.9,
        usedPercent: 10,
        resetsAt: "2026-09-10T10:00:00Z",
      },
      buckets: [
        {
          bucketId: "3p-5h",
          modelId: "3p-5h",
          label: "Five Hour Limit Remaining",
          groupName: "Claude and GPT models",
          window: "5h",
          remainingFraction: 0.8,
          usedPercent: 20,
          resetsAt: "2026-09-07T14:00:00Z",
        },
        {
          bucketId: "3p-weekly",
          modelId: "3p-weekly",
          label: "Weekly Limit Remaining",
          groupName: "Claude and GPT models",
          window: "weekly",
          remainingFraction: 1.0,
          usedPercent: 0,
          resetsAt: "2026-09-10T12:00:00Z",
        },
      ],
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

    const weekly = limits.windows.find((w) => w.id === ANTIGRAVITY_WINDOW_IDS.WEEKLY);
    expect(weekly?.usedPercent).toBe(10);
    expect(weekly?.resetsAt).toBe("2026-09-10T10:00:00Z");

    const thirdPartySession = limits.windows.find((w) => w.id === "antigravity_3p_session");
    expect(thirdPartySession).toBeDefined();
    expect(thirdPartySession?.label).toBe("Session · Claude & GPT");
    expect(thirdPartySession?.usedPercent).toBe(20);
    expect(thirdPartySession?.resetsAt).toBe("2026-09-07T14:00:00Z");

    const thirdParty = limits.windows.find((w) => w.id === "antigravity_3p_weekly");
    expect(thirdParty).toBeDefined();
    expect(thirdParty?.label).toBe("Weekly · Claude & GPT");
    expect(thirdParty?.usedPercent).toBe(0);
    expect(thirdParty?.resetsAt).toBe("2026-09-10T12:00:00Z");

    // Also verify mid-turn update preserves the real quota instead of token counts
    const update = makeAntigravityUsageLimitsUpdate({
      sessionTokensUsed: 50_000,
    });
    const updatedSession = update.windows.find((w) => w.id === ANTIGRAVITY_WINDOW_IDS.SESSION);
    expect(updatedSession?.usedPercent).toBe(25);
    expect(updatedSession?.resetsAt).toBe("2026-09-07T15:00:00Z");
  });
});
