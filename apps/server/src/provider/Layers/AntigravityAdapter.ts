import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  RuntimeTaskId,
  TurnId,
  ThreadTokenUsageSnapshot,
  ThreadTokenUsageCategories,
  type AntigravitySettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSetupError,
  type ProviderUserInputAnswers,
  type RuntimeTaskStatus,
  type ThreadId,
  type TurnCompletedPayload,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type { AntigravityAuth } from "../AntigravityAuth.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
  isAntigravitySignInRequiredError,
} from "../antigravityAuthSupport.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { parsePermissionRequest, type AcpToolCallState } from "../acp/AcpRuntimeModel.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  antigravityPermissionMode,
  antigravityModelOptions,
  applyAntigravityAcpModelSelection,
  buildAntigravityPrompt,
  type AntigravityAcpRuntimeInput,
  resolveAntigravityModel,
} from "../acp/AntigravityAcpSupport.ts";
import {
  antigravityApprovalOptions,
  antigravitySubagentOutput,
  classifyAntigravitySubagentToolCall,
  extractAntigravityUserInputQuestion,
  isAntigravityOpenCommand,
  isAntigravitySubagentReplayStart,
  isAntigravityUserInputRequest,
  makeAntigravityUserInputResponse,
  normalizeAntigravityToolCall,
  sanitizeAntigravityToolPayload,
  selectAntigravityPermissionOptionId,
} from "../acp/AntigravityProtocol.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCP from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  checkSubagentTranscriptStatus,
  computeSubagentUsage,
  extractConversationIdsFromText,
  findTranscriptPath,
} from "../../orchestration/subagentTranscriptQuery.ts";

export const KILLED_SUBAGENT_IDS = new Set<string>();
export const SUBAGENT_RUNNING_PIDS = new Map<string, Set<number>>();
export const SUBAGENT_ACTIVE_COMMANDS = new Map<string, string>();

export function findChildPidsOfHarness(): Promise<number[]> {
  return new Promise((resolve) => {
    try {
      if (process.platform === "win32") {
        const ps =
          "$h = (Get-Process localharness_external, agy_acp_server -ErrorAction SilentlyContinue).Id; if ($h) { Get-CimInstance Win32_Process | Where-Object { $h -contains $_.ParentProcessId } | Select-Object -ExpandProperty ProcessId }";
        NodeCP.exec(`powershell -NoProfile -Command "${ps}"`, (err, stdout) => {
          if (err || !stdout) return resolve([]);
          const pids = stdout
            .split(/\r?\n/)
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0);
          resolve(pids);
        });
      } else {
        NodeCP.exec(
          'pgrep -P $(pgrep -d, -f "localharness_external|agy_acp_server" 2>/dev/null) 2>/dev/null',
          (err, stdout) => {
            if (err || !stdout) return resolve([]);
            const pids = stdout
              .split(/\s+/)
              .map((s) => parseInt(s.trim(), 10))
              .filter((n) => Number.isFinite(n) && n > 0);
            resolve(pids);
          },
        );
      }
    } catch {
      resolve([]);
    }
  });
}

