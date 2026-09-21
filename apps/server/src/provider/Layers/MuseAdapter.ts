// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  createUuidV7Mint,
  spawnMspConnection,
  type MspHandshake,
  type SpawnedMspConnection,
} from "@muse-code/sdk";
import {
  EventId,
  MUSE_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  TurnId,
  type MuseSettings,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/hostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  MuseSkillCatalog,
  museSkillMentions,
  planMuseSkillDispatch,
  type MuseSkillDispatch,
} from "../Drivers/MuseSkills.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import {
  decodeMuseModelSelection,
  MUSE_ROUTED_MODEL_PREFIX,
  MuseModelCatalog,
} from "../muse/MuseModels.ts";
import {
  decodeMuseNotification,
  isMuseNotificationMethod,
  isRetryableMuseError,
  itemType,
  mapMuseNotification,
  MuseItem,
  museApprovalDecision,
  museTransportTruncationSignature,
  type MuseNotification,
} from "../muse/MuseRuntimeEvents.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type * as ProviderAdapter from "../Services/ProviderAdapter.ts";

type Adapter = ProviderAdapter.ProviderAdapterShape<ProviderAdapterError>;

const PROVIDER = ProviderDriverKind.make("muse");
const encodePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const ResumeCursor = Schema.Struct({
  sessionId: Schema.String,
  schemaVersion: Schema.Literal(1),
  selectedModel: Schema.optional(Schema.String),
});
const SessionResult = Schema.Struct({
  session: Schema.Struct({
    sessionId: Schema.String,
    workspaceRoot: Schema.String,
    modelId: Schema.NullOr(Schema.String),
    status: Schema.String,
    activeTurnId: Schema.NullOr(Schema.String),
  }),
  history: Schema.optional(
    Schema.Struct({
      mode: Schema.String,
      items: Schema.NullOr(Schema.Array(MuseItem)),
      snapshot: Schema.NullOr(
        Schema.Struct({ state: Schema.Struct({ items: Schema.Array(MuseItem) }) }),
      ),
    }),
  ),
});
const TurnResult = Schema.Struct({
  status: Schema.Literal("accepted"),
  turnId: Schema.String,
  startedNewTurn: Schema.optional(Schema.Boolean),
  disposition: Schema.optional(Schema.Literals(["started", "queued", "steered"])),
});
const CompactResult = Schema.Struct({
  status: Schema.Literals(["accepted", "noop"]),
  reason: Schema.optional(Schema.String),
});
const decodeResumeCursor = Schema.decodeUnknownEffect(ResumeCursor);
const decodeAnswer = Schema.decodeUnknownEffect(
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
type Approval = Extract<
  MuseNotification,
  { method: "approval/requested" | "approval/updated" }
>["params"];
export function killMuseProcessTree(childOrHandshake: unknown): void {
  if (process.platform !== "win32" || !childOrHandshake) return;
  try {
    const candidate = (childOrHandshake as { child?: unknown })?.child ?? childOrHandshake;
    let pid: number | undefined;

    if (typeof (candidate as { pid?: unknown }).pid === "number") {
      pid = (candidate as { pid: number }).pid;
    }

    if (pid === undefined) {
      const proto = Object.getPrototypeOf(candidate);
      const symbols = proto ? Object.getOwnPropertySymbols(proto) : [];
      for (const sym of symbols) {
        if (sym.description === "MuseServeChild.transport" || String(sym).includes("transport")) {
          const transportGetter = (candidate as Record<symbol, () => { child?: { pid?: number } }>)[
            sym
          ];
          const transport =
            typeof transportGetter === "function" ? transportGetter.call(candidate) : undefined;
          if (typeof transport?.child?.pid === "number") {
            pid = transport.child.pid;
            break;
          }
        }
      }
    }

    if (typeof pid === "number" && pid > 0) {
      NodeChildProcess.spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
      });
    }
  } catch {
    // Best-effort process tree termination
  }
}

type StartSessionInput = Parameters<Adapter["startSession"]>[0];
type UserInput = Extract<MuseNotification, { method: "userInput/requested" }>["params"];
interface SessionContext {
  session: ProviderSession;
  sessionId: string;
  host: SpawnedMspConnection;
  handshake: MspHandshake;
  scope: Scope.Closeable;
  lock: Semaphore.Semaphore;
  items: Map<string, MuseItem>;
  streamed: Map<string, string>;
  deltaCursors: Map<string, Set<string>>;
  approvals: Map<string, Approval>;
  questions: Map<string, UserInput>;
  settledTurns: Set<string>;
  selectedModel: string;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  pendingTokenUsage: Map<string, Extract<MuseNotification, { method: "session/tokenUsage" }>>;
  stopped: boolean;
  transportRetryStreak: { turnId: string; signature: string; count: number } | undefined;
  lastTransportMitigationTurnId: string | undefined;
  transportStreakCompacted: boolean;
  lastTurnStart: { parts: Array<Record<string, unknown>>; reasoningEffort?: string } | undefined;
  transientFailureStreak: { count: number } | undefined;
  transientRetryPending: { failedTurnId: string; attempt: number; cancelled: boolean } | undefined;
  startInput: StartSessionInput;
  needsRestart?: boolean;
  lastViewCursor?: string;
  isPagingView?: boolean;
  drainTimer?: ReturnType<typeof setInterval> | undefined;
}

// Consecutive identical truncated-stream retries after which the turn is interrupted:
// transient blips recover within an attempt or two, while a deterministic cutoff fails
// all ten CLI attempts the same way.
const TRANSPORT_TRUNCATION_INTERRUPT_STREAK = 4;

// T3-level redrives of turns the CLI failed with a transient backend error
// (503/overloaded/rate-limit/network). The CLI already burned its own ten
// attempts, so this is a small second budget with backoff, mirroring the
// Antigravity adapter's MAX_TURN_RETRIES — but patient: post-exhaustion
// implies an outage measured in minutes, and each redrive can itself fail
// slowly, so attempts wait for the backend to plausibly recover instead of
// hammering it. Deterministic failures (truncation, auth, quota) never
// consume it.
const MUSE_TRANSIENT_RETRY_DELAYS_MS = [15_000, 60_000, 300_000];

// Item kinds whose presence means the turn already acted on the world: an
// automatic redrive would execute them twice, so those turns fail with
// retryable:true for a manual resend instead.
const TRANSIENT_RETRY_SIDE_EFFECT_KINDS: ReadonlySet<string> = new Set([
  "userShell",
  "toolCall",
  "subagent",
  "workflow",
  "reminderChild",
]);

function hasActiveWorkflowOrSubagent(ctx: SessionContext): boolean {
  for (const item of ctx.items.values()) {
    if ((item.kind === "workflow" || item.kind === "subagent") && item.status === "inProgress") {
      return true;
    }
  }
  return false;
}

export async function healWindowsSkillSymlinks(cwd: string): Promise<void> {
  if (process.platform !== "win32") return;
  const skillDirs = [
    [".claude", "skills"],
    [".agents", "skills"],
    [".gemini", "skills"],
  ];
  for (const parts of skillDirs) {
    const fullPath = NodePath.join(cwd, ...parts);
    try {
      const stat = await NodeFSP.lstat(fullPath);
      if (stat.isFile()) {
        const targetRel = (await NodeFSP.readFile(fullPath, "utf-8")).trim();
        const targetAbs = NodePath.resolve(NodePath.dirname(fullPath), targetRel);
        const targetStat = await NodeFSP.stat(targetAbs).catch(() => null);
        if (targetStat?.isDirectory()) {
          await NodeFSP.unlink(fullPath);
          await NodeFSP.symlink(targetAbs, fullPath, "junction");
        }
      }
    } catch {
      // Ignore errors if directory/file does not exist or cannot be accessed.
    }
  }
}

