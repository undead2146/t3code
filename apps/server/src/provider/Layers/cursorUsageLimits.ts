// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off
/**
 * Cursor subscription quota and on-demand usage tracking.
 *
 * Connect-RPC endpoint:
 * POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
 *
 * Headers:
 * - Authorization: Bearer <accessToken>
 * - Content-Type: application/json
 * - Connect-Protocol-Version: 1
 *
 * Two windows are tracked:
 * 1. "Included in Pro" (id: "cursor_pro_included", kind: "monthly")
 * 2. "On-Demand" (id: "cursor_on_demand", kind: "other")
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

export interface CursorPeriodUsageDetails {
  readonly startOfMonth?: string;
  readonly numRequests?: number;
  readonly numRequestsTotal?: number;
  readonly numTokens?: number;
  readonly maxRequestUsage?: number;
  readonly maxTokenUsage?: number;
}

export interface CursorCurrentPeriodUsageResponse {
  readonly startOfMonth?: string;
  readonly endOfMonth?: string;
  readonly billingCycleStart?: string;
  readonly billingCycleEnd?: string;
  readonly userEmail?: string;
  readonly membershipType?: string;
  readonly limitType?: string;
  readonly isUnlimited?: boolean;
  readonly individualLimit?: number;
  readonly pooledLimit?: number;
  readonly overallLimit?: number;
  readonly hardLimit?: number;
  readonly warningLimit?: number;
  readonly totalSpend?: number;
  readonly includedSpend?: number;
  readonly standardCreditLimit?: number;
  readonly fastCreditLimit?: number;
  readonly regularUsage?: CursorPeriodUsageDetails;
}

export const CURSOR_WINDOW_IDS = {
  PRO_INCLUDED: "cursor_pro_included",
  ON_DEMAND: "cursor_on_demand",
} as const;

export const CURSOR_DEFAULT_ENDPOINT =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

const CACHE_TTL_MS = 60_000;

interface CachedQuota {
  readonly fetchedAt: number;
  readonly data: CursorCurrentPeriodUsageResponse;
}

let inMemoryLiveQuotaCache: CachedQuota | null = null;

export function clearCursorUsageLimitsCache(): void {
  inMemoryLiveQuotaCache = null;
}

/**
 * Resolves the Cursor auth access token from environment or local auth.json storage.
 */
export function findCursorAuthToken(env?: NodeJS.ProcessEnv): string | null {
  const envToken =
    env?.CURSOR_AUTH_TOKEN ||
    env?.CURSOR_AGENT_AUTH_TOKEN ||
    process.env.CURSOR_AUTH_TOKEN ||
    process.env.CURSOR_AGENT_AUTH_TOKEN;
  if (envToken && envToken.trim()) {
    return envToken.trim();
  }

  const homedir = NodeOS.homedir();
  const candidatePaths: string[] = [];

  if (process.platform === "win32") {
    const appData = env?.APPDATA || process.env.APPDATA;
    if (appData) {
      candidatePaths.push(NodePath.join(appData, "Cursor", "auth.json"));
    }
    candidatePaths.push(NodePath.join(homedir, "AppData", "Roaming", "Cursor", "auth.json"));
  } else if (process.platform === "darwin") {
    candidatePaths.push(NodePath.join(homedir, ".cursor", "auth.json"));
    candidatePaths.push(
      NodePath.join(homedir, "Library", "Application Support", "Cursor", "auth.json"),
    );
  } else {
    const xdgConfig = env?.XDG_CONFIG_HOME || process.env.XDG_CONFIG_HOME;
    if (xdgConfig) {
      candidatePaths.push(NodePath.join(xdgConfig, "cursor", "auth.json"));
    }
    candidatePaths.push(NodePath.join(homedir, ".config", "cursor", "auth.json"));
    candidatePaths.push(NodePath.join(homedir, ".cursor", "auth.json"));
  }

  for (const p of candidatePaths) {
    try {
      if (NodeFS.existsSync(p)) {
        const raw = NodeFS.readFileSync(p, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed?.accessToken === "string" && parsed.accessToken.trim()) {
          return parsed.accessToken.trim();
        }
      }
    } catch {
      // Continue to next candidate
    }
  }

  return null;
}

/**
 * Calls Cursor's DashboardService.GetCurrentPeriodUsage over Connect-RPC.
 */
