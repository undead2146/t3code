/**
 * Antigravity subscription and quota limits tracking.
 *
 * Antigravity uses Google's Gemini models under the hood. Google enforces
 * burst/session quotas (rolling 5 hours) and daily quotas (rolling 24 hours).
 *
 * This module computes and updates ServerProviderUsageLimits for Antigravity:
 * - Session window: 300 minutes (5 hours) rolling quota
 * - Daily window: 1440 minutes (24 hours) rolling quota
 *
 * When an account is authenticated, usageLimits are exposed so the Limits tab
 * displays the Antigravity meters alongside Codex and Claude Code. Mid-turn
 * token updates and HTTP 429 / RESOURCE_EXHAUSTED events stream updates to
 * adjust usage percentages and countdowns in real time.
 *
 * @module provider/Layers/antigravityUsageLimits
 */
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
  // Baseline token allocation models for Gemini 3.8 / Pro quotas
  DEFAULT_SESSION_TOKEN_LIMIT: 250_000,
  DEFAULT_DAILY_TOKEN_LIMIT: 1_000_000,
} as const;

export const ANTIGRAVITY_WINDOW_IDS = {
  SESSION: "session_window",
  DAILY: "daily_window",
} as const;

export interface AntigravityUsageLimitsInput {
  readonly checkedAt?: string;
  readonly sessionTokensUsed?: number;
  readonly sessionTokenLimit?: number;
  readonly sessionResetsAt?: string;
  readonly dailyTokensUsed?: number;
  readonly dailyTokenLimit?: number;
  readonly dailyResetsAt?: string;
}

function computeWindowResetsAt(now: DateTime.DateTime, durationMins: number): string {
  const future = DateTime.addDuration(now, Duration.minutes(durationMins));
  return DateTime.formatIso(future);
}

/**
 * Builds the initial or refreshed ServerProviderUsageLimits for Antigravity.
 */
export function makeAntigravityUsageLimits(
  input?: AntigravityUsageLimitsInput,
): ServerProviderUsageLimits {
  const now = DateTime.nowUnsafe();
  const checkedAt = input?.checkedAt ?? DateTime.formatIso(now);

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
 * Converts a mid-turn token count or rate-limit event into a ProviderUsageLimitsUpdate.
 */
export function makeAntigravityUsageLimitsUpdate(input: {
  readonly checkedAt?: string;
  readonly sessionTokensUsed?: number;
  readonly sessionTokenLimit?: number;
  readonly sessionResetsAt?: string;
  readonly dailyTokensUsed?: number;
  readonly dailyTokenLimit?: number;
  readonly dailyResetsAt?: string;
  readonly rateLimited?: boolean;
}): ProviderUsageLimitsUpdate {
  const now = DateTime.nowUnsafe();
  const checkedAt = input.checkedAt ?? DateTime.formatIso(now);

  const sessionLimit =
    input.sessionTokenLimit ?? ANTIGRAVITY_LIMIT_CONSTANTS.DEFAULT_SESSION_TOKEN_LIMIT;
  const sessionUsed = input.sessionTokensUsed ?? 0;
  const sessionPercent = input.rateLimited
    ? 100
    : clampPercent(Math.round((sessionUsed / Math.max(1, sessionLimit)) * 100));

  const dailyLimit = input.dailyTokenLimit ?? ANTIGRAVITY_LIMIT_CONSTANTS.DEFAULT_DAILY_TOKEN_LIMIT;
  const dailyUsed = input.dailyTokensUsed ?? 0;
  const dailyPercent = input.rateLimited
    ? 100
    : clampPercent(Math.round((dailyUsed / Math.max(1, dailyLimit)) * 100));

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
