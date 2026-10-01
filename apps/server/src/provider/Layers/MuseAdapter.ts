// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
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
  RuntimeTaskId,
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
  isMcpStartupAuditFailure,
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
  // The view head the connection is subscribed after; "" when Muse could not
  // project the session and did not subscribe it.
  viewCursor: Schema.optional(Schema.String),
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
  if (!childOrHandshake) return;
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
      if (process.platform === "win32") {
        NodeChildProcess.spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
          stdio: "ignore",
        });
      } else {
        try {
          NodeChildProcess.spawnSync("pkill", ["-KILL", "-P", String(pid)], { stdio: "ignore" });
        } catch {}
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
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
  autoApprovedApprovals: Set<string>;
  questions: Map<string, UserInput>;
  settledTurns: Set<string>;
  selectedModel: string;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  stderrBuffer: string[];
  pendingTokenUsage: Map<string, Extract<MuseNotification, { method: "session/tokenUsage" }>>;
  stopped: boolean;
  transportRetryStreak: { turnId: string; signature: string; count: number } | undefined;
  lastTransportMitigationTurnId: string | undefined;
  transportStreakCompacted: boolean;
  lastTurnStart: { parts: Array<Record<string, unknown>>; reasoningEffort?: string } | undefined;
  transientFailureStreak: { count: number } | undefined;
  transientRetryPending: { failedTurnId: string; attempt: number; cancelled: boolean } | undefined;
  // Latches the turn ids an MCP-audit re-resume already covered: the audit
  // verdict is per-process, so when the redriven turn fails the same way the
  // resume itself is rejected, not racing, and must surface instead of loop.
  // Extended to the redrive's turn id when it starts; cleared on completion.
  mcpAuditRetryTurnId: string | undefined;
  // Latches the turn ids a silent-completion summary nudge already covered:
  // a turn that did work but produced no response text gets one automatic
  // follow-up asking for a summary. Extended to the nudge turn's id when it
  // starts so a second silent end surfaces instead of looping; cleared on
  // completion.
  silentNudgeTurnId: string | undefined;
  // The turn id that last produced assistant text, if any. Compared at turn
  // completion to detect turns that did work but never responded. Reset after
  // every completed turn is evaluated, so a stale value can only ever match
  // its own turn.
  lastTurnTextTurnId: string | undefined;
  startInput: StartSessionInput;
  needsRestart?: boolean;
  lastViewCursor?: string;
  // Where view/page catch-up resumes. Only view/page results (and the view
  // head a session start or resume reports) advance it: live pushes can carry
  // transient events whose cursors collide with different durable events, so
  // a pushed cursor never proves the view up to it was delivered.
  durableViewCursor?: string | undefined;
  // Push-less sessions only: the view cursor just before the active turn
  // began, and which turn it belongs to.
  turnViewAnchor?: string | undefined;
  turnViewAnchorTurnId?: string | undefined;
  turnViewSeen?: Set<string> | undefined;
  nextTurnRereadAt?: number | undefined;
  isPagingView?: boolean;
  // The in-flight view/page drain, so a caller can wait for it instead of skipping.
  pagingPromise?: Promise<void> | undefined;
  // Set when session/resume answered without a view cursor (Muse reports
  // history "projectionUnavailable"): the connection is not subscribed, so no
  // notifications are pushed and view/page polling is the only event source.
  pushUnavailable?: boolean;
  settlingFromDisk?: boolean;
  drainTimer?: ReturnType<typeof setInterval> | undefined;
  lastActivityAt: number;
  sessionLogPath?: string;
  lastTurnId?: string;
}

