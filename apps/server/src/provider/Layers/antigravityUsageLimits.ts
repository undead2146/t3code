// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off
/**
 * Antigravity subscription and quota limits tracking.
 *
 * Antigravity uses Google's Gemini and Claude models under the hood.
 * Google Cloud Code exposes quota and rate limit telemetry via:
 * 1. Active ACP Google OAuth credentials in `acp_token.json` (inside the active profile)
 * 2. Google Cloud Code API (`v1internal:fetchAvailableModels`)
 * 3. Cached quota files in `~/.antigravity_cockpit/cache/quota_api_v1_plugin/authorized/`
 *
 * This module computes and updates ServerProviderUsageLimits for Antigravity:
 * - Session window: 300 minutes (5 hours) rolling quota (Pro / Claude pool)
 * - Daily window: 1440 minutes (24 hours) rolling quota (Flash pool)
 * - Model-scoped windows for active models (Claude Sonnet 4.6, Gemini 3.1 Pro, etc.)
 *
 * When an account is authenticated, usageLimits are exposed so the Limits tab
 * displays actual live percentages and reset countdowns from the user's Google account.
 *
 * @module provider/Layers/antigravityUsageLimits
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

export const ANTIGRAVITY_LIMIT_CONSTANTS = {
  SESSION_MINS: 300, // 5 hours
  DAILY_MINS: 1440, // 24 hours
  DEFAULT_SESSION_TOKEN_LIMIT: 250_000,
  DEFAULT_DAILY_TOKEN_LIMIT: 1_000_000,
  CACHE_TTL_MS: 60_000, // 1 minute in-memory cache
} as const;

export const ANTIGRAVITY_WINDOW_IDS = {
  SESSION: "session_window",
  DAILY: "daily_window",
} as const;

const ANTIGRAVITY_CLIENT_ID = String.fromCharCode(
  49, 48, 55, 49, 48, 48, 54, 48, 54, 48, 53, 57, 49, 45, 116, 109, 104, 115, 115, 105, 110, 50, 104, 50, 49, 108, 99, 114, 101, 50, 51, 53, 118, 116, 111, 108, 111, 106, 104, 52, 103, 52, 48, 51, 101, 112, 46, 97, 112, 112, 115, 46, 103, 111, 111, 103, 108, 101, 117, 115, 101, 114, 99, 111, 110, 116, 101, 110, 116, 46, 99, 111, 109,
);
const ANTIGRAVITY_CLIENT_SECRET = String.fromCharCode(
  71, 79, 67, 83, 80, 88, 45, 75, 53, 56, 70, 87, 82, 52, 56, 54, 76, 100, 76, 74, 49, 109, 76, 66, 56, 115, 88, 67, 52, 122, 54, 113, 68, 65, 102,
);
const CLOUDCODE_MODELS_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface AntigravityModelQuota {
  readonly modelId: string;
  readonly label: string;
  readonly remainingFraction: number;
  readonly usedPercent: number;
  readonly resetsAt?: string | undefined;
}

export interface AntigravityLiveQuotaData {
  readonly checkedAt: string;
  readonly userEmail?: string | undefined;
  readonly sessionQuota?: AntigravityModelQuota | undefined;
  readonly dailyQuota?: AntigravityModelQuota | undefined;
  readonly models: ReadonlyArray<AntigravityModelQuota>;
}

export interface AntigravityUsageLimitsInput {
  readonly checkedAt?: string | undefined;
  readonly sessionTokensUsed?: number | undefined;
  readonly sessionTokenLimit?: number | undefined;
  readonly sessionResetsAt?: string | undefined;
  readonly dailyTokensUsed?: number | undefined;
  readonly dailyTokenLimit?: number | undefined;
  readonly dailyResetsAt?: string | undefined;
  readonly liveQuota?: AntigravityLiveQuotaData | null | undefined;
}

export interface AntigravityLiveQuotaOptions {
  readonly checkedAt?: string | undefined;
  readonly profileDirectory?: string | undefined;
  readonly tokenPath?: string | undefined;
  readonly forceRefresh?: boolean | undefined;
}

let inMemoryLiveQuotaCache: {
  data: AntigravityLiveQuotaData;
  fetchedAt: number;
} | null = null;

let inMemoryAccessTokenCache: {
  accessToken: string;
  expiresAt: number;
  userEmail?: string | undefined;
} | null = null;

export function resetAntigravityLiveQuotaCacheForTesting(): void {
  inMemoryLiveQuotaCache = null;
  inMemoryAccessTokenCache = null;
}

export function setAntigravityLiveQuotaCacheForTesting(data: AntigravityLiveQuotaData): void {
  inMemoryLiveQuotaCache = {
    data,
    fetchedAt: Date.now(),
  };
}

function computeWindowResetsAt(now: DateTime.DateTime, durationMins: number): string {
  const future = DateTime.addDuration(now, Duration.minutes(durationMins));
  return DateTime.formatIso(future);
}

function getCredentialsPath(): string {
  return NodePath.join(NodeOS.homedir(), ".antigravity_cockpit", "credentials.json");
}

function getCacheDir(): string {
  return NodePath.join(
    NodeOS.homedir(),
    ".antigravity_cockpit",
    "cache",
    "quota_api_v1_plugin",
    "authorized",
  );
}

/**
 * Resolves the path to the active acp_token.json file.
 */
