import {
  NonNegativeInt,
  PositiveInt,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  TurnId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type EventId,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { MuseSubscriptionUsage, museSubscriptionUsageToLimits } from "../Layers/museUsageLimits.ts";

const optionalString = Schema.optional(Schema.NullOr(Schema.String));
const optionalInt = Schema.optional(Schema.NullOr(NonNegativeInt));
const identity = { sessionId: Schema.String, viewCursor: Schema.String };
export const MuseItem = Schema.Struct({
  itemId: Schema.String,
  kind: Schema.String,
  revision: Schema.NullOr(NonNegativeInt),
  status: Schema.String,
  turnId: Schema.optional(Schema.NullOr(Schema.String)),
  text: optionalString,
  summary: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  tool: optionalString,
  args: optionalString,
  visibleOutput: optionalString,
  failureReason: optionalString,
  fallbackText: optionalString,
  commandText: optionalString,
  outcome: optionalString,
  tokensBefore: optionalInt,
  tokensAfter: optionalInt,
  scriptId: optionalString,
  entryId: optionalString,
  workflowRunId: optionalString,
  scriptPath: optionalString,
  message: optionalString,
  triggerSource: optionalString,
  resumeFromRunId: optionalString,
  role: optionalString,
  objective: optionalString,
  subagentId: optionalString,
  reminderAgentId: optionalString,
  childSessionId: optionalString,
  taskId: optionalString,
  generationId: optionalInt,
});
export type MuseItem = typeof MuseItem.Type;

const approvalChoice = Schema.Struct({
  choiceId: Schema.String,
  decision: Schema.String,
  label: Schema.String,
  scope: Schema.String,
  acceptsFeedback: Schema.optional(Schema.Boolean),
});
const approvalSubject = Schema.Struct({
  kind: Schema.String,
  command: optionalString,
  path: optionalString,
  access: optionalString,
  toolName: optionalString,
});
const approval = {
  ...identity,
  approvalId: Schema.String,
  availableChoices: Schema.Array(approvalChoice),
  currentRequirementId: Schema.Struct({ approvalId: Schema.String, sourceIndex: NonNegativeInt }),
  subject: approvalSubject,
};
const tokenUsage = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cachedTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
});