export function arePathsEquivalent(pathA: string, pathB: string): boolean {
  if (pathA === pathB) return true;
  const normA = NodePath.normalize(pathA);
  const normB = NodePath.normalize(pathB);
  if (normA === normB) return true;
  if (process.platform === "win32") {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  return false;
}

export function make(
  settings: MuseSettings,
  options?: {
    environment?: NodeJS.ProcessEnv;
    instanceId?: ProviderInstanceId;
    transientRetryDelaysMs?: ReadonlyArray<number>;
  },
) {
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const clock = yield* Clock.Clock;
    const nowIso = () => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
    const instanceId = options?.instanceId ?? ProviderInstanceId.make("muse");
    const environment = options?.environment ?? (yield* HostProcess.HostProcessEnvironment);
    const sessions = new Map<ThreadId, SessionContext>();
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const lifecycle = yield* Semaphore.make(1);
    const mintEventId = createUuidV7Mint();
    const nextEventId = () => EventId.make(mintEventId());
    const transientRetryDelays = options?.transientRetryDelaysMs ?? MUSE_TRANSIENT_RETRY_DELAYS_MS;
    const requestError = (method: string, cause: unknown) => {
      let detail = "Muse Code rejected the request or its response was invalid.";
      if (typeof cause === "string" && cause.trim().length > 0) {
        detail = cause;
      } else if (Schema.is(ProviderAdapterRequestError)(cause)) {
        detail = cause.detail;
      } else if (cause instanceof Error && cause.message.trim().length > 0) {
        detail = cause.message;
      } else if (
        typeof cause === "object" &&
        cause !== null &&
        "message" in cause &&
        typeof (cause as { message: unknown }).message === "string" &&
        (cause as { message: string }).message.trim().length > 0
      ) {
        detail = (cause as { message: string }).message;
      }
      return new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail,
        ...(typeof cause === "string" ? {} : { cause }),
      });
    };
    const attempt = <A>(
      method: string,
      run: () => Promise<A>,
      timeoutDuration: Duration.Duration | string | number = "60 seconds",
    ) =>
      Effect.tryPromise({ try: run, catch: (cause) => requestError(method, cause) }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutDuration,
          orElse: () => Effect.fail(requestError(method, `${method} timed out`)),
        }),
      );
    const resolveModelSelection = Effect.fn("MuseAdapter.resolveModelSelection")(function* (
      host: SpawnedMspConnection,
      model: string,
    ) {
      const catalog = yield* attempt("model/list", () =>
        host.connection.request("model/list", {}),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(MuseModelCatalog)),
        Effect.mapError((cause) => requestError("model/list", cause)),
      );
      const routing = decodeMuseModelSelection(model);
      const matches = catalog.models.filter((entry) =>
        routing
          ? entry.modelId === routing.modelId &&
            entry.providerId === routing.providerId &&
            entry.profileId === routing.profileId
          : model === MUSE_DEFAULT_MODEL
            ? entry.isDefault
            : entry.modelId === model,
      );
      const match = matches[0];
      if (
        match &&
        matches.some(
          (entry) =>
            entry.modelId !== match.modelId ||
            entry.providerId !== match.providerId ||
            entry.profileId !== match.profileId,
        )
      )
        return yield* requestError(
          "session/setModel",
          "Muse Code reported ambiguous model routing. Select a model with a unique provider profile.",
        );
      if (match)
        return {
          modelId: match.modelId,
          providerId: match.providerId,
          profileId: match.profileId,
          displayLabel: match.displayLabel,
        };
      if (model === MUSE_DEFAULT_MODEL)
        return yield* requestError(
          "session/setModel",
          "Muse Code did not report its default model. Select an explicit model or start a new thread to use its startup default.",
        );
      if (model.startsWith(MUSE_ROUTED_MODEL_PREFIX))
        return yield* requestError(
          "session/setModel",
          "The selected Muse model profile is no longer available. Select a model from the current catalog.",
        );
      return { modelId: model };
    });
    const base = (ctx: SessionContext) => ({
      eventId: nextEventId(),
      provider: PROVIDER,
      providerInstanceId: instanceId,
      threadId: ctx.session.threadId,
      createdAt: nowIso(),
    });
    const emit = (event: ProviderRuntimeEvent) => {
      Queue.offerUnsafe(events, event);
    };
    const requireSession = Effect.fn("MuseAdapter.requireSession")(function* (threadId: ThreadId) {
      const ctx = sessions.get(threadId);
      if (!ctx || (ctx.stopped && !ctx.needsRestart))
        return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      return ctx;
    });
    const failSession = (ctx: SessionContext, message: string) => {
      if (ctx.stopped) return;
      ctx.stopped = true;
      stopDrainTimer(ctx);
      const turnId = ctx.session.activeTurnId;
      ctx.session = { ...ctx.session, status: "error", lastError: message, updatedAt: nowIso() };
      if (turnId && !ctx.settledTurns.has(turnId)) {
        ctx.settledTurns.add(turnId);
        emit({
          ...base(ctx),
          type: "turn.completed",
          turnId,
          payload: { state: "failed", errorMessage: message },
        });
      }
      emit({
        ...base(ctx),
        type: "runtime.error",
        ...(turnId ? { turnId } : {}),
        payload: { message },
      });
      emit({
        ...base(ctx),
        type: "session.exited",
        payload: { reason: message, recoverable: true },
      });
      // MSP invokes this at its native callback boundary, outside an Effect fiber.
      void Effect.runPromise(
        lifecycle.withPermit(
          Effect.gen(function* () {
            yield* Scope.close(ctx.scope, Exit.void);
            if (sessions.get(ctx.session.threadId) === ctx) sessions.delete(ctx.session.threadId);
          }),
        ),
      ).catch(() => undefined);
    };

    let drainViewPages: (ctx: SessionContext) => Promise<void>;

    const startDrainTimer = (ctx: SessionContext) => {
      if (ctx.drainTimer) return;
      ctx.drainTimer = setInterval(() => {
        if (ctx.stopped || ctx.session.status !== "running" || !ctx.session.activeTurnId) {
          stopDrainTimer(ctx);
          return;
        }
        void drainViewPages(ctx);
      }, 5_000);
    };

    const stopDrainTimer = (ctx: SessionContext) => {
      if (ctx.drainTimer) {
        clearInterval(ctx.drainTimer);
        ctx.drainTimer = undefined;
      }
    };

    drainViewPages = async (ctx: SessionContext): Promise<void> => {
      if (ctx.stopped || ctx.isPagingView || !ctx.host || !ctx.sessionId) return;
      ctx.isPagingView = true;
      try {
        let currentCursor = ctx.lastViewCursor;
        let pageCount = 0;
        const MAX_PAGES = 50;

        while (pageCount < MAX_PAGES && !ctx.stopped) {
          pageCount++;
          const requestPromise = ctx.host.connection.request("view/page", {
            sessionId: ctx.sessionId,
            ...(currentCursor ? { cursor: currentCursor } : {}),
            direction: "forward",
            limit: 200,
          }) as Promise<
            | {
                events?: Array<{ method: string; params?: unknown }>;
                nextCursor?: string | null;
              }
            | undefined
          >;

          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("view/page timeout")), 10_000),
          );

          const result = await Promise.race([requestPromise, timeoutPromise]);

          if (!result || !Array.isArray(result.events) || result.events.length === 0) {
            break;
          }

          for (const item of result.events) {
            receive(ctx, item);
          }

          if (!result.nextCursor || result.nextCursor === currentCursor) {
            break;
          }
          currentCursor = result.nextCursor;
        }
      } catch {
        // Best-effort drain: connection close or transient protocol error should not fail session
      } finally {
        ctx.isPagingView = false;
      }
    };

    const receive = (ctx: SessionContext, input: { method: string; params?: unknown }) => {
      if (ctx.stopped) return;
      if (input.method === "view/gap") {
        void drainViewPages(ctx);
        return;
      }
      if (!isMuseNotificationMethod(input.method)) return;
      const event = decodeMuseNotification(input);
      if (event.method !== "usage/changed" && event.params.sessionId !== ctx.sessionId) return;
      if (
        "viewCursor" in (event.params as Record<string, unknown>) &&
        typeof (event.params as Record<string, unknown>).viewCursor === "string"
      ) {
        ctx.lastViewCursor = (event.params as Record<string, unknown>).viewCursor as string;
      }
      if (event.method === "session/tokenUsage" && ctx.contextUsedTokens === undefined) {
        // Canonical usage is a per-turn snapshot; keep only each turn's latest notification.
        ctx.pendingTokenUsage.delete(event.params.turnId);
        ctx.pendingTokenUsage.set(event.params.turnId, event);
        return;
      }
      if (event.method === "item/delta") {
        const item = ctx.items.get(event.params.itemId);
        if (item && item.status !== "inProgress") return;
        const cursors = ctx.deltaCursors.get(event.params.itemId) ?? new Set<string>();
        if (cursors.has(event.params.viewCursor)) return;
        cursors.add(event.params.viewCursor);
        ctx.deltaCursors.set(event.params.itemId, cursors);
      }
      if (event.method === "session/contextUsage") {
        ctx.contextUsedTokens = event.params.usedTokens;
        if (event.params.windowTokens === undefined) delete ctx.contextWindowTokens;
        else ctx.contextWindowTokens = event.params.windowTokens;
      }
      if (
        event.method === "item/started" ||
        event.method === "item/updated" ||
        event.method === "item/completed"
      ) {
        const prior = ctx.items.get(event.params.item.itemId);
        if (prior && (prior.revision ?? 0) >= (event.params.item.revision ?? 0)) return;
      }
      if (event.method === "approval/requested" || event.method === "approval/updated") {
        const prior = ctx.approvals.get(event.params.approvalId);
        if (prior?.viewCursor === event.params.viewCursor) return;
        ctx.approvals.set(event.params.approvalId, event.params);
      }
      if (event.method === "userInput/requested") {
        if (ctx.questions.get(event.params.userInputId)?.viewCursor === event.params.viewCursor)
          return;
        ctx.questions.set(event.params.userInputId, event.params);
      }
      if (event.method === "userInput/settled") ctx.questions.delete(event.params.userInputId);
      if (event.method === "turn/started") {
        if (ctx.settledTurns.has(event.params.turnId)) return;
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: TurnId.make(event.params.turnId),
        };
        startDrainTimer(ctx);
      }
      const isInterimIncompleteTurn =
        event.method === "turn/completed" &&
        (event.params as { terminal?: string; reason?: string }).terminal === "failed" &&
        (event.params as { terminal?: string; reason?: string }).reason === "incomplete";

      if (
        (event.method === "turn/completed" || event.method === "turn/unqueued") &&
        !isInterimIncompleteTurn
      ) {
        stopDrainTimer(ctx);
        if (ctx.settledTurns.has(event.params.turnId)) return;
        ctx.settledTurns.add(event.params.turnId);
      }
      for (const mapped of mapMuseNotification(event, {
        threadId: ctx.session.threadId,
        providerInstanceId: instanceId,
        createdAt: nowIso(),
        nextEventId,
        itemById: (id) => ctx.items.get(id),
        streamedText: (id, field) => ctx.streamed.get(`${id}:${field}`) ?? "",
        approvalSubjectById: (id) => ctx.approvals.get(id)?.subject,
        ...(ctx.contextUsedTokens !== undefined
          ? { contextUsedTokens: ctx.contextUsedTokens }
          : {}),
        ...(ctx.contextWindowTokens !== undefined
          ? { contextWindowTokens: ctx.contextWindowTokens }
          : {}),
        ...(ctx.session.activeTurnId ? { activeTurnId: ctx.session.activeTurnId } : {}),
      })) {
        if (mapped.type === "content.delta" && mapped.itemId) {
          const field =
            mapped.payload.summaryIndex !== undefined
              ? `summary.${mapped.payload.summaryIndex}`
              : mapped.payload.streamKind === "command_output"
                ? "output"
                : "text";
          const key = `${mapped.itemId}:${field}`;
          ctx.streamed.set(key, (ctx.streamed.get(key) ?? "") + mapped.payload.delta);
        }
        emit(mapped);
      }
      if (event.method === "turn/retryScheduled") {
        const signature = museTransportTruncationSignature(event.params.reason);
        const streak = ctx.transportRetryStreak;
        if (
          !signature ||
          streak?.turnId !== event.params.turnId ||
          streak.signature !== signature
        ) {
          ctx.transportRetryStreak = signature
            ? { turnId: event.params.turnId, signature, count: 1 }
            : undefined;
        } else {
          streak.count += 1;
          if (
            streak.count >= TRANSPORT_TRUNCATION_INTERRUPT_STREAK &&
            event.params.nextAttempt < event.params.maxAttempts
          ) {
            ctx.transportRetryStreak = undefined;
            mitigateTransportTruncation(ctx, event.params.turnId, true);
          }
        }
      }
      if (event.method === "turn/completed" && event.params.terminal !== "cancelled") {
        ctx.transportRetryStreak = undefined;
        if (event.params.terminal === "completed") {
          ctx.lastTransportMitigationTurnId = undefined;
          ctx.transportStreakCompacted = false;
          ctx.transientFailureStreak = undefined;
          ctx.transientRetryPending = undefined;
          ctx.lastTurnStart = undefined;
        } else if (museTransportTruncationSignature(event.params.error?.message)) {
          ctx.transientFailureStreak = undefined;
          mitigateTransportTruncation(ctx, event.params.turnId, false);
        } else if (
          transientRetryDelays.length > 0 &&
          event.params.error?.retryable !== false &&
          isRetryableMuseError(event.params.error?.message) &&
          ctx.lastTurnStart
        ) {
          const used = ctx.transientFailureStreak?.count ?? 0;
          if (used >= transientRetryDelays.length) {
            ctx.transientFailureStreak = undefined;
            emit({
              ...base(ctx),
              type: "runtime.warning",
              turnId: TurnId.make(event.params.turnId),
              payload: {
                message: `Muse backend errors persisted through ${transientRetryDelays.length} automatic retries. The turn failed — resend your message to try again; the error above carries the provider request id for support.`,
              },
            });
          } else {
            // A refused redrive (tools already ran) ends the streak without
            // consuming budget, so a later manual resend retries fresh.
            const scheduled = scheduleTransientRetry(
              ctx,
              event.params.turnId,
              event.params.error?.message ?? "unknown error",
              used + 1,
            );
            ctx.transientFailureStreak = scheduled ? { count: used + 1 } : undefined;
          }
        } else {
          ctx.transientFailureStreak = undefined;
        }
      }
      if (event.method === "approval/resolved") ctx.approvals.delete(event.params.approvalId);
      if (
        event.method === "item/started" ||
        event.method === "item/updated" ||
        event.method === "item/completed"
      ) {
        ctx.items.set(event.params.item.itemId, event.params.item);
        if (event.params.item.status !== "inProgress")
          ctx.deltaCursors.delete(event.params.item.itemId);
        if (
          !hasActiveWorkflowOrSubagent(ctx) &&
          ctx.session.status === "running" &&
          (!ctx.session.activeTurnId || ctx.settledTurns.has(ctx.session.activeTurnId))
        ) {
          const { activeTurnId: _, ...rest } = ctx.session;
          ctx.session = { ...rest, status: "ready", updatedAt: nowIso() };
        }
      }
      if (
        (event.method === "turn/completed" || event.method === "turn/unqueued") &&
        !isInterimIncompleteTurn &&
        (!ctx.session.activeTurnId || ctx.session.activeTurnId === event.params.turnId)
      ) {
        for (const [id, item] of ctx.items.entries()) {
          if (item.kind === "reminderChild" && item.status === "inProgress") {
            ctx.items.set(id, { ...item, status: "completed" });
          }
        }
        if (!hasActiveWorkflowOrSubagent(ctx)) {
          const { activeTurnId: _, ...rest } = ctx.session;
          ctx.session = { ...rest, status: "ready", updatedAt: nowIso() };
        } else {
          ctx.session = { ...ctx.session, status: "running", updatedAt: nowIso() };
        }
      }
      if (event.method === "session/contextUsage" && ctx.pendingTokenUsage.size > 0) {
        const pending = [...ctx.pendingTokenUsage.values()];
        ctx.pendingTokenUsage.clear();
        for (const usage of pending) receive(ctx, usage);
      }
    };
    const stopContext = Effect.fn("MuseAdapter.stopContext")(function* (ctx: SessionContext) {
      if (ctx.stopped) return;
      ctx.stopped = true;
      stopDrainTimer(ctx);
      yield* Scope.close(ctx.scope, Exit.void);
      killMuseProcessTree(ctx.handshake);
      if (sessions.get(ctx.session.threadId) === ctx) sessions.delete(ctx.session.threadId);
      emit({
        ...base(ctx),
        type: "session.exited",
        payload: { reason: "Session stopped", recoverable: true },
      });
    });
    const startSession: Adapter["startSession"] = (input) =>
      lifecycle.withPermit(
        Effect.gen(function* () {
          const existing = sessions.get(input.threadId);
          if (existing) yield* stopContext(existing);
          const scope = yield* Scope.make();
          const start = Effect.gen(function* () {
            const cwd = input.cwd ?? config.cwd;
            yield* Effect.promise(() => healWindowsSkillSymlinks(cwd));
            const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
            const args = ["serve", "--trust-workspace"];
            if (
              input.sandboxMode === "danger-full-access" ||
              (input.sandboxMode === undefined && input.runtimeMode === "full-access")
            )
              args.push("--disable-sandbox");
            if (input.sandboxMode === "read-only") args.push("--disable-write", "--disable-shell");
            const handshake = yield* Effect.acquireRelease(
              Effect.try({
                try: () =>
                  spawnMspConnection({
                    command: settings.binaryPath || "muse",
                    args,
                    cwd,
                    env: McpProviderSession.withAgentDeviceEnvironment(environment, mcp),
                    shutdownTimeoutMs: 2_000,
                  }),
                catch: (cause) => requestError("spawn", cause),
              }),
              (child) =>
                Effect.tryPromise(async () => {
                  try {
                    await child.close();
                  } finally {
                    killMuseProcessTree(child);
                  }
                }).pipe(Effect.ignore),
            );
            const host = yield* attempt("initialize", () =>
              handshake.initialize({
                clientInfo: { name: "t3_code", version: "0.0.0" },
                capabilities: { requestedCapabilities: mcp ? ["sessionMcp"] : [] },
              }),
            );
            const cursor =
              input.resumeCursor === undefined
                ? undefined
                : yield* decodeResumeCursor(input.resumeCursor).pipe(
                    Effect.mapError((cause) => requestError("resume", cause)),
                  );
            const sessionId = cursor?.sessionId ?? host.connection.mintCommandId();
            const selectedModel =
              cursor?.selectedModel ?? input.modelSelection?.model ?? MUSE_DEFAULT_MODEL;
            const now = nowIso();
            const ctx: SessionContext = {
              session: {
                provider: PROVIDER,
                providerInstanceId: instanceId,
                threadId: input.threadId,
                runtimeMode: input.runtimeMode,
                cwd,
                status: "connecting",
                createdAt: now,
                updatedAt: now,
                resumeCursor: { schemaVersion: 1, sessionId, selectedModel },
              },
              sessionId,
              host,
              handshake,
              scope,
              lock: yield* Semaphore.make(1),
              items: new Map(),
              streamed: new Map(),
              deltaCursors: new Map(),
              approvals: new Map(),
              questions: new Map(),
              settledTurns: new Set(),
              pendingTokenUsage: new Map(),
              selectedModel,
              stopped: false,
              transportRetryStreak: undefined,
              lastTransportMitigationTurnId: undefined,
              transportStreakCompacted: false,
              lastTurnStart: undefined,
              transientFailureStreak: undefined,
              transientRetryPending: undefined,
              startInput: input,
              needsRestart: false,
            };
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                ctx.stopped = true;
                stopDrainTimer(ctx);
              }),
            );
            wireHostListeners(ctx, host);
            const mode =
              input.approvalPolicy === "never" ||
              (input.approvalPolicy === undefined && input.runtimeMode === "full-access")
                ? "allowAll"
                : input.approvalPolicy === "untrusted" || input.runtimeMode === "approval-required"
                  ? "promptUnmatched"
                  : "onRequest";
            const model = input.modelSelection?.model;
            const initialSelection =
              !cursor && model && model !== MUSE_DEFAULT_MODEL
                ? yield* resolveModelSelection(host, model)
                : undefined;
            const sessionConfig = mcp
              ? {
                  mcpServers: {
                    "t3-code": {
                      transport: "streamableHttp",
                      url: mcp.endpoint,
                      headers: { Authorization: mcp.authorizationHeader },
                      mode: "required",
                    },
                  },
                }
              : undefined;
            // session/resume is only valid within the same muse serve process. When T3 Code
            // restarts, it always spawns a fresh process whose sessions are empty, so resume
            // will be rejected. Fall back to session/start transparently so the user gets a
            // fresh conversation rather than an opaque error.
            const doStart = (startSessionId: string) =>
              attempt("session/start", () =>
                host.connection.command("session/start", {
                  sessionId: startSessionId,
                  ...(sessionConfig ? { config: sessionConfig } : {}),
                  workspaceRoot: cwd,
                  approvalMode: mode,
                  ...(initialSelection
                    ? {
                        modelId: initialSelection.modelId,
                        ...("providerId" in initialSelection
                          ? { providerId: initialSelection.providerId }
                          : {}),
                      }
                    : {}),
                }),
              );
            const resumeOrStart = cursor
              ? attempt("session/resume", () =>
                  host.connection.command("session/resume", {
                    sessionId,
                    ...(sessionConfig ? { config: sessionConfig } : {}),
                    history: "inline",
                  }),
                ).pipe(
                  Effect.catch(() => {
                    // Resume failed — muse serve was restarted and the session is gone.
                    // Mint a fresh session id and update ctx so notification routing stays correct.
                    const freshId = host.connection.mintCommandId();
                    ctx.sessionId = freshId;
                    ctx.session = {
                      ...ctx.session,
                      resumeCursor: { schemaVersion: 1, sessionId: freshId, selectedModel },
                    };
                    return doStart(freshId);
                  }),
                )
              : doStart(sessionId);
            const result = yield* resumeOrStart.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(SessionResult)),
              Effect.mapError((cause) => requestError("session/start", cause)),
            );
            if (!arePathsEquivalent(result.session.workspaceRoot, cwd))
              return yield* requestError(
                "session/resume",
                "Muse session belongs to a different workspace.",
              );
            if (ctx.stopped)
              return yield* requestError(
                "session/start",
                ctx.session.lastError ?? "Muse Code exited during session startup.",
              );
            // session/start accepts a provider, but only setModel carries its profile.
            if (initialSelection && "profileId" in initialSelection)
              yield* attempt("session/setModel", () =>
                host.connection.command("session/setModel", {
                  sessionId: ctx.sessionId,
                  model: initialSelection,
                }),
              );
            for (const item of result.history?.items ??
              result.history?.snapshot?.state.items ??
              []) {
              if ((ctx.items.get(item.itemId)?.revision ?? -1) < (item.revision ?? 0))
                ctx.items.set(item.itemId, item);
              if (item.text) ctx.streamed.set(`${item.itemId}:text`, item.text);
              item.summary?.forEach((text, index) =>
                ctx.streamed.set(`${item.itemId}:summary.${index}`, text),
              );
            }
            const snapshotCursor = result.history?.snapshot as
              | { cursor?: string; viewCursor?: string }
              | undefined;
            const foundCursor = snapshotCursor?.viewCursor ?? snapshotCursor?.cursor;
            if (foundCursor) {
              ctx.lastViewCursor = foundCursor;
            }
            if (ctx.session.status === "connecting") {
              const activeTurnId = result.session.activeTurnId;
              const hasActiveWorkflow = hasActiveWorkflowOrSubagent(ctx);
              ctx.session = {
                ...ctx.session,
                status:
                  (activeTurnId && !ctx.settledTurns.has(activeTurnId)) || hasActiveWorkflow
                    ? "running"
                    : "ready",
                ...(activeTurnId && !ctx.settledTurns.has(activeTurnId)
                  ? { activeTurnId: TurnId.make(activeTurnId) }
                  : {}),
              };
              if (ctx.session.status === "running" && ctx.session.activeTurnId) {
                startDrainTimer(ctx);
              }
            }
            // Only set approval mode post-resume when we actually resumed; session/start
            // already carries approvalMode in its params, so calling it again is redundant
            // and would use the wrong session id if we fell back to a fresh start.
            if (cursor && ctx.sessionId === sessionId)
              yield* attempt("session/setApprovalMode", () =>
                host.connection.command("session/setApprovalMode", {
                  sessionId: ctx.sessionId,
                  mode,
                }),
              );
            ctx.session = {
              ...ctx.session,
              ...(result.session.modelId ? { model: result.session.modelId } : {}),
            };
            if (ctx.stopped)
              return yield* requestError(
                "session/resume",
                ctx.session.lastError ?? "Muse Code disconnected.",
              );
            sessions.set(input.threadId, ctx);
            emit({
              ...base(ctx),
              type: "session.started",
              payload: { resume: ctx.session.resumeCursor },
            });
            emit({
              ...base(ctx),
              type: "thread.started",
              payload: { providerThreadId: sessionId },
            });
            return ctx.session;
          }).pipe(Effect.provideService(Scope.Scope, scope));
          return yield* start.pipe(
            Effect.onError(() => Scope.close(scope, Exit.void)),
            Effect.onInterrupt(() => Scope.close(scope, Exit.void)),
          );
        }),
      );
    const wireHostListeners = (ctx: SessionContext, host: SpawnedMspConnection) => {
      host.connection.onNotification((notification) => {
        try {
          receive(ctx, notification);
        } catch {
          failSession(ctx, "Muse Code sent an invalid notification.");
        }
      });
      host.connection.onProtocolError(() =>
        failSession(ctx, "Muse Code sent an invalid protocol frame."),
      );
      host.connection.onServerRequest(async (request) => {
        const method =
          request.method === "approval/request"
            ? "approval/requested"
            : request.method === "userInput/request"
              ? "userInput/requested"
              : undefined;
        if (!method) throw new Error(`Unsupported Muse Code request: ${request.method}`);
        try {
          receive(ctx, { method, params: request.params });
        } catch (cause) {
          failSession(ctx, "Muse Code sent an invalid server request.");
          throw cause;
        }
        return {};
      });
      void host.connection.closed.then(() => {
        if (!ctx.stopped && !ctx.needsRestart)
          failSession(ctx, "Muse Code closed its connection. Resume the thread to reconnect.");
      });
      void host.child.exit.then((exit) => {
        if (!ctx.stopped && !ctx.needsRestart)
          failSession(ctx, `Muse Code exited (${exit.kind}). Resume the thread to reconnect.`);
      });
    };

    const restartSession = Effect.fn("MuseAdapter.restartSession")(function* (ctx: SessionContext) {
      if (!ctx.needsRestart) return;
      const scope = yield* Scope.make();
      const input = ctx.startInput;
      const cwd = input.cwd ?? config.cwd;
      yield* Effect.promise(() => healWindowsSkillSymlinks(cwd));
      const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
      const args = ["serve", "--trust-workspace"];
      if (
        input.sandboxMode === "danger-full-access" ||
        (input.sandboxMode === undefined && input.runtimeMode === "full-access")
      )
        args.push("--disable-sandbox");
      if (input.sandboxMode === "read-only") args.push("--disable-write", "--disable-shell");
      const handshake = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            spawnMspConnection({
              command: settings.binaryPath || "muse",
              args,
              cwd,
              env: McpProviderSession.withAgentDeviceEnvironment(environment, mcp),
              shutdownTimeoutMs: 2_000,
            }),
          catch: (cause) => requestError("spawn", cause),
        }),
        (child) =>
          Effect.tryPromise(async () => {
            try {
              await child.close();
            } finally {
              killMuseProcessTree(child);
            }
          }).pipe(Effect.ignore),
      ).pipe(Effect.provideService(Scope.Scope, scope));
      const host = yield* attempt("initialize", () =>
        handshake.initialize({
          clientInfo: { name: "t3_code", version: "0.0.0" },
          capabilities: { requestedCapabilities: mcp ? ["sessionMcp"] : [] },
        }),
      );

      ctx.stopped = false;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          ctx.stopped = true;
          stopDrainTimer(ctx);
        }),
      ).pipe(Effect.provideService(Scope.Scope, scope));

      wireHostListeners(ctx, host);

      const mode =
        input.approvalPolicy === "never" ||
        (input.approvalPolicy === undefined && input.runtimeMode === "full-access")
          ? "allowAll"
          : input.approvalPolicy === "untrusted" || input.runtimeMode === "approval-required"
            ? "promptUnmatched"
            : "onRequest";
      const model = ctx.selectedModel;
      const initialSelection =
        model && model !== MUSE_DEFAULT_MODEL
          ? yield* resolveModelSelection(host, model)
          : undefined;
      const sessionConfig = mcp
        ? {
            mcpServers: {
              "t3-code": {
                transport: "streamableHttp" as const,
                url: mcp.endpoint,
                headers: { Authorization: mcp.authorizationHeader },
                mode: "required" as const,
              },
            },
          }
        : undefined;

      const freshSessionId = host.connection.mintCommandId();
      yield* attempt("session/start", () =>
        host.connection.command("session/start", {
          sessionId: freshSessionId,
          ...(sessionConfig ? { config: sessionConfig } : {}),
          workspaceRoot: cwd,
          approvalMode: mode,
          ...(initialSelection
            ? {
                modelId: initialSelection.modelId,
                ...("providerId" in initialSelection
                  ? { providerId: initialSelection.providerId }
                  : {}),
              }
            : {}),
        }),
      );

      ctx.scope = scope;
      ctx.host = host;
      ctx.handshake = handshake;
      ctx.sessionId = freshSessionId;
      ctx.session = {
        ...ctx.session,
        status: "ready",
        resumeCursor: {
          schemaVersion: 1,
          sessionId: freshSessionId,
          selectedModel: ctx.selectedModel,
        },
        updatedAt: nowIso(),
      };
      ctx.items.clear();
      ctx.streamed.clear();
      ctx.deltaCursors.clear();
      ctx.approvals.clear();
      ctx.questions.clear();
      ctx.pendingTokenUsage.clear();
      ctx.needsRestart = false;
    });

    const sendTurn: Adapter["sendTurn"] = Effect.fn("MuseAdapter.sendTurn")(function* (input) {
      let ctx = yield* requireSession(input.threadId);
      return yield* ctx.lock.withPermit(
        Effect.gen(function* () {
          cancelTransientRetry(ctx);
          if (ctx.needsRestart) {
            yield* restartSession(ctx);
            ctx = yield* requireSession(input.threadId);
          }

          if (ctx.stopped)
            return yield* requestError(
              "turn/start",
              "Muse Code session has closed. Resume the thread to reconnect.",
            );
          if (input.interactionMode === "plan")
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Muse Code does not expose a plan mode through MSP.",
            });
          const parts: Array<Record<string, unknown>> = [];
          const runtimeInstructions = buildRuntimeInstructions({ harness: "Muse Code" });
          // A skill part rejects every text part, so a dispatched skill carries
          // the runtime instructions, the user text, and file notes inside its
          // `arguments` instead of as parts. Images stay parts: the host allows
          // them alongside a skill part.
          let skillDispatch: MuseSkillDispatch | undefined;
          if (input.input?.trim()) {
            const prompt = input.input;
            if (museSkillMentions(prompt).length > 0) {
              const catalog = yield* attempt("skill/list", () =>
                ctx.host.connection.request("skill/list", { sessionId: ctx.sessionId }),
              ).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(MuseSkillCatalog)),
                Effect.mapError((cause) => requestError("skill/list", cause)),
              );
              skillDispatch = planMuseSkillDispatch(
                prompt,
                new Set(catalog.skills.map((skill) => skill.selector)),
              );
            }
            if (!skillDispatch) {
              parts.push({
                type: "text",
                text: `${runtimeInstructions}\n\n${prompt}`,
              });
            }
          }
          const skillArgumentSections: string[] = [];
          for (const attachment of input.attachments ?? []) {
            const filePath = resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment,
            });
            if (!filePath)
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Muse Code could not resolve the attachment.",
              });
            if (attachment.type === "image") {
              const bytes = yield* fs
                .readFile(filePath)
                .pipe(Effect.mapError((cause) => requestError("attachment", cause)));
              parts.push({
                type: "image",
                mediaType: attachment.mimeType,
                base64Data: Buffer.from(bytes).toString("base64"),
              });
            } else if (attachment.type === "file") {
              const note = `Attached file: ${encodePath(filePath)}`;
              if (skillDispatch) skillArgumentSections.push(note);
              else
                parts.push({
                  type: "text",
                  text: note,
                });
            } else {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: `Unsupported attachment type: ${attachment.type}`,
              });
            }
          }
          if (skillDispatch) {
            if (skillDispatch.argumentsText.trim()) {
              skillArgumentSections.unshift(skillDispatch.argumentsText);
            }
            skillArgumentSections.unshift(runtimeInstructions);
            parts.unshift({
              type: "skill",
              selector: skillDispatch.selector,
              arguments: skillArgumentSections.join("\n\n"),
            });
          }
          if (!parts.length)
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Muse Code requires text or an image.",
            });
          const model = input.modelSelection?.model;
          if (
            model &&
            (model !== ctx.selectedModel ||
              (model !== MUSE_DEFAULT_MODEL &&
                (decodeMuseModelSelection(model)?.modelId ?? model) !== ctx.session.model))
          ) {
            const selection = yield* resolveModelSelection(ctx.host, model);
            yield* attempt("session/setModel", () =>
              ctx.host.connection.command("session/setModel", {
                sessionId: ctx.sessionId,
                model: selection,
              }),
            );
            ctx.session = { ...ctx.session, model: selection.modelId };
          }
          if (input.modelSelection) {
            ctx.selectedModel = input.modelSelection.model;
            ctx.session = {
              ...ctx.session,
              resumeCursor: {
                schemaVersion: 1,
                sessionId: ctx.sessionId,
                selectedModel: ctx.selectedModel,
              },
            };
          }
          const effort = input.modelSelection
            ? getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort")
            : undefined;
          ctx.lastTurnStart = {
            parts,
            ...(effort ? { reasoningEffort: effort } : {}),
          };
          const result = yield* attempt(
            "turn/start",
            () =>
              ctx.host.connection.command("turn/start", {
                sessionId: ctx.sessionId,
                input: parts,
                ifBusy: "queue",
                ...(effort ? { reasoningEffort: effort } : {}),
              }),
            "20 seconds",
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(TurnResult)),
            Effect.mapError((cause) => requestError("turn/start", cause)),
            Effect.tapError((cause) =>
              Effect.sync(() => {
                failSession(
                  ctx,
                  `Muse Code failed to start turn: ${cause.detail ?? cause.message}`,
                );
              }),
            ),
          );
          if (ctx.stopped)
            return yield* requestError(
              "turn/start",
              ctx.session.lastError ?? "Muse Code disconnected.",
            );
          if (result.disposition !== "queued") {
            ctx.settledTurns.delete(result.turnId);
            emit({
              ...base(ctx),
              type: "turn.started",
              turnId: TurnId.make(result.turnId),
              payload: {},
            });
          }
          if (result.disposition !== "queued" && !ctx.settledTurns.has(result.turnId)) {
            ctx.session = {
              ...ctx.session,
              status: "running",
              activeTurnId: TurnId.make(result.turnId),
              updatedAt: nowIso(),
            };
            startDrainTimer(ctx);
          }
          return {
            threadId: input.threadId,
            turnId: TurnId.make(result.turnId),
            resumeCursor: ctx.session.resumeCursor,
          };
        }),
      );
    });
    const interruptTurn: Adapter["interruptTurn"] = Effect.fn("MuseAdapter.interruptTurn")(
      function* (threadId, turnId) {
        const ctx = yield* requireSession(threadId);
        cancelTransientRetry(ctx);
        const target = turnId ?? ctx.session.activeTurnId;
        if (!target || (turnId && ctx.session.activeTurnId !== turnId)) {
          if (ctx.session.status === "connecting") {
            yield* stopContext(ctx);
          }
          return;
        }
        if (ctx.settledTurns.has(target)) return;

        yield* Effect.promise(() => drainViewPages(ctx));
        if (ctx.settledTurns.has(target)) {
          stopDrainTimer(ctx);
          return;
        }

        const interruptedOption = yield* Effect.tryPromise({
          try: () =>
            ctx.host.connection.command("turn/interrupt", {
              sessionId: ctx.sessionId,
              turnId: target,
            }),
          catch: (cause) => requestError("turn/interrupt", cause),
        }).pipe(
          Effect.timeoutOption("5 seconds"),
          Effect.catch(() => Effect.succeed(Option.none())),
        );
        const interrupted = Option.isSome(interruptedOption);

        yield* Effect.promise(() => drainViewPages(ctx));
        stopDrainTimer(ctx);

        if (ctx.settledTurns.has(target)) {
          return;
        }

        for (const [id, item] of ctx.items.entries()) {
          if (item.status === "inProgress") {
            ctx.items.set(id, { ...item, status: "completed" });
            emit({
              ...base(ctx),
              type: "item.completed",
              turnId: target,
              itemId: RuntimeItemId.make(id),
              payload: {
                itemType: itemType(item),
                status: "completed",
              },
            });
          }
        }

        if (!ctx.settledTurns.has(target)) {
          ctx.settledTurns.add(target);
          emit({
            ...base(ctx),
            type: "turn.completed",
            turnId: target,
            payload: { state: "cancelled", stopReason: "interrupted" },
          });
        }

        if (!interrupted) {
          yield* Effect.logWarning(
            "Muse process unresponsive to turn/interrupt, stopping wedged process",
            {
              threadId,
              turnId: target,
              sessionId: ctx.sessionId,
            },
          );
          yield* stopContext(ctx);
          return;
        }

        const { activeTurnId: _, ...rest } = ctx.session;
        ctx.session = { ...rest, status: "ready", updatedAt: nowIso() };
        emit({
          ...base(ctx),
          type: "session.state.changed",
          payload: { state: "ready" },
        });

        // Terminate the underlying muse serve process immediately so file and git locks are released.
        // The session state remains ready, and needsRestart ensures the next turn runs on a fresh process.
        ctx.needsRestart = true;
        yield* Scope.close(ctx.scope, Exit.void);
        killMuseProcessTree(ctx.handshake);
        ctx.stopped = false;
      },
    );
    const respondToRequest: Adapter["respondToRequest"] = Effect.fn("MuseAdapter.respondToRequest")(
      function* (threadId, requestId, decision) {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.approvals.get(requestId);
        if (!pending)
          return yield* requestError("approval/decide", "Approval is no longer pending.");
        const choice = pending.availableChoices.find(
          (choice) => museApprovalDecision(choice.decision, choice.scope) === decision,
        );
        if (!choice)
          return yield* requestError(
            "approval/decide",
            `Muse Code does not offer the ${decision} decision for this request.`,
          );
        yield* attempt("approval/decide", () =>
          ctx.host.connection.command("approval/decide", {
            sessionId: ctx.sessionId,
            approvalId: requestId,
            requirementId: pending.currentRequirementId,
            choiceId: choice.choiceId,
          }),
        );
      },
    );
    const respondToUserInput: Adapter["respondToUserInput"] = Effect.fn(
      "MuseAdapter.respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const ctx = yield* requireSession(threadId);
      const pending = ctx.questions.get(requestId);
      if (!pending)
        return yield* requestError("userInput/answer", "Question is no longer pending.");
      const entries = yield* Effect.forEach(pending.questions, (question) =>
        Effect.gen(function* () {
          const values = yield* decodeAnswer(answers[question.id]).pipe(
            Effect.mapError((cause) => requestError("userInput/answer", cause)),
          );
          const selected = typeof values === "string" ? [values] : [...values];
          const allOptions = selected.every((value) =>
            question.options.some((option) => option.label === value),
          );
          if (allOptions) {
            const count = new Set(selected).size;
            const min =
              question.selection.mode === "single" ? 1 : (question.selection.minSelections ?? 0);
            const max = question.selection.mode === "single" ? 1 : question.selection.maxSelections;
            if (count !== selected.length || count < min || (max !== undefined && count > max))
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "respondToUserInput",
                issue: `Select ${min}${max === undefined ? " or more" : ` to ${max}`} distinct options for this question.`,
              });
          }
          return {
            questionId: question.id,
            ...(allOptions && (selected.length || question.selection.mode === "multiple")
              ? question.selection.mode === "multiple"
                ? { selectedLabels: selected }
                : { selectedLabel: selected[0] }
              : { freeText: selected.join("\n") }),
          };
        }),
      );
      yield* attempt("userInput/answer", () =>
        ctx.host.connection.command("userInput/answer", {
          sessionId: ctx.sessionId,
          userInputId: requestId,
          answers: entries,
        }),
      );
    });
    const readThread: Adapter["readThread"] = Effect.fn("MuseAdapter.readThread")(
      function* (threadId) {
        const ctx = yield* requireSession(threadId);
        const turns = new Map<TurnId, MuseItem[]>();
        for (const item of ctx.items.values())
          if (item.turnId) {
            const id = TurnId.make(item.turnId);
            const items = turns.get(id) ?? [];
            items.push(item);
            turns.set(id, items);
          }
        return { threadId, turns: Array.from(turns, ([id, items]) => ({ id, items })) };
      },
    );
    const stopSession: Adapter["stopSession"] = (threadId) =>
      lifecycle.withPermit(
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (ctx) yield* stopContext(ctx);
        }),
      );
    const stopAll = () => Effect.forEach([...sessions.values()], stopContext, { discard: true });
    const requestCompaction = Effect.fn("MuseAdapter.requestCompaction")(function* (
      ctx: SessionContext,
    ) {
      return yield* ctx.lock.withPermit(
        attempt("session/compact", () =>
          ctx.host.connection.command("session/compact", { sessionId: ctx.sessionId }),
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CompactResult)),
          Effect.mapError((cause) => requestError("session/compact", cause)),
        ),
      );
    });
    const compactThread = Effect.fn("MuseAdapter.compactThread")(function* (threadId: ThreadId) {
      const ctx = yield* requireSession(threadId);
      const result = yield* requestCompaction(ctx);
      if (result.status === "noop")
        yield* Queue.offer(events, {
          ...base(ctx),
          eventId: nextEventId(),
          type: "item.completed",
          payload: {
            itemType: "context_compaction",
            status: "completed",
            title: "Compaction skipped",
            detail: result.reason ?? "Muse Code has no context to compact.",
            data: { outcome: "noop" },
          },
        });
    });
    // A user send or interrupt supersedes a scheduled automatic redrive: the
    // pending task observes the cancellation at fire time and stays silent.
    const cancelTransientRetry = (ctx: SessionContext) => {
      if (ctx.transientRetryPending) {
        ctx.transientRetryPending.cancelled = true;
        ctx.transientRetryPending = undefined;
      }
      ctx.transientFailureStreak = undefined;
    };
    // Redrives a turn the CLI failed with a transient backend error as a new
    // turn/start with identical input, so checkpoints and the work log record
    // each attempt honestly and only the terminal outcome settles the thread.
    const scheduleTransientRetry = (
      ctx: SessionContext,
      failedTurnId: string,
      message: string,
      attemptNumber: number,
    ): boolean => {
      const delayMs = transientRetryDelays[attemptNumber - 1] ?? 30_000;
      for (const item of ctx.items.values()) {
        if (item.turnId === failedTurnId && TRANSIENT_RETRY_SIDE_EFFECT_KINDS.has(item.kind)) {
          emit({
            ...base(ctx),
            type: "runtime.warning",
            turnId: TurnId.make(failedTurnId),
            payload: {
              message:
                "Muse backend error is transient, but the failed turn already executed tools, so it was not retried automatically — re-running them could apply side effects twice. Resend your message to retry manually.",
            },
          });
          return false;
        }
      }
      const record = { failedTurnId, attempt: attemptNumber, cancelled: false };
      ctx.transientRetryPending = record;
      emit({
        ...base(ctx),
        type: "session.state.changed",
        payload: {
          state: "running",
          reason: `api_retry:${attemptNumber}/${transientRetryDelays.length}`,
        },
      });
      emit({
        ...base(ctx),
        type: "runtime.warning",
        turnId: TurnId.make(failedTurnId),
        payload: {
          message: `Muse backend error — retrying automatically in ${delayMs / 1_000}s (attempt ${attemptNumber} of ${transientRetryDelays.length}): ${message}`,
        },
      });
      const task = Effect.gen(function* () {
        // runPromise begins synchronously inside receive(), before the
        // session-ready transition below runs. Yield first so the guards
        // observe the settled post-notification state, not the mid-receive one.
        yield* Effect.yieldNow();
        if (delayMs > 0) yield* Effect.sleep(Duration.millis(delayMs));
        if (sessions.get(ctx.session.threadId) !== ctx || ctx.stopped) return;
        if (ctx.transientRetryPending !== record || record.cancelled) return;
        const redrive = ctx.lastTurnStart;
        if (!redrive || ctx.needsRestart) return;
        if (ctx.session.status !== "ready" || ctx.session.activeTurnId) return;
        yield* ctx.lock.withPermit(
          Effect.gen(function* () {
            if (sessions.get(ctx.session.threadId) !== ctx || ctx.stopped) return;
            if (ctx.transientRetryPending !== record || record.cancelled) return;
            const live = ctx.lastTurnStart;
            if (!live || ctx.needsRestart) return;
            if (ctx.session.status !== "ready" || ctx.session.activeTurnId) return;
            ctx.transientRetryPending = undefined;
            const started = yield* attempt("turn/start", () =>
              ctx.host.connection.command("turn/start", {
                sessionId: ctx.sessionId,
                input: live.parts,
                ifBusy: "queue",
                ...(live.reasoningEffort ? { reasoningEffort: live.reasoningEffort } : {}),
              }),
            ).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(TurnResult)),
              Effect.mapError((cause) => requestError("turn/start", cause)),
              Effect.either,
            );
            if (started._tag === "Left") {
              emit({
                ...base(ctx),
                type: "runtime.warning",
                turnId: TurnId.make(failedTurnId),
                payload: {
                  message: `Automatic retry ${attemptNumber} of ${transientRetryDelays.length} failed to start a new turn: ${started.left.detail}. Resend your message to try again.`,
                },
              });
              return;
            }
            const result = started.right;
            if (result.disposition !== "queued") {
              ctx.settledTurns.delete(result.turnId);
              emit({
                ...base(ctx),
                type: "turn.started",
                turnId: TurnId.make(result.turnId),
                payload: {},
              });
            }
            if (result.disposition !== "queued" && !ctx.settledTurns.has(result.turnId)) {
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: TurnId.make(result.turnId),
                updatedAt: nowIso(),
              };
              startDrainTimer(ctx);
            }
          }),
        );
      });
      // MSP invokes this at its native callback boundary, outside an Effect fiber.
      void Effect.runPromise(task).catch(() => undefined);
      return true;
    };
    // Breaks a deterministic truncated-stream failure streak: the CLI replays the same
    // cutoff on every attempt, so retrying unchanged cannot succeed. Compacts once per
    // streak, then escalates to guidance instead of compacting in a loop.
    const mitigateTransportTruncation = (
      ctx: SessionContext,
      turnId: string,
      interrupt: boolean,
    ) => {
      // Sync guard: the in-loop trigger races the terminal completion for one storm,
      // so exactly one mitigation runs per turn.
      if (ctx.stopped || ctx.lastTransportMitigationTurnId === turnId) return;
      ctx.lastTransportMitigationTurnId = turnId;
      const task = Effect.gen(function* () {
        if (sessions.get(ctx.session.threadId) !== ctx || ctx.stopped) return;
        if (interrupt)
          yield* interruptTurn(ctx.session.threadId, TurnId.make(turnId)).pipe(Effect.ignore);
        if (!ctx.transportStreakCompacted) {
          const outcome = yield* requestCompaction(ctx).pipe(
            Effect.map((result) => result.status),
            Effect.orElseSucceed(() => "failed" as const),
          );
          if (outcome === "accepted") {
            ctx.transportStreakCompacted = true;
            emit({
              ...base(ctx),
              type: "runtime.warning",
              turnId: TurnId.make(turnId),
              payload: {
                message: interrupt
                  ? `Muse's response stream was truncated identically ${TRANSPORT_TRUNCATION_INTERRUPT_STREAK} times, so the remaining retries were interrupted and the session compacted. Send your message again to retry on compacted context; if streams still truncate, lower reasoning effort or split the task.`
                  : "Muse's response stream was truncated and the turn failed. The session was compacted automatically — send your message again to retry on compacted context. If it fails again, lower reasoning effort or split the task.",
              },
            });
            return;
          }
          if (outcome === "noop") {
            emit({
              ...base(ctx),
              type: "runtime.warning",
              turnId: TurnId.make(turnId),
              payload: {
                message:
                  "Muse's response stream keeps truncating, but the session has nothing to compact — context size is not the cause. Lower reasoning effort, split the task into smaller turns, or re-authenticate Muse.",
              },
            });
            return;
          }
          emit({
            ...base(ctx),
            type: "runtime.warning",
            turnId: TurnId.make(turnId),
            payload: {
              message:
                "Muse's response stream was truncated and the turn failed. Automatic compaction failed — compact the thread manually and retry; if it persists, lower reasoning effort or split the task.",
            },
          });
          return;
        }
        emit({
          ...base(ctx),
          type: "runtime.warning",
          turnId: TurnId.make(turnId),
          payload: {
            message:
              "Muse's response stream keeps truncating even though the session was already compacted. Lower reasoning effort, split the task into smaller turns, or re-authenticate Muse. The turn error above carries the provider request id for support.",
          },
        });
      });
      // MSP invokes this at its native callback boundary, outside an Effect fiber.
      void Effect.runPromise(task).catch(() => undefined);
    };

    yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ensuring(Queue.shutdown(events))));
    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      compaction: { type: "native", start: compactThread },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      readThread,
      rollbackThread: () =>
        Effect.fail(
          requestError("rollbackThread", "Muse Code conversation rollback is not supported."),
        ),
      stopSession,
      stopAll,
      listSessions: () =>
        Effect.sync(() => [...sessions.values()].map((ctx) => ({ ...ctx.session }))),
      hasSession: (threadId) =>
        Effect.sync(() => {
          const ctx = sessions.get(threadId);
          return ctx !== undefined && !ctx.stopped;
        }),
      streamEvents: Stream.fromQueue(events),
    } satisfies Adapter;
  });
}
