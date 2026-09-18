// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off
import { describe, expect, it } from "@effect/vitest";

import {
  clearCursorUsageLimitsCache,
  CURSOR_DEFAULT_ENDPOINT,
  CURSOR_WINDOW_IDS,
  type CursorCurrentPeriodUsageResponse,
  fetchCursorCurrentPeriodUsage,
  findCursorAuthToken,
  getLiveCursorUsageLimits,
  makeCursorUsageLimits,
  makeCursorUsageLimitsUpdate,
} from "./cursorUsageLimits.ts";

describe("cursorUsageLimits", () => {
  it("findCursorAuthToken extracts token from environment variables", () => {
    expect(findCursorAuthToken({ CURSOR_AUTH_TOKEN: "test_token_123" })).toBe("test_token_123");
    expect(findCursorAuthToken({ CURSOR_AGENT_AUTH_TOKEN: "agent_tok_456" })).toBe("agent_tok_456");
    expect(findCursorAuthToken({ CURSOR_API_KEY: "key_789" })).toBe("key_789");
    expect(findCursorAuthToken({ CURSOR_TOKEN: "tok_abc" })).toBe("tok_abc");
    expect(findCursorAuthToken({ CURSOR_AUTH_TOKEN: "  trimmed  " })).toBe("trimmed");

    const nonExistentEnv = {
      APPDATA: "Z:\\nonexistent",
      LOCALAPPDATA: "Z:\\nonexistent",
      XDG_CONFIG_HOME: "Z:\\nonexistent",
      HOME: "Z:\\nonexistent",
      USERPROFILE: "Z:\\nonexistent",
    };
    expect(findCursorAuthToken({ ...nonExistentEnv, CURSOR_AUTH_TOKEN: "" })).toBeNull();
    expect(findCursorAuthToken(nonExistentEnv)).toBeNull();
  });

  it("fetchCursorCurrentPeriodUsage uses Connect-RPC headers and protocol", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    const mockFetch = (async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedMethod = init?.method || "";
      capturedHeaders = init?.headers || {};
      capturedBody = init?.body || "";

      return {
        ok: true,
        json: async () => ({
          billingCycleStart: "1789245529000",
          billingCycleEnd: "1791837529000",
          planUsage: {
            totalSpend: 2145,
            includedSpend: 2000,
            limit: 2000,
            totalPercentUsed: 23.83,
            autoPercentUsed: 47.67,
          },
        }),
      } as any;
    }) as typeof fetch;

    const result = await fetchCursorCurrentPeriodUsage("secret_cursor_jwt", {
      fetchImpl: mockFetch,
    });

    expect(capturedUrl).toBe(CURSOR_DEFAULT_ENDPOINT);
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders.Authorization).toBe("Bearer secret_cursor_jwt");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    expect(capturedHeaders["Connect-Protocol-Version"]).toBe("1");
    expect(capturedBody).toBe("{}");
    expect(result).toBeDefined();
    expect(result?.planUsage?.autoPercentUsed).toBe(47.67);
  });

  it("produces separate Cursor Models and Other Models windows matching Cursor dashboard", () => {
    const mockQuota: CursorCurrentPeriodUsageResponse = {
      billingCycleStart: "1789245529000",
      billingCycleEnd: "1791837529000",
      planUsage: {
        totalSpend: 2145,
        includedSpend: 2000,
        bonusSpend: 145,
        limit: 2000,
        totalPercentUsed: 23.83,
        autoPercentUsed: 47.67,
        apiPercentUsed: 0,
      },
      spendLimitUsage: {
        limitType: "user",
      },
      displayMessage: "You've used 24% of your included total usage",
    };

    const limits = makeCursorUsageLimits({
      quota: mockQuota,
      checkedAt: "2026-09-16T20:00:00.000Z",
    });

    // When distinct model buckets are present and no on-demand limit is set, exactly 2 windows are created
    expect(limits.windows).toHaveLength(2);

    const cursorModelsWindow = limits.windows.find((w) => w.id === CURSOR_WINDOW_IDS.CURSOR_MODELS);
    expect(cursorModelsWindow).toBeDefined();
    expect(cursorModelsWindow?.kind).toBe("monthly");
    expect(cursorModelsWindow?.label).toBe("Cursor Models");
    expect(cursorModelsWindow?.usedPercent).toBeCloseTo(47.67, 1);
    expect(cursorModelsWindow?.resetsAt).toBe("2026-10-12T20:38:49.000Z");
    expect(cursorModelsWindow?.windowDurationMins).toBe(43200);

    const otherModelsWindow = limits.windows.find((w) => w.id === CURSOR_WINDOW_IDS.OTHER_MODELS);
    expect(otherModelsWindow).toBeDefined();
    expect(otherModelsWindow?.kind).toBe("monthly");
    expect(otherModelsWindow?.label).toBe("Other Models");
    expect(otherModelsWindow?.usedPercent).toBe(0);

    // No on-demand window when spendLimit is undefined
    const onDemandWindow = limits.windows.find((w) => w.id === CURSOR_WINDOW_IDS.ON_DEMAND);
    expect(onDemandWindow).toBeUndefined();
  });

  it("falls back to totalPercentUsed for single Included in Pro window when model buckets omitted", () => {
    const mockQuota: CursorCurrentPeriodUsageResponse = {
      billingCycleStart: "1789245529000",
      billingCycleEnd: "1791837529000",
      planUsage: {
        totalSpend: 1500,
        includedSpend: 1500,
        limit: 2000,
        totalPercentUsed: 75.0,
      },
      spendLimitUsage: {
        limitType: "user",
      },
    };

    const limits = makeCursorUsageLimits({
      quota: mockQuota,
      checkedAt: "2026-09-16T20:00:00.000Z",
    });

    expect(limits.windows).toHaveLength(1);
    const proWindow = limits.windows.find((w) => w.id === CURSOR_WINDOW_IDS.PRO_INCLUDED);
    expect(proWindow?.label).toBe("Included in Pro");
    expect(proWindow?.usedPercent).toBe(75);
  });

  it("falls back to remaining / limit when percentage fields are omitted", () => {
    const mockQuota: CursorCurrentPeriodUsageResponse = {
      billingCycleStart: "1789245529000",
      billingCycleEnd: "1791837529000",
      planUsage: {
        includedSpend: 1800,
        remaining: 200,
        limit: 2000,
      },
      spendLimitUsage: {
        limitType: "user",
      },
    };

    const limits = makeCursorUsageLimits({
      quota: mockQuota,
      checkedAt: "2026-09-16T20:00:00.000Z",
    });

    const proWindow = limits.windows.find((w) => w.id === CURSOR_WINDOW_IDS.PRO_INCLUDED);
    // (2000 - 200) / 2000 = 90%
    expect(proWindow?.usedPercent).toBe(90);
  });

  it("calculates on-demand percentage correctly when spendLimitUsage has limits", () => {
    const mockQuota: CursorCurrentPeriodUsageResponse = {
      billingCycleStart: "1789245529000",
      billingCycleEnd: "1791837529000",
      planUsage: {
        includedSpend: 2000,
        limit: 2000,
        totalPercentUsed: 100,
      },
      spendLimitUsage: {
        totalSpend: 2500, // $25
        spendLimit: 5000, // $50 limit -> 50%
      },
    };

    const limits = makeCursorUsageLimits({
      quota: mockQuota,
      checkedAt: "2026-09-16T20:00:00.000Z",
    });

    const onDemandWindow = limits.windows.find((w) => w.id === CURSOR_WINDOW_IDS.ON_DEMAND);
    expect(onDemandWindow).toBeDefined();
    expect(onDemandWindow?.usedPercent).toBe(50);
  });

  it("handles legacy flat quota fields as fallback", () => {
    const mockQuota: CursorCurrentPeriodUsageResponse = {
      standardCreditLimit: 20,
      includedSpend: 10,
      totalSpend: 10,
      billingCycleStart: "2026-04-01T00:00:00.000Z",
      billingCycleEnd: "2026-05-01T00:00:00.000Z",
    };

    const limits = makeCursorUsageLimits({
      quota: mockQuota,
      checkedAt: "2026-04-15T00:00:00.000Z",
    });

    expect(limits.windows).toHaveLength(1);
    const proWindow = limits.windows.find((w) => w.id === CURSOR_WINDOW_IDS.PRO_INCLUDED);
    expect(proWindow?.usedPercent).toBe(50);
    expect(proWindow?.resetsAt).toBe("2026-05-01T00:00:00.000Z");
  });

  it("omits on-demand window when no limit set and limit is not configured", () => {
    const mockQuota: CursorCurrentPeriodUsageResponse = {
      standardCreditLimit: 20,
      includedSpend: 5,
      totalSpend: 5,
      limitType: "user",
      billingCycleStart: "2026-04-01T00:00:00.000Z",
      billingCycleEnd: "2026-05-01T00:00:00.000Z",
    };

    const limits = makeCursorUsageLimits({
      quota: mockQuota,
      checkedAt: "2026-04-15T00:00:00.000Z",
    });

    const onDemandWindow = limits.windows.find((w) => w.id === CURSOR_WINDOW_IDS.ON_DEMAND);
    expect(onDemandWindow).toBeUndefined();
  });

  it("handles null quota gracefully with unavailable limits", () => {
    const limits = makeCursorUsageLimits({
      quota: null,
      checkedAt: "2026-04-15T00:00:00.000Z",
    });

    expect(limits.windows).toHaveLength(0);
    expect(limits.unavailable?.reason).toBe("unsupported");
    expect(limits.unavailable?.message).toBe("Cursor usage limits unavailable.");
  });

  it("makeCursorUsageLimitsUpdate maps windows directly from quota", () => {
    const mockQuota: CursorCurrentPeriodUsageResponse = {
      planUsage: {
        autoPercentUsed: 48,
        apiPercentUsed: 0,
      },
    };

    const update = makeCursorUsageLimitsUpdate({ quota: mockQuota });
    expect(update.windows).toHaveLength(2);
    expect(update.windows[0]?.label).toBe("Cursor Models");
    expect(update.windows[0]?.usedPercent).toBe(48);
    expect(update.windows[1]?.label).toBe("Other Models");
    expect(update.windows[1]?.usedPercent).toBe(0);
  });

  it("caches live quota response for 60 seconds", async () => {
    clearCursorUsageLimitsCache();

    let fetchCount = 0;
    const mockFetch = (async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => ({
          planUsage: {
            autoPercentUsed: 47.67,
            apiPercentUsed: 0,
          },
        }),
      } as any;
    }) as typeof fetch;

    const env = { CURSOR_AUTH_TOKEN: "cache_test_token" };

    const first = await getLiveCursorUsageLimits({
      environment: env,
      fetchImpl: mockFetch,
    });
    expect(fetchCount).toBe(1);
    expect(first.windows[0]?.usedPercent).toBeCloseTo(47.67, 1);

    // Immediate second call should hit memory cache
    const second = await getLiveCursorUsageLimits({
      environment: env,
      fetchImpl: mockFetch,
    });
    expect(fetchCount).toBe(1);
    expect(second.windows[0]?.usedPercent).toBeCloseTo(47.67, 1);

    // Force refresh bypasses cache
    const third = await getLiveCursorUsageLimits({
      environment: env,
      fetchImpl: mockFetch,
      forceRefresh: true,
    });
    expect(fetchCount).toBe(2);
    expect(third.windows[0]?.usedPercent).toBeCloseTo(47.67, 1);

    clearCursorUsageLimitsCache();
  });
});
