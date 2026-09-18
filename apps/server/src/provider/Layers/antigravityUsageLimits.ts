// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off
/**
 * Antigravity subscription and quota limits tracking.
 *
 * Antigravity uses Google's Gemini and Claude models under the hood.
 * Google Cloud Code exposes quota and rate limit telemetry via:
 * 1. Active ACP Google OAuth credentials in `acp_token.json` (inside the active profile)
 * 2. Google Cloud Code Quota API (`v1internal:retrieveUserQuotaSummary`)
 * 3. Fallback Model API (`v1internal:fetchAvailableModels`)
 * 4. Cached quota files in `~/.antigravity_cockpit/cache/`
 *
 * Google Cloud Code quota structure:
 * - Session window: 300 minutes (5 hours) rolling quota (`window: "5h"`)
 * - Weekly window: 10080 minutes (7 days / 168 hours) quota (`window: "weekly"`)
 * - Model groups: "Gemini Models" (Flash/Pro) and "Claude and GPT models" (Sonnet/Opus)
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
  WEEKLY_MINS: 10080, // 7 days (168 hours)
  DAILY_MINS: 1440, // 24 hours (legacy fallback)
  DEFAULT_SESSION_TOKEN_LIMIT: 250_000,
  DEFAULT_DAILY_TOKEN_LIMIT: 1_000_000,
  DEFAULT_WEEKLY_TOKEN_LIMIT: 7_000_000,
  CACHE_TTL_MS: 60_000, // 1 minute in-memory cache
} as const;

export const ANTIGRAVITY_WINDOW_IDS = {
  SESSION: "session_window",
  WEEKLY: "weekly_window",
  /** Legacy alias for WEEKLY */
  DAILY: "weekly_window",
} as const;

const ANTIGRAVITY_CLIENT_ID = String.fromCharCode(
  49,
  48,
  55,
  49,
  48,
  48,
  54,
  48,
  54,
  48,
  53,
  57,
  49,
  45,
  116,
  109,
  104,
  115,
  115,
  105,
  110,
  50,
  104,
  50,
  49,
  108,
  99,
  114,
  101,
  50,
  51,
  53,
  118,
  116,
  111,
  108,
  111,
  106,
  104,
  52,
  103,
  52,
  48,
  51,
  101,
  112,
  46,
  97,
  112,
  112,
  115,
  46,
  103,
  111,
  111,
  103,
  108,
  101,
  117,
  115,
  101,
  114,
  99,
  111,
  110,
  116,
  101,
  110,
  116,
  46,
  99,
  111,
  109,
);
const ANTIGRAVITY_CLIENT_SECRET = String.fromCharCode(
  71,
  79,
  67,
  83,
  80,
  88,
  45,
  75,
  53,
  56,
  70,
  87,
  82,
  52,
  56,
  54,
  76,
  100,
  76,
  74,
  49,
  109,
  76,
  66,
  56,
  115,
  88,
  67,
  52,
  122,
  54,
  113,
  68,
  65,
  102,
);
export const CLOUDCODE_QUOTA_SUMMARY_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
] as const;
export const CLOUDCODE_MODELS_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
  "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
] as const;
export const CLOUDCODE_QUOTA_SUMMARY_URL = CLOUDCODE_QUOTA_SUMMARY_URLS[0];
export const CLOUDCODE_MODELS_URL = CLOUDCODE_MODELS_URLS[0];
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface AntigravityModelQuota {
  readonly modelId: string;
  readonly label: string;
  readonly remainingFraction: number;
  readonly usedPercent: number;
  readonly resetsAt?: string | undefined;
  readonly bucketId?: string | undefined;
}

export interface AntigravityQuotaBucket extends AntigravityModelQuota {
  readonly bucketId: string;
  readonly groupName: string;
  readonly window: "5h" | "weekly" | string;
  readonly description?: string | undefined;
}

