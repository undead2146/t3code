/**
 * Pure parsers for the provider CLIs' on-disk session transcripts.
 *
 * Both parsers are line-at-a-time reducers so callers can stream large files
 * without materialising them. Neither touches the filesystem.
 *
 * @module usageTranscripts
 */
import type { UsageProviderKind, UsageTokenTotals } from "@t3tools/contracts";

export interface UsageRecord {
  readonly provider: UsageProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  readonly reportedCostUsd: number | null;
  /**
   * Key for cross-file de-duplication, or `null` when the record is inherently
   * unique and needs no dedup.
   */
  readonly dedupeKey: string | null;
}

const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function addTotals(a: UsageTokenTotals, b: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export function totalTokens(totals: UsageTokenTotals): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/**
 * Cheap substring gate applied before `JSON.parse`.
 *
 * Transcripts are mostly tool output; only a minority of lines carry usage. On
 * a 30-day window this skips roughly half the lines outright and is worth about
 * an order of magnitude.
 */
export function mightCarryUsage(line: string, provider: UsageProviderKind): boolean {
  if (provider === "claude") return line.includes('"usage"');
  if (provider === "codex") return line.includes('"token_count"');
  if (provider === "antigravity") return line.includes('"usage"') || line.includes('"tokens"');
  return false;
}

/* -------------------------------------------------------------------------- */
/* Claude Code                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parses one line of a Claude Code transcript.
 *
 * T3 Code writes one record per assistant *content block*, and every one of
 * those records repeats the same complete `usage` object for the parent
 * message. Summing them overcounts by roughly 2.4x on a real workload, so the
 * caller must drop repeats by `dedupeKey` and keep the first.
 */
export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0) return null;

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  // Matches ccusage: prefer the message/request pair, fall back to whichever
  // half exists. Records with neither cannot be de-duplicated.
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      uncachedInputTokens: int(usageRecord["input_tokens"]),
      cachedInputTokens: int(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: int(usageRecord["cache_creation_input_tokens"]),
      outputTokens: int(usageRecord["output_tokens"]),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    dedupeKey,
  };
}

/* -------------------------------------------------------------------------- */
/* Codex                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Rolling state for a single Codex rollout file.
 *
 * Codex `token_count` events carry no model, so the model is carried forward
 * from the most recent `turn_context`. Sessions that switch models mid-run
 * attribute correctly from the switch onward.
 */
export interface CodexScanState {
  model: string;
  sessionId: string;
  lastUsageSignature: string | null;
  sawSessionMeta: boolean;
  /** While true, leading usage events are re-stamped copies of parent history. */
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

export function initialCodexScanState(): CodexScanState {
  return {
    model: "",
    sessionId: "",
    lastUsageSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

/**
 * A forked or subagent rollout opens with the parent's full history copied in,
 * every line re-stamped to the fork instant. Those copies are written in one
 * synchronous burst (observed gaps 0-40ms), while the child's first genuine
 * usage event only lands after a real model turn (observed 5s+). One second of
 * separation splits the two cleanly; `ccusage` uses the same threshold.
 */
const FORK_COPY_MAX_GAP_MS = 1000;

/** Whether a `session_meta` payload marks the rollout as a fork or subagent. */
function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload["forked_from_id"] === "string") return true;
  const source = payload["source"];
  if (typeof source !== "object" || source === null) return false;
  const subagent = (source as Record<string, unknown>)["subagent"];
  if (typeof subagent !== "object" || subagent === null) return false;
  const spawn = (subagent as Record<string, unknown>)["thread_spawn"];
  if (typeof spawn !== "object" || spawn === null) return false;
  return typeof (spawn as Record<string, unknown>)["parent_thread_id"] === "string";
}

/**
 * Feeds one line of a Codex rollout into `state`, returning a record when the
 * line was a usage event.
 *
 * Deltas come from `last_token_usage`. Summing those across a session
 * reconciles with the session's final `total_token_usage`, provided
 * consecutive duplicate events are dropped, which this does.
 */
export function parseCodexLine(line: string, state: CodexScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;
  const payloadType = payloadRecord["type"];

  if (record["type"] === "session_meta") {
    // Only the first meta describes this file's own session. A forked rollout
    // repeats the ancestors' metas right after it; letting those through would
    // reassign every subsequent record to an ancestor session.
    if (state.sawSessionMeta) return null;
    state.sawSessionMeta = true;
    const id = payloadRecord["id"] ?? payloadRecord["session_id"];
    if (typeof id === "string") state.sessionId = id;
    const metaTimestampMs = parseTimestampMs(record["timestamp"]);
    if (metaTimestampMs !== null && isForkedSessionMeta(payloadRecord)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return null;
  }

  if (record["type"] === "turn_context") {
    if (typeof payloadRecord["model"] === "string") state.model = payloadRecord["model"];
    return null;
  }

  if (payloadType !== "token_count") return null;

  const info = payloadRecord["info"];
  if (typeof info !== "object" || info === null) return null;
  const last = (info as Record<string, unknown>)["last_token_usage"];
  if (typeof last !== "object" || last === null) return null;
  const lastRecord = last as Record<string, unknown>;

  // Only an event that is otherwise eligible may consume the duplicate
  // signature. A token_count arriving before its turn_context (no model yet)
  // must not poison it, or the re-emitted copy after the model is known would
  // be skipped as a duplicate and those tokens never counted.
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;
  if (state.model.length === 0) return null;

  // Codex re-emits an unchanged token_count on some stream boundaries. Summing
  // those would double count, so identical consecutive payloads are skipped.
  const signature = JSON.stringify(lastRecord);
  if (signature === state.lastUsageSignature) return null;
  state.lastUsageSignature = signature;

  // In a forked rollout the copied parent history was already counted from the
  // parent's own file. Drop the leading burst; the first usage event separated
  // from its predecessor by a real turn's worth of time ends it for good.
  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      return null;
    }
    state.suppressingForkCopies = false;
  }