export function registerKilledSubagent(conversationId: string): void {
  if (!conversationId || typeof conversationId !== "string" || conversationId.length < 5) return;
  KILLED_SUBAGENT_IDS.add(conversationId);
  try {
    const pids = SUBAGENT_RUNNING_PIDS.get(conversationId);
    if (pids && pids.size > 0) {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    const activeCmd = SUBAGENT_ACTIVE_COMMANDS.get(conversationId);
    if (process.platform === "win32") {
      if (pids && pids.size > 0) {
        const pidList = [...pids].join(",");
        NodeCP.exec(
          `powershell -NoProfile -Command "Stop-Process -Id ${pidList} -Force -ErrorAction SilentlyContinue"`,
          () => {},
        );
      }
      if (activeCmd) {
        const safeSnippet = activeCmd.replace(/["'`$\\]/g, "").slice(0, 35);
        if (safeSnippet.length > 3) {
          const psKill = `$h = (Get-Process localharness_external, agy_acp_server -ErrorAction SilentlyContinue).Id; if ($h) { Get-CimInstance Win32_Process | Where-Object { $h -contains $_.ParentProcessId -and $_.CommandLine -like '*${safeSnippet}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }`;
          NodeCP.exec(`powershell -NoProfile -Command "${psKill}"`, () => {});
        }
      }
      const safeId = conversationId.replace(/["'`$\\]/g, "");
      const psIdKill = `Get-CimInstance Win32_Process | Where-Object CommandLine -like "*${safeId}*" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      NodeCP.exec(`powershell -NoProfile -Command "${psIdKill}"`, () => {});
    } else {
      if (pids && pids.size > 0) {
        for (const pid of pids) {
          NodeCP.exec(`kill -9 ${pid}`, () => {});
        }
      }
      if (activeCmd) {
        const safeSnippet = activeCmd.replace(/["'`$\\]/g, "").slice(0, 35);
        if (safeSnippet.length > 3) {
          NodeCP.exec(`pkill -9 -f "${safeSnippet}"`, () => {});
        }
      }
      NodeCP.exec(`pkill -9 -f "${conversationId}"`, () => {});
    }
  } catch {}
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function extractSubagentConversationId(
  toolCallId: string,
  nativeSessionId?: string,
): string | undefined {
  if (!toolCallId) return undefined;
  const parts = toolCallId.split(":");
  const candidate = parts[0];
  if (candidate && UUID_REGEX.test(candidate) && candidate !== nativeSessionId) {
    return candidate;
  }
  return undefined;
}

export interface TrackedSubagent {
  readonly taskId: RuntimeTaskId;
  readonly role?: string | undefined;
  readonly typeName?: string | undefined;
  readonly prompt?: string | undefined;
  readonly model?: string | undefined;
  status: "running" | "completed" | "failed" | "cancelled";
  conversationId?: string | undefined;
  readonly stepIndex: number;
  inputChars: number;
  outputChars: number;
  toolUses: number;
}

export interface TokenTracker {
  userMessagesChars: number;
  agentResponsesChars: number;
  toolCallsChars: number;
  subagentsChars: number;
  systemPromptTokens: number;
  systemToolsTokens: number;
  skillsTokens: number;
  checkpointBufferTokens: number;
  totalLifetimeProcessedTokens: number;
  toolUses: number;
  toolCallCharsById?: Map<string, number> | undefined;
}

export const ANTIGRAVITY_SYSTEM_PROMPT_TOKENS = 7900;
export const ANTIGRAVITY_SYSTEM_TOOLS_TOKENS = 13800;
export const ANTIGRAVITY_SKILLS_TOKENS = 2900;
export const ANTIGRAVITY_CHECKPOINT_BUFFER_TOKENS = 3200;

export function findConversationDb(sessionId: string): string | null {
  try {
    const home = NodeOS.homedir();
    const candidateDirs = [
      NodePath.join(home, ".antigravity", "conversations"),
      NodePath.join(home, ".gemini", "antigravity-cli", "conversations"),
      NodePath.join(home, ".t3", "userdata", "providers", "antigravity"),
      NodePath.join(process.cwd(), ".t3", "userdata", "providers", "antigravity"),
    ];
    for (const root of candidateDirs) {
      if (!NodeFS.existsSync(root)) continue;
      if (root.endsWith("conversations")) {
        const p = NodePath.join(root, `${sessionId}.db`);
        if (NodeFS.existsSync(p)) return p;
      } else {
        const hashes = NodeFS.readdirSync(root);
        for (const h of hashes) {
          const p = NodePath.join(root, h, "antigravity-acp", "conversations", `${sessionId}.db`);
          if (NodeFS.existsSync(p)) return p;
        }
      }
    }
  } catch {}
  return null;
}

export function parseProtoTokens(buf: Uint8Array): {
  userTokens: number;
  agentTokens: number;
  toolTokens: number;
} | null {
  try {
    let pos = 0;
    let f1Data: Uint8Array | null = null;
    while (pos < buf.length) {
      const key = buf[pos++];
      if (key === undefined) break;
      const fieldNum = key >> 3;
      const wireType = key & 0x7;
      if (wireType === 0) {
        while (pos < buf.length) {
          const b = buf[pos++];
          if (b === undefined || (b & 0x80) === 0) break;
        }
      } else if (wireType === 2) {
        let len = 0;
        let shift = 0;
        while (pos < buf.length) {
          const b = buf[pos++];
          if (b === undefined) break;
          len |= (b & 0x7f) << shift;
          shift += 7;
          if ((b & 0x80) === 0) break;
        }
        if (fieldNum === 1 && len > 1000) {
          f1Data = buf.subarray(pos, pos + len);
          break;
        }
        pos += len;
      } else {
        break;
      }
    }
    if (!f1Data) return null;

    let subPos = 0;
    let userTokens = 0;
    let agentTokens = 0;
    let toolTokens = 0;
    let foundMessages = false;

    while (subPos < f1Data.length) {
      const key = f1Data[subPos++];
      if (key === undefined) break;
      const fieldNum = key >> 3;
      const wireType = key & 0x7;
      if (wireType === 0) {
        while (subPos < f1Data.length) {
          const b = f1Data[subPos++];
          if (b === undefined || (b & 0x80) === 0) break;
        }
      } else if (wireType === 2) {
        let len = 0;
        let shift = 0;
        while (subPos < f1Data.length) {
          const b = f1Data[subPos++];
          if (b === undefined) break;
          len |= (b & 0x7f) << shift;
          shift += 7;
          if ((b & 0x80) === 0) break;
        }
        if (fieldNum === 2) {
          const msgBuf = f1Data.subarray(subPos, subPos + len);
          let mPos = 0;
          let role = -1;
          let tokens = 0;
          while (mPos < msgBuf.length) {
            const mKey = msgBuf[mPos++];
            if (mKey === undefined) break;
            const mFieldNum = mKey >> 3;
            const mWireType = mKey & 0x7;
            if (mWireType === 0) {
              let val = 0;
              let mShift = 0;
              while (mPos < msgBuf.length) {
                const b = msgBuf[mPos++];
                if (b === undefined) break;
                val |= (b & 0x7f) << mShift;
                mShift += 7;
                if ((b & 0x80) === 0) break;
              }
              if (mFieldNum === 2) role = val;
              else if (mFieldNum === 4) tokens = val;
            } else if (mWireType === 2) {
              let mLen = 0;
              let mShift = 0;
              while (mPos < msgBuf.length) {
                const b = msgBuf[mPos++];
                if (b === undefined) break;
                mLen |= (b & 0x7f) << mShift;
                mShift += 7;
                if ((b & 0x80) === 0) break;
              }
              mPos += mLen;
            } else {
              break;
            }
          }
          if (role === 1) userTokens += tokens;
          else if (role === 2) agentTokens += tokens;
          else if (role === 4) toolTokens += tokens;
          foundMessages = true;
        }
        subPos += len;
      } else {
        break;
      }
    }
    return foundMessages ? { userTokens, agentTokens, toolTokens } : null;
  } catch {
    return null;
  }
}

export function syncTokenTrackerFromDb(context: {
  nativeSessionId?: string | undefined;
  antigravityConversationId?: string | undefined;
  tokenTracker: TokenTracker;
}): void {
  try {
    const sessionId = context.nativeSessionId ?? context.antigravityConversationId;
    if (!sessionId) return;
    const dbPath = findConversationDb(sessionId);
    if (!dbPath || !NodeFS.existsSync(dbPath)) return;

    const sqliteModule = (
      process as unknown as { getBuiltinModule?: (name: string) => unknown }
    ).getBuiltinModule?.("node:sqlite") as
      | {
          DatabaseSync: new (
            path: string,
            options?: { readOnly?: boolean },
          ) => {
            prepare: (sql: string) => {
              all: (...args: unknown[]) => Array<Record<string, unknown>>;
              get: (...args: unknown[]) => Record<string, unknown> | undefined;
            };
            close: () => void;
          };
        }
      | undefined;

    if (!sqliteModule?.DatabaseSync) return;

    const db = new sqliteModule.DatabaseSync(dbPath, { readOnly: true });
    try {
      const latestGen = db
        .prepare(
          "SELECT data FROM gen_metadata WHERE length(data) > 1000 ORDER BY idx DESC LIMIT 1",
        )
        .get() as { data?: Uint8Array } | undefined;

      const protoTokens = latestGen?.data ? parseProtoTokens(latestGen.data) : null;

      const latestCp = db
        .prepare(
          "SELECT idx, length(step_payload) as cplen FROM steps WHERE step_type = 23 ORDER BY idx DESC LIMIT 1",
        )
        .get() as { idx?: number | bigint; cplen?: number } | undefined;
      const activeCpIdx = latestCp?.idx != null ? Number(latestCp.idx) : -1;
      if (latestCp?.cplen != null) {
        context.tokenTracker.checkpointBufferTokens = Math.round(Number(latestCp.cplen) / 4);
      }

      if (protoTokens) {
        context.tokenTracker.userMessagesChars = Math.round(protoTokens.userTokens * 4.2);
        context.tokenTracker.agentResponsesChars = Math.round(protoTokens.agentTokens * 4.2);
        context.tokenTracker.toolCallsChars = Math.round(protoTokens.toolTokens * 4.2);
      } else {
        const activeSteps = db
          .prepare(
            "SELECT idx, step_type, length(step_payload) as plen FROM steps WHERE idx >= ? ORDER BY idx",
          )
          .all(activeCpIdx) as Array<{ idx: number; step_type: number; plen: number }>;

        let userChars = 0;
        let agentChars = 0;
        let toolChars = 0;

        for (const s of activeSteps) {
          const plen = Number(s.plen ?? 0);
          if (s.step_type === 14) {
            userChars += plen;
          } else if (s.step_type === 15) {
            agentChars += plen;
          } else if (s.step_type === 23) {
            // Checkpoint buffer, do not count into agent responses
          } else if ([7, 9, 21, 25, 101, 103].includes(s.step_type)) {
            toolChars += plen;
          }
        }

        if (userChars > 0) {
          context.tokenTracker.userMessagesChars = userChars;
        } else {
          const lastUser = db
            .prepare(
              "SELECT length(step_payload) as plen FROM steps WHERE step_type = 14 ORDER BY idx DESC LIMIT 1",
            )
            .get() as { plen?: number } | undefined;
          if (lastUser?.plen) {
            context.tokenTracker.userMessagesChars = Number(lastUser.plen);
          }
        }
        if (agentChars > 0) {
          context.tokenTracker.agentResponsesChars = agentChars;
        }
        if (toolChars > 0) {
          context.tokenTracker.toolCallsChars = toolChars;
        }
      }

      const activeToolCount = db
        .prepare(
          "SELECT count(*) as cnt FROM steps WHERE idx >= ? AND step_type IN (7, 9, 21, 25, 103)",
        )
        .get(activeCpIdx) as { cnt?: number | bigint } | undefined;
      const toolCount = activeToolCount?.cnt != null ? Number(activeToolCount.cnt) : 0;
      if (toolCount > 0) {
        context.tokenTracker.toolUses = toolCount;
      }

      const subagentRow = db
        .prepare(
          "SELECT coalesce(sum(length(step_payload)), 0) as plen FROM steps WHERE idx >= ? AND step_type = 17",
        )
        .get(activeCpIdx) as { plen?: number | bigint } | undefined;
      const subagentChars = subagentRow?.plen != null ? Number(subagentRow.plen) : 0;
      if (subagentChars > 0) {
        context.tokenTracker.subagentsChars = subagentChars;
      }

      context.tokenTracker.toolCallCharsById?.clear();
    } finally {
      db.close();
    }
  } catch {}
}

export interface SubagentListEntry {
  readonly conversationId?: string;
  readonly role?: string;
  readonly type?: string;
  readonly state?: string;
  readonly stateDetail?: string;
  readonly transcript?: string;
}

export function parseSubagentListFromOutput(data: unknown): ReadonlyArray<SubagentListEntry> {
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

const PROVIDER = ProviderDriverKind.make("antigravity");
const ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
});
const decodeResumeCursor = Schema.decodeUnknownOption(ResumeCursor);
const isAcpError = Schema.is(EffectAcpErrors.AcpError);

type Adapter = ProviderAdapterShape<ProviderAdapterError>;
type Runtime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  | "handleRequestPermission"
  | "handleReadTextFile"
  | "handleWriteTextFile"
  | "start"
  | "setMode"
  | "setModel"
  | "getConfigOptions"
  | "getEvents"
  | "drainEvents"
  | "prompt"
  | "cancel"
>;
type NativePermission = EffectAcpSchema.RequestPermissionRequest;
type NativePermissionResponse = EffectAcpSchema.RequestPermissionResponse;

function mapAntigravityError(threadId: ThreadId, method: string, cause: EffectAcpErrors.AcpError) {
  return isAntigravitySignInRequiredError(cause)
    ? new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
        cause,
      })
    : mapAcpToAdapterError(PROVIDER, threadId, method, cause);
}

export interface AntigravityAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly makeRuntime: (
    input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner" | "onAuthorizationUrl">,
  ) => Effect.Effect<Runtime, EffectAcpErrors.AcpError | ProviderSetupError, Scope.Scope>;
  readonly withProcess: AntigravityAuth["withProcess"];
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onAvailableCommands?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onConfigOptionsUpdated?: (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ) => Effect.Effect<void>;
  readonly onAuthRequired?: Effect.Effect<void>;
  /** Model the provider default alias selects, when the account offers it. */
  readonly defaultModel?: Effect.Effect<string | undefined>;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly prewarm?: boolean;
}

interface PendingApproval {
  readonly request: NativePermission;
  readonly response: Deferred.Deferred<{
    readonly decision: ProviderApprovalDecision;
    readonly result: NativePermissionResponse;
  }>;
}

interface PendingQuestion {
  readonly request: NativePermission;
  readonly response: Deferred.Deferred<{
    readonly answers: ProviderUserInputAnswers;
    readonly result: NativePermissionResponse;
  }>;
}

interface OpenCommand {
  readonly toolCall: AcpToolCallState;
  readonly turnId: TurnId | undefined;
  readonly promoted: boolean;
}

interface OpenSubagent {
  readonly turnId: TurnId | undefined;
  readonly status: "pending" | "running" | undefined;
  readonly description?: string;
}

function subagentLinkage(toolCallId: string) {
  return {
    taskId: RuntimeTaskId.make(toolCallId),
    taskType: "subagent_batch",
    toolUseId: toolCallId,
    title: "Antigravity subagent batch",
  };
}

