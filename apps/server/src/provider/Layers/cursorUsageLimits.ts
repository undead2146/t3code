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
 * Windows tracked:
 * - "Cursor Models" (id: "cursor_models", kind: "monthly")
 * - "Other Models" (id: "cursor_other_models", kind: "monthly")
 * - "Included in Pro" (id: "cursor_pro_included", kind: "monthly") [fallback if single aggregate]
 * - "On-Demand" (id: "cursor_on_demand", kind: "other") [only if spendLimit configured]
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

export interface CursorPlanUsage {
  readonly totalSpend?: number;
  readonly includedSpend?: number;
  readonly bonusSpend?: number;
  readonly remaining?: number;
  readonly limit?: number;
  readonly remainingBonus?: boolean;
  readonly bonusTooltip?: string;
  readonly autoPercentUsed?: number;
  readonly apiPercentUsed?: number;
  readonly totalPercentUsed?: number;
}

export interface CursorSpendLimitUsage {
  readonly limitType?: string;
  readonly totalSpend?: number;
  readonly currentSpend?: number;
  readonly spendLimit?: number;
  readonly individualLimit?: number;
  readonly pooledLimit?: number;
}

export interface CursorCurrentPeriodUsageResponse {
  readonly startOfMonth?: string | number;
  readonly endOfMonth?: string | number;
  readonly billingCycleStart?: string | number;
  readonly billingCycleEnd?: string | number;
  readonly userEmail?: string;
  readonly membershipType?: string;
  readonly limitType?: string;
  readonly isUnlimited?: boolean;
  readonly displayMessage?: string;
  readonly enabled?: boolean;
  readonly planUsage?: CursorPlanUsage;
  readonly spendLimitUsage?: CursorSpendLimitUsage;
  // Fallbacks / legacy flat fields
  readonly totalSpend?: number;
  readonly includedSpend?: number;
  readonly remaining?: number;
  readonly limit?: number;
  readonly individualLimit?: number;
  readonly pooledLimit?: number;
  readonly overallLimit?: number;
  readonly hardLimit?: number;
  readonly warningLimit?: number;
  readonly standardCreditLimit?: number;
  readonly fastCreditLimit?: number;
  readonly regularUsage?: CursorPeriodUsageDetails;
}

export const CURSOR_WINDOW_IDS = {
  CURSOR_MODELS: "cursor_models",
  OTHER_MODELS: "cursor_other_models",
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
    env?.CURSOR_API_KEY ||
    env?.CURSOR_TOKEN;
  if (envToken?.trim()) {
    return envToken.trim();
  }

  // Check local Cursor auth storage:
  // Windows: %APPDATA%/Cursor/auth.json
  // macOS: ~/Library/Application Support/Cursor/auth.json
  // Linux: ~/.config/Cursor/auth.json
  const homeDir = NodeOS.homedir();
  const platform = process.platform;

  const candidatePaths: string[] = [];

  if (platform === "win32") {
    const appData = env?.APPDATA || NodePath.join(homeDir, "AppData", "Roaming");
    candidatePaths.push(NodePath.join(appData, "Cursor", "auth.json"));
  } else if (platform === "darwin") {
    candidatePaths.push(
      NodePath.join(homeDir, "Library", "Application Support", "Cursor", "auth.json"),
    );
  } else {
    const configDir = env?.XDG_CONFIG_HOME || NodePath.join(homeDir, ".config");
    candidatePaths.push(NodePath.join(configDir, "Cursor", "auth.json"));
  }

  // Also check ~/.cursor/auth.json as a fallback across platforms
  candidatePaths.push(NodePath.join(homeDir, ".cursor", "auth.json"));

  for (const filePath of candidatePaths) {
    try {
      if (NodeFS.existsSync(filePath)) {
        const raw = NodeFS.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        const token = parsed?.accessToken || parsed?.token || parsed?.auth_token || parsed?.apiKey;
        if (typeof token === "string" && token.trim()) {
          return token.trim();
        }
      }
    } catch {
      // Ignore read/parse errors and check next candidate
    }
  }

  return null;
}

/**
 * Queries the Cursor usage endpoint using Connect-RPC protocol.
 */
export async function fetchCursorCurrentPeriodUsage(
  accessToken: string,
  options?: {
    readonly fetchImpl?: typeof fetch;
    readonly endpoint?: string;
  },
): Promise<CursorCurrentPeriodUsageResponse | null> {
  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  const endpoint = options?.endpoint ?? CURSOR_DEFAULT_ENDPOINT;

  if (typeof fetchFn !== "function") {
    return null;
  }

  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as CursorCurrentPeriodUsageResponse;
    return data;
  } catch {
    return null;
  }
}

/**
 * Parses timestamp from string or number to milliseconds since epoch.
 */
function parseTimestampToMs(val: string | number | undefined): number | null {
  if (val === undefined || val === null) return null;
  if (typeof val === "number") {
    // If it's in seconds (e.g. 1789245529), convert to ms
    return val < 1e11 ? val * 1000 : val;
  }
  const str = val.trim();
  const num = Number(str);
  if (!Number.isNaN(num)) {
    return num < 1e11 ? num * 1000 : num;
  }
  const parsedDate = Date.parse(str);
  return Number.isNaN(parsedDate) ? null : parsedDate;
}