  const inputTokens = int(lastRecord["input_tokens"]);
  const cachedInputTokens = int(lastRecord["cached_input_tokens"]);
  const cacheCreationTokens = int(lastRecord["cache_write_input_tokens"]);
  const outputTokens = int(lastRecord["output_tokens"]);

  const totals: UsageTokenTotals = {
    // Codex reports `input_tokens` inclusive of the cached portion.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    // Reported inside output_tokens, surfaced separately for the token mix.
    reasoningTokens: Math.min(outputTokens, int(lastRecord["reasoning_output_tokens"])),
  };

  if (totalTokens(totals) === 0) return null;

  return {
    provider: "codex",
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    totals,
    // Codex does not report cost in the rollout.
    reportedCostUsd: null,
    // Events surviving the fork-copy suppression above are unique to this
    // rollout, so they need no global dedup.
    dedupeKey: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Antigravity                                                                */
/* -------------------------------------------------------------------------- */

export interface AntigravityScanState {
  model: string;
  sessionId: string;
  lastUsageSignature: string | null;
}

export function initialAntigravityScanState(): AntigravityScanState {
  return {
    model: "",
    sessionId: "",
    lastUsageSignature: null,
  };
}

/**
 * Parses one line of an Antigravity transcript or provider log.
 *
 * Supports both raw stream-JSON/brain transcripts and T3 Code provider logs
 * prefixed with `[timestamp] NTIVE: {...}`.
 */
export function parseAntigravityLine(
  line: string,
  state: AntigravityScanState,
): UsageRecord | null {
  let rawLine = line.trim();
  if (!rawLine) return null;

  let timestampMs: number | null = null;
  const prefixMatch = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s+(?:NTIVE|CANON):\s+(.*)$/.exec(rawLine);
  if (prefixMatch && prefixMatch[1] && prefixMatch[2]) {
    timestampMs = parseTimestampMs(prefixMatch[1]);
    rawLine = prefixMatch[2];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;

  // Handle init event
  if (record["event"] === "init") {
    if (typeof record["conversation_id"] === "string") {
      state.sessionId = record["conversation_id"];
    }
    const init = record["init"];
    if (typeof init === "object" && init !== null) {
      const initRecord = init as Record<string, unknown>;
      if (typeof initRecord["model"] === "string" && initRecord["model"].length > 0) {
        state.model = initRecord["model"];
      }
    }
    return null;
  }

  // Extract usage, step index, and model
  let usageObj: Record<string, unknown> | null = null;
  let stepIndex: number | null = null;
  let eventModel: string | null = null;

  if (record["type"] === "thread.token-usage.updated") {
    const payload = record["payload"];
    if (typeof payload === "object" && payload !== null) {
      const payloadRecord = payload as Record<string, unknown>;
      if (typeof payloadRecord["usage"] === "object" && payloadRecord["usage"] !== null) {
        usageObj = payloadRecord["usage"] as Record<string, unknown>;
      }
    }
    if (typeof record["threadId"] === "string") {
      state.sessionId = record["threadId"];
    }
  } else if (record["event"] === "step_update") {
    const stepUpdate = record["step_update"];
    if (typeof stepUpdate === "object" && stepUpdate !== null) {
      const stepUpdateRecord = stepUpdate as Record<string, unknown>;
      if (typeof stepUpdateRecord["conversation_id"] === "string") {
        state.sessionId = stepUpdateRecord["conversation_id"];
      }
      if (typeof stepUpdateRecord["step_index"] === "number") {
        stepIndex = stepUpdateRecord["step_index"];
      }
      if (typeof stepUpdateRecord["model"] === "string") {
        eventModel = stepUpdateRecord["model"];
      }
      if (typeof stepUpdateRecord["usage"] === "object" && stepUpdateRecord["usage"] !== null) {
        usageObj = stepUpdateRecord["usage"] as Record<string, unknown>;
      }
    }
  } else if (typeof record["usage"] === "object" && record["usage"] !== null) {
    usageObj = record["usage"] as Record<string, unknown>;
    if (typeof record["step_index"] === "number") {
      stepIndex = record["step_index"];
    }
    if (typeof record["conversation_id"] === "string") {
      state.sessionId = record["conversation_id"];
    }
    if (typeof record["model"] === "string") {
      eventModel = record["model"];
    }
  }

  if (!usageObj) return null;

  if (eventModel) {
    state.model = eventModel;
  }

  if (timestampMs === null) {
    timestampMs = parseTimestampMs(record["created_at"] ?? record["timestamp"]);
  }
  if (timestampMs === null) {
    return null;
  }

  // Deduplicate consecutive identical usage payloads
  const signature = `${state.sessionId}:${stepIndex ?? ""}:${JSON.stringify(usageObj)}`;
  if (signature === state.lastUsageSignature) return null;
  state.lastUsageSignature = signature;

  const rawInput = int(
    usageObj["input_tokens"] ??
      usageObj["prompt_tokens"] ??
      usageObj["prompt_token_count"] ??
      usageObj["inputTokens"],
  );
  const cachedInput = int(
    usageObj["cache_read_tokens"] ??
      usageObj["cache_read_input_tokens"] ??
      usageObj["cached_tokens"] ??
      usageObj["cached_content_token_count"] ??
      usageObj["cachedInputTokens"],
  );
  const cacheCreation = int(
    usageObj["cache_creation_tokens"] ??
      usageObj["cache_creation_input_tokens"] ??
      usageObj["cache_write_tokens"] ??
      usageObj["cacheCreationTokens"],
  );
  const output = int(
    usageObj["output_tokens"] ??
      usageObj["candidates_tokens"] ??
      usageObj["completion_tokens"] ??
      usageObj["candidates_token_count"] ??
      usageObj["outputTokens"],
  );
  const reasoning = int(
    usageObj["thinking_tokens"] ??
      usageObj["reasoning_tokens"] ??
      usageObj["reasoning_output_tokens"] ??
      usageObj["reasoningOutputTokens"],
  );

  const totals: UsageTokenTotals = {
    uncachedInputTokens: Math.max(0, rawInput - cachedInput - cacheCreation),
    cachedInputTokens: cachedInput,
    cacheCreationTokens: cacheCreation,
    outputTokens: output,
    reasoningTokens: Math.min(output, reasoning),
  };

  if (totalTokens(totals) === 0) return null;

  const cost =
    usageObj["costUSD"] ?? usageObj["cost_usd"] ?? record["costUSD"] ?? record["cost_usd"];
  const reportedCostUsd = typeof cost === "number" && Number.isFinite(cost) ? cost : null;

  const dedupeKey = state.sessionId ? `${state.sessionId}:${stepIndex ?? timestampMs}` : null;

  return {
    provider: "antigravity",
    timestampMs,
    model: state.model || "gemini-3.7-flash",
    sessionId: state.sessionId,
    totals,
    reportedCostUsd,
    dedupeKey,
  };
}

export { EMPTY_TOTALS };