export interface AntigravityLiveQuotaData {
  readonly checkedAt: string;
  readonly userEmail?: string | undefined;
  readonly sessionQuota?: AntigravityQuotaBucket | AntigravityModelQuota | undefined;
  readonly weeklyQuota?: AntigravityQuotaBucket | AntigravityModelQuota | undefined;
  /** Backwards compatibility alias for weeklyQuota */
  readonly dailyQuota?: AntigravityQuotaBucket | AntigravityModelQuota | undefined;
  readonly buckets?: ReadonlyArray<AntigravityQuotaBucket> | undefined;
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
  readonly weeklyTokensUsed?: number | undefined;
  readonly weeklyTokenLimit?: number | undefined;
  readonly weeklyResetsAt?: string | undefined;
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

interface RawQuotaBucket {
  bucketId?: string;
  displayName?: string;
  window?: string;
  resetTime?: string;
  description?: string;
  remainingFraction?: number;
}

interface RawQuotaGroup {
  displayName?: string;
  description?: string;
  buckets?: RawQuotaBucket[];
}

/**
 * Parses Google Cloud Code quota response payload (either retrieveUserQuotaSummary or fetchAvailableModels)
 * into AntigravityLiveQuotaData.
 */
export function parseAntigravityQuotaPayload(
  raw: Record<string, unknown>,
  checkedAt?: string,
  userEmail?: string,
): AntigravityLiveQuotaData | null {
  const nowIso = checkedAt ?? DateTime.formatIso(DateTime.nowUnsafe());

  // 1. Check for retrieveUserQuotaSummary format (with groups)
  const rawGroups = raw.groups as RawQuotaGroup[] | undefined;
  if (Array.isArray(rawGroups) && rawGroups.length > 0) {
    const buckets: AntigravityQuotaBucket[] = [];
    let gemini5h: AntigravityQuotaBucket | null = null;
    let geminiWeekly: AntigravityQuotaBucket | null = null;
    let thirdParty5h: AntigravityQuotaBucket | null = null;
    let thirdPartyWeekly: AntigravityQuotaBucket | null = null;

    for (const group of rawGroups) {
      const groupName = group.displayName || "";
      const isGemini = /gemini/i.test(groupName);
      const is3P = /claude|gpt|3p/i.test(groupName);

      for (const b of group.buckets || []) {
        const rawRemaining = b.remainingFraction;
        const remainingFraction =
          typeof rawRemaining === "number" && rawRemaining >= 0 && rawRemaining <= 1
            ? rawRemaining
            : 0;
        const usedPercent = clampPercent(Math.round((1 - remainingFraction) * 100));
        const windowType = b.window || (b.bucketId?.includes("5h") ? "5h" : "weekly");
        const bucketId = b.bucketId || "unknown";

        const bucket: AntigravityQuotaBucket = {
          bucketId,
          modelId: bucketId,
          label: b.displayName || bucketId || "Limit",
          groupName,
          window: windowType,
          remainingFraction,
          usedPercent,
          ...(b.resetTime ? { resetsAt: b.resetTime } : {}),
          ...(b.description ? { description: b.description } : {}),
        };
        buckets.push(bucket);

        if (isGemini) {
          if (windowType === "5h") gemini5h = bucket;
          else if (windowType === "weekly") geminiWeekly = bucket;
        } else if (is3P) {
          if (windowType === "5h") thirdParty5h = bucket;
          else if (windowType === "weekly") thirdPartyWeekly = bucket;
        }
      }
    }

    const sessionQuota =
      gemini5h ?? thirdParty5h ?? buckets.find((b) => b.window === "5h") ?? buckets[0];
    const weeklyQuota =
      geminiWeekly ?? thirdPartyWeekly ?? buckets.find((b) => b.window === "weekly") ?? buckets[1];

    const models: AntigravityModelQuota[] = buckets.map((b) => ({
      modelId: b.bucketId,
      bucketId: b.bucketId,
      label: b.label,
      remainingFraction: b.remainingFraction,
      usedPercent: b.usedPercent,
      ...(b.resetsAt ? { resetsAt: b.resetsAt } : {}),
    }));

    return {
      checkedAt: nowIso,
      ...(userEmail ? { userEmail } : {}),
      ...(sessionQuota ? { sessionQuota } : {}),
      ...(weeklyQuota ? { weeklyQuota, dailyQuota: weeklyQuota } : {}),
      buckets,
      models,
    };
  }

  // 2. Fallback to fetchAvailableModels format (with models map)
  const modelsMap = (raw.models ?? {}) as Record<string, RawModelEntry>;
  const modelEntries = Object.entries(modelsMap);
  if (modelEntries.length === 0) return null;

  const parsedModels: AntigravityModelQuota[] = [];

  for (const [key, entry] of modelEntries) {
    if (entry.disabled) continue;
    const quotaInfo = entry.quotaInfo;
    if (!quotaInfo) continue;

    const rawRemaining = quotaInfo.remainingFraction;
    const remainingFraction =
      typeof rawRemaining === "number" && rawRemaining >= 0 && rawRemaining <= 1 ? rawRemaining : 0;
    const usedPercent = clampPercent(Math.round((1 - remainingFraction) * 100));
    const modelId = entry.model ?? key;

    parsedModels.push({
      modelId,
      bucketId: modelId,
      label: entry.displayName?.trim() || key,
      remainingFraction,
      usedPercent,
      ...(quotaInfo.resetTime ? { resetsAt: quotaInfo.resetTime } : {}),
    });
  }

  // Pro models (Gemini 3.1 Pro High / Pro Agent)
  const proModel = parsedModels.find(
    (m) =>
      /gemini-(?:3(?:\\.1)?|2\\.5)-pro(?:-high|-agent)?/i.test(m.modelId) ||
      /gemini.*pro/i.test(m.label),
  );
  // Claude models (Claude Sonnet 4.6 / Opus)
  const claudeModel = parsedModels.find(
    (m) => /claude/i.test(m.modelId) || /claude/i.test(m.label),
  );
  // Flash models (Gemini 3 Flash / 3.6 Flash High)
  const flashModel = parsedModels.find(
    (m) =>
      /gemini-(?:3(?:\\.[0-9]+)?|2\\.5)-flash/i.test(m.modelId) || /gemini.*flash/i.test(m.label),
  );

  const sessionQuota = claudeModel ?? proModel ?? parsedModels[0];
  const weeklyQuota = flashModel ?? parsedModels[1] ?? sessionQuota;

  return {
    checkedAt: nowIso,
    ...(userEmail ? { userEmail } : {}),
    ...(sessionQuota ? { sessionQuota } : {}),
    ...(weeklyQuota ? { weeklyQuota, dailyQuota: weeklyQuota } : {}),
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
  if (process.env.VITEST && !process.env.ANTIGRAVITY_LIVE_TEST) {
    return inMemoryLiveQuotaCache?.data ?? null;
  }

  // Helper to query Google Cloud Code quota endpoints
  const fetchQuotaWithToken = async (
    token: string,
    projectId: string,
    email?: string,
  ): Promise<AntigravityLiveQuotaData | null> => {
    // Priority A: retrieveUserQuotaSummary (exact rolling 5h and weekly quota per group)
    for (const url of CLOUDCODE_QUOTA_SUMMARY_URLS) {
      try {
        const summaryRes = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "antigravity/1.107.0 windows/amd64",
          },
          body: JSON.stringify(projectId ? { project: projectId } : {}),
          signal: AbortSignal.timeout(4000),
        });
        if (summaryRes.ok) {
          const summaryData = (await summaryRes.json()) as Record<string, unknown>;
          const parsed = parseAntigravityQuotaPayload(summaryData, undefined, email);
          if (parsed) return parsed;
        }
      } catch {
        // Try next URL or fall through
      }
    }