/**
 * Converts timestamp to ISO 8601 string.
 */
function parseTimestampToIso(val: string | number | undefined): string | undefined {
  const ms = parseTimestampToMs(val);
  if (ms === null || !Number.isFinite(ms)) return undefined;
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Transforms Cursor API quota response into T3 Code ServerProviderUsageLimits.
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

  const rawResetsAt = quota.billingCycleEnd ?? quota.endOfMonth;
  const resetsAt = parseTimestampToIso(rawResetsAt);

  let windowDurationMins: number | undefined;
  const rawCycleStart = quota.billingCycleStart ?? quota.startOfMonth;
  if (rawCycleStart && rawResetsAt) {
    const startMs = parseTimestampToMs(rawCycleStart);
    const endMs = parseTimestampToMs(rawResetsAt);
    if (startMs !== null && endMs !== null && endMs > startMs) {
      windowDurationMins = Math.round((endMs - startMs) / (60 * 1000));
    }
  }

  const planUsage = quota.planUsage;

  const hasDistinctModelBuckets =
    (typeof planUsage?.autoPercentUsed === "number" &&
      Number.isFinite(planUsage.autoPercentUsed)) ||
    (typeof planUsage?.apiPercentUsed === "number" && Number.isFinite(planUsage.apiPercentUsed));

  if (hasDistinctModelBuckets) {
    // 1. Cursor Models (Cursor Grok, Composer, auto models)
    if (
      typeof planUsage?.autoPercentUsed === "number" &&
      Number.isFinite(planUsage.autoPercentUsed)
    ) {
      windows.push({
        id: CURSOR_WINDOW_IDS.CURSOR_MODELS,
        kind: "monthly",
        label: "Cursor Models",
        usedPercent: clampPercent(planUsage.autoPercentUsed),
        ...(resetsAt ? { resetsAt } : {}),
        ...(windowDurationMins ? { windowDurationMins } : {}),
      });
    }

    // 2. Other Models (named models, API models)
    if (
      typeof planUsage?.apiPercentUsed === "number" &&
      Number.isFinite(planUsage.apiPercentUsed)
    ) {
      windows.push({
        id: CURSOR_WINDOW_IDS.OTHER_MODELS,
        kind: "monthly",
        label: "Other Models",
        usedPercent: clampPercent(planUsage.apiPercentUsed),
        ...(resetsAt ? { resetsAt } : {}),
        ...(windowDurationMins ? { windowDurationMins } : {}),
      });
    }
  } else {
    // Fallback: single "Included in Pro" window
    let proUsedPercent = 0;
    if (
      typeof planUsage?.totalPercentUsed === "number" &&
      Number.isFinite(planUsage.totalPercentUsed)
    ) {
      proUsedPercent = clampPercent(planUsage.totalPercentUsed);
    } else if (
      typeof planUsage?.remaining === "number" &&
      typeof planUsage?.limit === "number" &&
      planUsage.limit > 0
    ) {
      proUsedPercent = clampPercent(
        ((planUsage.limit - planUsage.remaining) / planUsage.limit) * 100,
      );
    } else {
      const includedSpend = planUsage?.includedSpend ?? quota.includedSpend ?? 0;
      const standardLimit =
        planUsage?.limit ??
        quota.standardCreditLimit ??
        (quota.limit !== undefined && quota.limit > 0 ? quota.limit : 2000);

      if (standardLimit > 0) {
        proUsedPercent = clampPercent((includedSpend / standardLimit) * 100);
      }
    }

    windows.push({
      id: CURSOR_WINDOW_IDS.PRO_INCLUDED,
      kind: "monthly",
      label: "Included in Pro",
      usedPercent: proUsedPercent,
      ...(resetsAt ? { resetsAt } : {}),
      ...(windowDurationMins ? { windowDurationMins } : {}),
    });
  }

  // 3. "On-Demand" usage window (only present if onDemandLimit is configured and > 0)
  const spendLimitUsage = quota.spendLimitUsage;
  const onDemandSpend =
    spendLimitUsage?.totalSpend ??
    spendLimitUsage?.currentSpend ??
    (quota.totalSpend !== undefined && quota.includedSpend !== undefined
      ? Math.max(0, quota.totalSpend - quota.includedSpend)
      : 0);

  const onDemandLimit =
    spendLimitUsage?.spendLimit ??
    spendLimitUsage?.individualLimit ??
    spendLimitUsage?.pooledLimit ??
    quota.individualLimit ??
    quota.overallLimit ??
    quota.pooledLimit;

  if (onDemandLimit !== undefined && onDemandLimit > 0) {
    const onDemandUsedPercent = clampPercent((onDemandSpend / onDemandLimit) * 100);
    windows.push({
      id: CURSOR_WINDOW_IDS.ON_DEMAND,
      kind: "other",
      label: "On-Demand",
      usedPercent: onDemandUsedPercent,
      ...(resetsAt ? { resetsAt } : {}),
      ...(windowDurationMins ? { windowDurationMins } : {}),
    });
  }

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
    ...(input?.forceRefresh ? { forceRefresh: input.forceRefresh } : {}),
  });
  if (limits.windows.length === 0) {
    return null;
  }
  return {
    windows: limits.windows,
  };
}