export const MuseNotification = Schema.Union([
  Schema.Struct({ method: Schema.Literal("usage/changed"), params: MuseSubscriptionUsage }),
  Schema.Struct({
    method: Schema.Literals(["item/started", "item/updated", "item/completed"]),
    params: Schema.Struct({ ...identity, item: MuseItem }),
  }),
  Schema.Struct({
    method: Schema.Literal("item/delta"),
    params: Schema.Struct({
      ...identity,
      itemId: Schema.String,
      delta: Schema.String,
      field: optionalString,
    }),
  }),
  Schema.Struct({
    method: Schema.Literal("turn/started"),
    params: Schema.Struct({ ...identity, turnId: Schema.String }),
  }),
  Schema.Struct({
    method: Schema.Literal("turn/retryScheduled"),
    params: Schema.Struct({
      ...identity,
      turnId: Schema.String,
      nextAttempt: PositiveInt,
      maxAttempts: PositiveInt,
      reason: Schema.String,
      retryDelayMs: NonNegativeInt,
    }),
  }),
  Schema.Struct({
    method: Schema.Literal("turn/completed"),
    params: Schema.Struct({
      ...identity,
      turnId: Schema.String,
      terminal: Schema.String,
      reason: optionalString,
      error: Schema.optional(
        Schema.NullOr(
          Schema.Struct({ kind: Schema.String, message: Schema.String, retryable: Schema.Boolean }),
        ),
      ),
      usage: Schema.optional(Schema.NullOr(tokenUsage)),
    }),
  }),
  Schema.Struct({
    method: Schema.Literal("turn/unqueued"),
    params: Schema.Struct({ ...identity, turnId: Schema.String }),
  }),
  Schema.Struct({
    method: Schema.Literal("approval/requested"),
    params: Schema.Struct({
      ...approval,
      itemId: Schema.String,
      turnId: Schema.String,
      toolName: Schema.String,
      rawArgs: Schema.String,
    }),
  }),
  Schema.Struct({ method: Schema.Literal("approval/updated"), params: Schema.Struct(approval) }),
  Schema.Struct({
    method: Schema.Literal("approval/resolved"),
    params: Schema.Struct({
      ...identity,
      approvalId: Schema.String,
      itemId: Schema.String,
      turnId: Schema.String,
      decision: Schema.String,
      amendment: Schema.optional(Schema.Struct({ durability: Schema.String })),
    }),
  }),
  Schema.Struct({
    method: Schema.Literal("userInput/requested"),
    params: Schema.Struct({
      ...identity,
      userInputId: Schema.String,
      itemId: Schema.String,
      turnId: Schema.String,
      questions: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          header: Schema.String,
          question: Schema.String,
          options: Schema.Array(
            Schema.Struct({ label: Schema.String, description: optionalString }),
          ),
          selection: Schema.Struct({
            mode: Schema.Literals(["single", "multiple"]),
            minSelections: Schema.optional(NonNegativeInt),
            maxSelections: Schema.optional(NonNegativeInt),
          }),
        }),
      ),
    }),
  }),
  Schema.Struct({
    method: Schema.Literal("userInput/settled"),
    params: Schema.Struct({
      ...identity,
      userInputId: Schema.String,
      answers: Schema.Array(
        Schema.Struct({
          questionId: Schema.String,
          freeText: optionalString,
          selectedLabel: optionalString,
          selectedLabels: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
    }),
  }),
  Schema.Struct({
    method: Schema.Literal("session/todoListChanged"),
    params: Schema.Struct({
      ...identity,
      items: Schema.Array(Schema.Struct({ text: Schema.String, status: Schema.String })),
    }),
  }),
  Schema.Struct({
    method: Schema.Literal("session/tokenUsage"),
    params: Schema.Struct({
      ...identity,
      turnId: Schema.String,
      promptTokens: NonNegativeInt,
      totalTokens: NonNegativeInt,
      usage: tokenUsage,
      cumulative: Schema.Struct({
        promptTokens: NonNegativeInt,
        outputTokens: NonNegativeInt,
        totalTokens: NonNegativeInt,
      }),
    }),
  }),
  Schema.Struct({
    method: Schema.Literal("session/contextUsage"),
    params: Schema.Struct({
      ...identity,
      usedTokens: NonNegativeInt,
      windowTokens: Schema.optional(NonNegativeInt),
    }),
  }),
]);
export type MuseNotification = typeof MuseNotification.Type;
export const decodeMuseNotification = Schema.decodeUnknownSync(MuseNotification);

const notificationMethods: ReadonlySet<string> = new Set([
  "item/started",
  "item/updated",
  "item/completed",
  "item/delta",
  "turn/started",
  "turn/retryScheduled",
  "turn/completed",
  "turn/unqueued",
  "approval/requested",
  "approval/updated",
  "approval/resolved",
  "userInput/requested",
  "userInput/settled",
  "session/todoListChanged",
  "session/tokenUsage",
  "session/contextUsage",
  "usage/changed",
]);
export const isMuseNotificationMethod = (method: string): boolean =>
  notificationMethods.has(method);

const TRANSPORT_TRUNCATION_MARKERS = [
  "body-truncated",
  "transport_stream_error",
  "response body ended before completion",
];
export const MUSE_TRANSPORT_TRUNCATION_SIGNATURE = "transport-truncation";
// Classifies failures where the model response stream was cut off mid-body. The CLI
// replays these identically (same ~185 KiB cutoff on every attempt), so callers use
// the signature to break the retry storm instead of burning all ten attempts.
export function museTransportTruncationSignature(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const lowered = message.toLowerCase();
  if (!TRANSPORT_TRUNCATION_MARKERS.some((marker) => lowered.includes(marker))) return undefined;
  return MUSE_TRANSPORT_TRUNCATION_SIGNATURE;
}

const MUSE_TRANSIENT_FAILURE_MARKERS = [
  "temporarily overloaded",
  "overloaded",
  "server_error",
  "server error",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
  "temporarily unavailable",
  "try again",
  "please retry",
  "high demand",
  "capacity",
  "unreachable",
  "rate limit",
  "rate_limit",
  "too many requests",
  "timed out",
  "timeout",
  "econnreset",
  "etimedout",
  "socket hang up",
  "fetch failed",
  "network error",
  "connection reset",
  "connection aborted",
];
const MUSE_FATAL_FAILURE_MARKERS = [
  "unauthorized",
  "authentication",
  "invalid api key",
  "invalid key",
  "forbidden",
  "quota",
  "billing",
  "payment",
  "insufficient",
  "usage limit",
  "context length",
  "too many tokens",
  "max tokens",
  "invalid request",
  "validation",
];
// Classifies turn failures worth a T3-level automatic retry: transient backend,
// capacity, rate-limit, and network failures where an identical redrive can
// succeed. Fatal markers (auth, quota/billing, context limits, malformed
// requests) and deterministic transport truncation fail fast instead, since
// retrying those unchanged can never succeed.
export function isRetryableMuseError(message: string | undefined): boolean {
  if (!message) return false;
  const lowered = message.toLowerCase();
  if (MUSE_FATAL_FAILURE_MARKERS.some((marker) => lowered.includes(marker))) return false;
  if (museTransportTruncationSignature(message) !== undefined) return false;
  if (/\b50[234]\b/.test(lowered) || /\b429\b/.test(lowered)) return true;
  return MUSE_TRANSIENT_FAILURE_MARKERS.some((marker) => lowered.includes(marker));
}

export function museApprovalDecision(
  decision: string,
  scope?: string,
): ProviderApprovalDecision | undefined {
  switch (decision) {
    case "approved":
      return "accept";
    case "approvedForSession":
      return "acceptForSession";
    case "approvedPolicyAmendment":
      return scope === "session" ? "acceptForSession" : "acceptAlways";
    case "denied":
    case "deniedPolicyAmendment":
      return "decline";
    case "abort":
      return "cancel";
    default:
      return undefined;
  }
}

function itemTitle(item: MuseItem): string | undefined {
  if (item.tool) {
    return item.tool === "read_file" ? "Read file" : item.tool;
  }
  if (item.kind === "workflow") {
    if (item.scriptId) return `Workflow: ${item.scriptId}`;
    if (item.entryId) return `Workflow: ${item.entryId}`;
    if (item.workflowRunId) return `Workflow: ${item.workflowRunId}`;
    return "Workflow";
  }
  if (item.kind === "subagent") {
    if (item.role) return `Subagent: ${item.role}`;
    if (item.objective) return `Subagent: ${item.objective}`;
    return "Subagent task";
  }
  if (item.kind === "reminderChild") {
    if (item.reminderAgentId) return `Reminder: ${item.reminderAgentId}`;
    return "Reminder";
  }
  return undefined;
}

export function itemType(item: MuseItem): CanonicalItemType {
  switch (item.kind) {
    case "userMessage":
      return "user_message";
    case "agentMessage":
      return "assistant_message";
    case "reasoning":
      return "reasoning";
    case "userShell":
      return "command_execution";
    case "toolCall":
      return "dynamic_tool_call";
    case "subagent":
    case "workflow":
    case "reminderChild":
      return "collab_agent_tool_call";
    case "compaction":
      return "context_compaction";
    default:
      return "unknown";
  }
}

function requestType(subject: typeof approvalSubject.Type): CanonicalRequestType {
  if (subject.kind === "shell") return "command_execution_approval";
  if (subject.kind === "fileAccess")
    return subject.access === "read" ? "file_read_approval" : "file_change_approval";
  return "mcp_elicitation_approval";
}

// Tool-spawned children never arrive as kind="subagent" items, so the Agents
// surface would miss them entirely. These tools are translated into the same
// task.* lifecycle the native subagent items produce.
const SUBAGENT_TOOL_METHODS: ReadonlySet<string> = new Set([
  "subagent_spawn",
  "subagent_wait",
  "subagent_read_result",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonRecord(text: string | null | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    // Partial tool output is completed by later item updates.
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function subagentTaskTitle(input: Record<string, unknown> | undefined): string {
  const taskName = input ? nonEmptyString(input.task_name) : undefined;
  if (taskName) return `Subagent: ${taskName}`;
  const role = input ? nonEmptyString(input.role) : undefined;
  if (role) return `Subagent: ${role}`;
  return "Subagent";
}

export interface MuseEventContext {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly createdAt: string;
  readonly nextEventId: () => EventId;
  readonly itemById: (id: string) => MuseItem | undefined;
  readonly streamedText: (itemId: string, field: string) => string;
  readonly activeTurnId?: TurnId;
  readonly contextUsedTokens?: number;
  readonly contextWindowTokens?: number;
  readonly approvalSubjectById?: (id: string) => typeof approvalSubject.Type | undefined;
}

/** Maps validated MSP facts; the adapter owns lifecycle and replay deduplication. */
export function mapMuseNotification(
  event: MuseNotification,
  context: MuseEventContext,
): ProviderRuntimeEvent[] {
  const base = {
    eventId: context.nextEventId(),
    provider: ProviderDriverKind.make("muse"),
    providerInstanceId: context.providerInstanceId,
    threadId: context.threadId,
    createdAt: context.createdAt,
    ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
    raw: { source: "muse.msp.notification" as const, method: event.method, payload: event.params },
  };
  switch (event.method) {
    case "usage/changed": {
      const limits = museSubscriptionUsageToLimits(event.params);
      return [
        {
          ...base,
          type: "account.rate-limits.updated",
          payload: { limits: { windows: limits.windows, checkedAt: limits.checkedAt } },
        },
      ];
    }
    case "item/started":
    case "item/updated":
    case "item/completed": {
      const item = event.params.item;
      const type =
        event.method === "item/started"
          ? "item.started"
          : event.method === "item/updated"
            ? "item.updated"
            : "item.completed";
      const status =
        item.status === "inProgress"
          ? "inProgress"
          : item.status === "completed"
            ? "completed"
            : item.status === "rejected"
              ? "declined"
              : "failed";
      const title = itemTitle(item);
      const detail =
        item.text ||
        item.message ||
        item.summary?.join("\n") ||
        item.visibleOutput ||
        item.failureReason ||
        item.fallbackText;
      let input: Record<string, unknown> | undefined;
      if (item.args) {
        try {
          const parsed: unknown = JSON.parse(item.args);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          // Partial tool arguments are completed by later item updates.
        }
      }
      const result: ProviderRuntimeEvent[] = [
        {
          ...base,
          type,
          itemId: RuntimeItemId.make(item.itemId),
          ...(item.turnId ? { turnId: TurnId.make(item.turnId) } : {}),
          ...(item.turnId === null ? { turnId: undefined } : {}),
          payload: {
            itemType: itemType(item),
            status,
            ...(title ? { title } : {}),
            ...(detail ? { detail } : {}),
            data: {
              ...item,
              ...(input ? { input } : {}),
              ...(item.commandText ? { command: item.commandText } : {}),
              ...(typeof input?.file_path === "string" ? { path: input.file_path } : {}),
              ...(item.visibleOutput ? { rawOutput: item.visibleOutput } : {}),
            },
          },
        },
      ];
      if (item.kind === "workflow" || item.kind === "subagent") {
        const taskId = RuntimeTaskId.make(item.itemId);
        if (type === "item.started") {
          result.push({
            ...base,
            eventId: context.nextEventId(),
            type: "task.started",
            itemId: RuntimeItemId.make(item.itemId),
            ...(item.turnId ? { turnId: TurnId.make(item.turnId) } : {}),
            ...(item.turnId === null ? { turnId: undefined } : {}),
            payload: {
              taskId,
              taskType: item.kind === "workflow" ? "local_workflow" : "subagent",
              title: title ?? (item.kind === "workflow" ? "Workflow" : "Subagent"),
              description: detail || title || (item.kind === "workflow" ? "Workflow" : "Subagent"),
              ...(item.kind === "subagent" && item.role ? { role: item.role } : {}),
              ...(() => {
                const workflowName = item.entryId ?? item.scriptId;
                return item.kind === "workflow" && workflowName ? { workflowName } : {};
              })(),
              ...(item.workflowRunId || item.scriptPath
                ? {
                    runHandles: {
                      ...(item.workflowRunId ? { runId: item.workflowRunId } : {}),
                      ...(item.scriptPath ? { scriptPath: item.scriptPath } : {}),
                    },
                  }
                : {}),
            },
          });
        } else if (type === "item.updated") {
          result.push({
            ...base,
            eventId: context.nextEventId(),
            type: "task.updated",
            itemId: RuntimeItemId.make(item.itemId),
            ...(item.turnId ? { turnId: TurnId.make(item.turnId) } : {}),
            ...(item.turnId === null ? { turnId: undefined } : {}),
            payload: {
              taskId,
              status:
                status === "inProgress"
                  ? "running"
                  : status === "completed"
                    ? "completed"
                    : "failed",
              ...(detail ? { description: detail } : {}),
            },
          });
        } else if (type === "item.completed") {
          result.push({
            ...base,
            eventId: context.nextEventId(),
            type: "task.completed",
            itemId: RuntimeItemId.make(item.itemId),
            ...(item.turnId ? { turnId: TurnId.make(item.turnId) } : {}),
            ...(item.turnId === null ? { turnId: undefined } : {}),
            payload: {
              taskId,
              status: status === "completed" ? "completed" : "failed",
              ...(detail ? { summary: detail } : {}),
            },
          });
        }
      }
      if (item.kind === "toolCall" && item.tool && SUBAGENT_TOOL_METHODS.has(item.tool)) {
        const output = parseJsonRecord(item.visibleOutput);
        const subagentId =
          (input ? nonEmptyString(input.subagent_id) : undefined) ??
          nonEmptyString(output?.subagent_id);
        if (item.tool === "subagent_spawn" && type === "item.completed" && status === "completed") {
          // A rejected spawn has no child; the failed tool row already shows it.
          if (output?.status === "accepted" && subagentId) {
            const role = input ? nonEmptyString(input.role) : undefined;
            const objective = input ? nonEmptyString(input.objective) : undefined;
            const agentPath = nonEmptyString(output.agent_path);
            result.push({
              ...base,
              eventId: context.nextEventId(),
              type: "task.started",
              itemId: RuntimeItemId.make(item.itemId),
              ...(item.turnId ? { turnId: TurnId.make(item.turnId) } : {}),
              ...(item.turnId === null ? { turnId: undefined } : {}),
              payload: {
                taskId: RuntimeTaskId.make(subagentId),
                taskType: "subagent",
                title: subagentTaskTitle(input),
                ...(objective ? { description: objective } : {}),
                ...(role ? { role } : {}),
                toolUseId: item.itemId,
                ...(agentPath ? { agentPath } : {}),
              },
            });
          }
        } else if (
          item.tool === "subagent_wait" &&
          type === "item.started" &&
          subagentId !== undefined
        ) {
          result.push({
            ...base,
            eventId: context.nextEventId(),
            type: "task.updated",
            itemId: RuntimeItemId.make(item.itemId),
            ...(item.turnId ? { turnId: TurnId.make(item.turnId) } : {}),
            ...(item.turnId === null ? { turnId: undefined } : {}),
            payload: {
              taskId: RuntimeTaskId.make(subagentId),
              taskType: "subagent",
              status: "running",
              description: "Waiting for subagent result",
            },
          });
        } else if (
          (item.tool === "subagent_wait" || item.tool === "subagent_read_result") &&
          type === "item.completed" &&
          subagentId !== undefined
        ) {
          // A wait that times out (or any unrecognized envelope) leaves the
          // child alive; only an explicit terminal envelope settles it.
          const envelopeStatus = nonEmptyString(output?.status);
          const terminalStatus =
            envelopeStatus === "ready"
              ? ("completed" as const)
              : envelopeStatus === "failed" || envelopeStatus === "error"
                ? ("failed" as const)
                : envelopeStatus === "cancelled" || envelopeStatus === "canceled"
                  ? ("stopped" as const)
                  : undefined;
          const summary = nonEmptyString(output?.summary);
          if (terminalStatus) {
            result.push({
              ...base,
              eventId: context.nextEventId(),
              type: "task.completed",
              itemId: RuntimeItemId.make(item.itemId),
              ...(item.turnId ? { turnId: TurnId.make(item.turnId) } : {}),
              ...(item.turnId === null ? { turnId: undefined } : {}),
              payload: {
                taskId: RuntimeTaskId.make(subagentId),
                taskType: "subagent",
                status: terminalStatus,
                ...(summary ? { summary } : {}),
              },
            });
          } else {
            result.push({
              ...base,
              eventId: context.nextEventId(),
              type: "task.updated",
              itemId: RuntimeItemId.make(item.itemId),
              ...(item.turnId ? { turnId: TurnId.make(item.turnId) } : {}),
              ...(item.turnId === null ? { turnId: undefined } : {}),
              payload: {
                taskId: RuntimeTaskId.make(subagentId),
                taskType: "subagent",
                status: "running",
              },
            });
          }
        }
      }
      // Single-shot completions can arrive without any streamed deltas.
      const textFields =
        item.kind === "agentMessage" || item.kind === "reasoning"
          ? [
              {
                field: "text",
                text: item.text,
                streamKind:
                  item.kind === "reasoning"
                    ? ("reasoning_text" as const)
                    : ("assistant_text" as const),
              },
              ...(item.summary ?? []).map((text, index) => ({
                field: `summary.${index}`,
                text,
                streamKind: "reasoning_summary_text" as const,
              })),
            ]
          : [];
      const backfill: ProviderRuntimeEvent[] = [];
      for (const { field, text, streamKind } of textFields) {
        const streamed = context.streamedText(item.itemId, field);
        if (!text || !text.startsWith(streamed) || text.length === streamed.length) continue;
        backfill.push({
          ...base,
          eventId: context.nextEventId(),
          type: "content.delta",
          itemId: RuntimeItemId.make(item.itemId),
          ...(item.turnId ? { turnId: TurnId.make(item.turnId) } : {}),
          payload: {
            streamKind,
            delta: text.slice(streamed.length),
            ...(field.startsWith("summary.") ? { summaryIndex: Number(field.slice(8)) } : {}),
          },
        });
      }
      if (item.kind === "compaction" && item.outcome === "compacted" && type === "item.completed") {
        result.push({
          ...base,
          eventId: context.nextEventId(),
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            ...(item.tokensBefore != null ? { beforeTokens: item.tokensBefore } : {}),
            ...(item.tokensAfter != null ? { afterTokens: item.tokensAfter } : {}),
          },
        });
      }
      if (
        item.kind === "compaction" &&
        item.outcome !== "compacted" &&
        item.outcome !== "noop" &&
        type === "item.completed"
      ) {
        result.push({
          ...base,
          eventId: context.nextEventId(),
          type: "runtime.error",
          payload: {
            message: item.failureReason ?? `Muse Code compaction ${item.outcome ?? "failed"}.`,
          },
        });
      }
      return type === "item.started" ? [...result, ...backfill] : [...backfill, ...result];
    }
    case "item/delta": {
      const params = event.params;
      const item = context.itemById(params.itemId);
      const field = params.field ?? "text";
      if (field !== "text" && field !== "output" && !/^summary\.\d+$/.test(field)) return [];
      const streamKind = field.startsWith("summary.")
        ? "reasoning_summary_text"
        : field === "output"
          ? "command_output"
          : item?.kind === "reasoning"
            ? "reasoning_text"
            : item?.kind === "agentMessage"
              ? "assistant_text"
              : "unknown";
      return [
        {
          ...base,
          type: "content.delta",
          itemId: RuntimeItemId.make(params.itemId),
          ...(item?.turnId ? { turnId: TurnId.make(item.turnId) } : {}),
          ...(item?.turnId === null ? { turnId: undefined } : {}),
          payload: {
            streamKind,
            delta: params.delta,
            ...(field.startsWith("summary.") && /^summary\.\d+$/.test(field)
              ? { summaryIndex: Number(field.slice(8)) }
              : {}),
          },
        },
      ];
    }
    case "turn/retryScheduled":
      return [
        {
          ...base,
          type: "runtime.warning",
          turnId: TurnId.make(event.params.turnId),
          payload: {
            message: `Muse Code retry ${event.params.nextAttempt}/${event.params.maxAttempts} in ${event.params.retryDelayMs / 1_000}s: ${event.params.reason}`,
          },
        },
      ];
    case "turn/started":
      return [
        { ...base, type: "turn.started", turnId: TurnId.make(event.params.turnId), payload: {} },
      ];
    case "turn/completed": {
      const params = event.params;
      if (params.terminal === "failed" && params.reason === "incomplete") {
        return [];
      }
      return [
        {
          ...base,
          type: "turn.completed",
          turnId: TurnId.make(params.turnId),
          payload: {
            state:
              params.terminal === "completed"
                ? "completed"
                : params.terminal === "cancelled"
                  ? "cancelled"
                  : "failed",
            ...(params.reason ? { stopReason: params.reason } : {}),
            ...(params.error?.message ? { errorMessage: params.error.message } : {}),
            ...(params.error?.retryable !== undefined ? { retryable: params.error.retryable } : {}),
            ...(params.usage ? { usage: params.usage } : {}),
          },
        },
      ];
    }
    case "turn/unqueued":
      return [
        {
          ...base,
          type: "turn.aborted",
          turnId: TurnId.make(event.params.turnId),
          payload: { reason: "Queued turn removed" },
        },
      ];
    case "approval/requested":
    case "approval/updated": {
      const params = event.params;
      // T3 answers by decision, so each label must describe the first matching native choice.
      const options = params.availableChoices
        .flatMap((choice) => {
          const decision = museApprovalDecision(choice.decision, choice.scope);
          return decision ? [{ decision, label: choice.label }] : [];
        })
        .filter(
          (choice, index, choices) =>
            choices.findIndex((candidate) => candidate.decision === choice.decision) === index,
        );
      return [
        {
          ...base,
          type: "request.opened",
          requestId: RuntimeRequestId.make(params.approvalId),
          ...(event.method === "approval/requested"
            ? {
                turnId: TurnId.make(event.params.turnId),
                itemId: RuntimeItemId.make(event.params.itemId),
              }
            : {}),
          payload: {
            requestType: requestType(params.subject),
            detail:
              params.subject.command ||
              params.subject.path ||
              params.subject.toolName ||
              "Tool approval",
            options,
            args: params,
          },
        },
      ];
    }
    case "approval/resolved": {
      const subject = context.approvalSubjectById?.(event.params.approvalId);
      return [
        {
          ...base,
          type: "request.resolved",
          requestId: RuntimeRequestId.make(event.params.approvalId),
          turnId: TurnId.make(event.params.turnId),
          payload: {
            requestType: subject ? requestType(subject) : "unknown",
            decision:
              museApprovalDecision(event.params.decision, event.params.amendment?.durability) ??
              event.params.decision,
          },
        },
      ];
    }
    case "userInput/requested":
      return [
        {
          ...base,
          type: "user-input.requested",
          requestId: RuntimeRequestId.make(event.params.userInputId),
          itemId: RuntimeItemId.make(event.params.itemId),
          turnId: TurnId.make(event.params.turnId),
          payload: {
            questions: event.params.questions.map((question) => ({
              id: question.id,
              header: question.header,
              question: question.question,
              allowCustomAnswer: true,
              multiSelect: question.selection.mode === "multiple",
              options: question.options.map((option) => ({
                label: option.label,
                description: option.description ?? "",
              })),
            })),
          },
        },
      ];
    case "userInput/settled":
      return [
        {
          ...base,
          type: "user-input.resolved",
          requestId: RuntimeRequestId.make(event.params.userInputId),
          payload: {
            answers: Object.fromEntries(
              event.params.answers.map((answer) => [
                answer.questionId,
                answer.freeText ?? answer.selectedLabels ?? answer.selectedLabel ?? "",
              ]),
            ),
          },
        },
      ];
    case "session/todoListChanged":
      return [
        {
          ...base,
          type: "turn.plan.updated",
          payload: {
            plan: event.params.items
              .filter((item) => item.status !== "cancelled" && item.text.trim())
              .map((item) => ({
                step: item.text,
                status:
                  item.status === "completed"
                    ? "completed"
                    : item.status === "inProgress"
                      ? "inProgress"
                      : "pending",
              })),
          },
        },
      ];
    case "session/tokenUsage": {
      const usedTokens = context.contextUsedTokens ?? event.params.totalTokens;
      const maxTokens = context.contextWindowTokens ?? 1_000_000;
      return [
        {
          ...base,
          type: "thread.token-usage.updated",
          turnId: TurnId.make(event.params.turnId),
          payload: {
            usage: {
              usedTokens,
              maxTokens,
              totalProcessedTokens: event.params.cumulative.totalTokens,
              inputTokens: event.params.cumulative.promptTokens,
              outputTokens: event.params.cumulative.outputTokens,
              lastInputTokens: event.params.promptTokens,
              lastOutputTokens: event.params.usage.outputTokens,
              lastCachedInputTokens: event.params.usage.cachedTokens,
            },
          },
        },
      ];
    }
    case "session/contextUsage":
      return [
        {
          ...base,
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens: event.params.usedTokens,
              ...(event.params.windowTokens ? { maxTokens: event.params.windowTokens } : {}),
            },
          },
        },
      ];
  }
}