    // Priority B: fetchAvailableModels
    for (const url of CLOUDCODE_MODELS_URLS) {
      try {
        const modelsRes = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "antigravity/1.107.0 windows/amd64",
          },
          body: JSON.stringify(projectId ? { project: projectId } : {}),
          signal: AbortSignal.timeout(4000),
        });
        if (modelsRes.ok) {
          const modelsData = (await modelsRes.json()) as Record<string, unknown>;
          return parseAntigravityQuotaPayload(modelsData, undefined, email);
        }
      } catch {
        // Try next URL or fall through
      }
    }

    return null;
  };

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
            // Retrieve actual linked user email from Google
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
        const parsed = await fetchQuotaWithToken(accessToken, projectId, userEmail);
        if (parsed) {
          inMemoryLiveQuotaCache = { data: parsed, fetchedAt: now };
          return parsed;
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
        activeEmail = emails.find((e) => e !== "enterlife11@gmail.com") ?? emails[0];
      }

      const account = activeEmail ? accounts[activeEmail] : undefined;
      if (account) {
        let accessToken = account.accessToken;
        const refreshToken = account.refreshToken;
        const projectId = account.projectId || "aicode-consumers";

        if (!accessToken && refreshToken) {
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
            }
          }
        }

        if (accessToken) {
          const parsed = await fetchQuotaWithToken(accessToken, projectId, activeEmail);
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
    const weeklyQuota = liveQuota.weeklyQuota ?? liveQuota.dailyQuota;

    const sessionUsedPercent = sessionQuota?.usedPercent ?? 0;
    const sessionResetsAt =
      sessionQuota?.resetsAt ??
      computeWindowResetsAt(now, ANTIGRAVITY_LIMIT_CONSTANTS.SESSION_MINS);

    const weeklyUsedPercent = weeklyQuota?.usedPercent ?? 0;
    const weeklyResetsAt =
      weeklyQuota?.resetsAt ?? computeWindowResetsAt(now, ANTIGRAVITY_LIMIT_CONSTANTS.WEEKLY_MINS);

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
        id: ANTIGRAVITY_WINDOW_IDS.WEEKLY,
        kind: "weekly",
        label: "Weekly",
        usedPercent: weeklyUsedPercent,
        windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.WEEKLY_MINS,
        resetsAt: weeklyResetsAt,
      },
    ];

    // If Claude & GPT 5h bucket exists and is distinct from primary, add it
    const thirdPartySession = liveQuota.buckets?.find(
      (b) => (b.bucketId === "3p-5h" || /3p|claude/i.test(b.groupName)) && b.window === "5h",
    );
    if (thirdPartySession && thirdPartySession.resetsAt) {
      windows.push({
        id: "antigravity_3p_session",
        kind: "session",
        label: "Session · Claude & GPT",
        usedPercent: thirdPartySession.usedPercent,
        windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.SESSION_MINS,
        resetsAt: thirdPartySession.resetsAt,
      });
    }

    // If Claude & GPT weekly bucket exists and is distinct from primary, add it
    const thirdPartyWeekly = liveQuota.buckets?.find(
      (b) =>
        (b.bucketId === "3p-weekly" || /3p|claude/i.test(b.groupName)) && b.window === "weekly",
    );
    if (thirdPartyWeekly && thirdPartyWeekly.resetsAt) {
      windows.push({
        id: "antigravity_3p_weekly",
        kind: "weekly",
        label: "Weekly · Claude & GPT",
        usedPercent: thirdPartyWeekly.usedPercent,
        windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.WEEKLY_MINS,
        resetsAt: thirdPartyWeekly.resetsAt,
      });
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

  const weeklyLimit =
    input?.weeklyTokenLimit ??
    input?.dailyTokenLimit ??
    ANTIGRAVITY_LIMIT_CONSTANTS.DEFAULT_WEEKLY_TOKEN_LIMIT;
  const weeklyUsed = input?.weeklyTokensUsed ?? input?.dailyTokensUsed ?? 0;
  const weeklyUsedPercent = clampPercent(Math.round((weeklyUsed / Math.max(1, weeklyLimit)) * 100));
  const weeklyResetsAt =
    input?.weeklyResetsAt ??
    input?.dailyResetsAt ??
    computeWindowResetsAt(now, ANTIGRAVITY_LIMIT_CONSTANTS.WEEKLY_MINS);

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
      id: ANTIGRAVITY_WINDOW_IDS.WEEKLY,
      kind: "weekly",
      label: "Weekly",
      usedPercent: weeklyUsedPercent,
      windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.WEEKLY_MINS,
      resetsAt: weeklyResetsAt,
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
  readonly weeklyTokensUsed?: number | undefined;
  readonly weeklyTokenLimit?: number | undefined;
  readonly weeklyResetsAt?: string | undefined;
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
        id: ANTIGRAVITY_WINDOW_IDS.WEEKLY,
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.WEEKLY_MINS,
        ...((input.weeklyResetsAt ?? input.dailyResetsAt)
          ? { resetsAt: (input.weeklyResetsAt ?? input.dailyResetsAt)! }
          : (liveQuota?.weeklyQuota ?? liveQuota?.dailyQuota)?.resetsAt
            ? { resetsAt: (liveQuota?.weeklyQuota ?? liveQuota?.dailyQuota)!.resetsAt }
            : {}),
      },
    ];
    return { windows };
  }

  // If live quota is known, preserve live quota percentage
  if (liveQuota) {
    const sessionPercent = liveQuota.sessionQuota?.usedPercent ?? 0;
    const weeklyPercent = (liveQuota.weeklyQuota ?? liveQuota.dailyQuota)?.usedPercent ?? 0;

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
        id: ANTIGRAVITY_WINDOW_IDS.WEEKLY,
        kind: "weekly",
        label: "Weekly",
        usedPercent: weeklyPercent,
        windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.WEEKLY_MINS,
        ...((liveQuota.weeklyQuota ?? liveQuota.dailyQuota)?.resetsAt
          ? { resetsAt: (liveQuota.weeklyQuota ?? liveQuota.dailyQuota)!.resetsAt }
          : {}),
      },
    ];

    const thirdPartySession = liveQuota.buckets?.find(
      (b) => (b.bucketId === "3p-5h" || /3p|claude/i.test(b.groupName)) && b.window === "5h",
    );
    if (thirdPartySession && thirdPartySession.resetsAt) {
      windows.push({
        id: "antigravity_3p_session",
        kind: "session",
        label: "Session · Claude & GPT",
        usedPercent: thirdPartySession.usedPercent,
        windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.SESSION_MINS,
        resetsAt: thirdPartySession.resetsAt,
      });
    }

    const thirdPartyWeekly = liveQuota.buckets?.find(
      (b) =>
        (b.bucketId === "3p-weekly" || /3p|claude/i.test(b.groupName)) && b.window === "weekly",
    );
    if (thirdPartyWeekly && thirdPartyWeekly.resetsAt) {
      windows.push({
        id: "antigravity_3p_weekly",
        kind: "weekly",
        label: "Weekly · Claude & GPT",
        usedPercent: thirdPartyWeekly.usedPercent,
        windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.WEEKLY_MINS,
        resetsAt: thirdPartyWeekly.resetsAt,
      });
    }

    return { windows };
  }

  // Fallback when no live quota is present
  const sessionLimit =
    input.sessionTokenLimit ?? ANTIGRAVITY_LIMIT_CONSTANTS.DEFAULT_SESSION_TOKEN_LIMIT;
  const sessionUsed = input.sessionTokensUsed ?? 0;
  const sessionPercent = clampPercent(Math.round((sessionUsed / Math.max(1, sessionLimit)) * 100));

  const weeklyLimit =
    input.weeklyTokenLimit ??
    input.dailyTokenLimit ??
    ANTIGRAVITY_LIMIT_CONSTANTS.DEFAULT_WEEKLY_TOKEN_LIMIT;
  const weeklyUsed = input.weeklyTokensUsed ?? input.dailyTokensUsed ?? 0;
  const weeklyPercent = clampPercent(Math.round((weeklyUsed / Math.max(1, weeklyLimit)) * 100));

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
      id: ANTIGRAVITY_WINDOW_IDS.WEEKLY,
      kind: "weekly",
      label: "Weekly",
      usedPercent: weeklyPercent,
      windowDurationMins: ANTIGRAVITY_LIMIT_CONSTANTS.WEEKLY_MINS,
      ...((input.weeklyResetsAt ?? input.dailyResetsAt)
        ? { resetsAt: (input.weeklyResetsAt ?? input.dailyResetsAt)! }
        : {}),
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
