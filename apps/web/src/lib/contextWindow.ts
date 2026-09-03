import type { OrchestrationThreadActivity, ThreadTokenUsageSnapshot } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowCategories = {
  readonly userMessages?: number;
  readonly agentResponses?: number;
  readonly toolCalls?: number;
  readonly systemPrompt?: number;
  readonly systemTools?: number;
  readonly skills?: number;
  readonly subagents?: number;
  readonly checkpointBuffer?: number;
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
  readonly categories?: ContextWindowCategories | null;
};

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens < 0) {
      continue;
    }

    const maxTokens = asFiniteNumber(payload?.maxTokens);
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;
    const categoriesPayload = asRecord(payload?.categories);
    const categories: ContextWindowCategories | null = categoriesPayload
      ? {
          ...(asFiniteNumber(categoriesPayload.userMessages) !== null
            ? { userMessages: asFiniteNumber(categoriesPayload.userMessages)! }
            : {}),
          ...(asFiniteNumber(categoriesPayload.agentResponses) !== null
            ? { agentResponses: asFiniteNumber(categoriesPayload.agentResponses)! }
            : {}),
          ...(asFiniteNumber(categoriesPayload.toolCalls) !== null
            ? { toolCalls: asFiniteNumber(categoriesPayload.toolCalls)! }
            : {}),
          ...(asFiniteNumber(categoriesPayload.systemPrompt) !== null
            ? { systemPrompt: asFiniteNumber(categoriesPayload.systemPrompt)! }
            : {}),
          ...(asFiniteNumber(categoriesPayload.systemTools) !== null
            ? { systemTools: asFiniteNumber(categoriesPayload.systemTools)! }
            : {}),
          ...(asFiniteNumber(categoriesPayload.skills) !== null
            ? { skills: asFiniteNumber(categoriesPayload.skills)! }
            : {}),
          ...(asFiniteNumber(categoriesPayload.subagents) !== null
            ? { subagents: asFiniteNumber(categoriesPayload.subagents)! }
            : {}),
          ...(asFiniteNumber(categoriesPayload.checkpointBuffer) !== null
            ? { checkpointBuffer: asFiniteNumber(categoriesPayload.checkpointBuffer)! }
            : {}),
        }
      : null;

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: asFiniteNumber(payload?.inputTokens),
      cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
      outputTokens: asFiniteNumber(payload?.outputTokens),
      reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
      lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(payload?.toolUses),
      durationMs: asFiniteNumber(payload?.durationMs),
      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
      autoCompactThreshold: asFiniteNumber(payload?.autoCompactThreshold),
      updatedAt: activity.createdAt,
      categories,
    };
  }

  return null;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
