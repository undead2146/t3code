// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off globalRandom:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  clearCursorUsageLimitsCache,
  CURSOR_WINDOW_IDS,
  fetchCursorCurrentPeriodUsage,
  findCursorAuthToken,
  getLiveCursorUsageLimits,
  makeCursorUsageLimits,
  makeCursorUsageLimitsUpdate,
  type CursorCurrentPeriodUsageResponse,
} from "./cursorUsageLimits.ts";

describe("cursorUsageLimits", () => {
  const tempDir = NodePath.join(
    NodeOS.tmpdir(),
    `cursor-usage-test-${Math.random().toString(36).slice(2)}`,
  );

  beforeEach(() => {
    clearCursorUsageLimitsCache();
    NodeFS.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("resolves token from environment variable", () => {
    const token = findCursorAuthToken({
      CURSOR_AUTH_TOKEN: "test-env-token",
    } as NodeJS.ProcessEnv);
    expect(token).toBe("test-env-token");
  });

  it("resolves token from disk auth.json if env is not set", () => {
    const fakeAppData = NodePath.join(tempDir, "appdata");
    const cursorDir = NodePath.join(fakeAppData, "Cursor");
    NodeFS.mkdirSync(cursorDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(cursorDir, "auth.json"),
      JSON.stringify({ accessToken: "disk-access-token-xyz" }),
      "utf8",
    );

    const token = findCursorAuthToken({
      APPDATA: fakeAppData,
    } as NodeJS.ProcessEnv);

    if (process.platform === "win32") {
      expect(token).toBe("disk-access-token-xyz");
    } else {
      // On non-windows, pass mock XDG_CONFIG_HOME
      const fakeXdg = NodePath.join(tempDir, "xdg");
      const linuxCursorDir = NodePath.join(fakeXdg, "cursor");
      NodeFS.mkdirSync(linuxCursorDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(linuxCursorDir, "auth.json"),
        JSON.stringify({ accessToken: "disk-access-token-xyz" }),
        "utf8",
      );
      const linuxToken = findCursorAuthToken({
        XDG_CONFIG_HOME: fakeXdg,
      } as NodeJS.ProcessEnv);
      expect(linuxToken).toBe("disk-access-token-xyz");
    }
  });

  it("calculates Pro included percentage correctly from nested planUsage in cents", () => {
    const mockQuota: CursorCurrentPeriodUsageResponse = {
      billingCycleStart: "1789245529000",
      billingCycleEnd: "1791837529000",
      planUsage: {
        totalSpend: 1801,
        includedSpend: 1801,
        remaining: 199,
        limit: 2000,
        totalPercentUsed: 20.01,
      },
      spendLimitUsage: {
        limitType: "user",
      },
      displayMessage: "You've used 90% of your included usage",
    };

    const limits = makeCursorUsageLimits({
      quota: mockQuota,
      checkedAt: "2026-09-16T20:00:00.000Z",
    });

    expect(limits.windows).toHaveLength(2);
    const proWindow = limits.windows.find((w) => w.id === CURSOR_WINDOW_IDS.PRO_INCLUDED);
    expect(proWindow).toBeDefined();
    expect(proWindow?.kind).toBe("monthly");
    expect(proWindow?.label).toBe("Included in Pro");
    // 1801 / 2000 = 0.9005 = 90.05%
    expect(proWindow?.usedPercent).toBeCloseTo(90.05, 1);
    expect(proWindow?.resetsAt).toBe("2026-10-12T20:38:49.000Z");
    expect(proWindow?.windowDurationMins).toBe(43200);

    const onDemandWindow = limits.windows.find((w) => w.id === CURSOR_WINDOW_IDS.ON_DEMAND);
    expect(onDemandWindow).toBeDefined();
    expect(onDemandWindow?.usedPercent).toBe(0);
  });

  it("calculates on-demand percentage correctly when spendLimitUsage has limits", () => {
    const mockQuota: CursorCurrentPeriodUsageResponse = {
      billingCycleStart: "1789245529000",
      billingCycleEnd: "1791837529000",
      planUsage: {
        includedSpend: 2000,
        limit: 2000,
      },
      spendLimitUsage: {
        totalSpend: 2500, // $25
        individualLimit: 5000, // $50 limit -> 50%
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

    expect(limits.windows).toHaveLength(2);
    const proWindow = limits.windows.find((w) => w.id === CURSOR_WINDOW_IDS.PRO_INCLUDED);
    expect(proWindow?.usedPercent).toBe(50);
    expect(proWindow?.resetsAt).toBe("2026-05-01T00:00:00.000Z");
  });

  it("sets on-demand to 0% when no limit set and 0 spend", () => {
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
    expect(onDemandWindow?.usedPercent).toBe(0);
  });

  it("handles null quota gracefully with unavailable limits", () => {
    const limits = makeCursorUsageLimits({
      quota: null,
      checkedAt: "2026-04-15T00:00:00.000Z",
    });

    expect(limits.windows).toHaveLength(0);
    expect(limits.unavailable?.reason).toBe("unsupported");
  });

  it("calls Connect-RPC endpoint with proper headers and payload", async () => {
    let capturedUrl = "";
    let capturedHeaders: unknown;
    let capturedBody = "";

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedHeaders = init?.headers;
      capturedBody = (init?.body as string) ?? "";
      return new Response(
        JSON.stringify({
          membershipType: "pro",
          planUsage: {
            includedSpend: 1801,
            limit: 2000,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const data = await fetchCursorCurrentPeriodUsage("token_secret", {
      fetchImpl: mockFetch,
    });

    expect(capturedUrl).toBe(
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    );
    expect((capturedHeaders as Record<string, string>)["Authorization"]).toBe(
      "Bearer token_secret",
    );
    expect((capturedHeaders as Record<string, string>)["Connect-Protocol-Version"]).toBe("1");
    expect(capturedBody).toBe(JSON.stringify({}));
    expect(data?.planUsage?.includedSpend).toBe(1801);
  });

  it("caches live limits for 60 seconds", async () => {
    let callCount = 0;
    const mockFetch = (async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          planUsage: {
            limit: 2000,
            includedSpend: 1000,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const env = { CURSOR_AUTH_TOKEN: "mock-token" } as NodeJS.ProcessEnv;
    const first = await getLiveCursorUsageLimits({
      environment: env,
      fetchImpl: mockFetch,
    });
    expect(callCount).toBe(1);
    expect(first.windows[0]?.usedPercent).toBe(50);

    const second = await getLiveCursorUsageLimits({
      environment: env,
      fetchImpl: mockFetch,
    });
    expect(callCount).toBe(1); // Cached!

    const third = await getLiveCursorUsageLimits({
      environment: env,
      fetchImpl: mockFetch,
      forceRefresh: true,
    });
    expect(callCount).toBe(2); // Bypassed cache
  });

  it("creates update payload with makeCursorUsageLimitsUpdate", () => {
    const directUpdate = makeCursorUsageLimitsUpdate({
      quota: {
        planUsage: {
          limit: 2000,
          includedSpend: 1200,
        },
      },
    });
    expect(directUpdate.windows).toHaveLength(2);
    expect(directUpdate.windows[0]?.usedPercent).toBe(60);
  });
});