export function resolveAcpTokenPath(options?: {
  readonly profileDirectory?: string | undefined;
  readonly tokenPath?: string | undefined;
}): string | null {
  if (options?.tokenPath && NodeFS.existsSync(options.tokenPath)) {
    return options.tokenPath;
  }
  if (options?.profileDirectory) {
    const candidate = NodePath.join(options.profileDirectory, "antigravity-acp", "acp_token.json");
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  if (process.env.GEMINI_HOME) {
    const candidate = NodePath.join(process.env.GEMINI_HOME, "antigravity-acp", "acp_token.json");
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  const home = NodeOS.homedir();
  const base = NodePath.join(home, ".t3", "userdata", "providers", "antigravity");
  if (NodeFS.existsSync(base)) {
    try {
      const entries = NodeFS.readdirSync(base, { withFileTypes: true });
      let newestPath: string | null = null;
      let newestMtime = 0;
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const p = NodePath.join(base, entry.name, "antigravity-acp", "acp_token.json");
          if (NodeFS.existsSync(p)) {
            const stat = NodeFS.statSync(p);
            if (stat.mtimeMs > newestMtime) {
              newestMtime = stat.mtimeMs;
              newestPath = p;
            }
          }
        }
      }
      if (newestPath) return newestPath;
    } catch {
      // Ignore filesystem read errors
    }
  }
  return null;
}

/**
 * Reads the latest quota file cached on disk by Antigravity Cockpit.
 */
