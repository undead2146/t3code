import {
  type CanonicalItemType,
  type AntigravitySettings,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type AntigravityAdapterShape } from "../Services/AntigravityAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  isAntigravityEffortSupported,
  resolveAntigravityBinary,
  resolveAntigravityContextWindow,
} from "./AntigravityProvider.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");
const decodeJsonExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

export interface AntigravityAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

interface ActiveProcessHandle {
  readonly kill: () => Effect.Effect<void, never, never>;
}

interface TrackedSubagent {
  readonly taskId: RuntimeTaskId;
  readonly role?: string;
  readonly typeName?: string;
  readonly prompt?: string;
  readonly model?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  conversationId?: string;
  readonly stepIndex: number;
}

interface AntigravitySessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  cwd: string;
  antigravityConversationId: string | undefined;
  activeProcess: ActiveProcessHandle | undefined;
  activeTurnId: TurnId | undefined;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  stopped: boolean;
  lastKnownContextWindow: number | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  readonly subagents: Map<string, TrackedSubagent>;
}

interface RawSubagentInput {
  readonly Role?: string;
  readonly role?: string;
  readonly TypeName?: string;
  readonly typeName?: string;
  readonly Prompt?: string;
  readonly prompt?: string;
  readonly Model?: string;
  readonly model?: string;
  readonly Workspace?: string;
  readonly workspace?: string;
}

function parseSubagentsParam(parameters: unknown): ReadonlyArray<RawSubagentInput> {
  if (!parameters || typeof parameters !== "object") return [];
  const p = parameters as Record<string, unknown>;
  let raw = p.Subagents ?? p.subagents ?? p.Subagent ?? p.subagent ?? p.agents ?? p.Agents;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {}
  }
  if (Array.isArray(raw)) {
    return raw.filter(
      (item): item is RawSubagentInput => typeof item === "object" && item !== null,
    );
  }
  if (typeof raw === "object" && raw !== null) {
    return [raw as RawSubagentInput];
  }
  if (p.Prompt || p.prompt || p.Role || p.role || p.TypeName || p.typeName) {
    return [p as RawSubagentInput];
  }
  return [];
}

interface SubagentListEntry {
  readonly role?: string;
  readonly type?: string;
  readonly conversationId?: string;
  readonly transcript?: string;
  readonly state?: string;
  readonly stateDetail?: string;
}

function parseSubagentListFromOutput(data: unknown): ReadonlyArray<SubagentListEntry> {
  if (typeof data !== "string") return [];
  const start = data.indexOf("[");
  const end = data.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(data.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is SubagentListEntry => typeof item === "object" && item !== null,
        );
      }
    } catch {}
  }
  return [];
}

function toolNameToItemType(toolName: string): CanonicalItemType {
  switch (toolName) {
    case "run_command":
    case "command_status":
    case "send_command_input":
      return "command_execution";
    case "replace_file_content":
    case "multi_replace_file_content":
    case "write_to_file":
    case "sed_file":
    case "notebook_edit":
      return "file_change";
    case "view_file":
    case "list_dir":
    case "read_resource":
      return "dynamic_tool_call";
    case "search_web":
    case "read_url_content":
    case "grep_search":
    case "find_by_name":
      return "web_search";
    case "call_mcp_tool":
      return "mcp_tool_call";
    case "invoke_subagent":
    case "define_subagent":
    case "manage_subagents":
    case "send_message":
      return "collab_agent_tool_call";
    default:
      return "dynamic_tool_call";
  }
}