export async function fetchCursorCurrentPeriodUsage(
  token: string,
  options?: {
    readonly endpoint?: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: typeof fetch;
  },
): Promise<CursorCurrentPeriodUsageResponse | null> {
  const endpoint = options?.endpoint ?? CURSOR_DEFAULT_ENDPOINT;
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const fetcher = options?.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as CursorCurrentPeriodUsageResponse;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Computes ServerProviderUsageLimits from Cursor CurrentPeriodUsageResponse.
 */
export function makeCursorUsageLimits(input: {
  readonly quota: CursorCurrentPeriodUsageResponse | null;
  readonly checkedAt?: string;
}): ServerProviderUsageLimits {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const quota = input.quota;

  if (!quota) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "Cursor usage limits unavailable.",
    });
  }

  const windows: ServerProviderUsageWindow[] = [];

  const resetsAt = quota.billingCycleEnd ?? quota.endOfMonth;
  let windowDurationMins: number | undefined;
  const cycleStart = quota.billingCycleStart ?? quota.startOfMonth;
  if (cycleStart && resetsAt) {
    const startMs = Date.parse(cycleStart);
    const endMs = Date.parse(resetsAt);
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs) {
      windowDurationMins = Math.round((endMs - startMs) / (60 * 1000));
    }
  }

  // 1. "Included in Pro" window
  const includedSpend = quota.includedSpend ?? 0;
  const standardLimit = quota.standardCreditLimit ?? 20;
  const proUsedPercent =
    standardLimit > 0 ? clampPercent((includedSpend / standardLimit) * 100) : 0;

  windows.push({
    id: CURSOR_WINDOW_IDS.PRO_INCLUDED,
    kind: "monthly",
    label: "Included in Pro",
    usedPercent: proUsedPercent,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins ? { windowDurationMins } : {}),
  });

  // 2. "On-Demand" usage window
  const totalSpend = quota.totalSpend ?? 0;
  const onDemandSpend = Math.max(0, totalSpend - includedSpend);
  const onDemandLimit = quota.individualLimit ?? quota.overallLimit ?? quota.pooledLimit;

  let onDemandUsedPercent = 0;
  if (onDemandLimit !== undefined && onDemandLimit > 0) {
    onDemandUsedPercent = clampPercent((onDemandSpend / onDemandLimit) * 100);
  } else if (onDemandSpend > 0) {
    onDemandUsedPercent = 100;
  } else {
    onDemandUsedPercent = 0;
  }

  windows.push({
    id: CURSOR_WINDOW_IDS.ON_DEMAND,
    kind: "other",
    label: "On-Demand",
    usedPercent: onDemandUsedPercent,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins ? { windowDurationMins } : {}),
  });

  return makeUsageLimits({
    checkedAt,
    windows,
  });
}

/**
 * Live quota retrieval with 60-second TTL caching.
 */
export async function getLiveCursorUsageLimits(input?: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly checkedAt?: string;
  readonly forceRefresh?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
}): Promise<ServerProviderUsageLimits> {
  const checkedAt = input?.checkedAt ?? new Date().toISOString();
  const now = Date.now();

  if (!input?.forceRefresh && inMemoryLiveQuotaCache) {
    if (now - inMemoryLiveQuotaCache.fetchedAt < CACHE_TTL_MS) {
      return makeCursorUsageLimits({
        quota: inMemoryLiveQuotaCache.data,
        checkedAt,
      });
    }
  }

  const token = findCursorAuthToken(input?.environment);
  if (!token) {
    if (inMemoryLiveQuotaCache) {
      return makeCursorUsageLimits({
        quota: inMemoryLiveQuotaCache.data,
        checkedAt,
      });
    }
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Cursor auth token not found.",
    });
  }

  const quota = await fetchCursorCurrentPeriodUsage(token, {
    ...(input?.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input?.endpoint ? { endpoint: input.endpoint } : {}),
  });

  if (quota) {
    inMemoryLiveQuotaCache = {
      fetchedAt: now,
      data: quota,
    };
    return makeCursorUsageLimits({
      quota,
      checkedAt,
    });
  }

  if (inMemoryLiveQuotaCache) {
    return makeCursorUsageLimits({
      quota: inMemoryLiveQuotaCache.data,
      checkedAt,
    });
  }

  return makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Failed to fetch Cursor usage limits.",
  });
}

export function makeCursorUsageLimitsUpdate(input: {
  readonly quota: CursorCurrentPeriodUsageResponse | null;
  readonly checkedAt?: string;
}): ProviderUsageLimitsUpdate {
  const limits = makeCursorUsageLimits({
    quota: input.quota,
    ...(input.checkedAt ? { checkedAt: input.checkedAt } : {}),
  });
  return {
    windows: limits.windows,
  };
}

export async function getLiveCursorUsageLimitsUpdate(input?: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly forceRefresh?: boolean;
}): Promise<ProviderUsageLimitsUpdate | null> {
  const limits = await getLiveCursorUsageLimits({
    ...(input?.environment ? { environment: input.environment } : {}),
    ...(input?.forceRefresh !== undefined ? { forceRefresh: input.forceRefresh } : {}),
  });
  if (!limits || limits.windows.length === 0) return null;
  return {
    windows: limits.windows,
  };
}