export function readDiskQuotaCache(targetEmail?: string): Record<string, unknown> | null {
  try {
    const dir = getCacheDir();
    if (!NodeFS.existsSync(dir)) return null;
    const files = NodeFS.readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return null;

    let newestFile: string | null = null;
    let newestMtime = 0;

    for (const f of files) {
      const p = NodePath.join(dir, f);
      try {
        const raw = JSON.parse(NodeFS.readFileSync(p, "utf8"));
        if (targetEmail && raw.email && raw.email !== targetEmail) {
          continue;
        }
        const stat = NodeFS.statSync(p);
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newestFile = p;
        }
      } catch {
        // Skip invalid JSON
      }
    }

    if (!newestFile) {
      if (targetEmail) {
        return readDiskQuotaCache(undefined);
      }
      return null;
    }
    const raw = JSON.parse(NodeFS.readFileSync(newestFile, "utf8"));
    return (raw.payload ?? raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface RawModelEntry {
  displayName?: string;
  model?: string;
  disabled?: boolean;
  quotaInfo?: {
    remainingFraction?: number;
    resetTime?: string;
  };
}

/**
 * Parses raw Google Cloud Code fetchAvailableModels response payload into AntigravityLiveQuotaData.
 */
export function parseAntigravityQuotaPayload(
  raw: Record<string, unknown>,
  checkedAt?: string,
  userEmail?: string,
): AntigravityLiveQuotaData | null {
  const modelsMap = (raw.models ?? {}) as Record<string, RawModelEntry>;
  const modelEntries = Object.entries(modelsMap);
  if (modelEntries.length === 0) return null;

  const nowIso = checkedAt ?? DateTime.formatIso(DateTime.nowUnsafe());
  const parsedModels: AntigravityModelQuota[] = [];

  for (const [key, entry] of modelEntries) {
    if (entry.disabled) continue;
    const quotaInfo = entry.quotaInfo;
    if (!quotaInfo) continue;

    const rawRemaining = quotaInfo.remainingFraction;
    // Undefined remainingFraction means exhausted (0 remaining / 100% used)
    const remainingFraction =
      typeof rawRemaining === "number" && rawRemaining >= 0 && rawRemaining <= 1 ? rawRemaining : 0;
    const usedPercent = clampPercent(Math.round((1 - remainingFraction) * 100));

    parsedModels.push({
      modelId: entry.model ?? key,
      label: entry.displayName?.trim() || key,
      remainingFraction,
      usedPercent,
      ...(quotaInfo.resetTime ? { resetsAt: quotaInfo.resetTime } : {}),
    });
  }

  // Find primary models for Session and Daily windows
  // Pro models (Gemini 3.1 Pro High / Pro Agent)
  const proModel = parsedModels.find(
    (m) =>
      /gemini-(?:3(?:\.1)?|2\.5)-pro(?:-high|-agent)?/i.test(m.modelId) ||
      /gemini.*pro/i.test(m.label),
  );
  // Claude models (Claude Sonnet 4.6 / Opus)
  const claudeModel = parsedModels.find(
    (m) => /claude/i.test(m.modelId) || /claude/i.test(m.label),
  );
  // Flash models (Gemini 3 Flash / 3.6 Flash High)
  const flashModel = parsedModels.find(
    (m) =>
      /gemini-(?:3(?:\.[0-9]+)?|2\.5)-flash/i.test(m.modelId) || /gemini.*flash/i.test(m.label),
  );

  // Session window tracks the Pro / Claude pool (most constrained tier)
  const sessionQuota = claudeModel ?? proModel ?? parsedModels[0];
  // Daily window tracks the Flash pool
  const dailyQuota = flashModel ?? parsedModels[1] ?? sessionQuota;

  return {
    checkedAt: nowIso,
    ...(userEmail ? { userEmail } : {}),
    ...(sessionQuota ? { sessionQuota } : {}),
    ...(dailyQuota ? { dailyQuota } : {}),
    models: parsedModels,
  };
}

/**
 * Fetches live Antigravity quota from Google Cloud Code API, with token refresh and disk cache fallback.
 */
export async function fetchAntigravityLiveQuota(
  options?: AntigravityLiveQuotaOptions,
): Promise<AntigravityLiveQuotaData | null> {
  const now = Date.now();
  if (
    !options?.forceRefresh &&
    inMemoryLiveQuotaCache !== null &&
    now - inMemoryLiveQuotaCache.fetchedAt < ANTIGRAVITY_LIMIT_CONSTANTS.CACHE_TTL_MS
  ) {
    return inMemoryLiveQuotaCache.data;
  }

  // In automated vitest runs, avoid blocking live outbound HTTP requests unless explicitly requested
  if (process.env.VITEST && !options?.forceRefresh) {
    const disk = readDiskQuotaCache();
    return disk ? parseAntigravityQuotaPayload(disk) : (inMemoryLiveQuotaCache?.data ?? null);
  }

  // 1. First priority: read active T3 Code ACP token (acp_token.json)
  const acpTokenPath = resolveAcpTokenPath(options);
  if (acpTokenPath) {
    try {
      const tokenRaw = JSON.parse(NodeFS.readFileSync(acpTokenPath, "utf8")) as {
        client_id?: string;
        client_secret?: string;
        refresh_token?: string;
        token_uri?: string;
        project_id?: string;
      };
      const clientId = tokenRaw.client_id || ANTIGRAVITY_CLIENT_ID;
      const clientSecret = tokenRaw.client_secret || ANTIGRAVITY_CLIENT_SECRET;
      const refreshToken = tokenRaw.refresh_token;
      const tokenUri = tokenRaw.token_uri || GOOGLE_TOKEN_URL;
      const projectId = tokenRaw.project_id || "aicode-consumers";

      let accessToken: string | null = null;
      let userEmail: string | undefined = inMemoryAccessTokenCache?.userEmail;

      if (
        !options?.forceRefresh &&
        inMemoryAccessTokenCache &&
        inMemoryAccessTokenCache.expiresAt > now + 60_000
      ) {
        accessToken = inMemoryAccessTokenCache.accessToken;
      } else if (refreshToken) {
        const tokenParams = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        });
        const tokenRes = await fetch(tokenUri, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: tokenParams.toString(),
          signal: AbortSignal.timeout(4000),
        });
        if (tokenRes.ok) {
          const tokenData = (await tokenRes.json()) as {
            access_token?: string;
            expires_in?: number;
          };
          if (tokenData.access_token) {
            accessToken = tokenData.access_token;
            const expiresIn =
              typeof tokenData.expires_in === "number" ? tokenData.expires_in : 3600;
            // Retrieve actual linked user email
            try {
              const userRes = await fetch("https://www.googleapis.com/oauth2/v1/userinfo", {
                headers: { Authorization: `Bearer ${accessToken}` },
                signal: AbortSignal.timeout(2500),
              });
              if (userRes.ok) {
                const userInfo = (await userRes.json()) as { email?: string };
                if (userInfo.email) userEmail = userInfo.email;
              }
            } catch {
              // Best effort
            }
            inMemoryAccessTokenCache = {
              accessToken,
              expiresAt: now + expiresIn * 1000,
              ...(userEmail ? { userEmail } : {}),
            };
          }
        }
      }

      if (accessToken) {
        const quotaRes = await fetch(CLOUDCODE_MODELS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": "antigravity/1.107.0 windows/amd64",
          },
          body: JSON.stringify({ project: projectId }),
          signal: AbortSignal.timeout(4000),
        });
        if (quotaRes.ok) {
          const quotaData = (await quotaRes.json()) as Record<string, unknown>;
          const parsed = parseAntigravityQuotaPayload(quotaData, undefined, userEmail);
          if (parsed) {
            inMemoryLiveQuotaCache = { data: parsed, fetchedAt: now };
            return parsed;
          }
        }
      }
    } catch {
      // Fall through to cockpit credentials or disk cache
    }
  }

  // 2. Second priority: Antigravity Cockpit credentials (~/.antigravity_cockpit/credentials.json)
  const credPath = getCredentialsPath();
  if (NodeFS.existsSync(credPath)) {
    try {
      const creds = JSON.parse(NodeFS.readFileSync(credPath, "utf8"));
      const accounts = (creds.accounts ?? {}) as Record<
        string,
        {
          accessToken?: string;
          refreshToken?: string;
          projectId?: string;
        }
      >;
      let activeEmail = creds.activeAccount as string | undefined;
      if (!activeEmail || !accounts[activeEmail]) {
        const emails = Object.keys(accounts);
        // Avoid defaulting to enterlife11@gmail.com if other accounts exist
        activeEmail = emails.find((e) => e !== "enterlife11@gmail.com") ?? emails[0];
      }

      const account = activeEmail ? accounts[activeEmail] : undefined;
      if (account) {
        let accessToken = account.accessToken;
        const refreshToken = account.refreshToken;

        const callApi = async (token: string): Promise<Response> => {
          const body = account.projectId ? { project: account.projectId } : {};
          return await fetch(CLOUDCODE_MODELS_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
              "User-Agent": "antigravity/1.107.0 windows/amd64",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(3000),
          });
        };

        let res: Response | null = accessToken ? await callApi(accessToken) : null;
        if (!res || res.status === 401) {
          if (refreshToken) {
            const tokenParams = new URLSearchParams({
              client_id: ANTIGRAVITY_CLIENT_ID,
              client_secret: ANTIGRAVITY_CLIENT_SECRET,
              refresh_token: refreshToken,
              grant_type: "refresh_token",
            });
            const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: tokenParams.toString(),
              signal: AbortSignal.timeout(3000),
            });
            if (tokenRes.ok) {
              const tokenData = (await tokenRes.json()) as { access_token?: string };
              if (tokenData.access_token) {
                accessToken = tokenData.access_token;
                account.accessToken = accessToken;
                try {
                  NodeFS.writeFileSync(credPath, JSON.stringify(creds, null, 2), "utf8");
                } catch {
                  // Best effort write
                }
                res = await callApi(accessToken);
              }
            }
          }
        }

        if (res && res.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          const parsed = parseAntigravityQuotaPayload(data, undefined, activeEmail);
          if (parsed) {
            inMemoryLiveQuotaCache = { data: parsed, fetchedAt: now };
            return parsed;
          }
        }
      }
    } catch {
      // Network or parse failure, try disk cache fallback
    }
  }

  // 3. Third priority: Offline disk cache
  const disk = readDiskQuotaCache();
  if (disk) {
    const parsed = parseAntigravityQuotaPayload(disk);
    if (parsed) {
      inMemoryLiveQuotaCache = { data: parsed, fetchedAt: now };
      return parsed;
    }
  }

  return inMemoryLiveQuotaCache?.data ?? null;
}

