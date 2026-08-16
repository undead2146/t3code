import {
  ApprovalRequestId,
  type AntigravitySettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
  type ProviderThreadSnapshot,
} from "@t3tools/contracts";
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
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type AntigravityAdapterShape } from "../Services/AntigravityAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export interface AntigravityAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

interface AntigravitySessionContext {
  readonly threadId: ThreadId;
  readonly conversationId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  activeTurnId: TurnId | undefined;
  activeTurnFiber: Fiber.Fiber<void, never> | undefined;
  activeChildProcess: ChildProcess.ChildProcess | undefined;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  currentModelId: string | undefined;
  stopped: boolean;
}

export const makeAntigravityAdapter = Effect.fn("makeAntigravityAdapter")(function* (
  antigravitySettings: AntigravitySettings,
  options?: AntigravityAdapterLiveOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedEnvironment = options?.environment ?? process.env;
  const instanceId = options?.instanceId ?? ProviderInstanceId.make("antigravity");

  const sessionsRef = yield* SynchronizedRef.make<Map<ThreadId, AntigravitySessionContext>>(
    new Map(),
  );
  const eventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const emitEvent = (event: ProviderRuntimeEvent) => PubSub.publish(eventPubSub, event);

  const resolveBrainLogsPath = (conversationId: string): Effect.Effect<string> =>
    Effect.gen(function* () {
      const homeDir =
        antigravitySettings.homePath?.trim() ||
        resolvedEnvironment.HOME ||
        "/home/ubuntu";
      return path.join(
        homeDir,
        ".gemini",
        "antigravity-cli",
        "brain",
        conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
    });

  const startSession: AntigravityAdapterShape["startSession"] = (input: ProviderSessionStartInput) =>
    SynchronizedRef.modifyEffect(sessionsRef, (sessions) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        const conversationId =
          typeof input.resumeCursor === "string" && input.resumeCursor.trim().length > 0
            ? input.resumeCursor.trim()
            : yield* crypto.randomUUID;

        const sessionScope = yield* Scope.make();
        const initialSession: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: input.cwd,
          model: input.modelSelection?.model ?? "gemini-3.7-flash-high",
          threadId: input.threadId,
          resumeCursor: conversationId,
          createdAt,
          updatedAt: createdAt,
        };

        const ctx: AntigravitySessionContext = {
          threadId: input.threadId,
          conversationId,
          session: initialSession,
          scope: sessionScope,
          activeTurnId: undefined,
          activeTurnFiber: undefined,
          activeChildProcess: undefined,
          turns: [],
          currentModelId: input.modelSelection?.model,
          stopped: false,
        };

        sessions.set(input.threadId, ctx);

        return [initialSession, sessions];
      }),
    );

  const sendTurn: AntigravityAdapterShape["sendTurn"] = (input: ProviderSendTurnInput) =>
    SynchronizedRef.modifyEffect(sessionsRef, (sessions) =>
      Effect.gen(function* () {
        const ctx = sessions.get(input.threadId);
        if (!ctx || ctx.stopped) {
          return yield* Effect.fail(
            new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
            }),
          );
        }

        const turnId = TurnId.make(yield* crypto.randomUUID);
        ctx.activeTurnId = turnId;
        const turnStartTime = yield* nowIso;

        const model = input.modelSelection?.model || ctx.currentModelId || "gemini-3.7-flash-high";
        const effort = input.modelSelection?.options
          ? getModelSelectionStringOptionValue(input.modelSelection.options, "effort")
          : undefined;

        const binaryPath = antigravitySettings.binaryPath || "agy";
        const args = [
          "-p",
          "--output-format",
          "stream-json",
          "--conversation",
          ctx.conversationId,
        ];

        if (model) {
          args.push("--model", model);
        }
        if (effort) {
          args.push("--effort", effort);
        }
        if (antigravitySettings.dangerouslySkipPermissions) {
          args.push("--dangerously-skip-permissions");
        }
        if (antigravitySettings.launchArgs?.trim()) {
          args.push(...antigravitySettings.launchArgs.trim().split(/\s+/));
        }

        const promptText = input.input ?? "";
        args.push(promptText);

        const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, {
          env: resolvedEnvironment,
        });

        const turnFiber = yield* Effect.gen(function* () {
          const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            env: resolvedEnvironment,
            cwd: ctx.session.cwd ?? process.cwd(),
            shell: spawnCommand.shell,
          });

          const child = yield* commandSpawner.spawn(command).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: `Failed to spawn agy process: ${String(cause)}`,
                  cause,
                }),
            ),
          );
          ctx.activeChildProcess = child;

          // Stream stdout lines
          const stdoutFiber = yield* child.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.gen(function* () {
                const trimmed = line.trim();
                if (!trimmed) return;

                let eventObj: any;
                try {
                  eventObj = JSON.parse(trimmed);
                } catch {
                  // Non-json stdout fallback
                  const itemId = RuntimeItemId.make(yield* crypto.randomUUID);
                  const eventId = EventId.make(yield* crypto.randomUUID);
                  yield* emitEvent({
                    id: eventId,
                    kind: "notification",
                    provider: PROVIDER,
                    providerInstanceId: instanceId,
                    threadId: input.threadId,
                    createdAt: yield* nowIso,
                    data: {
                      _tag: "item.updated",
                      itemId,
                      turnId,
                      delta: trimmed + "\n",
                      streamKind: "assistant_text",
                    } as any,
                  });
                  return;
                }

                const eventId = EventId.make(yield* crypto.randomUUID);
                const itemId = RuntimeItemId.make(
                  eventObj.step_index !== undefined
                    ? `step-${eventObj.step_index}`
                    : yield* crypto.randomUUID,
                );

                if (eventObj.type === "PLANNER_RESPONSE" || eventObj.content) {
                  const text = eventObj.content || eventObj.thinking || "";
                  yield* emitEvent({
                    id: eventId,
                    kind: "notification",
                    provider: PROVIDER,
                    providerInstanceId: instanceId,
                    threadId: input.threadId,
                    createdAt: yield* nowIso,
                    data: {
                      _tag: "item.updated",
                      itemId,
                      turnId,
                      delta: text,
                      streamKind: eventObj.thinking ? "reasoning_text" : "assistant_text",
                    } as any,
                  });
                } else if (eventObj.tool_calls) {
                  yield* emitEvent({
                    id: eventId,
                    kind: "notification",
                    provider: PROVIDER,
                    providerInstanceId: instanceId,
                    threadId: input.threadId,
                    createdAt: yield* nowIso,
                    data: {
                      _tag: "item.started",
                      itemId,
                      turnId,
                      itemType: "tool_call",
                      payload: eventObj.tool_calls,
                    } as any,
                  });
                }
              }),
            ),
            Effect.fork,
          );

          yield* child.exitCode;
          yield* Fiber.join(stdoutFiber);

          ctx.activeTurnId = undefined;
          ctx.activeChildProcess = undefined;

          // Emit turn completion
          const turnEndEventId = EventId.make(yield* crypto.randomUUID);
          yield* emitEvent({
            id: turnEndEventId,
            kind: "notification",
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            createdAt: yield* nowIso,
            data: {
              _tag: "turn.completed",
              turnId,
              status: "completed",
            } as any,
          });
        }).pipe(
          Effect.catchAll((err) =>
            Effect.gen(function* () {
              ctx.activeTurnId = undefined;
              ctx.activeChildProcess = undefined;
              const errorEventId = EventId.make(yield* crypto.randomUUID);
              yield* emitEvent({
                id: errorEventId,
                kind: "error",
                provider: PROVIDER,
                providerInstanceId: instanceId,
                threadId: input.threadId,
                createdAt: yield* nowIso,
                data: {
                  message: `Antigravity turn error: ${String(err)}`,
                } as any,
              });
            }),
          ),
          Effect.fork,
        );

        ctx.activeTurnFiber = turnFiber;

        const result: ProviderTurnStartResult = {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.conversationId,
        };

        return [result, sessions];
      }),
    );

  const interruptTurn: AntigravityAdapterShape["interruptTurn"] = (threadId, turnId) =>
    SynchronizedRef.updateEffect(sessionsRef, (sessions) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) return sessions;

        if (ctx.activeChildProcess) {
          yield* Effect.ignore(ctx.activeChildProcess.kill());
          ctx.activeChildProcess = undefined;
        }
        if (ctx.activeTurnFiber) {
          yield* Fiber.interrupt(ctx.activeTurnFiber);
          ctx.activeTurnFiber = undefined;
        }
        ctx.activeTurnId = undefined;

        const eventId = EventId.make(yield* crypto.randomUUID);
        yield* emitEvent({
          id: eventId,
          kind: "notification",
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId,
          createdAt: yield* nowIso,
          data: {
            _tag: "turn.interrupted",
            turnId: turnId ?? TurnId.make("active"),
          } as any,
        });

        return sessions;
      }),
    );

  const respondToRequest: AntigravityAdapterShape["respondToRequest"] = (
    _threadId,
    _requestId,
    _decision,
  ) => Effect.void;

  const respondToUserInput: AntigravityAdapterShape["respondToUserInput"] = (
    _threadId,
    _requestId,
    _answers,
  ) => Effect.void;

  const stopSession: AntigravityAdapterShape["stopSession"] = (threadId) =>
    SynchronizedRef.updateEffect(sessionsRef, (sessions) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) return sessions;

        ctx.stopped = true;
        if (ctx.activeChildProcess) {
          yield* Effect.ignore(ctx.activeChildProcess.kill());
        }
        if (ctx.activeTurnFiber) {
          yield* Fiber.interrupt(ctx.activeTurnFiber);
        }
        yield* Scope.close(ctx.scope, Exit.void);
        sessions.delete(threadId);
        return sessions;
      }),
    );

  const listSessions: AntigravityAdapterShape["listSessions"] = () =>
    SynchronizedRef.get(sessionsRef).pipe(
      Effect.map((sessions) => Array.from(sessions.values()).map((ctx) => ctx.session)),
    );

  const hasSession: AntigravityAdapterShape["hasSession"] = (threadId) =>
    SynchronizedRef.get(sessionsRef).pipe(Effect.map((sessions) => sessions.has(threadId)));

  const readThread: AntigravityAdapterShape["readThread"] = (threadId) =>
    SynchronizedRef.get(sessionsRef).pipe(
      Effect.flatMap((sessions) => {
        const ctx = sessions.get(threadId);
        if (!ctx) {
          return Effect.succeed({ threadId, turns: [] });
        }

        return Effect.gen(function* () {
          const logPath = yield* resolveBrainLogsPath(ctx.conversationId);
          const logExists = yield* fileSystem.exists(logPath);

          if (!logExists) {
            return { threadId, turns: ctx.turns };
          }

          const content = yield* fileSystem.readFileString(logPath).pipe(Effect.orDie);
          const lines = content.split("\n");
          const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
          let currentTurnItems: Array<unknown> = [];
          let currentTurnId = TurnId.make(ctx.conversationId);

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const record = JSON.parse(trimmed);
              if (record.type === "USER_INPUT") {
                if (currentTurnItems.length > 0) {
                  turns.push({ id: currentTurnId, items: currentTurnItems });
                  currentTurnItems = [];
                }
                currentTurnId = TurnId.make(`turn-${record.step_index ?? turns.length}`);
                currentTurnItems.push(record);
              } else {
                currentTurnItems.push(record);
              }
            } catch {
              // Ignore unparseable lines
            }
          }

          if (currentTurnItems.length > 0) {
            turns.push({ id: currentTurnId, items: currentTurnItems });
          }

          return { threadId, turns: turns.length > 0 ? turns : ctx.turns };
        });
      }),
    );

  const rollbackThread: AntigravityAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    SynchronizedRef.get(sessionsRef).pipe(
      Effect.map((sessions) => {
        const ctx = sessions.get(threadId);
        if (ctx) {
          ctx.turns = ctx.turns.slice(0, Math.max(0, ctx.turns.length - numTurns));
        }
        return { threadId, turns: ctx?.turns ?? [] };
      }),
    );

  const stopAll: AntigravityAdapterShape["stopAll"] = () =>
    SynchronizedRef.updateEffect(sessionsRef, (sessions) =>
      Effect.gen(function* () {
        for (const ctx of sessions.values()) {
          ctx.stopped = true;
          if (ctx.activeChildProcess) {
            yield* Effect.ignore(ctx.activeChildProcess.kill());
          }
          if (ctx.activeTurnFiber) {
            yield* Fiber.interrupt(ctx.activeTurnFiber);
          }
          yield* Scope.close(ctx.scope, Exit.void);
        }
        sessions.clear();
        return sessions;
      }),
    );

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
    streamEvents: Stream.fromPubSub(eventPubSub),
  } satisfies AntigravityAdapterShape;
});