function toolParamsToDetail(parameters: unknown): string | undefined {
  if (!parameters || typeof parameters !== "object") return undefined;
  const p = parameters as Record<string, unknown>;
  if (p.Subagents !== undefined || p.subagents !== undefined) {
    const subagents = parseSubagentsParam(parameters);
    if (subagents.length > 0) {
      return subagents
        .map((s) => s.Role || s.role || s.TypeName || s.typeName || "Subagent")
        .join(", ");
    }
  }
  const candidate =
    p.CommandLine ??
    p.TargetFile ??
    p.AbsolutePath ??
    p.DirectoryPath ??
    p.Query ??
    p.query ??
    p.Url ??
    p.Prompt ??
    p.prompt ??
    p.Recipient ??
    p.recipient ??
    p.Action ??
    p.action;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

function parseAntigravityUsageSnapshot(
  rawUsage: unknown,
  contextWindow: number | undefined,
  existingUsage?: ThreadTokenUsageSnapshot,
  isResultEvent = false,
): ThreadTokenUsageSnapshot | undefined {
  if (!rawUsage || typeof rawUsage !== "object") {
    return undefined;
  }
  const usage = rawUsage as Record<string, unknown>;
  const count = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;

  const rawInputTokens = count(usage.input_tokens);
  const outputTokens = count(usage.output_tokens);
  const reasoningOutputTokens = count(usage.thinking_tokens);
  const cachedInputTokens = count(usage.cache_read_tokens ?? usage.cached_tokens);
  const totalTokens = count(usage.total_tokens);

  const maxTokens = contextWindow ?? existingUsage?.maxTokens ?? 1_000_000;

  if (isResultEvent) {
    // result.usage from agy represents cumulative lifetime totals across all turns of the session.
    // We update totalProcessedTokens, but MUST NOT overwrite the active context window usage.
    const totalProcessed =
      totalTokens ??
      (rawInputTokens !== undefined && outputTokens !== undefined
        ? rawInputTokens + outputTokens
        : undefined);
    const totalProcessedTokens =
      totalProcessed !== undefined
        ? Math.max(totalProcessed, existingUsage?.totalProcessedTokens ?? 0)
        : existingUsage?.totalProcessedTokens;

    if (existingUsage) {
      return {
        ...existingUsage,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
      };
    }

    const inputTokens = rawInputTokens ?? 0;
    const cachedTokens = cachedInputTokens ?? 0;
    const activeTokens = inputTokens + cachedTokens + (outputTokens ?? 0);
    if (activeTokens <= 0) {
      return undefined;
    }
    const usedTokens = Math.min(activeTokens, maxTokens);
    const rawCategories =
      usage.categories ??
      usage.category_breakdown ??
      usage.token_usage_by_category ??
      (typeof usage.by_category === "object" ? usage.by_category : undefined);
    const categoriesObj =
      typeof rawCategories === "object" && rawCategories !== null
        ? (rawCategories as Record<string, unknown>)
        : usage;

    const userMessages = count(
      categoriesObj.user_messages ??
        categoriesObj.user_messages_tokens ??
        categoriesObj.userMessages,
    );
    const agentResponses = count(
      categoriesObj.agent_responses ??
        categoriesObj.agent_responses_tokens ??
        categoriesObj.agentResponses,
    );
    const toolCalls = count(
      categoriesObj.tool_calls ?? categoriesObj.tool_calls_tokens ?? categoriesObj.toolCalls,
    );
    const systemPrompt = count(
      categoriesObj.system_prompt ??
        categoriesObj.system_prompt_tokens ??
        categoriesObj.systemPrompt,
    );
    const systemTools = count(
      categoriesObj.system_tools ?? categoriesObj.system_tools_tokens ?? categoriesObj.systemTools,
    );
    const skills = count(
      categoriesObj.skills ?? categoriesObj.skills_tokens ?? categoriesObj.skills,
    );
    const subagents = count(
      categoriesObj.subagents ?? categoriesObj.subagents_tokens ?? categoriesObj.subagents,
    );
    const checkpointBuffer = count(
      categoriesObj.checkpoint_buffer ??
        categoriesObj.checkpoint_buffer_tokens ??
        categoriesObj.checkpointBuffer,
    );

    const hasAnyCategory =
      userMessages !== undefined ||
      agentResponses !== undefined ||
      toolCalls !== undefined ||
      systemPrompt !== undefined ||
      systemTools !== undefined ||
      skills !== undefined ||
      subagents !== undefined ||
      checkpointBuffer !== undefined;

    const categories = hasAnyCategory
      ? {
          ...(userMessages !== undefined ? { userMessages } : {}),
          ...(agentResponses !== undefined ? { agentResponses } : {}),
          ...(toolCalls !== undefined ? { toolCalls } : {}),
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          ...(systemTools !== undefined ? { systemTools } : {}),
          ...(skills !== undefined ? { skills } : {}),
          ...(subagents !== undefined ? { subagents } : {}),
          ...(checkpointBuffer !== undefined ? { checkpointBuffer } : {}),
        }
      : existingUsage?.categories;

    return {
      usedTokens,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
      ...(inputTokens > 0 ? { inputTokens } : {}),
      ...(outputTokens !== undefined && outputTokens > 0 ? { outputTokens } : {}),
      ...(reasoningOutputTokens !== undefined && reasoningOutputTokens > 0
        ? { reasoningOutputTokens }
        : {}),
      ...(cachedTokens > 0 ? { cachedInputTokens: cachedTokens } : {}),
      compactsAutomatically: true,
      ...(categories ? { categories } : {}),
    };
  }

  // For step_update.usage (the active LLM call state in the conversation):
  // The context window size is the full prompt in the model (uncached + cached input tokens + generated output tokens).
  const inputTokens = rawInputTokens ?? 0;
  const cachedTokens = cachedInputTokens ?? 0;
  const activeTokens = inputTokens + cachedTokens + (outputTokens ?? 0);

  if (activeTokens <= 0) {
    return undefined;
  }

  const usedTokens = Math.min(activeTokens, maxTokens);
  const totalProcessedTokens = existingUsage?.totalProcessedTokens;

  const rawCategories =
    usage.categories ??
    usage.category_breakdown ??
    usage.token_usage_by_category ??
    (typeof usage.by_category === "object" ? usage.by_category : undefined);
  const categoriesObj =
    typeof rawCategories === "object" && rawCategories !== null
      ? (rawCategories as Record<string, unknown>)
      : usage;

  const userMessages = count(
    categoriesObj.user_messages ?? categoriesObj.user_messages_tokens ?? categoriesObj.userMessages,
  );
  const agentResponses = count(
    categoriesObj.agent_responses ??
      categoriesObj.agent_responses_tokens ??
      categoriesObj.agentResponses,
  );
  const toolCalls = count(
    categoriesObj.tool_calls ?? categoriesObj.tool_calls_tokens ?? categoriesObj.toolCalls,
  );
  const systemPrompt = count(
    categoriesObj.system_prompt ?? categoriesObj.system_prompt_tokens ?? categoriesObj.systemPrompt,
  );
  const systemTools = count(
    categoriesObj.system_tools ?? categoriesObj.system_tools_tokens ?? categoriesObj.systemTools,
  );
  const skills = count(categoriesObj.skills ?? categoriesObj.skills_tokens ?? categoriesObj.skills);
  const subagents = count(
    categoriesObj.subagents ?? categoriesObj.subagents_tokens ?? categoriesObj.subagents,
  );
  const checkpointBuffer = count(
    categoriesObj.checkpoint_buffer ??
      categoriesObj.checkpoint_buffer_tokens ??
      categoriesObj.checkpointBuffer,
  );

  const hasAnyCategory =
    userMessages !== undefined ||
    agentResponses !== undefined ||
    toolCalls !== undefined ||
    systemPrompt !== undefined ||
    systemTools !== undefined ||
    skills !== undefined ||
    subagents !== undefined ||
    checkpointBuffer !== undefined;

  const categories = hasAnyCategory
    ? {
        ...(userMessages !== undefined ? { userMessages } : {}),
        ...(agentResponses !== undefined ? { agentResponses } : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        ...(systemTools !== undefined ? { systemTools } : {}),
        ...(skills !== undefined ? { skills } : {}),
        ...(subagents !== undefined ? { subagents } : {}),
        ...(checkpointBuffer !== undefined ? { checkpointBuffer } : {}),
      }
    : existingUsage?.categories;

  return {
    usedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens !== undefined && outputTokens > 0 ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined && reasoningOutputTokens > 0
      ? { reasoningOutputTokens }
      : {}),
    ...(cachedTokens > 0 ? { cachedInputTokens: cachedTokens } : {}),
    compactsAutomatically: true,
    ...(categories ? { categories } : {}),
  };
}

export function makeAntigravityAdapter(
  settings: AntigravitySettings,
  options?: AntigravityAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const processEnv = options?.environment ?? process.env;

    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("antigravity");
    const sessions = new Map<ThreadId, AntigravitySessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        if (Option.isSome(existing)) {
          return Effect.succeed([existing.value, current] as const);
        }
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(current);
            next.set(threadId, semaphore);
            return [semaphore, next] as const;
          }),
        );
      });

    const withThreadLock = <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) =>
        Semaphore.withPermit(semaphore)(effect),
      );

    const publishEvent = (event: ProviderRuntimeEvent): Effect.Effect<void, never, never> =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Antigravity runtime identifier.",
            cause,
          }),
      ),
    );

    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const nextTurnId = Effect.map(randomUUIDv4, (id) => TurnId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<AntigravitySessionContext, ProviderAdapterError> =>
      Effect.sync(() => sessions.get(threadId)).pipe(
        Effect.flatMap((ctx) =>
          ctx && !ctx.stopped
            ? Effect.succeed(ctx)
            : Effect.fail(
                new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
              ),
        ),
      );

    const startSession: AntigravityAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const threadId = input.threadId;
          const existing = sessions.get(threadId);
          if (existing && !existing.stopped) {
            return existing.session;
          }

          const sessionScope = yield* Scope.make();
          const createdAt = yield* nowIso;
          const isTargetInstance =
            input.modelSelection?.instanceId === boundInstanceId ||
            !input.modelSelection?.instanceId;
          const session: ProviderSession = {
            threadId,
            status: "ready",
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            runtimeMode: input.runtimeMode,
            model: isTargetInstance ? input.modelSelection?.model : undefined,
            createdAt,
            updatedAt: createdAt,
          };

          const contextWindow = resolveAntigravityContextWindow(input.modelSelection);
          const ctx: AntigravitySessionContext = {
            threadId,
            session,
            scope: sessionScope,
            cwd: input.cwd ?? process.cwd(),
            antigravityConversationId: undefined,
            activeProcess: undefined,
            activeTurnId: undefined,
            turns: [],
            stopped: false,
            lastKnownContextWindow: contextWindow,
            lastKnownTokenUsage: undefined,
            subagents: new Map(),
          };

          sessions.set(threadId, ctx);

          const stamp = yield* makeEventStamp();
          yield* publishEvent({
            ...stamp,
            provider: PROVIDER,
            threadId,
            type: "session.started",
            payload: {},
          });

          return session;
        }),
      );

    const sendTurn: AntigravityAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const threadId = input.threadId;
          const ctx = yield* requireSession(threadId);

          if (ctx.activeProcess) {
            yield* ctx.activeProcess.kill();
            ctx.activeProcess = undefined;
          }

          const turnContextWindow = resolveAntigravityContextWindow(input.modelSelection);
          if (turnContextWindow !== undefined) {
            ctx.lastKnownContextWindow = turnContextWindow;
          }

          if (ctx.activeTurnId) {
            const abortedStamp = yield* makeEventStamp();
            yield* publishEvent({
              ...abortedStamp,
              provider: PROVIDER,
              threadId,
              turnId: ctx.activeTurnId,
              type: "turn.aborted",
              payload: {
                reason: "Superseded by new turn",
              },
            });
            yield* publishEvent({
              ...abortedStamp,
              provider: PROVIDER,
              threadId,
              turnId: ctx.activeTurnId,
              type: "turn.completed",
              payload: {
                state: "interrupted",
              },
            });
            ctx.activeTurnId = undefined;
          }

          const turnId = yield* nextTurnId;

          ctx.activeTurnId = turnId;
          const turnStartedAt = yield* nowIso;
          const turnStartEventId = yield* nextEventId;

          const turnRecord: { id: TurnId; items: Array<unknown> } = {
            id: turnId,
            items: [{ prompt: input.input ?? "" }],
          };
          ctx.turns.push(turnRecord);

          yield* publishEvent({
            eventId: turnStartEventId,
            provider: PROVIDER,
            threadId,
            turnId,
            createdAt: turnStartedAt,
            type: "turn.started",
            payload: {},
          });

          const binary = resolveAntigravityBinary(settings.binaryPath, processEnv);
          const args = ["--output-format", "stream-json", "--print-timeout", "24h"];

          if (settings.dangerouslySkipPermissions !== false) {
            args.push("--dangerously-skip-permissions");
          }

          if (ctx.cwd) {
            args.push("--add-dir", ctx.cwd);
          }

          const selectedModel = input.modelSelection?.model;
          const effortSupported = isAntigravityEffortSupported(selectedModel);
          const selectedEffort = effortSupported
            ? getModelSelectionStringOptionValue(input.modelSelection, "effort")
            : undefined;
          let effectiveEffort = selectedEffort || (effortSupported ? settings.effort : undefined);

          if (selectedModel) {
            args.push("--model", selectedModel);
          }

          // If effort is not specified, effort is supported, and model doesn't embed it in the slug, default to "medium"
          if (
            effortSupported &&
            !effectiveEffort &&
            (!selectedModel || !selectedModel.match(/-(low|medium|high)$/i))
          ) {
            effectiveEffort = "medium";
          }

          if (effortSupported && effectiveEffort) {
            args.push("--effort", effectiveEffort);
          }

          if (ctx.antigravityConversationId) {
            args.push("--conversation", ctx.antigravityConversationId);
          }

          const promptText = input.input ?? "";
          args.push("-p", promptText);

          const spawnCommand = yield* resolveSpawnCommand(binary, args, {
            env: processEnv,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId,
                  detail: `Failed to resolve spawn command (${binary})`,
                  cause,
                }),
            ),
            Effect.tapError((error) =>
              Effect.gen(function* () {
                ctx.activeTurnId = undefined;
                const completedStamp = yield* makeEventStamp();
                yield* publishEvent({
                  ...completedStamp,
                  provider: PROVIDER,
                  threadId,
                  turnId,
                  type: "turn.completed",
                  payload: {
                    state: "failed",
                    errorMessage: error.detail,
                  },
                });
              }),
            ),
          );

          const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: ctx.cwd,
            env: processEnv,
            shell: spawnCommand.shell,
          });

          const processHandle = yield* childProcessSpawner.spawn(command).pipe(
            Effect.provideService(Scope.Scope, ctx.scope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId,
                  detail: `Failed to spawn Antigravity CLI process (${binary})`,
                  cause,
                }),
            ),
            Effect.tapError((error) =>
              Effect.gen(function* () {
                ctx.activeTurnId = undefined;
                const completedStamp = yield* makeEventStamp();
                yield* publishEvent({
                  ...completedStamp,
                  provider: PROVIDER,
                  threadId,
                  turnId,
                  type: "turn.completed",
                  payload: {
                    state: "failed",
                    errorMessage: error.detail,
                  },
                });
              }),
            ),
          );

          ctx.activeProcess = {
            kill: () => Effect.asVoid(Effect.ignore(processHandle.kill())),
          };

          const stderrChunks: Array<string> = [];
          let hasEmittedText = false;
          let lastResultError: string | undefined;

          const monitorEffect = Effect.gen(function* () {
            yield* Stream.runForEach(
              processHandle.stderr.pipe(Stream.decodeText(), Stream.splitLines),
              (line) =>
                Effect.sync(() => {
                  const trimmed = line.trim();
                  if (trimmed) {
                    stderrChunks.push(trimmed);
                  }
                }),
            ).pipe(Effect.forkIn(ctx.scope));

            const stdoutLines = processHandle.stdout.pipe(Stream.decodeText(), Stream.splitLines);

            yield* Stream.runForEach(stdoutLines, (line) =>
              Effect.gen(function* () {
                const trimmed = line.trim();
                if (!trimmed) return;

                const decoded = decodeJsonExit(trimmed);
                if (
                  Exit.isSuccess(decoded) &&
                  typeof decoded.value === "object" &&
                  decoded.value !== null
                ) {
                  const data = decoded.value as Record<string, unknown>;
                  const stamp = yield* makeEventStamp();

                  if (nativeEventLogger) {
                    yield* nativeEventLogger.write(data, threadId);
                  }

                  if (data.event === "init") {
                    if (typeof data.conversation_id === "string") {
                      ctx.antigravityConversationId = data.conversation_id;
                    }
                    yield* publishEvent({
                      ...stamp,
                      provider: PROVIDER,
                      threadId,
                      turnId,
                      type: "session.state.changed",
                      payload: { state: "running" },
                    });
                  } else if (
                    data.event === "step_update" &&
                    typeof data.step_update === "object" &&
                    data.step_update !== null
                  ) {
                    const step = data.step_update as Record<string, unknown>;
                    turnRecord.items.push(step);

                    if (step.step_type === "agent_response") {
                      if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
                        hasEmittedText = true;
                        yield* publishEvent({
                          ...stamp,
                          provider: PROVIDER,
                          threadId,
                          turnId,
                          type: "content.delta",
                          payload: {
                            streamKind: "assistant_text",
                            delta: step.text_delta,
                          },
                        });
                      }
                    } else if (step.step_type === "tool" && typeof step.tool_name === "string") {
                      const toolItemType = toolNameToItemType(step.tool_name);
                      const toolInfo =
                        typeof step.tool_info === "object" && step.tool_info !== null
                          ? (step.tool_info as Record<string, unknown>)
                          : undefined;
                      const toolDetail = toolParamsToDetail(toolInfo?.parameters);
                      const itemId = RuntimeItemId.make(`step-${step.step_index}`);

                      if (step.state === "ACTIVE") {
                        yield* publishEvent({
                          ...stamp,
                          provider: PROVIDER,
                          threadId,
                          turnId,
                          itemId,
                          type: "item.started",
                          payload: {
                            itemType: toolItemType,
                            status: "inProgress",
                            title: step.tool_name,
                            ...(toolDetail ? { detail: toolDetail } : {}),
                            ...(toolInfo ? { data: toolInfo } : {}),
                          },
                        });

                        if (step.tool_name === "invoke_subagent") {
                          const stepIdx = Number(step.step_index) || 0;
                          const stepKey = `s${stepIdx}`;
                          if (!ctx.subagents.has(stepKey)) {
                            ctx.subagents.set(stepKey, {
                              taskId: RuntimeTaskId.make(`subagent-${threadId}-${stepKey}`),
                              role: "Subagent",
                              status: "running",
                              stepIndex: stepIdx,
                            });
                            const parsedList = parseSubagentsParam(toolInfo?.parameters);
                            const subagentList =
                              parsedList.length > 0 ? parsedList : [{ Role: "Subagent" }];
                            for (let idx = 0; idx < subagentList.length; idx++) {
                              const item = subagentList[idx]!;
                              const taskId = RuntimeTaskId.make(
                                `subagent-${threadId}-s${stepIdx}-i${idx}`,
                              );
                              const role =
                                item.Role ||
                                item.role ||
                                item.TypeName ||
                                item.typeName ||
                                "Subagent";
                              const prompt = item.Prompt || item.prompt;
                              const rawModel = item.Model || item.model;
                              const model =
                                rawModel && rawModel !== "inherit"
                                  ? rawModel
                                  : ctx.session.model || undefined;
                              const tracked: TrackedSubagent = {
                                taskId,
                                role,
                                typeName: item.TypeName || item.typeName,
                                prompt,
                                model,
                                status: "running",
                                stepIndex: stepIdx,
                              };
                              ctx.subagents.set(String(taskId), tracked);
                              ctx.subagents.set(`s${stepIdx}-i${idx}`, tracked);

                              yield* publishEvent({
                                ...stamp,
                                provider: PROVIDER,
                                threadId,
                                turnId,
                                type: "task.started",
                                payload: {
                                  taskId,
                                  title: role,
                                  ...(prompt ? { description: prompt.slice(0, 300) } : {}),
                                  ...(role ? { role } : {}),
                                  ...(model ? { model } : {}),
                                  taskType: "subagent",
                                  agentKind: "agent",
                                  timelineBypass: false,
                                },
                              });
                            }
                          }
                        } else if (step.tool_name === "send_message") {
                          const p = (toolInfo?.parameters ?? {}) as Record<string, unknown>;
                          const recipient = (p.Recipient || p.recipient) as string | undefined;
                          const message = (p.Message || p.message) as string | undefined;
                          if (recipient) {
                            const tracked = ctx.subagents.get(recipient);
                            if (tracked && tracked.status === "running") {
                              yield* publishEvent({
                                ...stamp,
                                provider: PROVIDER,
                                threadId,
                                turnId,
                                type: "task.progress",
                                payload: {
                                  taskId: tracked.taskId,
                                  description: tracked.prompt || tracked.role || "Subagent",
                                  summary: message
                                    ? `Sent message: ${message.slice(0, 100)}`
                                    : "Sent message to subagent",
                                  lastToolName: "send_message",
                                  status: "running",
                                  taskType: "subagent",
                                  agentKind: "agent",
                                  ...(tracked.role ? { role: tracked.role } : {}),
                                  ...(tracked.model ? { model: tracked.model } : {}),
                                },
                              });
                            }
                          }
                        } else if (step.tool_name === "manage_subagents") {
                          const p = (toolInfo?.parameters ?? {}) as Record<string, unknown>;
                          const action = (p.Action || p.action) as string | undefined;
                          const convIds = (p.ConversationIds ||
                            p.conversation_ids ||
                            p.conversationIds) as unknown;
                          if (action === "kill_all") {
                            for (const tracked of ctx.subagents.values()) {
                              if (tracked.status === "running") {
                                tracked.status = "cancelled";
                                yield* publishEvent({
                                  ...stamp,
                                  provider: PROVIDER,
                                  threadId,
                                  turnId,
                                  type: "task.completed",
                                  payload: {
                                    taskId: tracked.taskId,
                                    status: "cancelled",
                                    taskType: "subagent",
                                    agentKind: "agent",
                                  },
                                });
                              }
                            }
                          } else if (action === "kill" && Array.isArray(convIds)) {
                            for (const cid of convIds) {
                              if (typeof cid === "string") {
                                const tracked = ctx.subagents.get(cid);
                                if (tracked && tracked.status === "running") {
                                  tracked.status = "cancelled";
                                  yield* publishEvent({
                                    ...stamp,
                                    provider: PROVIDER,
                                    threadId,
                                    turnId,
                                    type: "task.completed",
                                    payload: {
                                      taskId: tracked.taskId,
                                      status: "cancelled",
                                      taskType: "subagent",
                                      agentKind: "agent",
                                    },
                                  });
                                }
                              }
                            }
                          }
                        }
                      } else if (
                        step.state === "DONE" ||
                        step.state === "ERROR" ||
                        step.state === "CANCELLED" ||
                        step.state === "FAILED"
                      ) {
                        yield* publishEvent({
                          ...stamp,
                          provider: PROVIDER,
                          threadId,
                          turnId,
                          itemId,
                          type: "item.completed",
                          payload: {
                            itemType: toolItemType,
                            status: step.state === "DONE" ? "completed" : "failed",
                            title: step.tool_name,
                            ...(toolDetail ? { detail: toolDetail } : {}),
                            ...(toolInfo ? { data: toolInfo } : {}),
                          },
                        });

                        if (step.tool_name === "invoke_subagent") {
                          const stepIdx = Number(step.step_index) || 0;
                          const stepKey = `s${stepIdx}`;
                          if (!ctx.subagents.has(stepKey)) {
                            ctx.subagents.set(stepKey, {
                              taskId: RuntimeTaskId.make(`subagent-${threadId}-${stepKey}`),
                              role: "Subagent",
                              status: "running",
                              stepIndex: stepIdx,
                            });
                            const parsedList = parseSubagentsParam(toolInfo?.parameters);
                            const subagentList =
                              parsedList.length > 0 ? parsedList : [{ Role: "Subagent" }];
                            for (let idx = 0; idx < subagentList.length; idx++) {
                              const item = subagentList[idx]!;
                              const taskId = RuntimeTaskId.make(
                                `subagent-${threadId}-s${stepIdx}-i${idx}`,
                              );
                              const role =
                                item.Role ||
                                item.role ||
                                item.TypeName ||
                                item.typeName ||
                                "Subagent";
                              const prompt = item.Prompt || item.prompt;
                              const rawModel = item.Model || item.model;
                              const model =
                                rawModel && rawModel !== "inherit"
                                  ? rawModel
                                  : ctx.session.model || undefined;
                              const tracked: TrackedSubagent = {
                                taskId,
                                role,
                                typeName: item.TypeName || item.typeName,
                                prompt,
                                model,
                                status: "running",
                                stepIndex: stepIdx,
                              };
                              ctx.subagents.set(String(taskId), tracked);
                              ctx.subagents.set(`s${stepIdx}-i${idx}`, tracked);

                              yield* publishEvent({
                                ...stamp,
                                provider: PROVIDER,
                                threadId,
                                turnId,
                                type: "task.started",
                                payload: {
                                  taskId,
                                  title: role,
                                  ...(prompt ? { description: prompt.slice(0, 300) } : {}),
                                  ...(role ? { role } : {}),
                                  ...(model ? { model } : {}),
                                  taskType: "subagent",
                                  agentKind: "agent",
                                  timelineBypass: false,
                                },
                              });
                            }
                          }

                          const isFailed = step.state !== "DONE";
                          if (isFailed) {
                            for (const tracked of ctx.subagents.values()) {
                              if (tracked.stepIndex === stepIdx && tracked.status === "running") {
                                tracked.status = "failed";
                                yield* publishEvent({
                                  ...stamp,
                                  provider: PROVIDER,
                                  threadId,
                                  turnId,
                                  type: "task.completed",
                                  payload: {
                                    taskId: tracked.taskId,
                                    status: "failed",
                                    taskType: "subagent",
                                    agentKind: "agent",
                                    error: `Subagent launch failed (${step.state})`,
                                  },
                                });
                              }
                            }
                          }
                        } else if (step.tool_name === "manage_subagents") {
                          const output =
                            typeof step.content === "string"
                              ? step.content
                              : typeof toolInfo?.output === "string"
                                ? toolInfo.output
                                : typeof step.output === "string"
                                  ? step.output
                                  : "";
                          const listedSubagents = parseSubagentListFromOutput(output);
                          for (const sub of listedSubagents) {
                            const cid = sub.conversationId;
                            if (!cid) continue;
                            const taskId = RuntimeTaskId.make(cid);
                            const role = sub.role || sub.type || "Subagent";
                            const rawStatus = sub.state;
                            const status =
                              rawStatus === "completed"
                                ? "completed"
                                : rawStatus === "errored" || rawStatus === "failed"
                                  ? "failed"
                                  : rawStatus === "idle"
                                    ? "idle"
                                    : "running";

                            if (!ctx.subagents.has(cid)) {
                              const tracked: TrackedSubagent = {
                                taskId,
                                role,
                                typeName: sub.type,
                                status:
                                  status === "completed" || status === "failed"
                                    ? status
                                    : "running",
                                stepIndex: Number(step.step_index) || 0,
                              };
                              ctx.subagents.set(cid, tracked);
                              ctx.subagents.set(String(taskId), tracked);

                              yield* publishEvent({
                                ...stamp,
                                provider: PROVIDER,
                                threadId,
                                turnId,
                                type: "task.started",
                                payload: {
                                  taskId,
                                  title: role,
                                  role,
                                  taskType: "subagent",
                                  agentKind: "agent",
                                  timelineBypass: false,
                                  runHandles: {
                                    runId: cid,
                                    ...(sub.transcript ? { scriptPath: sub.transcript } : {}),
                                  },
                                },
                              });
                            }

                            if (status === "completed" || status === "failed") {
                              yield* publishEvent({
                                ...stamp,
                                provider: PROVIDER,
                                threadId,
                                turnId,
                                type: "task.completed",
                                payload: {
                                  taskId,
                                  status,
                                  taskType: "subagent",
                                  agentKind: "agent",
                                },
                              });
                            } else if (sub.stateDetail) {
                              yield* publishEvent({
                                ...stamp,
                                provider: PROVIDER,
                                threadId,
                                turnId,
                                type: "task.progress",
                                payload: {
                                  taskId,
                                  title: role,
                                  role,
                                  summary: sub.stateDetail,
                                  lastToolName: sub.stateDetail.split(":")[0]?.trim() || "subagent",
                                  status: "running",
                                  taskType: "subagent",
                                  agentKind: "agent",
                                },
                              });
                            }
                          }
                        }
                      }
                    } else if (step.step_type === "error_message") {
                      const errorText =
                        typeof step.error === "string"
                          ? step.error
                          : typeof step.content === "string"
                            ? step.content
                            : undefined;
                      if (errorText) {
                        yield* publishEvent({
                          ...stamp,
                          provider: PROVIDER,
                          threadId,
                          turnId,
                          type: "content.delta",
                          payload: {
                            streamKind: "assistant_text",
                            delta: `\n\n> ⚠️ **Antigravity Notice**: ${errorText}\n\n`,
                          },
                        });
                      }
                    }

                    if (
                      step.step_type !== "checkpoint" &&
                      typeof step.usage === "object" &&
                      step.usage !== null
                    ) {
                      const usageSnapshot = parseAntigravityUsageSnapshot(
                        step.usage,
                        ctx.lastKnownContextWindow,
                        ctx.lastKnownTokenUsage,
                        false,
                      );
                      if (usageSnapshot) {
                        ctx.lastKnownTokenUsage = usageSnapshot;
                        yield* publishEvent({
                          ...stamp,
                          provider: PROVIDER,
                          threadId,
                          turnId,
                          type: "thread.token-usage.updated",
                          payload: { usage: usageSnapshot },
                        });
                      }
                    }
                  } else if (
                    data.event === "result" &&
                    typeof data.result === "object" &&
                    data.result !== null
                  ) {
                    const resultObj = data.result as Record<string, unknown>;
                    turnRecord.items.push(resultObj);
                    if (typeof resultObj.conversation_id === "string") {
                      ctx.antigravityConversationId = resultObj.conversation_id;
                    }
                    if (resultObj.status === "ERROR" && typeof resultObj.error === "string") {
                      lastResultError = resultObj.error;
                      const formattedError =
                        resultObj.error === "timeout waiting for response"
                          ? "timeout waiting for response (synchronous tool execution exceeded time limit; run long commands/builds in background with WaitMsBeforeAsync or manage_task)"
                          : resultObj.error;
                      yield* publishEvent({
                        ...stamp,
                        provider: PROVIDER,
                        threadId,
                        turnId,
                        type: "content.delta",
                        payload: {
                          streamKind: "assistant_text",
                          delta: `\n\n**Antigravity Error**: ${formattedError}\n`,
                        },
                      });
                    }
                    if (
                      typeof resultObj.response === "string" &&
                      !hasEmittedText &&
                      resultObj.response.length > 0
                    ) {
                      hasEmittedText = true;
                      yield* publishEvent({
                        ...stamp,
                        provider: PROVIDER,
                        threadId,
                        turnId,
                        type: "content.delta",
                        payload: {
                          streamKind: "assistant_text",
                          delta: resultObj.response,
                        },
                      });
                    }
                    if (typeof resultObj.usage === "object" && resultObj.usage !== null) {
                      const usageSnapshot = parseAntigravityUsageSnapshot(
                        resultObj.usage,
                        ctx.lastKnownContextWindow,
                        ctx.lastKnownTokenUsage,
                        true,
                      );
                      if (usageSnapshot) {
                        ctx.lastKnownTokenUsage = usageSnapshot;
                        yield* publishEvent({
                          ...stamp,
                          provider: PROVIDER,
                          threadId,
                          turnId,
                          type: "thread.token-usage.updated",
                          payload: { usage: usageSnapshot },
                        });
                      }
                    }
                  }
                }
              }),
            );

            const exitCode = yield* processHandle.exitCode;
            const isSuccess =
              exitCode === 0 && (!lastResultError || hasEmittedText || turnRecord.items.length > 0);
            const errorDetail =
              (exitCode !== 0 ? lastResultError : undefined) ||
              (stderrChunks.length > 0 ? stderrChunks.join("\n") : undefined) ||
              (!isSuccess ? `Antigravity CLI process exited with code ${exitCode}` : undefined);

            yield* withThreadLock(
              threadId,
              Effect.gen(function* () {
                if (ctx.activeTurnId !== turnId) return;
                ctx.activeProcess = undefined;
                ctx.activeTurnId = undefined;

                const completedStamp = yield* makeEventStamp();
                yield* publishEvent({
                  ...completedStamp,
                  provider: PROVIDER,
                  threadId,
                  turnId,
                  type: "turn.completed",
                  payload: {
                    state: isSuccess ? "completed" : "failed",
                    ...(!isSuccess ? { errorMessage: errorDetail } : {}),
                  },
                });
              }),
            );
          }).pipe(
            Effect.catchCause((cause) =>
              withThreadLock(
                threadId,
                Effect.gen(function* () {
                  if (Cause.hasInterruptsOnly(cause)) {
                    return yield* Effect.failCause(cause);
                  }
                  if (ctx.activeTurnId !== turnId) return;
                  if (ctx.activeProcess) {
                    yield* ctx.activeProcess.kill();
                    ctx.activeProcess = undefined;
                  }
                  ctx.activeTurnId = undefined;

                  const completedStamp = yield* makeEventStamp();
                  yield* publishEvent({
                    ...completedStamp,
                    provider: PROVIDER,
                    threadId,
                    turnId,
                    type: "turn.completed",
                    payload: {
                      state: "failed",
                      errorMessage: "Antigravity CLI process monitor failed.",
                    },
                  });
                  yield* Effect.logWarning("Antigravity process monitor failed", {
                    cause,
                  });
                }),
              ),
            ),
          );

          yield* Effect.forkIn(monitorEffect, ctx.scope);

          return {
            threadId,
            turnId,
          };
        }),
      );

    const interruptTurn: AntigravityAdapterShape["interruptTurn"] = (threadId, turnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) {
            if (turnId) {
              const stamp = yield* makeEventStamp();
              yield* publishEvent({
                ...stamp,
                provider: PROVIDER,
                threadId,
                turnId,
                type: "turn.aborted",
                payload: {
                  reason: "Turn interrupted by user",
                },
              });
              yield* publishEvent({
                ...stamp,
                provider: PROVIDER,
                threadId,
                turnId,
                type: "turn.completed",
                payload: {
                  state: "interrupted",
                },
              });
            }
            return;
          }

          if (turnId !== undefined && ctx.activeTurnId !== turnId) {
            return;
          }

          const effectiveTurnId = turnId ?? ctx.activeTurnId;
          if (ctx.activeProcess) {
            yield* ctx.activeProcess.kill();
            ctx.activeProcess = undefined;
          }

          if (effectiveTurnId) {
            ctx.activeTurnId = undefined;
            const stamp = yield* makeEventStamp();

            yield* publishEvent({
              ...stamp,
              provider: PROVIDER,
              threadId,
              turnId: effectiveTurnId,
              type: "turn.aborted",
              payload: {
                reason: "Turn interrupted by user",
              },
            });

            yield* publishEvent({
              ...stamp,
              provider: PROVIDER,
              threadId,
              turnId: effectiveTurnId,
              type: "turn.completed",
              payload: {
                state: "interrupted",
              },
            });
          }
        }),
      );

    const respondToRequest: AntigravityAdapterShape["respondToRequest"] = () => Effect.void;

    const respondToUserInput: AntigravityAdapterShape["respondToUserInput"] = () => Effect.void;

    const stopSessionInternal = (
      ctx: AntigravitySessionContext,
    ): Effect.Effect<void, ProviderAdapterError, never> =>
      Effect.gen(function* () {
        ctx.stopped = true;
        if (ctx.activeProcess) {
          yield* ctx.activeProcess.kill();
          ctx.activeProcess = undefined;
        }

        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
        sessions.delete(ctx.threadId);

        const stamp = yield* makeEventStamp();
        yield* publishEvent({
          ...stamp,
          provider: PROVIDER,
          threadId: ctx.threadId,
          type: "session.exited",
          payload: {
            exitKind: "graceful",
          },
        });
      });

    const stopSession: AntigravityAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) {
            const stamp = yield* makeEventStamp();
            yield* publishEvent({
              ...stamp,
              provider: PROVIDER,
              threadId,
              type: "session.exited",
              payload: {
                exitKind: "graceful",
              },
            });
            return;
          }
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: AntigravityAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: AntigravityAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const readThread: AntigravityAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          turns: ctx.turns.map((turn) => ({
            id: turn.id,
            items: turn.items,
          })),
        };
      });

    const rollbackThread: AntigravityAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Antigravity CLI sessions do not support provider-side rollback.",
        });
      });

    const stopAll: AntigravityAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
        Effect.tap(() =>
          managedNativeEventLogger ? managedNativeEventLogger.close() : Effect.void,
        ),
      ),
    );

    const streamEvents = Stream.fromQueue(runtimeEventQueue);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents,
    } satisfies AntigravityAdapterShape;
  });
}