function isAutoApproveSession(ctx: SessionContext): boolean {
  return (
    ctx.startInput.approvalPolicy === "never" ||
    (ctx.startInput.approvalPolicy === undefined && ctx.session.runtimeMode === "full-access")
  );
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
// "incremental" reads forward from the last delivered cursor; "turn" re-reads a
// push-less session's active turn from its start.
type ViewReadMode = "incremental" | "turn";
// Muse serve answers view/page in 15-30s on a loaded single-core host; this
// only exists to notice a dead connection.
const VIEW_PAGE_TIMEOUT_MS = 120_000;
// Session start/resume and turn/start load the whole session in Muse, which
// took 17s+ on a loaded host; the reactor bounds the full start at 3 minutes.
const MUSE_SESSION_LOAD_TIMEOUT = "150 seconds";
const MUSE_TURN_START_TIMEOUT = "90 seconds";

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

function hasInProgressItem(ctx: SessionContext): boolean {
  for (const item of ctx.items.values()) {
    if (item.status === "inProgress") return true;
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

interface MuseTerminalOutcome {
  terminal: "completed" | "failed" | "interrupted";
  reason?: string | null;
}

function findMuseSessionLog(museHome: string, sessionId: string): string | undefined {
  const now = new Date();
  for (let daysAgo = 0; daysAgo <= 7; daysAgo++) {
    const d = new Date(now.getTime() - daysAgo * 86_400_000);
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const candidate = NodePath.join(museHome, "sessions", yyyy, mm, dd, sessionId, "session.jsonl");
    if (NodeFS.existsSync(candidate)) {
      return candidate;
    }
  }
  const sessionsRoot = NodePath.join(museHome, "sessions");
  try {
    if (!NodeFS.existsSync(sessionsRoot)) return undefined;
    const years = NodeFS.readdirSync(sessionsRoot);
    for (const y of years) {
      const yPath = NodePath.join(sessionsRoot, y);
      if (!NodeFS.statSync(yPath).isDirectory()) continue;
      const months = NodeFS.readdirSync(yPath);
      for (const m of months) {
        const mPath = NodePath.join(yPath, m);
        if (!NodeFS.statSync(mPath).isDirectory()) continue;
        const days = NodeFS.readdirSync(mPath);
        for (const d of days) {
          const cand = NodePath.join(mPath, d, sessionId, "session.jsonl");
          if (NodeFS.existsSync(cand)) {
            return cand;
          }
        }
      }
    }
  } catch {
    // Ignore directory traversal errors
  }
  return undefined;
}

function checkOnDiskTerminal(
  sessionLogPath: string,
  activeTurnId: string,
): MuseTerminalOutcome | undefined {
  try {
    const stat = NodeFS.statSync(sessionLogPath);
    if (stat.size === 0) return undefined;
    const readSize = Math.min(stat.size, 128 * 1024);
    const buffer = Buffer.alloc(readSize);
    const fd = NodeFS.openSync(sessionLogPath, "r");
    try {
      NodeFS.readSync(fd, buffer, 0, readSize, stat.size - readSize);
    } finally {
      NodeFS.closeSync(fd);
    }
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.includes('"terminal"') && line.includes(activeTurnId)) {
        try {
          const parsed = JSON.parse(line);
          const payload = parsed.payload ?? parsed;
          if (
            payload?.kind === "run" &&
            payload?.run_id === activeTurnId &&
            payload?.event?.kind === "terminal"
          ) {
            const terminal = payload.event.terminal;
            if (terminal === "completed" || terminal === "failed" || terminal === "interrupted") {
              return {
                terminal,
                reason: payload.event.reason,
              };
            }
          }
        } catch {
          // Incomplete line if read buffer split mid-record
        }
      }
    }
  } catch {
    // Session log not accessible or read error
  }
  return undefined;
}

export function make(
  settings: MuseSettings,
  options?: {
    environment?: NodeJS.ProcessEnv;
    instanceId?: ProviderInstanceId;
    transientRetryDelaysMs?: ReadonlyArray<number>;
    mcpAuditRetryDelayMs?: number;
    silentNudgeDelayMs?: number;
    drainIntervalMs?: number;
    quietSettleThresholdMs?: number;
    sessionRecordCheckQuietMs?: number;
    viewCatchUpMs?: number;
    turnRereadMinIntervalMs?: number;
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
    // Session start/stop/teardown serialize per thread only: a Muse process that
    // hangs while starting must not block starts and stops on every other thread.
    const lifecycles = new Map<ThreadId, Semaphore.Semaphore>();
    const withThreadLifecycle = <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => {
      let lock = lifecycles.get(threadId);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        lifecycles.set(threadId, lock);
      }
      return lock.withPermit(effect);
    };
    const mintEventId = createUuidV7Mint();
    const nextEventId = () => EventId.make(mintEventId());
    const transientRetryDelays = options?.transientRetryDelaysMs ?? MUSE_TRANSIENT_RETRY_DELAYS_MS;
    const mcpAuditRetryDelayMs = Math.max(0, options?.mcpAuditRetryDelayMs ?? 10_000);
    const silentNudgeDelayMs = Math.max(0, options?.silentNudgeDelayMs ?? 5_000);
    const drainIntervalMs = Math.max(1, options?.drainIntervalMs ?? 5_000);
    const quietSettleThresholdMs = Math.max(1, options?.quietSettleThresholdMs ?? 45_000);
    const sessionRecordCheckQuietMs = Math.max(1, options?.sessionRecordCheckQuietMs ?? 10_000);
    const viewCatchUpMs = Math.max(0, options?.viewCatchUpMs ?? 90_000);
    // A turn re-read runs at most every 3x its own cost, and never more often than this.
    const turnRereadMinIntervalMs = Math.max(0, options?.turnRereadMinIntervalMs ?? 2_000);
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
      timeoutDuration: Duration.Input = method === "turn/start"
        ? MUSE_TURN_START_TIMEOUT
        : method === "initialize" || method === "session/start" || method === "session/resume"
          ? MUSE_SESSION_LOAD_TIMEOUT
          : "60 seconds",
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
        withThreadLifecycle(
          ctx.session.threadId,
          Effect.gen(function* () {
            yield* Scope.close(ctx.scope, Exit.void);
            if (sessions.get(ctx.session.threadId) === ctx) sessions.delete(ctx.session.threadId);
          }),
        ),
      ).catch(() => undefined);
    };

    let drainViewPages: (ctx: SessionContext, mode?: ViewReadMode) => Promise<void>;

    const settleTurnFromOutcome = (
      ctx: SessionContext,
      turnId: string,
      outcome: MuseTerminalOutcome,
      notice: string,
    ) => {
      if (ctx.settledTurns.has(turnId)) return;
      ctx.settledTurns.add(turnId);
      stopDrainTimer(ctx);
      // Adapter-side settles are invisible by construction: no provider event
      // announced them. Say so out loud, so a quiet thread never reads as a
      // silently dropped turn.
      emit({
        ...base(ctx),
        type: "runtime.warning",
        turnId: TurnId.make(turnId),
        payload: { message: notice },
      });

      for (const [id, item] of ctx.items.entries()) {
        if (item.status === "inProgress") {
          ctx.items.set(id, { ...item, status: "completed" });
          emit({
            ...base(ctx),
            type: "item.completed",
            turnId: TurnId.make(turnId),
            itemId: RuntimeItemId.make(id),
            payload: {
              itemType: itemType(item),
              status: "completed",
            },
          });
          if (item.kind === "workflow" || item.kind === "subagent") {
            emit({
              ...base(ctx),
              type: "task.completed",
              turnId: TurnId.make(turnId),
              itemId: RuntimeItemId.make(id),
              payload: {
                taskId: RuntimeTaskId.make(id),
                taskType: item.kind === "workflow" ? "local_workflow" : "subagent",
                status: "completed",
                summary: "Completed",
              },
            });
          }
        }
      }

      emit({
        ...base(ctx),
        type: "turn.completed",
        turnId: TurnId.make(turnId),
        payload: {
          state:
            outcome.terminal === "interrupted"
              ? "interrupted"
              : outcome.terminal === "failed"
                ? "failed"
                : "completed",
          ...(outcome.reason ? { errorMessage: outcome.reason } : {}),
        },
      });

      const { activeTurnId: _, ...rest } = ctx.session;
      ctx.session = { ...rest, status: "ready", updatedAt: nowIso() };
      emit({
        ...base(ctx),
        type: "session.state.changed",
        payload: { state: "ready" },
      });
    };

    const startDrainTimer = (ctx: SessionContext) => {
      if (ctx.drainTimer) return;
      ctx.drainTimer = setInterval(() => {
        if (ctx.stopped || ctx.session.status !== "running" || !ctx.session.activeTurnId) {
          stopDrainTimer(ctx);
          return;
        }
        void drainViewPages(ctx);

        const activeTurnId = ctx.session.activeTurnId;
        if (!activeTurnId) return;

        const quietMs = Date.now() - ctx.lastActivityAt;

        // Layer 1: If quiet for >= 10s, inspect the on-disk session.jsonl
        if (quietMs >= sessionRecordCheckQuietMs) {
          if (!ctx.sessionLogPath && ctx.sessionId) {
            const museHome =
              ((ctx.host.initializeResult as Record<string, unknown> | undefined)?.museHome as
                | string
                | undefined) ||
              process.env.MUSE_HOME ||
              (process.platform === "win32"
                ? process.env.LOCALAPPDATA
                  ? NodePath.join(process.env.LOCALAPPDATA, "muse")
                  : NodePath.join(NodeOS.homedir(), ".local", "share", "muse")
                : process.env.XDG_DATA_HOME
                  ? NodePath.join(process.env.XDG_DATA_HOME, "muse")
                  : NodePath.join(NodeOS.homedir(), ".local", "share", "muse"));
            ctx.sessionLogPath = findMuseSessionLog(museHome, ctx.sessionId);
          }

          if (ctx.sessionLogPath) {
            const onDiskTerminal = checkOnDiskTerminal(ctx.sessionLogPath, activeTurnId);
            if (onDiskTerminal && !ctx.settlingFromDisk) {
              // The record shows the turn ended but its events have not reached
              // us yet (always the case without push). Drain the view first so
              // the final items (the assistant reply) and the real turn/completed
              // go through receive(), which also drives retries and nudges.
              // Settle from the record only if the view still never delivers it:
              // Muse writes the record before it projects the view, and on a
              // loaded host the view can trail by seconds, so keep paging.
              ctx.settlingFromDisk = true;
              void drainUntilTurnSettles(ctx, activeTurnId)
                .then(() => {
                  if (
                    ctx.stopped ||
                    ctx.settledTurns.has(activeTurnId) ||
                    ctx.session.activeTurnId !== activeTurnId
                  )
                    return;
                  settleTurnFromOutcome(
                    ctx,
                    activeTurnId,
                    onDiskTerminal,
                    "Muse's session record shows this turn ended, but its final events never arrived — settled from the session record.",
                  );
                })
                .finally(() => {
                  ctx.settlingFromDisk = false;
                });
              return;
            }
          }
        }

        // Layer 2: Quiet turn auto-finalization, only when Muse's session record
        // cannot be found. With the record, only its terminal entry (Layer 1)
        // ends a turn: a quiet stretch proves nothing, since a model step can
        // think for minutes without an event and Muse briefly has no open task
        // between every two steps. Muse's own stream timeouts write a terminal
        // entry for a truly hung turn, and the stalled-turn watchdog covers the rest.
        if (
          !ctx.sessionLogPath &&
          quietMs >= quietSettleThresholdMs &&
          !ctx.settlingFromDisk &&
          !hasInProgressItem(ctx) &&
          !hasActiveWorkflowOrSubagent(ctx) &&
          ctx.approvals.size === 0 &&
          ctx.questions.size === 0
        ) {
          settleTurnFromOutcome(
            ctx,
            activeTurnId,
            { terminal: "completed" },
            `No provider activity for ${Math.round(quietMs / 1_000)}s with nothing still running; marking the turn complete. If the model was still working, resend to continue.`,
          );
          return;
        }
      }, pollIntervalMs(ctx));
    };

    // Without push, polling is the only event source, so poll fast enough that
    // the thread still reads as live.
    const pollIntervalMs = (ctx: SessionContext) =>
      ctx.pushUnavailable ? Math.min(drainIntervalMs, 1_000) : drainIntervalMs;

    // Waits for any in-flight drain, then drains once more so events written
    // after that drain started are also delivered.
    const drainViewFully = async (ctx: SessionContext): Promise<void> => {
      await ctx.pagingPromise;
      await drainViewPages(ctx, "turn");
    };

    // Pages the view until the turn's own turn/completed arrives, for at most
    // viewCatchUpMs. Returns early once the turn settled through receive().
    const drainUntilTurnSettles = async (ctx: SessionContext, turnId: string): Promise<void> => {
      const deadline = Date.now() + viewCatchUpMs;
      while (true) {
        await drainViewFully(ctx);
        if (ctx.stopped || ctx.settledTurns.has(turnId) || ctx.session.activeTurnId !== turnId)
          return;
        if (Date.now() >= deadline) return;
        await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, drainIntervalMs)));
      }
    };

    const stopDrainTimer = (ctx: SessionContext) => {
      if (ctx.drainTimer) {
        clearInterval(ctx.drainTimer);
        ctx.drainTimer = undefined;
      }
    };

    drainViewPages = (ctx: SessionContext, mode: ViewReadMode = "incremental"): Promise<void> => {
      if (ctx.stopped || !ctx.host || !ctx.sessionId) return Promise.resolve();
      if (ctx.isPagingView) return ctx.pagingPromise ?? Promise.resolve();
      ctx.isPagingView = true;
      const run = pageView(ctx, mode).finally(() => {
        ctx.isPagingView = false;
        ctx.pagingPromise = undefined;
      });
      ctx.pagingPromise = run;
      return run;
    };

    const pageView = async (ctx: SessionContext, mode: ViewReadMode): Promise<void> => {
      try {
        let currentCursor = ctx.durableViewCursor;
        // Without push, Muse only has a provisional view of the running turn
        // and renumbers it when the turn ends, so a cursor inside the turn can
        // land past events that were not there yet. Re-read the turn from where
        // it began; receive() drops what was already delivered. A re-read costs
        // the whole turn so far (seconds per page on a loaded host, growing with
        // the turn), so it is rationed by its own cost and forced only when the
        // turn ends; the polls in between read forward from the last cursor.
        const activeTurnId = ctx.session.activeTurnId;
        let seen: Set<string> | undefined;
        let rereading = false;
        if (ctx.pushUnavailable && activeTurnId) {
          if (ctx.turnViewAnchorTurnId !== activeTurnId) {
            ctx.turnViewAnchorTurnId = activeTurnId;
            ctx.turnViewAnchor = ctx.durableViewCursor;
            ctx.turnViewSeen = new Set();
            ctx.nextTurnRereadAt = 0;
          }
          seen = ctx.turnViewSeen;
          if (mode === "turn" || Date.now() >= (ctx.nextTurnRereadAt ?? 0)) {
            rereading = true;
            currentCursor = ctx.turnViewAnchor;
          }
        }
        const startedAt = Date.now();
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

          // Only a dead connection should end a read. A loaded host takes tens of
          // seconds per page; abandoning a slow page just re-sends it, piling
          // concurrent reads onto the same overloaded process.
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("view/page timeout")), VIEW_PAGE_TIMEOUT_MS),
          );

          const result = await Promise.race([requestPromise, timeoutPromise]);

          if (!result || !Array.isArray(result.events) || result.events.length === 0) {
            break;
          }

          for (const item of result.events) {
            if (seen) {
              // Re-reads return the same events, possibly renumbered; deliver each once.
              const {
                viewCursor: _cursor,
                sourceRange: _range,
                ...content
              } = (item.params ?? {}) as Record<string, unknown>;
              const signature = `${item.method}|${JSON.stringify(content)}`;
              if (seen.has(signature)) continue;
              seen.add(signature);
            }
            try {
              receive(ctx, item);
            } catch {
              // Ignore single item failure so remaining page events are processed
            }
          }
          const lastCursor = (result.events.at(-1)?.params as { viewCursor?: unknown } | undefined)
            ?.viewCursor;
          if (typeof lastCursor === "string" && lastCursor) ctx.durableViewCursor = lastCursor;

          if (!result.nextCursor || result.nextCursor === currentCursor) {
            break;
          }
          currentCursor = result.nextCursor;
        }
        if (rereading) {
          ctx.nextTurnRereadAt =
            Date.now() + Math.max(turnRereadMinIntervalMs, 3 * (Date.now() - startedAt));
        }
      } catch {
        // Best-effort drain: connection close or transient protocol error should not fail session
      }
    };

    // Resume answers with an empty view cursor when Muse cannot project the
    // session's view; the connection is then not subscribed to pushes. Mark the
    // session for polling and anchor the cursor at the view head so the first
    // poll does not replay the whole history as if it were live.
    const adoptResumeViewState = async (
      ctx: SessionContext,
      viewCursor: string | undefined,
    ): Promise<void> => {
      ctx.pushUnavailable = viewCursor === "";
      if (viewCursor) ctx.durableViewCursor = viewCursor;
      if (!ctx.pushUnavailable || ctx.durableViewCursor) return;
      try {
        const head = (await ctx.host.connection.request("view/page", {
          sessionId: ctx.sessionId,
          direction: "backward",
          limit: 1,
        })) as { events?: Array<{ params?: { viewCursor?: unknown } }> } | undefined;
        const cursor = head?.events?.at(-1)?.params?.viewCursor;
        if (typeof cursor === "string" && cursor) {
          ctx.lastViewCursor = cursor;
          ctx.durableViewCursor = cursor;
        }
      } catch {
        // Without an anchor the first poll pages from the start; replayed turns are ignored.
      }
    };

    const receive = (ctx: SessionContext, input: { method: string; params?: unknown }) => {
      if (ctx.stopped) return;
      if (typeof input !== "object" || input === null || !("method" in input)) return;

      const rawParams = input.params as Record<string, unknown> | undefined;
      if (rawParams && typeof rawParams === "object" && typeof rawParams.viewCursor === "string") {
        ctx.lastViewCursor = rawParams.viewCursor;
      }
      ctx.lastActivityAt = Date.now();

      if (input.method === "view/gap") {
        void drainViewPages(ctx);
        return;
      }
      if (!isMuseNotificationMethod(input.method)) return;
      let event: MuseNotification;
      try {
        event = decodeMuseNotification(input);
      } catch {
        return;
      }
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
        // View catch-up replays requests push already delivered, under a different cursor.
        if (prior && event.method === "approval/requested") return;
        ctx.approvals.set(event.params.approvalId, event.params);

        if (isAutoApproveSession(ctx)) {
          ctx.autoApprovedApprovals.add(event.params.approvalId);
          const approvedChoice =
            event.params.availableChoices.find(
              (choice) =>
                choice.decision === "approved" ||
                choice.decision === "approvedForSession" ||
                choice.decision === "approvedPolicyAmendment",
            ) ?? event.params.availableChoices[0];
          if (approvedChoice) {
            void ctx.host.connection
              .command("approval/decide", {
                sessionId: ctx.sessionId,
                approvalId: event.params.approvalId,
                requirementId: event.params.currentRequirementId,
                choiceId: approvedChoice.choiceId,
              })
              .catch(() => {});
          }
          return;
        }
      }
      if (event.method === "approval/resolved") {
        ctx.approvals.delete(event.params.approvalId);
        if (ctx.autoApprovedApprovals.delete(event.params.approvalId)) return;
      }
      if (event.method === "userInput/requested") {
        if (ctx.questions.has(event.params.userInputId)) return;
        ctx.questions.set(event.params.userInputId, event.params);
      }
      if (event.method === "userInput/settled") ctx.questions.delete(event.params.userInputId);
      if (event.method === "turn/started") {
        if (ctx.settledTurns.has(event.params.turnId)) return;
        ctx.lastTurnId = event.params.turnId;
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
          // Track assistant prose per turn so a completed turn that did work
          // but never responded can be nudged for a summary. Reasoning
          // summaries and tool output are not user-visible responses.
          if (field === "text" && mapped.payload.delta) {
            const owner = ctx.items.get(mapped.itemId)?.turnId ?? ctx.session.activeTurnId;
            if (owner) ctx.lastTurnTextTurnId = String(owner);
          }
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
          ctx.mcpAuditRetryTurnId = undefined;
          ctx.lastTurnStart = undefined;
          // A turn that did work but produced no response text leaves the
          // thread silently dead (observed after hour-long model stalls that
          // end without any assistant message). Ask for a summary once so the
          // thread always gets a response. Failed turns already surface their
          // error; textless turns that ran nothing need no summary. The
          // lastTurnId match keeps resume replays of older completions from
          // scheduling extra nudges.
          if (event.params.turnId === ctx.lastTurnId) {
            if (
              ctx.silentNudgeTurnId === event.params.turnId &&
              ctx.lastTurnTextTurnId !== event.params.turnId
            ) {
              emit({
                ...base(ctx),
                type: "runtime.warning",
                turnId: TurnId.make(event.params.turnId),
                payload: {
                  message:
                    "The follow-up summary also ended without a response. Resend your message to continue manually.",
                },
              });
            } else if (
              ctx.lastTurnTextTurnId !== event.params.turnId &&
              turnDidWork(ctx, event.params.turnId)
            ) {
              if (scheduleSilentNudge(ctx, event.params.turnId))
                ctx.silentNudgeTurnId = event.params.turnId;
            } else {
              ctx.silentNudgeTurnId = undefined;
            }
            ctx.lastTurnTextTurnId = undefined;
          }
        } else if (museTransportTruncationSignature(event.params.error?.message)) {
          ctx.transientFailureStreak = undefined;
          mitigateTransportTruncation(ctx, event.params.turnId, false);
        } else if (
          isMcpStartupAuditFailure(event.params.error?.message) &&
          ctx.lastTurnStart &&
          event.params.turnId === ctx.lastTurnId
        ) {
          // The audit verdict belongs to the serve process that just failed
          // the run, so a re-resume on a fresh process gets a new verdict
          // with identical input and the same session history. One attempt:
          // a second failure means the resume itself is rejected, not racing.
          // The lastTurnId match also ignores replayed failures from older
          // turns, which resume bursts re-emit as notifications.
          if (ctx.mcpAuditRetryTurnId === event.params.turnId) {
            emit({
              ...base(ctx),
              type: "runtime.warning",
              turnId: TurnId.make(event.params.turnId),
              payload: {
                message:
                  "Muse rejected the resumed session twice (MCP startup audit failed) — the turn failed without running anything. Resend your message to retry, or stop the session and resend to start fresh (previous context will be dropped).",
              },
            });
          } else {
            const scheduled = scheduleMcpAuditRetry(
              ctx,
              event.params.turnId,
              event.params.error?.message ?? "unknown error",
            );
            if (scheduled) ctx.mcpAuditRetryTurnId = event.params.turnId;
          }
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
          if (
            item.status === "inProgress" &&
            item.kind !== "workflow" &&
            item.kind !== "subagent"
          ) {
            ctx.items.set(id, { ...item, status: "completed" });
            emit({
              ...base(ctx),
              type: "item.completed",
              turnId: TurnId.make(event.params.turnId),
              itemId: RuntimeItemId.make(id),
              payload: {
                itemType: itemType(item),
                status: "completed",
              },
            });
          }
        }
        if (!hasActiveWorkflowOrSubagent(ctx)) {
          const { activeTurnId: _, ...rest } = ctx.session;
          ctx.session = { ...rest, status: "ready", updatedAt: nowIso() };
          emit({
            ...base(ctx),
            type: "session.state.changed",
            payload: { state: "ready" },
          });
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
      withThreadLifecycle(
        input.threadId,
        Effect.gen(function* () {
          const existing = sessions.get(input.threadId);
          if (existing) yield* stopContext(existing);
          const scope = yield* Scope.make();
          const start = Effect.gen(function* () {
            const cwd = input.cwd ?? config.cwd;
            yield* Effect.promise(() => healWindowsSkillSymlinks(cwd));
            const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
            const args = ["serve", "--trust-workspace"];
            const isFullAccess =
              input.sandboxMode === "danger-full-access" ||
              (input.sandboxMode === undefined && input.runtimeMode === "full-access") ||
              input.approvalPolicy === "never";
            if (
              input.sandboxMode === "danger-full-access" ||
              (input.sandboxMode === undefined && input.runtimeMode === "full-access")
            )
              args.push("--disable-sandbox");
            if (input.sandboxMode === "read-only") args.push("--disable-write", "--disable-shell");
            const baseEnv = {
              ...environment,
              MUSE_NO_AUTO_UPDATE: "1",
              TBH_STREAM_IDLE_TIMEOUT_SECS: "600",
              TBH_STREAM_FIRST_EVENT_TIMEOUT_SECS: "600",
            };
            const sessionEnv = isFullAccess
              ? {
                  ...baseEnv,
                  MUSE_APPROVAL_MODE: "never",
                  APPROVAL_MODE: "never",
                  MUSE_DISABLE_APPROVAL_JUDGE: "1",
                  APPROVAL_JUDGE: "off",
                }
              : baseEnv;
            const stderrBuffer: string[] = [];
            const handshake = yield* Effect.acquireRelease(
              Effect.try({
                try: () =>
                  spawnMspConnection({
                    command: settings.binaryPath || "muse",
                    args,
                    cwd,
                    env: McpProviderSession.withAgentDeviceEnvironment(sessionEnv, mcp),
                    shutdownTimeoutMs: 2_000,
                    onStderr: (chunk: string | Buffer) => {
                      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
                      for (const line of text.split("\n")) {
                        const trimmed = line.trim();
                        if (trimmed) {
                          stderrBuffer.push(trimmed);
                          if (stderrBuffer.length > 100) stderrBuffer.shift();
                        }
                      }
                    },
                    connection: {
                      frameLimitBytes: 512 * 1024 * 1024,
                    },
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
              autoApprovedApprovals: new Set(),
              questions: new Map(),
              settledTurns: new Set(),
              pendingTokenUsage: new Map(),
              stderrBuffer,
              selectedModel,
              stopped: false,
              transportRetryStreak: undefined,
              lastTransportMitigationTurnId: undefined,
              transportStreakCompacted: false,
              lastTurnStart: undefined,
              transientFailureStreak: undefined,
              transientRetryPending: undefined,
              mcpAuditRetryTurnId: undefined,
              silentNudgeTurnId: undefined,
              lastTurnTextTurnId: undefined,
              startInput: input,
              needsRestart: false,
              lastActivityAt: Date.now(),
              sessionLogPath: undefined,
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
                    excludeItems: true,
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
            const foundCursor =
              result.viewCursor ?? snapshotCursor?.viewCursor ?? snapshotCursor?.cursor;
            if (foundCursor) {
              ctx.lastViewCursor = foundCursor;
              ctx.durableViewCursor = foundCursor;
            }
            if (cursor && ctx.sessionId === sessionId)
              yield* Effect.promise(() => adoptResumeViewState(ctx, result.viewCursor));
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
                ctx.lastTurnId = ctx.session.activeTurnId;
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
      host.connection.onProtocolError((error) => {
        failSession(ctx, `Muse Code protocol error: ${error.message}`);
        void host.close().catch(() => {});
      });
      host.connection.onServerRequest(async (request) => {
        if (request.method === "approval/request" && isAutoApproveSession(ctx)) {
          const params = request.params as Approval;
          if (params?.approvalId) {
            ctx.autoApprovedApprovals.add(params.approvalId);
            const approvedChoice =
              params.availableChoices?.find(
                (choice) =>
                  choice.decision === "approved" ||
                  choice.decision === "approvedForSession" ||
                  choice.decision === "approvedPolicyAmendment",
              ) ?? params.availableChoices?.[0];
            if (approvedChoice) {
              void ctx.host.connection
                .command("approval/decide", {
                  sessionId: ctx.sessionId,
                  approvalId: params.approvalId,
                  requirementId: params.currentRequirementId,
                  choiceId: approvedChoice.choiceId,
                })
                .catch(() => {});
            }
            return {};
          }
        }
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
      let exitHandled = false;
      const handleExit = (exitKind?: string) => {
        if (exitHandled || ctx.stopped || ctx.needsRestart) return;
        exitHandled = true;
        const stderrTail = ctx.stderrBuffer.slice(-10).join("\n").trim();
        const baseReason = exitKind
          ? `Muse Code exited (${exitKind}).`
          : "Muse Code closed its connection.";
        const message = stderrTail
          ? `${baseReason} Stderr: ${stderrTail}. Resume the thread to reconnect.`
          : `${baseReason} Resume the thread to reconnect.`;
        failSession(ctx, message);
      };
      void host.connection.closed.then(() => {
        setTimeout(() => handleExit(), 300);
      });
      void host.child.exit.then((exit) => {
        handleExit(exit.kind);
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
      const isFullAccess =
        input.sandboxMode === "danger-full-access" ||
        (input.sandboxMode === undefined && input.runtimeMode === "full-access") ||
        input.approvalPolicy === "never";
      if (
        input.sandboxMode === "danger-full-access" ||
        (input.sandboxMode === undefined && input.runtimeMode === "full-access")
      )
        args.push("--disable-sandbox");
      if (input.sandboxMode === "read-only") args.push("--disable-write", "--disable-shell");
      const baseEnv = {
        ...environment,
        MUSE_NO_AUTO_UPDATE: "1",
        TBH_STREAM_IDLE_TIMEOUT_SECS: "600",
        TBH_STREAM_FIRST_EVENT_TIMEOUT_SECS: "600",
      };
      const sessionEnv = isFullAccess
        ? {
            ...baseEnv,
            MUSE_APPROVAL_MODE: "never",
            APPROVAL_MODE: "never",
            MUSE_DISABLE_APPROVAL_JUDGE: "1",
            APPROVAL_JUDGE: "off",
          }
        : baseEnv;
      const stderrBuffer: string[] = [];
      const handshake = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            spawnMspConnection({
              command: settings.binaryPath || "muse",
              args,
              cwd,
              env: McpProviderSession.withAgentDeviceEnvironment(sessionEnv, mcp),
              shutdownTimeoutMs: 2_000,
              onStderr: (chunk: string | Buffer) => {
                const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
                for (const line of text.split("\n")) {
                  const trimmed = line.trim();
                  if (trimmed) {
                    stderrBuffer.push(trimmed);
                    if (stderrBuffer.length > 100) stderrBuffer.shift();
                  }
                }
              },
              connection: {
                frameLimitBytes: 512 * 1024 * 1024,
              },
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
      ctx.autoApprovedApprovals.clear();
      ctx.questions.clear();
      ctx.pendingTokenUsage.clear();
      ctx.stderrBuffer = stderrBuffer;
      // A fresh session/start always subscribes the connection.
      ctx.pushUnavailable = false;
      // The new session's view starts empty; catch-up pages it from the start.
      ctx.durableViewCursor = undefined;
      ctx.needsRestart = false;
    });

    // A turn that queues while the adapter tracks no live turn means the host
    // is still busy with a turn this adapter already settled (e.g. an
    // idle-settled turn whose tool calls kept running). The queued turn would
    // wait behind that zombie indefinitely, so stop the stale host turn and
    // let the queue drain instead of leaving the session stuck in starting.
    // The explicit turn id keeps this race-safe: if the stale turn already
    // finished, the interrupt is rejected and the queued turn proceeds.
    const interruptStaleHostTurn = (ctx: SessionContext, queuedTurnId: string) =>
      Effect.gen(function* () {
        const activeTurnId = ctx.session.activeTurnId ?? undefined;
        if (
          ctx.session.status === "running" &&
          activeTurnId !== undefined &&
          !ctx.settledTurns.has(activeTurnId)
        ) {
          return;
        }
        const staleTurnId = ctx.lastTurnId;
        if (!staleTurnId) return;
        const interrupted = yield* attempt(
          "turn/interrupt",
          () =>
            ctx.host.connection.command("turn/interrupt", {
              sessionId: ctx.sessionId,
              turnId: staleTurnId,
            }),
          "10 seconds",
        ).pipe(Effect.option);
        if (Option.isNone(interrupted)) {
          yield* Effect.logWarning("Muse stale host turn interrupt failed", {
            threadId: ctx.session.threadId,
            staleTurnId,
            queuedTurnId,
          });
          return;
        }
        emit({
          ...base(ctx),
          type: "runtime.warning",
          turnId: TurnId.make(queuedTurnId),
          payload: {
            message:
              "The previous turn was still running in the provider, so it was stopped to let the queued turn start.",
          },
        });
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
            MUSE_TURN_START_TIMEOUT,
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(TurnResult)),
            Effect.mapError((cause) => requestError("turn/start", cause)),
            Effect.tapError((cause) =>
              Effect.sync(() => {
                const message = cause.detail ?? cause.message;
                if (
                  message.includes("conflicts with an existing event") ||
                  message.includes("event log failed")
                ) {
                  ctx.session = { ...ctx.session, resumeCursor: undefined };
                  ctx.needsRestart = true;
                }
                failSession(ctx, `Muse Code failed to start turn: ${message}`);
              }),
            ),
          );
          if (ctx.stopped)
            return yield* requestError(
              "turn/start",
              ctx.session.lastError ?? "Muse Code disconnected.",
            );
          if (result.disposition !== "queued") {
            ctx.lastTurnId = result.turnId;
            ctx.settledTurns.delete(result.turnId);
            emit({
              ...base(ctx),
              type: "turn.started",
              turnId: TurnId.make(result.turnId),
              payload: {},
            });
          }
          if (result.disposition === "queued") {
            yield* interruptStaleHostTurn(ctx, result.turnId);
          }
          if (result.disposition !== "queued" && !ctx.settledTurns.has(result.turnId)) {
            ctx.lastActivityAt = Date.now();
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
        const hasWedgedBackground =
          hasActiveWorkflowOrSubagent(ctx) ||
          ctx.session.status === "running" ||
          [...ctx.items.values()].some((i) => i.status === "inProgress");

        if (!target && !hasWedgedBackground) {
          if (ctx.session.status === "connecting") {
            yield* stopContext(ctx);
          }
          return;
        }

        if (target) {
          yield* Effect.promise(() => drainViewPages(ctx));
          if (ctx.settledTurns.has(target) && !hasWedgedBackground) {
            stopDrainTimer(ctx);
            return;
          }
        }

        let interrupted = false;
        if (target) {
          const interruptedOption = yield* Effect.tryPromise({
            try: () =>
              ctx.host.connection.command("turn/interrupt", {
                sessionId: ctx.sessionId,
                turnId: target,
              }),
            catch: (cause) => requestError("turn/interrupt", cause),
          }).pipe(
            Effect.timeoutOption("3 seconds"),
            Effect.catch(() => Effect.succeed(Option.none())),
          );
          interrupted = Option.isSome(interruptedOption);
        } else {
          interrupted = true;
        }

        yield* Effect.promise(() => drainViewPages(ctx));
        stopDrainTimer(ctx);

        if (target && ctx.settledTurns.has(target) && !hasWedgedBackground) {
          return;
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

        for (const [id, item] of ctx.items.entries()) {
          if (item.status === "inProgress") {
            ctx.items.set(id, { ...item, status: "completed" });
            emit({
              ...base(ctx),
              type: "item.completed",
              turnId: target ?? TurnId.make(item.turnId),
              itemId: RuntimeItemId.make(id),
              payload: {
                itemType: itemType(item),
                status: "completed",
              },
            });
            if (item.kind === "workflow" || item.kind === "subagent") {
              emit({
                ...base(ctx),
                type: "task.completed",
                turnId: target ?? TurnId.make(item.turnId),
                itemId: RuntimeItemId.make(id),
                payload: {
                  taskId: RuntimeTaskId.make(id),
                  taskType: item.kind === "workflow" ? "local_workflow" : "subagent",
                  status: "stopped",
                  summary: "Workflow interrupted by user",
                },
              });
            }
          }
        }

        if (target && !ctx.settledTurns.has(target)) {
          ctx.settledTurns.add(target);
          emit({
            ...base(ctx),
            type: "turn.completed",
            turnId: target,
            payload: { state: "cancelled", stopReason: "interrupted" },
          });
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
      withThreadLifecycle(
        threadId,
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
    const TRANSIENT_CONTINUE_PROMPT =
      "Your previous turn was cut off by a temporary model backend outage (the model API returned 5xx errors), not by the user. Everything you did before it is in this conversation, including tool results. Continue the user's latest request from exactly where you stopped: do not redo completed steps, and do not stop to summarize until the task is done or you are genuinely blocked.";
    const scheduleTransientRetry = (
      ctx: SessionContext,
      failedTurnId: string,
      message: string,
      attemptNumber: number,
    ): boolean => {
      const delayMs = transientRetryDelays[attemptNumber - 1] ?? 30_000;
      // A turn that already ran tools must not be redriven with its original
      // prompt: that would redo the work. Its tool results are in the session,
      // so ask the model to continue instead; continuing never re-runs a tool.
      let continueWork = false;
      for (const item of ctx.items.values()) {
        if (item.turnId === failedTurnId && TRANSIENT_RETRY_SIDE_EFFECT_KINDS.has(item.kind)) {
          continueWork = true;
          break;
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
          message: `Muse backend error — ${continueWork ? "asking the model to continue where it stopped" : "retrying automatically"} in ${delayMs / 1_000}s (attempt ${attemptNumber} of ${transientRetryDelays.length}): ${message}`,
        },
      });
      const task = Effect.gen(function* () {
        // runPromise begins synchronously inside receive(), before the
        // session-ready transition below runs. Yield first so the guards
        // observe the settled post-notification state, not the mid-receive one.
        yield* Effect.yieldNow;
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
            const input = continueWork
              ? [
                  {
                    type: "text",
                    text: `${buildRuntimeInstructions({ harness: "Muse Code" })}\n\n${TRANSIENT_CONTINUE_PROMPT}`,
                  },
                ]
              : live.parts;
            const started = yield* attempt("turn/start", () =>
              ctx.host.connection.command("turn/start", {
                sessionId: ctx.sessionId,
                input,
                ifBusy: "queue",
                ...(live.reasoningEffort ? { reasoningEffort: live.reasoningEffort } : {}),
              }),
            ).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(TurnResult)),
              Effect.mapError((cause) => requestError("turn/start", cause)),
              Effect.match({
                onFailure: (left) => ({ _tag: "Left", left }) as const,
                onSuccess: (right) => ({ _tag: "Right", right }) as const,
              }),
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
              ctx.lastTurnId = result.turnId;
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
    // Respawns the serve process and re-resumes the SAME session after Muse
    // failed a run with an MCP startup audit error. Muse can keep rejecting the
    // session's MCP startup on every fresh process (observed after a process
    // loss), but a resume without the t3-code MCP server audits cleanly and
    // keeps the conversation. So the replacement resumes without MCP: T3 tools
    // are unavailable until the next session start, the thread keeps working.
    // Returns false when the session is gone: the caller aborts the redrive and
    // the next manual resend falls back to a fresh session through startSession.
    const reauditSession = Effect.fn("MuseAdapter.reauditSession")(function* (ctx: SessionContext) {
      const input = ctx.startInput;
      const cwd = input.cwd ?? config.cwd;
      yield* Effect.promise(() => healWindowsSkillSymlinks(cwd));
      const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
      // Spawn the replacement before tearing down the stale process: if the
      // spawn or handshake fails, the existing session is left untouched and
      // the turn simply stays failed. Closing the old scope trips the stopped
      // finalizer, which also guards the old host's exit handler below.
      const scope = yield* Scope.make();
      const args = ["serve", "--trust-workspace"];
      const isFullAccess =
        input.sandboxMode === "danger-full-access" ||
        (input.sandboxMode === undefined && input.runtimeMode === "full-access") ||
        input.approvalPolicy === "never";
      if (
        input.sandboxMode === "danger-full-access" ||
        (input.sandboxMode === undefined && input.runtimeMode === "full-access")
      )
        args.push("--disable-sandbox");
      if (input.sandboxMode === "read-only") args.push("--disable-write", "--disable-shell");
      const baseEnv = {
        ...environment,
        MUSE_NO_AUTO_UPDATE: "1",
        TBH_STREAM_IDLE_TIMEOUT_SECS: "600",
        TBH_STREAM_FIRST_EVENT_TIMEOUT_SECS: "600",
      };
      const sessionEnv = isFullAccess
        ? {
            ...baseEnv,
            MUSE_APPROVAL_MODE: "never",
            APPROVAL_MODE: "never",
            MUSE_DISABLE_APPROVAL_JUDGE: "1",
            APPROVAL_JUDGE: "off",
          }
        : baseEnv;
      const stderrBuffer: string[] = [];
      const handshake = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            spawnMspConnection({
              command: settings.binaryPath || "muse",
              args,
              cwd,
              env: McpProviderSession.withAgentDeviceEnvironment(sessionEnv, mcp),
              shutdownTimeoutMs: 2_000,
              onStderr: (chunk: string | Buffer) => {
                const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
                for (const line of text.split("\n")) {
                  const trimmed = line.trim();
                  if (trimmed) {
                    stderrBuffer.push(trimmed);
                    if (stderrBuffer.length > 100) stderrBuffer.shift();
                  }
                }
              },
              connection: {
                frameLimitBytes: 512 * 1024 * 1024,
              },
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
      const initialized = yield* attempt("initialize", () =>
        handshake.initialize({
          clientInfo: { name: "t3_code", version: "0.0.0" },
          capabilities: { requestedCapabilities: [] },
        }),
      ).pipe(
        Effect.match({
          onFailure: (left) => ({ _tag: "Left", left }) as const,
          onSuccess: (right) => ({ _tag: "Right", right }) as const,
        }),
      );
      if (initialized._tag === "Left") {
        yield* Scope.close(scope, Exit.void);
        emit({
          ...base(ctx),
          type: "runtime.warning",
          payload: {
            message: `MCP audit retry failed to start a replacement process (${initialized.left.detail}). Resend your message to try again.`,
          },
        });
        return false;
      }
      const host = initialized.right;
      yield* Scope.close(ctx.scope, Exit.void);
      killMuseProcessTree(ctx.handshake);
      wireHostListeners(ctx, host);
      const resumed = yield* attempt("session/resume", () =>
        host.connection.command("session/resume", {
          sessionId: ctx.sessionId,
          excludeItems: true,
        }),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(SessionResult)),
        Effect.mapError((cause) => requestError("session/resume", cause)),
        Effect.match({
          onFailure: (left) => ({ _tag: "Left", left }) as const,
          onSuccess: (right) => ({ _tag: "Right", right }) as const,
        }),
      );
      if (resumed._tag === "Left") {
        yield* Scope.close(scope, Exit.void);
        killMuseProcessTree(handshake);
        // The session is gone from the CLI, so no re-resume can ever work.
        // Route the next manual resend to a fresh session instead.
        ctx.session = { ...ctx.session, resumeCursor: undefined };
        ctx.needsRestart = true;
        ctx.stopped = false;
        emit({
          ...base(ctx),
          type: "runtime.warning",
          payload: {
            message: `MCP audit retry could not re-attach to the session (${resumed.left.detail}). Resend your message to start fresh.`,
          },
        });
        return false;
      }
      const result = resumed.right;
      if (!arePathsEquivalent(result.session.workspaceRoot, cwd)) {
        yield* Scope.close(scope, Exit.void);
        killMuseProcessTree(handshake);
        ctx.stopped = false;
        emit({
          ...base(ctx),
          type: "runtime.warning",
          payload: {
            message:
              "MCP audit retry aborted: the resumed session belongs to a different workspace. Resend your message to start fresh.",
          },
        });
        return false;
      }
      for (const item of result.history?.items ?? result.history?.snapshot?.state.items ?? []) {
        if ((ctx.items.get(item.itemId)?.revision ?? -1) < (item.revision ?? 0))
          ctx.items.set(item.itemId, item);
        if (item.text) ctx.streamed.set(`${item.itemId}:text`, item.text);
        item.summary?.forEach((text, index) =>
          ctx.streamed.set(`${item.itemId}:summary.${index}`, text),
        );
      }
      const mode =
        input.approvalPolicy === "never" ||
        (input.approvalPolicy === undefined && input.runtimeMode === "full-access")
          ? "allowAll"
          : input.approvalPolicy === "untrusted" || input.runtimeMode === "approval-required"
            ? "promptUnmatched"
            : "onRequest";
      const approval = yield* attempt("session/setApprovalMode", () =>
        host.connection.command("session/setApprovalMode", {
          sessionId: ctx.sessionId,
          mode,
        }),
      ).pipe(
        Effect.match({
          onFailure: (left) => ({ _tag: "Left", left }) as const,
          onSuccess: (right) => ({ _tag: "Right", right }) as const,
        }),
      );
      if (approval._tag === "Left") {
        yield* Scope.close(scope, Exit.void);
        killMuseProcessTree(handshake);
        ctx.session = { ...ctx.session, resumeCursor: undefined };
        ctx.needsRestart = true;
        ctx.stopped = false;
        emit({
          ...base(ctx),
          type: "runtime.warning",
          payload: {
            message: `MCP audit retry failed to configure the resumed session (${approval.left.detail}). Resend your message to start fresh.`,
          },
        });
        return false;
      }
      ctx.scope = scope;
      ctx.host = host;
      ctx.handshake = handshake;
      ctx.stderrBuffer = stderrBuffer;
      ctx.session = {
        ...ctx.session,
        resumeCursor: {
          schemaVersion: 1,
          sessionId: ctx.sessionId,
          selectedModel: ctx.selectedModel,
        },
        updatedAt: nowIso(),
      };
      ctx.stopped = false;
      yield* Effect.promise(() => adoptResumeViewState(ctx, result.viewCursor));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          ctx.stopped = true;
          stopDrainTimer(ctx);
        }),
      ).pipe(Effect.provideService(Scope.Scope, scope));
      return true;
    });
    // Redrives a turn the CLI failed with an MCP startup audit error by
    // re-resuming the same session on a fresh serve process, then starting an
    // identical turn. The audit runs before the model, so a failed turn never
    // acts — but the side-effect guard stays: if the turn somehow executed
    // tools, redriving could apply them twice.
    const scheduleMcpAuditRetry = (
      ctx: SessionContext,
      failedTurnId: string,
      message: string,
    ): boolean => {
      for (const item of ctx.items.values()) {
        if (item.turnId === failedTurnId && TRANSIENT_RETRY_SIDE_EFFECT_KINDS.has(item.kind)) {
          emit({
            ...base(ctx),
            type: "runtime.warning",
            turnId: TurnId.make(failedTurnId),
            payload: {
              message:
                "Muse reported an MCP startup audit failure, but the failed turn already executed tools, so it was not retried automatically — re-running them could apply side effects twice. Resend your message to retry manually.",
            },
          });
          return false;
        }
      }
      const record = { failedTurnId, attempt: 1, cancelled: false };
      ctx.transientRetryPending = record;
      emit({
        ...base(ctx),
        type: "session.state.changed",
        payload: { state: "running", reason: "mcp_audit_retry:1/1" },
      });
      emit({
        ...base(ctx),
        type: "runtime.warning",
        turnId: TurnId.make(failedTurnId),
        payload: {
          message: `Muse rejected the resumed session before the model ran (MCP startup audit failed) — restarting its process without T3 Code tools and retrying once in ${mcpAuditRetryDelayMs / 1_000}s. Nothing was executed, so this is safe: ${message}`,
        },
      });
      const task = Effect.gen(function* () {
        yield* Effect.yieldNow;
        if (mcpAuditRetryDelayMs > 0) yield* Effect.sleep(Duration.millis(mcpAuditRetryDelayMs));
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
            const reattached = yield* reauditSession(ctx);
            if (!reattached) return;
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
              Effect.match({
                onFailure: (left) => ({ _tag: "Left", left }) as const,
                onSuccess: (right) => ({ _tag: "Right", right }) as const,
              }),
            );
            if (started._tag === "Left") {
              emit({
                ...base(ctx),
                type: "runtime.warning",
                turnId: TurnId.make(failedTurnId),
                payload: {
                  message: `MCP audit retry failed to start a new turn: ${started.left.detail}. Resend your message to try again.`,
                },
              });
              return;
            }
            const result = started.right;
            if (result.disposition !== "queued") {
              ctx.lastTurnId = result.turnId;
              // The redrive consumed the audit retry: if it fails the same
              // way, that is a rejected resume, not a race — surface it.
              ctx.mcpAuditRetryTurnId = result.turnId;
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
    // Item kinds that count as real work for the silent-completion nudge.
    // Reminder children are system-driven noise, not model work.
    const SILENT_NUDGE_WORK_KINDS: ReadonlySet<string> = new Set([
      "toolCall",
      "userShell",
      "subagent",
      "workflow",
    ]);
    const turnDidWork = (ctx: SessionContext, turnId: string): boolean => {
      for (const item of ctx.items.values()) {
        if (item.turnId === turnId && SILENT_NUDGE_WORK_KINDS.has(item.kind)) return true;
      }
      return false;
    };
    // Starts one follow-up turn asking for a summary after a turn completed
    // with no response text. Unlike a redrive this never repeats tool calls:
    // it only asks the model to report on history, so there is nothing to
    // apply twice. Bounded to one attempt per turn via silentNudgeTurnId; a
    // user send supersedes it through the shared pending slot.
    const SILENT_SUMMARY_NUDGE =
      "Your previous turn ended without any visible response. Briefly summarize what you accomplished in that turn, what remains unfinished, and any blockers. Do not start new work.";
    const scheduleSilentNudge = (ctx: SessionContext, completedTurnId: string): boolean => {
      const record = { failedTurnId: completedTurnId, attempt: 1, cancelled: false };
      ctx.transientRetryPending = record;
      emit({
        ...base(ctx),
        type: "session.state.changed",
        payload: { state: "running", reason: "silent_nudge:1/1" },
      });
      emit({
        ...base(ctx),
        type: "runtime.warning",
        turnId: TurnId.make(completedTurnId),
        payload: {
          message: `The turn completed without any response text — asking for a summary in ${silentNudgeDelayMs / 1_000}s so the thread doesn't go quiet.`,
        },
      });
      const task = Effect.gen(function* () {
        yield* Effect.yieldNow;
        if (silentNudgeDelayMs > 0) yield* Effect.sleep(Duration.millis(silentNudgeDelayMs));
        if (sessions.get(ctx.session.threadId) !== ctx || ctx.stopped) return;
        if (ctx.transientRetryPending !== record || record.cancelled) return;
        if (ctx.session.status !== "ready" || ctx.session.activeTurnId) return;
        if (ctx.needsRestart) return;
        yield* ctx.lock.withPermit(
          Effect.gen(function* () {
            if (sessions.get(ctx.session.threadId) !== ctx || ctx.stopped) return;
            if (ctx.transientRetryPending !== record || record.cancelled) return;
            if (ctx.session.status !== "ready" || ctx.session.activeTurnId) return;
            if (ctx.needsRestart) return;
            ctx.transientRetryPending = undefined;
            const runtimeInstructions = buildRuntimeInstructions({ harness: "Muse Code" });
            const started = yield* attempt("turn/start", () =>
              ctx.host.connection.command("turn/start", {
                sessionId: ctx.sessionId,
                input: [
                  { type: "text", text: `${runtimeInstructions}\n\n${SILENT_SUMMARY_NUDGE}` },
                ],
                ifBusy: "queue",
              }),
            ).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(TurnResult)),
              Effect.mapError((cause) => requestError("turn/start", cause)),
              Effect.match({
                onFailure: (left) => ({ _tag: "Left", left }) as const,
                onSuccess: (right) => ({ _tag: "Right", right }) as const,
              }),
            );
            if (started._tag === "Left") {
              emit({
                ...base(ctx),
                type: "runtime.warning",
                turnId: TurnId.make(completedTurnId),
                payload: {
                  message: `Silent-completion follow-up failed to start: ${started.left.detail}. Resend your message to try again.`,
                },
              });
              return;
            }
            const result = started.right;
            if (result.disposition !== "queued") {
              ctx.lastTurnId = result.turnId;
              // The nudge consumed the silent-completion retry: if it ends
              // silently too, that is a rejected pattern, not a race.
              ctx.silentNudgeTurnId = result.turnId;
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