interface TurnIntent {
  readonly turnId: TurnId;
  readonly generation: number;
  settled: boolean;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly nativeSessionId: string;
  readonly scope: Scope.Closeable;
  readonly runtime: Runtime;
  readonly promptLock: Semaphore.Semaphore;
  readonly stopLock: Semaphore.Semaphore;
  readonly commandLock: Semaphore.Semaphore;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  readonly questions: Map<ApprovalRequestId, PendingQuestion>;
  readonly commands: Map<string, OpenCommand>;
  /** Keep only IDs after settlement or MCP exclusion so merged late updates cannot change identity. */
  readonly subagents: Map<string, OpenSubagent | "finished" | "mcp">;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly trackedSubagents: Map<string, TrackedSubagent>;
  readonly tokenTracker: TokenTracker;
  antigravityConversationId: string | undefined;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  lastEmittedUsage?: ThreadTokenUsageSnapshot;
  promptFiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> | undefined;
  generation: number;
  stopped: boolean;
  closed: boolean;
  disconnected: boolean;
}

const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;

function isInsideRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolves an agent-supplied path and rejects anything outside the session roots. */
const resolveClientFilePath = Effect.fn("AntigravityAdapter.resolveClientFilePath")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly requestPath: string;
  }) {
    const { path } = input;
    const resolved = path.resolve(input.requestPath);
    // Follow symlinks on the parent so a link out of the workspace cannot escape it.
    const parent = yield* input.fileSystem
      .realPath(path.dirname(resolved))
      .pipe(Effect.orElseSucceed(() => path.dirname(resolved)));
    const real = path.join(parent, path.basename(resolved));
    const roots = yield* Effect.forEach(input.allowedRoots, (root) =>
      input.fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root)),
    );
    if (!roots.some((root) => isInsideRoot(path, root, real))) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Path '${input.requestPath}' is outside the session workspace.`,
      );
    }
    return real;
  },
);

const readClientTextFile = Effect.fn("AntigravityAdapter.readClientTextFile")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly allowedRoots: ReadonlyArray<string>;
  readonly request: EffectAcpSchema.ReadTextFileRequest;
}): Effect.fn.Return<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpError> {
  const filePath = yield* resolveClientFilePath({ ...input, requestPath: input.request.path });
  const info = yield* input.fileSystem
    .stat(filePath)
    .pipe(
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.resourceNotFound(`File '${input.request.path}' not found.`),
      ),
    );
  if (info.type !== "File" || Number(info.size) > CLIENT_FILE_MAX_BYTES) {
    return yield* EffectAcpErrors.AcpRequestError.invalidParams(
      `File '${input.request.path}' is not a readable text file under ${CLIENT_FILE_MAX_BYTES} bytes.`,
    );
  }
  const text = yield* input.fileSystem
    .readFileString(filePath)
    .pipe(
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.internalError(`Could not read '${input.request.path}'.`),
      ),
    );
  const line = input.request.line ?? undefined;
  const limit = input.request.limit ?? undefined;
  if (line === undefined && limit === undefined) {
    return { content: text };
  }
  // ACP lines are 1-indexed. `limit` is a line count.
  const lines = text.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
  return { content: lines.slice(start, end).join("\n") };
});

const writeClientTextFile = Effect.fn("AntigravityAdapter.writeClientTextFile")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly allowedRoots: ReadonlyArray<string>;
  readonly request: EffectAcpSchema.WriteTextFileRequest;
}): Effect.fn.Return<EffectAcpSchema.WriteTextFileResponse, EffectAcpErrors.AcpError> {
  const filePath = yield* resolveClientFilePath({ ...input, requestPath: input.request.path });
  yield* input.fileSystem.makeDirectory(input.path.dirname(filePath), { recursive: true }).pipe(
    Effect.andThen(input.fileSystem.writeFileString(filePath, input.request.content)),
    Effect.mapError(() =>
      EffectAcpErrors.AcpRequestError.internalError(`Could not write '${input.request.path}'.`),
    ),
  );
  return {};
});

/** Keeps one official ACP process per thread and drains a cancelled prompt before steering. */
export const makeAntigravityAdapter = Effect.fn("makeAntigravityAdapter")(function* (
  settings: AntigravitySettings,
  options: AntigravityAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const ownerScope = yield* Effect.scope;
  const makeNativeLoggers = yield* makeAcpNativeLoggerFactory();
  const sessions = new Map<ThreadId, SessionContext>();
  const locks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  const startingSessions = new Map<
    ThreadId,
    {
      readonly sessionScope: Scope.Closeable;
      readonly abort: Effect.Effect<void>;
    }
  >();

  interface WarmStandby {
    readonly runtime: Runtime;
    readonly scope: Scope.Closeable;
    readonly started: AcpSessionRuntime.AcpSessionRuntimeStartResult;
    readonly cwd: string;
  }
  let warmStandby: WarmStandby | undefined;
  let isPrewarming = false;

  const prewarmEnabled =
    options.prewarm ?? (process.env.NODE_ENV !== "test" && !process.env.VITEST);

  const prewarm = (targetCwd: string) =>
    Effect.gen(function* () {
      if (!prewarmEnabled) return;
      if ((warmStandby && warmStandby.cwd === targetCwd) || isPrewarming) return;
      isPrewarming = true;
      const standbyScope = yield* Scope.make("sequential");
      const stopOwned = Scope.close(standbyScope, Exit.void);
      yield* options
        .withProcess(
          stopOwned,
          Effect.gen(function* () {
            const runtime = yield* options.makeRuntime({
              cwd: targetCwd,
              clientInfo: { name: "t3-code", version: "0.0.0" },
              clientFileSystem: true,
              additionalDirectories: [serverConfig.attachmentsDir],
              mcpServers: [],
              ...makeNativeLoggers({
                nativeEventLogger: options.nativeEventLogger,
                provider: PROVIDER,
                threadId: "standby-warm" as ThreadId,
              }),
            });
            const allowedRoots = [targetCwd, serverConfig.attachmentsDir];
            yield* runtime.handleReadTextFile((request) =>
              readClientTextFile({ fileSystem, path, allowedRoots, request }),
            );
            yield* runtime.handleWriteTextFile((request) =>
              writeClientTextFile({ fileSystem, path, allowedRoots, request }),
            );
            yield* runtime.handleRequestPermission(() =>
              Effect.succeed({
                outcome: { outcome: "cancelled" },
              } satisfies NativePermissionResponse),
            );
            const started = yield* runtime.start();
            if (warmStandby) {
              yield* Scope.close(warmStandby.scope, Exit.void);
            }
            warmStandby = {
              runtime,
              scope: standbyScope,
              started,
              cwd: targetCwd,
            };
          }),
        )
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              isPrewarming = false;
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Scope.close(standbyScope, Exit.void);
              yield* Effect.logDebug("Antigravity pre-warm standby failed", cause);
            }),
          ),
        );
    });
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Could not create an Antigravity event ID.",
          cause,
        }),
    ),
  );
  const stamp = Effect.all({
    eventId: Effect.map(randomId, EventId.make),
    createdAt: nowIso,
  });
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

  function buildTokenUsageSnapshot(context: SessionContext): ThreadTokenUsageSnapshot {
    const userMessages = Math.round(context.tokenTracker.userMessagesChars / 4.2);
    const agentResponses = Math.round(context.tokenTracker.agentResponsesChars / 4.2);
    const toolCalls = Math.round(context.tokenTracker.toolCallsChars / 4.2);
    const systemPrompt = context.tokenTracker.systemPromptTokens;
    const systemTools = context.tokenTracker.systemToolsTokens;
    const skills = context.tokenTracker.skillsTokens;
    const checkpointBuffer = context.tokenTracker.checkpointBufferTokens;

    let subagents = 0;
    for (const s of context.trackedSubagents.values()) {
      const sTok = Math.round(((s.inputChars ?? 0) + (s.outputChars ?? 0)) / 4);
      subagents += Math.max(0, sTok);
    }
    if (context.tokenTracker.subagentsChars > 0) {
      subagents = Math.max(subagents, Math.round(context.tokenTracker.subagentsChars / 4));
    }

    const usedTokens =
      userMessages + agentResponses + toolCalls + systemPrompt + systemTools + skills + subagents;

    const cachedInputTokens = systemPrompt + systemTools + skills;
    const inputTokens = userMessages + toolCalls + subagents;
    const outputTokens = agentResponses;
    const maxTokens = 1_000_000;

    const totalProcessedTokens = Math.max(
      usedTokens,
      context.tokenTracker.totalLifetimeProcessedTokens + cachedInputTokens,
    );

    return {
      usedTokens,
      totalProcessedTokens,
      maxTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      toolUses: context.tokenTracker.toolUses,
      compactsAutomatically: true,
      categories: {
        userMessages,
        agentResponses,
        toolCalls,
        systemPrompt,
        systemTools,
        skills,
        ...(subagents > 0 ? { subagents } : {}),
        ...(checkpointBuffer > 0 ? { checkpointBuffer } : {}),
      },
    };
  }

  const emitTokenUsage = (context: SessionContext, turnId?: TurnId) =>
    Effect.gen(function* () {
      syncTokenTrackerFromDb(context);
      const snapshot = buildTokenUsageSnapshot(context);
      context.lastEmittedUsage = snapshot;
      yield* emit({
        type: "thread.token-usage.updated",
        ...(yield* stamp),
        provider: PROVIDER,
        threadId: context.threadId,
        turnId: turnId ?? context.activeTurnId,
        payload: {
          usage: snapshot,
        },
      });
    });

  function writeSubagentTranscriptStep(subagentId: string, toolCall: AcpToolCallState): void {
    try {
      const home = NodeOS.homedir();
      const candidateDirs = [
        NodePath.join(home, ".t3", "userdata", "providers", "antigravity"),
        NodePath.join(process.cwd(), ".t3", "userdata", "providers", "antigravity"),
      ];
      for (const root of candidateDirs) {
        if (!NodeFS.existsSync(root)) continue;
        const hashes = NodeFS.readdirSync(root);
        for (const h of hashes) {
          const brainDir = NodePath.join(root, h, "antigravity-acp", "brain", subagentId);
          if (NodeFS.existsSync(brainDir)) {
            const logsDir = NodePath.join(brainDir, ".system_generated", "logs");
            if (!NodeFS.existsSync(logsDir)) {
              NodeFS.mkdirSync(logsDir, { recursive: true });
            }
            const transcriptPath = NodePath.join(logsDir, "transcript.jsonl");
            const now = DateTime.nowUnsafe();
            const stepIndex = DateTime.toEpochMillis(now);
            const stepObj = {
              step_index: stepIndex,
              type: "PLANNER_RESPONSE",
              tool_calls: [
                {
                  name: toolCall.title ?? toolCall.kind ?? "tool",
                  args: toolCall.data ?? {},
                },
              ],
              content: toolCall.detail ?? toolCall.title,
              created_at: DateTime.formatIso(now),
            };
            NodeFS.appendFileSync(transcriptPath, JSON["stringify"](stepObj) + "\n", "utf8");
            return;
          }
        }
      }
    } catch {}
  }

  const withThreadLock = <A, E, R>(threadId: ThreadId, task: Effect.Effect<A, E, R>) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
      const existing = current.get(threadId);
      if (existing) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((lock) => [lock, new Map(current).set(threadId, lock)] as const),
      );
    }).pipe(Effect.flatMap((lock) => lock.withPermit(task)));

  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const cancelRequests = Effect.fn("AntigravityAdapter.cancelRequests")(function* (
    context: SessionContext,
  ) {
    for (const pending of context.approvals.values()) {
      yield* Deferred.succeed(pending.response, {
        decision: "cancel",
        result: { outcome: { outcome: "cancelled" } },
      });
    }
    for (const pending of context.questions.values()) {
      yield* Deferred.succeed(pending.response, {
        answers: {},
        result: { outcome: { outcome: "cancelled" } },
      });
    }
  });

  const finishBackgroundCommands = (context: SessionContext) =>
    context.commandLock.withPermit(
      Effect.gen(function* () {
        for (const [id, command] of context.commands) {
          if (!command.promoted) continue;
          yield* emit({
            type: "task.completed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: command.turnId,
            payload: {
              taskId: RuntimeTaskId.make(id),
              taskType: "local_bash",
              toolUseId: id,
              status: "stopped",
            },
          });
        }
        context.commands.clear();
      }),
    );

  const finishSubagents = (
    context: SessionContext,
    status: Extract<RuntimeTaskStatus, "cancelled" | "failed" | "idle">,
    error?: string,
  ) =>
    context.commandLock.withPermit(
      Effect.gen(function* () {
        for (const [id, subagent] of context.subagents) {
          if (subagent === "finished" || subagent === "mcp") continue;
          yield* emit({
            type: "task.updated",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: subagent.turnId,
            payload: {
              ...subagentLinkage(id),
              status,
              ...(status === "idle"
                ? {
                    description: "Turn ended. Individual agent status is unavailable.",
                    timelineBypass: true,
                  }
                : {}),
              ...(error ? { error } : {}),
            },
          });
          context.subagents.set(id, "finished");
        }
      }),
    );

  const stopContext = (context: SessionContext) =>
    context.stopLock
      .withPermit(
        Effect.gen(function* () {
          if (context.closed) return;
          context.stopped = true;
          yield* Effect.gen(function* () {
            yield* cancelRequests(context);
            if (context.promptFiber && !context.disconnected) {
              yield* Effect.ignore(context.runtime.cancel);
            }
          }).pipe(Effect.ensuring(Scope.close(context.scope, Exit.void)));
          context.closed = true;
          if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
          yield* finishBackgroundCommands(context);
          yield* finishSubagents(
            context,
            context.disconnected ? "failed" : "cancelled",
            context.disconnected ? "Antigravity process stopped." : undefined,
          );
          context.subagents.clear();
          yield* emit({
            type: "session.exited",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            payload: {
              exitKind: context.disconnected ? "error" : "graceful",
              ...(context.disconnected ? { reason: "Antigravity process stopped." } : {}),
            },
          });
        }),
      )
      .pipe(Effect.uninterruptible);

  const handlePermission = Effect.fn("AntigravityAdapter.handlePermission")(function* (
    context: SessionContext,
    request: NativePermission,
  ): Effect.fn.Return<NativePermissionResponse, ProviderAdapterError> {
    if (context.stopped || request.sessionId !== context.nativeSessionId) {
      return { outcome: { outcome: "cancelled" } };
    }
    const requestId = ApprovalRequestId.make(yield* randomId);
    const runtimeRequestId = RuntimeRequestId.make(requestId);
    const turnId = context.activeTurnId;
    const rawPayload = sanitizeAntigravityToolPayload(request);

    if (isAntigravityUserInputRequest(request)) {
      const question = extractAntigravityUserInputQuestion(request);
      if (!question) return { outcome: { outcome: "cancelled" } };
      const response = yield* Deferred.make<{
        answers: ProviderUserInputAnswers;
        result: NativePermissionResponse;
      }>();
      context.questions.set(requestId, { request, response });
      return yield* Effect.gen(function* () {
        yield* emit({
          type: "user-input.requested",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          payload: { questions: [question] },
          raw: { source: "acp.jsonrpc", method: "session/request_permission", payload: rawPayload },
        });
        const answer = yield* Deferred.await(response);
        yield* emit({
          type: "user-input.resolved",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          payload: { answers: answer.answers },
        });
        return answer.result;
      }).pipe(Effect.ensuring(Effect.sync(() => context.questions.delete(requestId))));
    }

    const response = yield* Deferred.make<{
      decision: ProviderApprovalDecision;
      result: NativePermissionResponse;
    }>();
    context.approvals.set(requestId, { request, response });
    const parsed = parsePermissionRequest(request);
    const toolCall = parsed.toolCall ? normalizeAntigravityToolCall(parsed.toolCall) : undefined;
    const permissionRequest = {
      ...parsed,
      ...(toolCall ? { toolCall } : {}),
      detail:
        toolCall?.command ??
        toolCall?.detail ??
        toolCall?.title ??
        "Antigravity requests permission.",
    };
    return yield* Effect.gen(function* () {
      yield* emit(
        makeAcpRequestOpenedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          permissionRequest,
          approvalOptions: antigravityApprovalOptions(request),
          detail: permissionRequest.detail ?? "Antigravity requests permission.",
          args: rawPayload,
          source: "acp.jsonrpc",
          method: "session/request_permission",
          rawPayload,
        }),
      );
      const answer = yield* Deferred.await(response);
      yield* emit(
        makeAcpRequestResolvedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          permissionRequest,
          decision: answer.decision,
        }),
      );
      return answer.result;
    }).pipe(Effect.ensuring(Effect.sync(() => context.approvals.delete(requestId))));
  });

  const handleEvent = Effect.fn("AntigravityAdapter.handleEvent")(function* (
    context: SessionContext,
    event: AcpSessionRuntime.AcpSessionRuntimeEvent,
  ) {
    if (event._tag === "EventStreamBarrier") {
      yield* Deferred.succeed(event.acknowledge, undefined);
      return;
    }
    if (context.stopped) return;
    switch (event._tag) {
      case "ModeChanged":
        return;
      case "AvailableCommandsUpdated":
        yield* options.onAvailableCommands?.(event.availableCommands, context.cwd) ?? Effect.void;
        return;
      case "ConfigOptionsUpdated":
        yield* options.onConfigOptionsUpdated?.(event.configOptions) ?? Effect.void;
        return;
      case "ConnectionTerminated":
        context.stopped = true;
        context.disconnected = true;
        yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
        return;
      case "AssistantItemStarted":
      case "AssistantItemCompleted":
        yield* emit(
          makeAcpAssistantItemEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            itemId: event.itemId,
            lifecycle: event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
          }),
        );
        return;
      case "ThoughtDelta":
      case "ContentDelta":
        if (event.text) {
          context.tokenTracker.agentResponsesChars += event.text.length;
          context.tokenTracker.totalLifetimeProcessedTokens += Math.round(event.text.length / 4);
        }
        yield* emit(
          makeAcpContentDeltaEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            ...(event._tag === "ContentDelta" && event.itemId ? { itemId: event.itemId } : {}),
            ...(event._tag === "ThoughtDelta" ? { streamKind: "reasoning_text" } : {}),
            text: event.text,
            rawPayload: sanitizeAntigravityToolPayload(event.rawPayload),
          }),
        );
        return;
      case "PlanUpdated":
        yield* emit(
          makeAcpPlanUpdatedEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            payload: event.payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload: sanitizeAntigravityToolPayload(event.rawPayload),
          }),
        );
        return;
      case "ToolCallUpdated":
        yield* context.commandLock.withPermit(
          Effect.gen(function* () {
            const toolCall = normalizeAntigravityToolCall(event.toolCall);
            const tracked = context.subagents.get(toolCall.toolCallId);
            if (tracked === "finished") return;
            const kind = classifyAntigravitySubagentToolCall(toolCall, event.rawPayload);
            const isMcp = tracked === "mcp" || kind === "mcp";
            if (isMcp) context.subagents.set(toolCall.toolCallId, "mcp");
            const subagent = tracked === "mcp" ? undefined : tracked;
            if (!isMcp && (subagent || kind === "subagent")) {
              const turnId = subagent?.turnId ?? context.activeTurnId;
              const linkage = subagentLinkage(toolCall.toolCallId);
              // Replay starts claim completion before the result says whether the call failed.
              if (
                context.activeTurnId === undefined &&
                isAntigravitySubagentReplayStart(event.rawPayload)
              ) {
                context.subagents.set(toolCall.toolCallId, { turnId, status: undefined });
                return;
              }
              if (toolCall.status === "failed") {
                const summary = antigravitySubagentOutput(toolCall);
                yield* emit({
                  type: "task.completed",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId,
                  payload: {
                    ...linkage,
                    status: toolCall.status,
                    ...(summary ? { summary } : {}),
                  },
                });
                context.subagents.set(toolCall.toolCallId, "finished");
              } else if (context.activeTurnId === undefined && toolCall.status === "completed") {
                yield* emit({
                  type: "task.updated",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId,
                  payload: {
                    ...linkage,
                    status: "idle",
                    description: "Individual agent status is unavailable for this earlier batch.",
                    timelineBypass: true,
                  },
                });
                context.subagents.set(toolCall.toolCallId, "finished");
              } else {
                // start_subagent returns after launching a batch. Its output is
                // the launch description, not a child result or completion.
                const status = toolCall.status === "pending" ? "pending" : "running";
                const description =
                  antigravitySubagentOutput(toolCall) ?? subagent?.description ?? linkage.title;
                if (subagent?.status !== status || subagent?.description !== description) {
                  yield* emit({
                    type: "task.progress",
                    ...(yield* stamp),
                    provider: PROVIDER,
                    threadId: context.threadId,
                    turnId,
                    payload: { ...linkage, description, summary: description, status },
                  });
                }
                context.subagents.set(toolCall.toolCallId, { turnId, status, description });
              }
              return;
            }
            const existing = context.commands.get(toolCall.toolCallId);
            yield* emit(
              makeAcpToolCallEvent({
                stamp: yield* stamp,
                provider: PROVIDER,
                threadId: context.threadId,
                turnId: existing?.turnId ?? context.activeTurnId,
                toolCall,
                rawPayload: sanitizeAntigravityToolPayload(event.rawPayload),
              }),
            );
            if (isAntigravityOpenCommand(toolCall)) {
              context.commands.set(toolCall.toolCallId, {
                toolCall,
                turnId: existing?.turnId ?? context.activeTurnId,
                promoted: existing?.promoted ?? false,
              });
            } else if (toolCall.status === "completed" || toolCall.status === "failed") {
              context.commands.delete(toolCall.toolCallId);
              if (existing?.promoted) {
                yield* emit({
                  type: "task.completed",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId: existing.turnId,
                  payload: {
                    taskId: RuntimeTaskId.make(toolCall.toolCallId),
                    taskType: "local_bash",
                    toolUseId: toolCall.toolCallId,
                    status: toolCall.status === "failed" ? "failed" : "completed",
                  },
                });
              }
            }

            // Check if this toolCall belongs to a multiplexed subagent
            const subagentId = extractSubagentConversationId(
              toolCall.toolCallId,
              context.nativeSessionId,
            );
            if (subagentId) {
              if (KILLED_SUBAGENT_IDS.has(subagentId)) {
                const tracked = context.trackedSubagents.get(subagentId);
                if (tracked && tracked.status === "running") {
                  tracked.status = "cancelled";
                  yield* emit({
                    type: "task.completed",
                    ...(yield* stamp),
                    provider: PROVIDER,
                    threadId: context.threadId,
                    turnId: existing?.turnId ?? context.activeTurnId,
                    payload: {
                      taskId: tracked.taskId,
                      status: "stopped",
                      taskType: "subagent",
                      agentKind: "agent",
                    },
                  });
                }
                return;
              }

              let tracked = context.trackedSubagents.get(subagentId);
              if (!tracked) {
                const taskId = RuntimeTaskId.make(subagentId);
                const subIndex = context.trackedSubagents.size + 1;
                const role = `Subagent #${subIndex}`;
                tracked = {
                  taskId,
                  role,
                  status: "running",
                  conversationId: subagentId,
                  stepIndex: subIndex,
                  inputChars: 200,
                  outputChars: 0,
                  toolUses: 0,
                };
                context.trackedSubagents.set(subagentId, tracked);
                context.trackedSubagents.set(String(taskId), tracked);
                yield* emit({
                  type: "task.started",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId: existing?.turnId ?? context.activeTurnId,
                  payload: {
                    taskId,
                    taskType: "subagent",
                    agentKind: "agent",
                    title: role,
                    description: toolCall.title ?? toolCall.detail ?? role,
                    role,
                    model: context.session.model ?? "gemini-3.8-flash-high",
                  },
                });
              }

              const toolData = (toolCall.data ?? {}) as Record<string, unknown>;
              const cmd = (toolData.CommandLine ||
                toolData.command ||
                (toolData.parameters as any)?.CommandLine) as string | undefined;
              if (typeof cmd === "string" && cmd.trim()) {
                SUBAGENT_ACTIVE_COMMANDS.set(subagentId, cmd.trim());
                findChildPidsOfHarness().then((pids) => {
                  let set = SUBAGENT_RUNNING_PIDS.get(subagentId);
                  if (!set) {
                    set = new Set();
                    SUBAGENT_RUNNING_PIDS.set(subagentId, set);
                  }
                  for (const p of pids) set.add(p);
                });
              }

              const callChars =
                (toolCall.title?.length ?? 0) +
                (toolCall.detail?.length ?? 0) +
                JSON["stringify"](toolData).length;
              tracked.outputChars += callChars;
              tracked.toolUses += 1;
              const subTotalTokens = Math.max(
                1,
                Math.round((tracked.inputChars + tracked.outputChars) / 4),
              );
              const subUsage = {
                totalTokens: subTotalTokens,
                inputTokens: Math.max(1, Math.round(tracked.inputChars / 4)),
                outputTokens: Math.max(1, Math.round(tracked.outputChars / 4)),
                toolUses: tracked.toolUses,
              };

              if (toolCall.status === "inProgress" || toolCall.status === "pending") {
                yield* emit({
                  type: "task.progress",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId: existing?.turnId ?? context.activeTurnId,
                  payload: {
                    taskId: tracked.taskId,
                    status: "running",
                    taskType: "subagent",
                    agentKind: "agent",
                    summary: toolCall.title ?? toolCall.detail ?? "Running tool",
                    description: toolCall.title ?? toolCall.detail ?? "Running tool",
                    lastToolName: toolCall.title?.split(" ")[0]?.toLowerCase() ?? "tool",
                    typedUsage: subUsage,
                  },
                });
              } else if (toolCall.status === "completed" || toolCall.status === "failed") {
                yield* emit({
                  type: "task.progress",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId: existing?.turnId ?? context.activeTurnId,
                  payload: {
                    taskId: tracked.taskId,
                    status: "running",
                    taskType: "subagent",
                    agentKind: "agent",
                    summary: toolCall.title ?? toolCall.detail ?? "Tool finished",
                    description: toolCall.title ?? toolCall.detail ?? "Tool finished",
                    lastToolName: toolCall.title?.split(" ")[0]?.toLowerCase() ?? "tool",
                    typedUsage: subUsage,
                  },
                });
              }

              writeSubagentTranscriptStep(subagentId, toolCall);
              yield* emitTokenUsage(context);
            } else {
              const toolData = (toolCall.data ?? {}) as Record<string, unknown>;
              const callChars =
                (toolCall.title?.length ?? 0) +
                (toolCall.detail?.length ?? 0) +
                (toolCall.command?.length ?? 0) +
                JSON["stringify"](toolData).length;
              if (!context.tokenTracker.toolCallCharsById) {
                context.tokenTracker.toolCallCharsById = new Map();
              }
              const prevChars =
                context.tokenTracker.toolCallCharsById.get(toolCall.toolCallId) ?? 0;
              const delta = Math.max(0, callChars - prevChars);
              if (delta > 0) {
                context.tokenTracker.toolCallCharsById.set(toolCall.toolCallId, callChars);
                context.tokenTracker.toolCallsChars += delta;
                context.tokenTracker.totalLifetimeProcessedTokens += Math.round(delta / 4);
              }
              if (
                (toolCall.status === "completed" || toolCall.status === "failed") &&
                prevChars === 0
              ) {
                context.tokenTracker.toolUses += 1;
              }
              yield* emitTokenUsage(context);
            }

            const toolTitle = (toolCall.title ?? toolCall.kind ?? "").toLowerCase();
            const toolData = (toolCall.data ?? {}) as Record<string, unknown>;

            if (
              (toolTitle.includes("subagent") ||
                toolTitle.includes("invoke_subagent") ||
                toolTitle.includes("start_subagent")) &&
              !toolTitle.includes("manage_subagents")
            ) {
              const subagentsArg = (toolData.Subagents || toolData.subagents) as unknown;
              if (Array.isArray(subagentsArg)) {
                for (const sub of subagentsArg) {
                  if (typeof sub === "object" && sub !== null) {
                    const role = ((sub as Record<string, unknown>).Role ||
                      (sub as Record<string, unknown>).role ||
                      (sub as Record<string, unknown>).TypeName ||
                      (sub as Record<string, unknown>).typeName ||
                      "Subagent") as string;
                    const typeName = ((sub as Record<string, unknown>).TypeName ||
                      (sub as Record<string, unknown>).typeName) as string | undefined;
                    const prompt = ((sub as Record<string, unknown>).Prompt ||
                      (sub as Record<string, unknown>).prompt) as string | undefined;
                    const model = ((sub as Record<string, unknown>).Model ||
                      (sub as Record<string, unknown>).model) as string | undefined;
                    const tempId = RuntimeTaskId.make(yield* randomId);
                    const tracked: TrackedSubagent = {
                      taskId: tempId,
                      role,
                      typeName,
                      prompt,
                      model,
                      status: "running",
                      stepIndex: context.trackedSubagents.size + 1,
                      inputChars: (prompt?.length ?? 0) + 100,
                      outputChars: 0,
                      toolUses: 0,
                    };
                    context.trackedSubagents.set(String(tempId), tracked);
                    yield* emit({
                      type: "task.started",
                      ...(yield* stamp),
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId: existing?.turnId ?? context.activeTurnId,
                      payload: {
                        taskId: tempId,
                        taskType: "subagent",
                        agentKind: "agent",
                        title: role,
                        description: prompt || role,
                        role,
                        model,
                      },
                    });
                  }
                }
              }
            } else if (toolTitle.includes("manage_subagents")) {
              const action = (toolData.Action || toolData.action) as string | undefined;
              const convIds = (toolData.ConversationIds ||
                toolData.conversation_ids ||
                toolData.conversationIds) as unknown;
              if (action === "kill_all") {
                for (const tracked of context.trackedSubagents.values()) {
                  if (tracked.status === "running") {
                    tracked.status = "cancelled";
                    yield* emit({
                      type: "task.completed",
                      ...(yield* stamp),
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId: existing?.turnId ?? context.activeTurnId,
                      payload: {
                        taskId: tracked.taskId,
                        status: "stopped",
                        taskType: "subagent",
                        agentKind: "agent",
                      },
                    });
                  }
                }
              } else if (action === "kill" && Array.isArray(convIds)) {
                for (const cid of convIds) {
                  if (typeof cid === "string") {
                    const tracked = context.trackedSubagents.get(cid);
                    if (tracked && tracked.status === "running") {
                      tracked.status = "cancelled";
                      yield* emit({
                        type: "task.completed",
                        ...(yield* stamp),
                        provider: PROVIDER,
                        threadId: context.threadId,
                        turnId: existing?.turnId ?? context.activeTurnId,
                        payload: {
                          taskId: tracked.taskId,
                          status: "stopped",
                          taskType: "subagent",
                          agentKind: "agent",
                        },
                      });
                    }
                  }
                }
              }

              if (toolCall.status === "completed" && typeof toolCall.detail === "string") {
                const listed = parseSubagentListFromOutput(toolCall.detail);
                for (const sub of listed) {
                  const cid = sub.conversationId;
                  if (!cid) continue;
                  if (KILLED_SUBAGENT_IDS.has(cid)) {
                    const tracked = context.trackedSubagents.get(cid);
                    if (tracked) tracked.status = "cancelled";
                    continue;
                  }
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

                  const existingTracked = context.trackedSubagents.get(cid);
                  if (existingTracked?.status === "cancelled") continue;

                  if (!existingTracked) {
                    const tracked: TrackedSubagent = {
                      taskId,
                      role,
                      typeName: sub.type,
                      status: status === "idle" ? "running" : status,
                      conversationId: cid,
                      stepIndex: context.trackedSubagents.size + 1,
                      inputChars: 200,
                      outputChars: 0,
                      toolUses: 0,
                    };
                    context.trackedSubagents.set(cid, tracked);
                    context.trackedSubagents.set(String(taskId), tracked);

                    yield* emit({
                      type: "task.started",
                      ...(yield* stamp),
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId: existing?.turnId ?? context.activeTurnId,
                      payload: {
                        taskId,
                        title: role,
                        role,
                        taskType: "subagent",
                        agentKind: "agent",
                      },
                    });
                  }

                  const trackedSub = context.trackedSubagents.get(cid) ?? existingTracked;
                  const computedUsage = computeSubagentUsage(cid, sub.transcript);
                  const fallbackUsage = trackedSub
                    ? {
                        totalTokens: Math.max(
                          1,
                          Math.round(
                            ((trackedSub.inputChars ?? 0) + (trackedSub.outputChars ?? 0)) / 4,
                          ),
                        ),
                        inputTokens: Math.max(1, Math.round((trackedSub.inputChars ?? 0) / 4)),
                        outputTokens: Math.max(1, Math.round((trackedSub.outputChars ?? 0) / 4)),
                        toolUses: trackedSub.toolUses ?? 0,
                      }
                    : undefined;
                  const usage = computedUsage ?? fallbackUsage;

                  if (status === "completed" || status === "failed") {
                    yield* emit({
                      type: "task.completed",
                      ...(yield* stamp),
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId: existing?.turnId ?? context.activeTurnId,
                      payload: {
                        taskId,
                        status,
                        taskType: "subagent",
                        agentKind: "agent",
                        ...(usage ? { typedUsage: usage } : {}),
                      },
                    });
                  } else if (sub.stateDetail) {
                    yield* emit({
                      type: "task.progress",
                      ...(yield* stamp),
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId: existing?.turnId ?? context.activeTurnId,
                      payload: {
                        taskId,
                        description: sub.stateDetail || role || "Subagent",
                        role,
                        summary: sub.stateDetail,
                        lastToolName: sub.stateDetail.split(":")[0]?.trim() || "subagent",
                        status: "running",
                        taskType: "subagent",
                        agentKind: "agent",
                        ...(usage ? { typedUsage: usage } : {}),
                      },
                    });
                  }
                }
              }
            } else if (toolTitle.includes("send_message")) {
              const recipient = (toolData.Recipient || toolData.recipient) as string | undefined;
              const message = (toolData.Message || toolData.message) as string | undefined;
              if (recipient && context.trackedSubagents.has(recipient)) {
                const tracked = context.trackedSubagents.get(recipient)!;
                yield* emit({
                  type: "task.progress",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId: existing?.turnId ?? context.activeTurnId,
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

            if (toolCall.status === "completed" && typeof toolCall.detail === "string") {
              const foundCids = extractConversationIdsFromText(toolCall.detail);
              if (foundCids.length > 0) {
                let cIdx = 0;
                for (const tracked of context.trackedSubagents.values()) {
                  if (!tracked.conversationId && cIdx < foundCids.length) {
                    const cid = foundCids[cIdx++]!;
                    tracked.conversationId = cid;
                    context.trackedSubagents.set(cid, tracked);
                  }
                }
              }
            }
          }),
        );
        return;
    }
  });

  const startSession: Adapter["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (!settings.enabled) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Enable Antigravity in provider settings before starting a thread.",
          });
        }
        if (
          (input.provider !== undefined && input.provider !== PROVIDER) ||
          (input.providerInstanceId !== undefined &&
            input.providerInstanceId !== options.instanceId) ||
          (input.modelSelection !== undefined &&
            input.modelSelection.instanceId !== options.instanceId)
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The Antigravity provider instance does not match the requested session.",
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The session requires a workspace directory.",
          });
        }
        const cursor = decodeResumeCursor(input.resumeCursor);
        if (input.resumeCursor !== undefined && Option.isNone(cursor)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The saved Antigravity session is invalid. Start a new thread.",
          });
        }
        const previous = sessions.get(input.threadId);
        if (previous) yield* stopContext(previous);
        const cwd = path.resolve(input.cwd);

        const canUseWarmStandby =
          !Option.isSome(cursor) && warmStandby !== undefined && warmStandby.cwd === cwd;

        let sessionScope: Scope.Closeable;
        let runtime: Runtime;
        let started: AcpSessionRuntime.AcpSessionRuntimeStartResult;
        let usedStandby = false;

        if (canUseWarmStandby && warmStandby) {
          const claimed = warmStandby;
          warmStandby = undefined;
          sessionScope = claimed.scope;
          runtime = claimed.runtime;
          started = claimed.started;
          usedStandby = true;
          yield* prewarm(cwd).pipe(Effect.forkIn(ownerScope));
        } else {
          sessionScope = yield* Scope.make("sequential");
        }

        let transferred = false;
        let context: SessionContext | undefined;
        yield* Effect.addFinalizer(() => {
          startingSessions.delete(input.threadId);
          if (transferred) return Effect.void;
          sessions.delete(input.threadId);
          return Scope.close(sessionScope, Exit.void);
        });
        const stopOwned = Effect.suspend(() =>
          context ? stopContext(context).pipe(Effect.ignore) : Scope.close(sessionScope, Exit.void),
        );
        startingSessions.set(input.threadId, {
          sessionScope,
          abort: Scope.close(sessionScope, Exit.void),
        });

        const setupSessionBody = Effect.gen(function* () {
          const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
          if (!usedStandby) {
            runtime = yield* options.makeRuntime({
              cwd,
              clientInfo: { name: "t3-code", version: "0.0.0" },
              clientFileSystem: true,
              additionalDirectories: [serverConfig.attachmentsDir],
              ...(Option.isSome(cursor) ? { resumeSessionId: cursor.value.sessionId } : {}),
              mcpServers: mcp
                ? [
                    {
                      type: "http",
                      name: "t3-code",
                      url: mcp.endpoint,
                      headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
                    },
                  ]
                : [],
              ...makeNativeLoggers({
                nativeEventLogger: options.nativeEventLogger,
                provider: PROVIDER,
                threadId: input.threadId,
              }),
            });
            yield* prewarm(cwd).pipe(Effect.forkIn(ownerScope));
          }

          const allowedRoots = [cwd, serverConfig.attachmentsDir];
          yield* runtime.handleReadTextFile((request) =>
            readClientTextFile({ fileSystem, path, allowedRoots, request }),
          );
          yield* runtime.handleWriteTextFile((request) =>
            writeClientTextFile({ fileSystem, path, allowedRoots, request }),
          );
          yield* runtime.handleRequestPermission((request) =>
            context
              ? handlePermission(context, request).pipe(
                  Effect.mapError((cause) =>
                    EffectAcpErrors.AcpRequestError.internalError(
                      "Could not process an Antigravity permission request.",
                      undefined,
                      { cause },
                    ),
                  ),
                )
              : Effect.succeed({
                  outcome: { outcome: "cancelled" },
                } satisfies NativePermissionResponse),
          );
          if (!usedStandby) {
            started = yield* runtime.start();
          }
          const model = yield* applyAntigravityAcpModelSelection({
            runtime,
            model: input.modelSelection?.model,
            defaultModel: yield* options.defaultModel ?? Effect.succeed(undefined),
            mapError: (cause) => cause,
          });
          yield* runtime.setMode(antigravityPermissionMode(input.runtimeMode));
          yield* options.onSessionStarted?.(started, cwd) ?? Effect.void;
          const createdAt = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            cwd,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(model ? { model } : {}),
            resumeCursor: { schemaVersion: 1, sessionId: started.sessionId },
            createdAt,
            updatedAt: createdAt,
          };
          context = {
            threadId: input.threadId,
            cwd,
            nativeSessionId: started.sessionId,
            scope: sessionScope,
            runtime,
            promptLock: yield* Semaphore.make(1),
            stopLock: yield* Semaphore.make(1),
            commandLock: yield* Semaphore.make(1),
            approvals: new Map(),
            questions: new Map(),
            commands: new Map(),
            turns: [],
            subagents: new Map(),
            trackedSubagents: new Map(),
            tokenTracker: {
              userMessagesChars: 0,
              agentResponsesChars: 0,
              toolCallsChars: 0,
              subagentsChars: 0,
              systemPromptTokens: ANTIGRAVITY_SYSTEM_PROMPT_TOKENS,
              systemToolsTokens: ANTIGRAVITY_SYSTEM_TOOLS_TOKENS,
              skillsTokens: ANTIGRAVITY_SKILLS_TOKENS,
              checkpointBufferTokens: ANTIGRAVITY_CHECKPOINT_BUFFER_TOKENS,
              totalLifetimeProcessedTokens: 0,
              toolUses: 0,
            },
            antigravityConversationId: undefined,
            session,
            activeTurnId: undefined,
            promptFiber: undefined,
            generation: 0,
            stopped: false,
            closed: false,
            disconnected: false,
          };
          const running = context;
          sessions.set(input.threadId, running);
          startingSessions.delete(input.threadId);
          syncTokenTrackerFromDb(running);
          yield* emitTokenUsage(running);
          yield* Stream.runForEach(runtime.getEvents(), (event) =>
            handleEvent(running, event),
          ).pipe(
            Effect.catchCause(() =>
              Effect.logError("Could not process an Antigravity runtime event."),
            ),
            Effect.forkIn(sessionScope),
          );
          yield* emit({
            type: "session.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* emit({
            type: "session.state.changed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Antigravity ACP session ready" },
          });
          yield* emit({
            type: "thread.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          yield* runtime.drainEvents;
          if (running.stopped) {
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
          transferred = true;
          return session;
        });

        if (usedStandby) {
          return yield* setupSessionBody.pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((cause) =>
              isAcpError(cause)
                ? mapAntigravityError(input.threadId, "session/start", cause)
                : new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/start",
                    detail: "Could not start Antigravity. Check the provider setup status.",
                    cause,
                  }),
            ),
          );
        }

        return yield* options.withProcess(stopOwned, setupSessionBody).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.tapError((cause) =>
            isAntigravitySignInRequiredError(cause)
              ? (options.onAuthRequired ?? Effect.void)
              : Effect.void,
          ),
          Effect.mapError((cause) =>
            isAcpError(cause)
              ? mapAntigravityError(input.threadId, "session/start", cause)
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/start",
                  detail: "Could not start Antigravity. Check the provider setup status.",
                  cause,
                }),
          ),
        );
      }).pipe(Effect.scoped),
    );

  const promoteBackgroundCommands = (context: SessionContext) =>
    context.commandLock.withPermit(
      Effect.gen(function* () {
        for (const [id, command] of context.commands) {
          if (command.promoted) continue;
          yield* emit({
            type: "task.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: command.turnId,
            payload: {
              taskId: RuntimeTaskId.make(id),
              taskType: "local_bash",
              toolUseId: id,
              description:
                command.toolCall.command ?? command.toolCall.title ?? "Antigravity command",
            },
          });
          context.commands.set(id, { ...command, promoted: true });
        }
      }),
    );

  const sendTurn: Adapter["sendTurn"] = Effect.fn("AntigravityAdapter.sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "The selected model belongs to another provider instance.",
      });
    }
    const prompt = yield* buildAntigravityPrompt({
      input: input.input,
      attachments: input.attachments,
      attachmentsDir: serverConfig.attachmentsDir,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => mapAntigravityError(input.threadId, "session/prompt", cause)),
    );
    let intent: TurnIntent | undefined;
    // The caller holds promptLock while it changes or settles the active turn.
    const finishTurn = (turn: TurnIntent, payload: TurnCompletedPayload) =>
      Effect.gen(function* () {
        if (turn.settled || context.stopped || context.generation !== turn.generation) return;
        turn.settled = true;
        yield* promoteBackgroundCommands(context);
        yield* finishSubagents(
          context,
          payload.state === "cancelled"
            ? "cancelled"
            : payload.state === "failed"
              ? "failed"
              : "idle",
          payload.errorMessage,
        );
        syncTokenTrackerFromDb(context);
        yield* emitTokenUsage(context, turn.turnId);
        context.activeTurnId = undefined;
        context.promptFiber = undefined;
        context.session = {
          ...context.session,
          status: payload.state === "failed" ? "error" : "ready",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
          ...(payload.errorMessage
            ? { lastError: payload.errorMessage }
            : { lastError: undefined }),
        };
        yield* emit({
          type: "turn.completed",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId: turn.turnId,
          payload,
        });
      }).pipe(Effect.uninterruptible);

    return yield* Effect.gen(function* () {
      const launch = yield* context.promptLock.withPermit(
        Effect.gen(function* () {
          yield* requireSession(input.threadId);
          const requestedModel = input.modelSelection?.model ?? context.session.model;
          const configOptions = yield* context.runtime.getConfigOptions;
          const model = resolveAntigravityModel({
            configOptions,
            model: requestedModel,
            defaultModel: yield* options.defaultModel ?? Effect.succeed(undefined),
          });
          const availableModels = antigravityModelOptions(configOptions);
          if (model && !availableModels.some((option) => option.value === model)) {
            return yield* EffectAcpErrors.AcpRequestError.invalidParams(
              `Antigravity model '${model}' is unavailable for this Google account. Select an available model.`,
            );
          }
          const turnId = context.activeTurnId ?? TurnId.make(yield* randomId);
          const steering = context.activeTurnId !== undefined;
          const turn: TurnIntent = { turnId, generation: ++context.generation, settled: false };
          intent = turn;
          context.activeTurnId = turnId;
          if (!steering) {
            context.tokenTracker.userMessagesChars += prompt.length;
            context.tokenTracker.totalLifetimeProcessedTokens += Math.round(prompt.length / 4);
            yield* emitTokenUsage(context, turnId);
            yield* emit({
              type: "turn.started",
              ...(yield* stamp),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: model ? { model } : {},
            });
          }
          if (context.promptFiber) {
            yield* cancelRequests(context);
            yield* context.runtime.cancel;
            yield* Fiber.await(context.promptFiber);
            yield* finishSubagents(context, "cancelled");
          }
          yield* applyAntigravityAcpModelSelection({
            runtime: context.runtime,
            model,
            mapError: (cause) => cause,
          });
          yield* context.runtime.setMode(antigravityPermissionMode(context.session.runtimeMode));
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            ...(model ? { model } : {}),
            updatedAt: yield* nowIso,
          };
          const dispatched = yield* Deferred.make<void>();
          const fiber = yield* context.runtime
            .prompt(
              {
                prompt: [
                  ...prompt,
                  {
                    type: "text",
                    text: buildRuntimeInstructions({ harness: "Antigravity", model }),
                  },
                ],
              },
              { dispatched },
            )
            .pipe(Effect.forkIn(context.scope));
          context.promptFiber = fiber;
          // Fiber.join can skip a scope-close waiter when the child is interrupted.
          // Unwrap the Exit after Fiber.await returns.
          yield* Effect.raceFirst(
            Deferred.await(dispatched),
            Fiber.await(fiber).pipe(
              Effect.flatMap((exit) => exit),
              Effect.asVoid,
            ),
          );
          return { turn, fiber };
        }),
      );
      const result = yield* Fiber.await(launch.fiber).pipe(Effect.flatMap((exit) => exit));
      yield* context.runtime.drainEvents;
      if (context.stopped) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: input.threadId,
        });
      }
      const record = context.turns.find((turn) => turn.id === launch.turn.turnId);
      if (record) record.items.push(result);
      else context.turns.push({ id: launch.turn.turnId, items: [result] });
      // Monitor active background subagents before finishing the turn
      const runningSubagents = [...context.trackedSubagents.values()].filter(
        (s) =>
          s.status === "running" &&
          !KILLED_SUBAGENT_IDS.has(String(s.taskId)) &&
          !KILLED_SUBAGENT_IDS.has(s.conversationId || ""),
      );
      if (runningSubagents.length > 0) {
        let iter = 0;
        const maxIter = 120;
        while (iter < maxIter) {
          if (context.stopped) break;
          yield* Effect.sleep("1500 millis");
          iter++;
          let stillRunningCount = 0;
          for (const tracked of runningSubagents) {
            if (tracked.status !== "running") continue;
            const targetId = tracked.conversationId;
            if (targetId) {
              const subStatus = checkSubagentTranscriptStatus(targetId);
              const computedUsage = computeSubagentUsage(targetId);
              const fallbackUsage = {
                totalTokens: Math.max(
                  1,
                  Math.round(((tracked.inputChars ?? 0) + (tracked.outputChars ?? 0)) / 4),
                ),
                inputTokens: Math.max(1, Math.round((tracked.inputChars ?? 0) / 4)),
                outputTokens: Math.max(1, Math.round((tracked.outputChars ?? 0) / 4)),
                toolUses: tracked.toolUses ?? 0,
              };
              const usage = computedUsage ?? fallbackUsage;
              if (subStatus.status === "completed" || subStatus.status === "failed") {
                tracked.status = subStatus.status;
                yield* emit({
                  type: "task.completed",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: launch.turn.turnId,
                  payload: {
                    taskId: tracked.taskId,
                    status: subStatus.status,
                    taskType: "subagent",
                    agentKind: "agent",
                    ...(usage ? { typedUsage: usage } : {}),
                  },
                });
              } else {
                stillRunningCount++;
                if (subStatus.summary || subStatus.lastToolName) {
                  yield* emit({
                    type: "task.progress",
                    ...(yield* stamp),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: launch.turn.turnId,
                    payload: {
                      taskId: tracked.taskId,
                      description:
                        subStatus.summary || tracked.prompt || tracked.role || "Subagent",
                      role: tracked.role,
                      summary: subStatus.summary,
                      lastToolName: subStatus.lastToolName,
                      status: "running",
                      taskType: "subagent",
                      agentKind: "agent",
                      ...(usage ? { typedUsage: usage } : {}),
                    },
                  });
                }
              }
            }
          }
          if (stillRunningCount === 0) break;
        }
      }

      for (const tracked of context.trackedSubagents.values()) {
        if (tracked.status === "running") {
          const isKilled =
            KILLED_SUBAGENT_IDS.has(String(tracked.taskId)) ||
            (tracked.conversationId ? KILLED_SUBAGENT_IDS.has(tracked.conversationId) : false);
          const finalStatus = isKilled ? "cancelled" : "completed";
          tracked.status = finalStatus;
          const subUsage = {
            totalTokens: Math.max(
              1,
              Math.round(((tracked.inputChars ?? 0) + (tracked.outputChars ?? 0)) / 4),
            ),
            inputTokens: Math.max(1, Math.round((tracked.inputChars ?? 0) / 4)),
            outputTokens: Math.max(1, Math.round((tracked.outputChars ?? 0) / 4)),
            toolUses: tracked.toolUses ?? 0,
          };
          yield* emit({
            type: "task.completed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: launch.turn.turnId,
            payload: {
              taskId: tracked.taskId,
              status: finalStatus === "cancelled" ? "stopped" : finalStatus,
              taskType: "subagent",
              agentKind: "agent",
              typedUsage: subUsage,
            },
          });
        }
      }

      yield* emitTokenUsage(context, launch.turn.turnId);

      yield* context.promptLock.withPermit(
        finishTurn(launch.turn, {
          state: result.stopReason === "cancelled" ? "cancelled" : "completed",
          stopReason: result.stopReason,
        }),
      );
      return {
        threadId: input.threadId,
        turnId: launch.turn.turnId,
        resumeCursor: context.session.resumeCursor,
      };
    }).pipe(
      Effect.tapError((cause) =>
        isAntigravitySignInRequiredError(cause)
          ? (options.onAuthRequired ?? Effect.void)
          : Effect.void,
      ),
      Effect.mapError((cause) =>
        isAcpError(cause) ? mapAntigravityError(input.threadId, "session/prompt", cause) : cause,
      ),
      Effect.tapError((cause) =>
        Effect.suspend(() =>
          intent
            ? context.promptLock.withPermit(
                finishTurn(intent, { state: "failed", errorMessage: cause.message }),
              )
            : Effect.void,
        ),
      ),
      Effect.onInterrupt(() =>
        context.promptLock.withPermit(
          Effect.gen(function* () {
            const turn = intent;
            if (!turn || turn.settled || context.stopped || context.generation !== turn.generation)
              return;
            const promptFiber = context.promptFiber;
            yield* cancelRequests(context);
            yield* Effect.ignore(context.runtime.cancel);
            if (promptFiber) yield* Fiber.interrupt(promptFiber);
            yield* finishTurn(turn, { state: "cancelled", stopReason: "cancelled" });
          }),
        ),
      ),
    );
  });

  const interruptTurn: Adapter["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const starting = startingSessions.get(threadId);
      if (starting) {
        startingSessions.delete(threadId);
        yield* starting.abort;
        yield* emit({
          type: "turn.completed",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId,
          turnId: undefined,
          payload: { state: "cancelled", stopReason: "cancelled" },
        });
        return;
      }
      const context = sessions.get(threadId);
      if (!context) {
        return;
      }
      yield* context.promptLock
        .withPermit(
          Effect.gen(function* () {
            yield* cancelRequests(context);
            yield* Effect.ignore(context.runtime.cancel);
          }),
        )
        .pipe(
          Effect.mapError((cause) => mapAntigravityError(threadId, "session/cancel", cause)),
          Effect.ignore,
        );
    });

  const respondToRequest: Adapter["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.approvals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: "This approval request is no longer pending.",
        });
      }
      const optionId =
        decision === "cancel"
          ? undefined
          : selectAntigravityPermissionOptionId(pending.request, decision);
      if (decision !== "cancel" && optionId === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue:
            "Antigravity did not offer this permission choice. Select one of the available choices.",
        });
      }
      yield* Deferred.succeed(pending.response, {
        decision,
        result: {
          outcome:
            optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId },
        },
      });
    });

  const respondToUserInput: Adapter["respondToUserInput"] = (threadId, requestId, answers) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.questions.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: "This question is no longer pending.",
        });
      }
      const result = makeAntigravityUserInputResponse(pending.request, answers);
      if (!result) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue:
            "Select one of Antigravity's offered answers. Custom answers are not supported for this question.",
        });
      }
      yield* Deferred.succeed(pending.response, { answers, result });
    });

  const stopSession: Adapter["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const starting = startingSessions.get(threadId);
      if (starting) {
        startingSessions.delete(threadId);
        yield* starting.abort;
        return;
      }
      yield* withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopContext));
    });
  const stopAll: Adapter["stopAll"] = () =>
    Effect.gen(function* () {
      if (warmStandby) {
        yield* Scope.close(warmStandby.scope, Exit.void);
        warmStandby = undefined;
      }
      for (const [id, starting] of startingSessions) {
        startingSessions.delete(id);
        yield* starting.abort;
      }
      yield* Effect.forEach([...sessions.values()], stopContext, { discard: true });
    });
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.void
          : Effect.logError("Could not stop an Antigravity session."),
      ),
      Effect.ensuring(PubSub.shutdown(events)),
    ),
  );

  // Pre-warm a standby Antigravity ACP runtime in the background on startup
  yield* prewarm(path.resolve(".")).pipe(
    Effect.forkIn(ownerScope),
    Effect.catchCause(() => Effect.void),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    stopAll,
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((context) => !context.stopped)
          .map((context) => ({ ...context.session })),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns })),
    rollbackThread: (_threadId: ThreadId, _numTurns: number) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Antigravity does not support conversation rewind. Start a new thread instead.",
        }),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});