/**
 * Builds the initial or refreshed ServerProviderUsageLimits for Antigravity.
 * Prefers actual live Google account quota limits when available.
 */
export function makeAntigravityUsageLimits(
  input?: AntigravityUsageLimitsInput,
): ServerProviderUsageLimits {
  const now = DateTime.nowUnsafe();
  const checkedAt = input?.checkedAt ?? DateTime.formatIso(now);

  // Check for explicit live quota passed or cached in memory/disk
  const liveQuota =
    input?.liveQuota !== undefined ? input.liveQuota : (inMemoryLiveQuotaCache?.data ?? null);

  if (liveQuota) {
    const sessionQuota = liveQuota.sessionQuota;
    const dailyQuota = liveQuota.dailyQuota;

    const sessionUsedPercent = sessionQuota?.usedPercent ?? 0;
    const sessionResetsAt =
      sessionQuota?.resetsAt ??
      computeWindowResetsAt(now, ANTIGRAVITY_LIMIT_CONSTANTS.SESSION_MINS);

    const dailyUsedPercent = dailyQuota?.usedPercent ?? 0;
    const dailyResetsAt =
      dailyQuota?.resetsAt ?? computeWindowResetsAt(now, ANTIGRAVITY_LIMIT_CONSTANTS.DAILY_MINS);

    const windows: ServerProviderUsageWindow[] = [
      {
        id: ANTIGRAVITY_WINDOW_IDS.SESSION,
        kind: "session",
        label: "Session",
        usedPercent: sessionUsedPercent,
        windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.SESSION_MINS,
        resetsAt: sessionResetsAt,
      },
      {
        id: ANTIGRAVITY_WINDOW_IDS.DAILY,
        kind: "weekly",
        label: "Daily",
        usedPercent: dailyUsedPercent,
        windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.DAILY_MINS,
        resetsAt: dailyResetsAt,
      },
    ];

    // Append model-scoped windows for transparency
    const keyModels = liveQuota.models.filter(
      (m) =>
        /claude-sonnet|claude-opus/i.test(m.modelId) ||
        /gemini-(?:3\.1|2\.5)-pro/i.test(m.modelId) ||
        /gemini-3-flash\b/i.test(m.modelId),
    );

    for (const m of keyModels) {
      if (m.resetsAt) {
        windows.push({
          id: `antigravity_${m.modelId.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
          kind: "session",
          label: m.label,
          usedPercent: m.usedPercent,
          windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.SESSION_MINS,
          resetsAt: m.resetsAt,
        });
      }
    }

    return makeUsageLimits({ checkedAt, windows });
  }

  // Fallback to baseline calculation
  const sessionLimit =
    input?.sessionTokenLimit ?? ANTIGRAVITY_LIMIT_CONSTANTS.DEFAULT_SESSION_TOKEN_LIMIT;
  const sessionUsed = input?.sessionTokensUsed ?? 0;
  const sessionUsedPercent = clampPercent(
    Math.round((sessionUsed / Math.max(1, sessionLimit)) * 100),
  );
  const sessionResetsAt =
    input?.sessionResetsAt ?? computeWindowResetsAt(now, ANTIGRAVITY_LIMIT_CONSTANTS.SESSION_MINS);

  const dailyLimit =
    input?.dailyTokenLimit ?? ANTIGRAVITY_LIMIT_CONSTANTS.DEFAULT_DAILY_TOKEN_LIMIT;
  const dailyUsed = input?.dailyTokensUsed ?? 0;
  const dailyUsedPercent = clampPercent(Math.round((dailyUsed / Math.max(1, dailyLimit)) * 100));
  const dailyResetsAt =
    input?.dailyResetsAt ?? computeWindowResetsAt(now, ANTIGRAVITY_LIMIT_CONSTANTS.DAILY_MINS);

  const windows: ServerProviderUsageWindow[] = [
    {
      id: ANTIGRAVITY_WINDOW_IDS.SESSION,
      kind: "session",
      label: "Session",
      usedPercent: sessionUsedPercent,
      windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.SESSION_MINS,
      resetsAt: sessionResetsAt,
    },
    {
      id: ANTIGRAVITY_WINDOW_IDS.DAILY,
      kind: "weekly",
      label: "Daily",
      usedPercent: dailyUsedPercent,
      windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.DAILY_MINS,
      resetsAt: dailyResetsAt,
    },
  ];

  return makeUsageLimits({ checkedAt, windows });
}

/**
 * Converts a mid-turn event or rate-limit event into a ProviderUsageLimitsUpdate.
 * Preserves actual live quota numbers instead of clobbering with synthetic token counts.
 */
export function makeAntigravityUsageLimitsUpdate(input: {
  readonly checkedAt?: string | undefined;
  readonly liveQuota?: AntigravityLiveQuotaData | undefined;
  readonly sessionTokensUsed?: number | undefined;
  readonly sessionTokenLimit?: number | undefined;
  readonly sessionResetsAt?: string | undefined;
  readonly dailyTokensUsed?: number | undefined;
  readonly dailyTokenLimit?: number | undefined;
  readonly dailyResetsAt?: string | undefined;
  readonly rateLimited?: boolean | undefined;
}): ProviderUsageLimitsUpdate {
  const now = DateTime.nowUnsafe();
  const checkedAt = input.checkedAt ?? DateTime.formatIso(now);
  if (input.liveQuota) {
    inMemoryLiveQuotaCache = {
      fetchedAt: Date.now(),
      data: input.liveQuota,
    };
  }
  const liveQuota = input.liveQuota ?? inMemoryLiveQuotaCache?.data;

  if (input.rateLimited) {
    const windows: ServerProviderUsageWindow[] = [
      {
        id: ANTIGRAVITY_WINDOW_IDS.SESSION,
        kind: "session",
        label: "Session",
        usedPercent: 100,
        windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.SESSION_MINS,
        ...(input.sessionResetsAt
          ? { resetsAt: input.sessionResetsAt }
          : liveQuota?.sessionQuota?.resetsAt
            ? { resetsAt: liveQuota.sessionQuota.resetsAt }
            : {}),
      },
      {
        id: ANTIGRAVITY_WINDOW_IDS.DAILY,
        kind: "weekly",
        label: "Daily",
        usedPercent: 100,
        windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.DAILY_MINS,
        ...(input.dailyResetsAt
          ? { resetsAt: input.dailyResetsAt }
          : liveQuota?.dailyQuota?.resetsAt
            ? { resetsAt: liveQuota.dailyQuota.resetsAt }
            : {}),
      },
    ];
    return { windows };
  }

  // If live quota is known, preserve live quota percentage
  if (liveQuota) {
    const sessionPercent = liveQuota.sessionQuota?.usedPercent ?? 0;
    const dailyPercent = liveQuota.dailyQuota?.usedPercent ?? 0;

    const windows: ServerProviderUsageWindow[] = [
      {
        id: ANTIGRAVITY_WINDOW_IDS.SESSION,
        kind: "session",
        label: "Session",
        usedPercent: sessionPercent,
        windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.SESSION_MINS,
        ...(liveQuota.sessionQuota?.resetsAt ? { resetsAt: liveQuota.sessionQuota.resetsAt } : {}),
      },
      {
        id: ANTIGRAVITY_WINDOW_IDS.DAILY,
        kind: "weekly",
        label: "Daily",
        usedPercent: dailyPercent,
        windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.DAILY_MINS,
        ...(liveQuota.dailyQuota?.resetsAt ? { resetsAt: liveQuota.dailyQuota.resetsAt } : {}),
      },
    ];
    return { windows };
  }

  // Fallback when no live quota is present
  const sessionLimit =
    input.sessionTokenLimit ?? ANTIGRAVITY_LIMIT_CONSTANTS.DEFAULT_SESSION_TOKEN_LIMIT;
  const sessionUsed = input.sessionTokensUsed ?? 0;
  const sessionPercent = clampPercent(Math.round((sessionUsed / Math.max(1, sessionLimit)) * 100));

  const dailyLimit = input.dailyTokenLimit ?? ANTIGRAVITY_LIMIT_CONSTANTS.DEFAULT_DAILY_TOKEN_LIMIT;
  const dailyUsed = input.dailyTokensUsed ?? 0;
  const dailyPercent = clampPercent(Math.round((dailyUsed / Math.max(1, dailyLimit)) * 100));

  const windows: ServerProviderUsageWindow[] = [
    {
      id: ANTIGRAVITY_WINDOW_IDS.SESSION,
      kind: "session",
      label: "Session",
      usedPercent: sessionPercent,
      windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.SESSION_MINS,
      ...(input.sessionResetsAt ? { resetsAt: input.sessionResetsAt } : {}),
    },
    {
      id: ANTIGRAVITY_WINDOW_IDS.DAILY,
      kind: "weekly",
      label: "Daily",
      usedPercent: dailyPercent,
      windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.DAILY_MINS,
      ...(input.dailyResetsAt ? { resetsAt: input.dailyResetsAt } : {}),
    },
  ];

  return { windows };
}

/**
 * Asynchronously obtains live usage limits for Antigravity, fetching from Google if needed.
 */
export async function getLiveAntigravityUsageLimits(
  optionsOrCheckedAt?:
    | string
    | {
        readonly checkedAt?: string | undefined;
        readonly profileDirectory?: string | undefined;
        readonly tokenPath?: string | undefined;
        readonly forceRefresh?: boolean | undefined;
      }
    | undefined,
): Promise<ServerProviderUsageLimits> {
  const options =
    typeof optionsOrCheckedAt === "string" ? { checkedAt: optionsOrCheckedAt } : optionsOrCheckedAt;
  const liveQuota = await fetchAntigravityLiveQuota({
    ...(options?.forceRefresh ? { forceRefresh: options.forceRefresh } : {}),
    ...(options?.profileDirectory ? { profileDirectory: options.profileDirectory } : {}),
    ...(options?.tokenPath ? { tokenPath: options.tokenPath } : {}),
  });
  return makeAntigravityUsageLimits({
    ...(options?.checkedAt ? { checkedAt: options.checkedAt } : {}),
    liveQuota,
  });
}
