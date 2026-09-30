// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  EnvironmentId,
  MuseSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as MuseAdapter from "./MuseAdapter.ts";

const decodeMuseSettings = Schema.decodeSync(MuseSettings);

let mockNotificationCallback: ((notification: any) => void) | undefined;
let mockSessionResultHistory: any = undefined;
let mockResumeShouldFail = false;
let mockStartShouldFail: string | false = false;
let mockStartHangWorkspace: string | undefined;
let mockResumeViewCursor: string | undefined;
let mintCommandIdCounter = 0;
let mockCommands: Array<{ method: string; params: any }> = [];
let mockTurnStartResponse: any = undefined;
let mockTurnInterruptShouldHang = false;
let mockRequestHandler: ((method: string, params: any) => Promise<any>) | undefined;
let mockServerRequestHandler: ((request: any) => Promise<any>) | undefined;
let lastSpawnOptions: any = undefined;

vi.mock("@muse-code/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muse-code/sdk")>();
  return {
    ...actual,
    spawnMspConnection: (options: any) => (
      (lastSpawnOptions = options),
      {
        close: vi.fn(async () => {}),
        initialize: vi.fn(async () => ({
          connection: {
            onNotification: vi.fn((cb) => {
              mockNotificationCallback = cb;
            }),
            onProtocolError: vi.fn(() => {}),
            onServerRequest: vi.fn((cb) => {
              mockServerRequestHandler = cb;
            }),
            closed: new Promise(() => {}),
            mintCommandId: () => `cmd-${++mintCommandIdCounter}`,
            command: vi.fn(async (method: string, params: any) => {
              mockCommands.push({ method, params });
              if (method === "turn/interrupt" && mockTurnInterruptShouldHang)
                return new Promise(() => {});
              if (method === "session/compact") return { status: "accepted" };
              if (method === "session/start" && mockStartShouldFail)
                throw new Error(mockStartShouldFail);
              if (method === "session/start" && mockStartHangWorkspace === params.workspaceRoot)
                return new Promise(() => {});
              if (method === "session/resume" && mockResumeShouldFail)
                throw new Error("Session not found");
              if (method === "session/start" || method === "session/resume") {
                return {
                  session: {
                    sessionId: params.sessionId ?? `cmd-${mintCommandIdCounter}`,
                    workspaceRoot: params.workspaceRoot ?? "Z:\\test-workspace",
                    modelId: "default",
                    status: "ready",
                    activeTurnId: null,
                  },
                  history: mockSessionResultHistory,
                  ...(method === "session/resume" && mockResumeViewCursor !== undefined
                    ? { viewCursor: mockResumeViewCursor }
                    : {}),
                };
              }
              if (method === "turn/start") {
                if (mockTurnStartResponse) {
                  const res = mockTurnStartResponse;
                  mockTurnStartResponse = undefined;
                  return res;
                }
                return {
                  status: "accepted",
                  turnId: `turn-${++mintCommandIdCounter}`,
                };
              }
              return {};
            }),
            request: vi.fn(async (method: string, params: any) => {
              if (mockRequestHandler) return mockRequestHandler(method, params);
              return {};
            }),
          },
          child: {
            exit: new Promise(() => {}),
            close: vi.fn(async () => {}),
          },
        })),
      }
    ),
  };
});

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-muse-adapter-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

afterEach(() => {
  mockTurnInterruptShouldHang = false;
  mockStartShouldFail = false;
  mockStartHangWorkspace = undefined;
  mockResumeViewCursor = undefined;
  mockResumeShouldFail = false;
  McpProviderSession.clearAllMcpProviderSessions();
  mockTurnStartResponse = undefined;
  mockSessionResultHistory = undefined;
  mockCommands = [];
  mockRequestHandler = undefined;
  mockServerRequestHandler = undefined;
  lastSpawnOptions = undefined;
});

describe("MuseAdapter per-thread session lifecycle", () => {
  it.live("starts and stops other threads while one session start hangs", () =>
    Effect.gen(function* () {
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });
      mockStartHangWorkspace = "Z:\\hung-workspace";
      const hung = yield* adapter
        .startSession({
          threadId: ThreadId.make("thread-hung"),
          cwd: "Z:\\hung-workspace",
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      // Let the hung start take its thread's lifecycle permit first.
      yield* Effect.sleep("20 millis");

      const other = yield* adapter
        .startSession({
          threadId: ThreadId.make("thread-other"),
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
        })
        .pipe(Effect.timeoutOption("2 seconds"));
      expect(Option.isSome(other)).toBe(true);
      const stopped = yield* adapter
        .stopSession(ThreadId.make("thread-other"))
        .pipe(Effect.timeoutOption("2 seconds"));
      expect(Option.isSome(stopped)).toBe(true);

      yield* Fiber.interrupt(hung);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("MuseAdapter session lifecycle with workflow items", () => {
  it.effect(
    "prevents session status from dropping to ready when turn/completed arrives while a workflow is inProgress",
    () =>
      Effect.gen(function* () {
        const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
          environment: process.env,
        });

        const threadId = ThreadId.make("thread-test-1");
        const session = yield* adapter.startSession({
          threadId,
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
        });

        expect(session.status).toBe("ready");
        expect(mockNotificationCallback).toBeDefined();
        const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;

        // 1. Turn starts
        mockNotificationCallback!({
          method: "turn/started",
          params: {
            sessionId,
            viewCursor: "cursor-1",
            turnId: "turn-100",
          },
        });

        let sessions = yield* adapter.listSessions();
        let current = sessions.find((s) => s.threadId === threadId);
        expect(current?.status).toBe("running");
        expect(current?.activeTurnId).toBe("turn-100");

        // 2. Workflow item starts
        mockNotificationCallback!({
          method: "item/started",
          params: {
            sessionId,
            viewCursor: "cursor-2",
            item: {
              itemId: "wf-item-1",
              kind: "workflow",
              revision: 1,
              status: "inProgress",
              turnId: "turn-100",
              scriptId: "data-sync",
            },
          },
        });

        // 3. Turn completes while workflow is still inProgress
        mockNotificationCallback!({
          method: "turn/completed",
          params: {
            sessionId,
            viewCursor: "cursor-3",
            turnId: "turn-100",
            terminal: "completed",
          },
        });

        sessions = yield* adapter.listSessions();
        current = sessions.find((s) => s.threadId === threadId);
        // Session MUST remain "running" because workflow is inProgress!
        expect(current?.status).toBe("running");

        // 4. Workflow item completes
        mockNotificationCallback!({
          method: "item/completed",
          params: {
            sessionId,
            viewCursor: "cursor-4",
            item: {
              itemId: "wf-item-1",
              kind: "workflow",
              revision: 2,
              status: "completed",
              turnId: "turn-100",
              scriptId: "data-sync",
            },
          },
        });

        sessions = yield* adapter.listSessions();
        current = sessions.find((s) => s.threadId === threadId);
        // Now that workflow has completed and turn was completed, session transitions to ready!
        expect(current?.status).toBe("ready");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("transitions to ready immediately on turn/completed if no workflow is active", () =>
    Effect.gen(function* () {
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-2");
      const session = yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });

      const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;

      mockNotificationCallback!({
        method: "turn/started",
        params: {
          sessionId,
          viewCursor: "cursor-1",
          turnId: "turn-200",
        },
      });

      let sessions = yield* adapter.listSessions();
      let current = sessions.find((s) => s.threadId === threadId);
      expect(current?.status).toBe("running");

      mockNotificationCallback!({
        method: "turn/completed",
        params: {
          sessionId,
          viewCursor: "cursor-2",
          turnId: "turn-200",
          terminal: "completed",
        },
      });

      sessions = yield* adapter.listSessions();
      current = sessions.find((s) => s.threadId === threadId);
      expect(current?.status).toBe("ready");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "sets session status to running on startup if restored history contains an inProgress workflow",
    () =>
      Effect.gen(function* () {
        mockSessionResultHistory = {
          mode: "inline",
          items: [
            {
              itemId: "wf-prev-1",
              kind: "workflow",
              revision: 1,
              status: "inProgress",
              turnId: "turn-prev",
              scriptId: "background-job",
            },
          ],
          snapshot: null,
        };

        const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
          environment: process.env,
        });

        const threadId = ThreadId.make("thread-test-3");
        const session = yield* adapter.startSession({
          threadId,
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
        });

        expect(session.status).toBe("running");

        const sessions = yield* adapter.listSessions();
        const current = sessions.find((s) => s.threadId === threadId);
        expect(current?.status).toBe("running");

        mockSessionResultHistory = undefined;
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "falls back to session/start when session/resume is rejected by a freshly spawned muse process",
    () =>
      Effect.gen(function* () {
        mockResumeShouldFail = true;
        mintCommandIdCounter = 0;

        const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
          environment: process.env,
        });

        const threadId = ThreadId.make("thread-test-4");
        // Simulate a stored resume cursor from a previous muse serve run.
        const staleResumeCursor = { schemaVersion: 1, sessionId: "old-session-id" };
        const session = yield* adapter.startSession({
          threadId,
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
          resumeCursor: staleResumeCursor,
        });

        // Despite the stale cursor, the session must start successfully via fallback.
        expect(session.status).toBe("ready");
        // The resume cursor must carry a fresh session id, not the stale one.
        const newCursor = session.resumeCursor as { schemaVersion: number; sessionId: string };
        expect(newCursor.schemaVersion).toBe(1);
        expect(newCursor.sessionId).not.toBe("old-session-id");

        mockResumeShouldFail = false;
      }).pipe(Effect.provide(testLayer)),
  );
  it.effect("accepts items with revision 0 without failing or aborting the session", () =>
    Effect.gen(function* () {
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-rev0");
      const session = yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });

      const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;

      // Deliver an item with initial revision 0
      mockNotificationCallback!({
        method: "item/started",
        params: {
          sessionId,
          viewCursor: "cursor-0",
          item: {
            itemId: "item-rev0",
            kind: "agentMessage",
            revision: 0,
            status: "inProgress",
            turnId: "turn-rev0",
            text: "Hello from Muse",
          },
        },
      });

      const sessions = yield* adapter.listSessions();
      const current = sessions.find((s) => s.threadId === threadId);
      // Session must not have crashed with "Muse Code sent an invalid notification"
      expect(current?.lastError).toBeUndefined();
      expect(current?.status).toBe("ready");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("supports multiple consecutive turns without hanging or getting stuck in running", () =>
    Effect.gen(function* () {
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-multi-turn");
      const session = yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });

      const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;

      // --- Turn 1 ---
      const turn1 = yield* adapter.sendTurn({
        threadId,
        input: "First user message",
      });
      expect(turn1.turnId).toBeDefined();

      let sessions = yield* adapter.listSessions();
      let current = sessions.find((s) => s.threadId === threadId);
      expect(current?.status).toBe("running");
      expect(current?.activeTurnId).toBe(turn1.turnId);

      // Turn 1 notifications
      mockNotificationCallback!({
        method: "turn/started",
        params: {
          sessionId,
          viewCursor: "cursor-1-start",
          turnId: turn1.turnId,
        },
      });
      mockNotificationCallback!({
        method: "item/started",
        params: {
          sessionId,
          viewCursor: "cursor-1-item",
          item: {
            itemId: "item-t1-1",
            kind: "agentMessage",
            revision: 0,
            status: "inProgress",
            turnId: turn1.turnId,
          },
        },
      });
      mockNotificationCallback!({
        method: "item/completed",
        params: {
          sessionId,
          viewCursor: "cursor-1-item-done",
          item: {
            itemId: "item-t1-1",
            kind: "agentMessage",
            revision: 1,
            status: "completed",
            turnId: turn1.turnId,
          },
        },
      });
      mockNotificationCallback!({
        method: "turn/completed",
        params: {
          sessionId,
          viewCursor: "cursor-1-done",
          turnId: turn1.turnId,
          terminal: "completed",
        },
      });

      sessions = yield* adapter.listSessions();
      current = sessions.find((s) => s.threadId === threadId);
      expect(current?.status).toBe("ready");
      expect(current?.activeTurnId).toBeUndefined();

      // --- Turn 2 ---
      const turn2 = yield* adapter.sendTurn({
        threadId,
        input: "Second user message after making changes",
      });
      expect(turn2.turnId).toBeDefined();
      expect(turn2.turnId).not.toBe(turn1.turnId);

      sessions = yield* adapter.listSessions();
      current = sessions.find((s) => s.threadId === threadId);
      expect(current?.status).toBe("running");
      expect(current?.activeTurnId).toBe(turn2.turnId);

      // Turn 2 notifications
      mockNotificationCallback!({
        method: "turn/started",
        params: {
          sessionId,
          viewCursor: "cursor-2-start",
          turnId: turn2.turnId,
        },
      });
      mockNotificationCallback!({
        method: "item/started",
        params: {
          sessionId,
          viewCursor: "cursor-2-item",
          item: {
            itemId: "item-t2-1",
            kind: "workflow",
            revision: 0,
            status: "inProgress",
            turnId: turn2.turnId,
          },
        },
      });
      mockNotificationCallback!({
        method: "item/completed",
        params: {
          sessionId,
          viewCursor: "cursor-2-item-done",
          item: {
            itemId: "item-t2-1",
            kind: "workflow",
            revision: 1,
            status: "completed",
            turnId: turn2.turnId,
          },
        },
      });
      mockNotificationCallback!({
        method: "turn/completed",
        params: {
          sessionId,
          viewCursor: "cursor-2-done",
          turnId: turn2.turnId,
          terminal: "completed",
        },
      });

      sessions = yield* adapter.listSessions();
      current = sessions.find((s) => s.threadId === threadId);
      expect(current?.status).toBe("ready");
      expect(current?.activeTurnId).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "settles session to ready when turn/completed arrives even if a reminderChild is inProgress",
    () =>
      Effect.gen(function* () {
        const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
          environment: process.env,
        });

        const threadId = ThreadId.make("thread-test-reminder-settle");
        const session = yield* adapter.startSession({
          threadId,
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
        });

        const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;

        const turn = yield* adapter.sendTurn({
          threadId,
          input: "Test turn with reminder",
        });

        mockNotificationCallback!({
          method: "turn/started",
          params: {
            sessionId,
            viewCursor: "cursor-start",
            turnId: turn.turnId,
          },
        });
        mockNotificationCallback!({
          method: "item/started",
          params: {
            sessionId,
            viewCursor: "cursor-item",
            item: {
              itemId: "item-reminder-1",
              kind: "reminderChild",
              revision: 0,
              status: "inProgress",
              turnId: turn.turnId,
            },
          },
        });
        mockNotificationCallback!({
          method: "turn/completed",
          params: {
            sessionId,
            viewCursor: "cursor-turn-done",
            turnId: turn.turnId,
            terminal: "completed",
          },
        });

        const sessions = yield* adapter.listSessions();
        const current = sessions.find((s) => s.threadId === threadId);
        expect(current?.status).toBe("ready");
        expect(current?.activeTurnId).toBeUndefined();
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("interruptTurn settles active turn and transitions session to ready", () =>
    Effect.gen(function* () {
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-interrupt");
      const session = yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Long running turn to interrupt",
      });

      let sessions = yield* adapter.listSessions();
      let current = sessions.find((s) => s.threadId === threadId);
      expect(current?.status).toBe("running");
      expect(current?.activeTurnId).toBe(turn.turnId);

      // Call interruptTurn
      yield* adapter.interruptTurn(threadId, turn.turnId);

      sessions = yield* adapter.listSessions();
      current = sessions.find((s) => s.threadId === threadId);
      expect(current?.status).toBe("ready");
      expect(current?.activeTurnId).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("interruptTurn force-completes in-flight messages so they stop streaming", () =>
    Effect.gen(function* () {
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-interrupt-flush");
      const session = yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });

      const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;
      const turn = yield* adapter.sendTurn({ threadId, input: "Turn with streaming output" });

      mockNotificationCallback!({
        method: "turn/started",
        params: { sessionId, viewCursor: "cursor-start", turnId: turn.turnId },
      });
      mockNotificationCallback!({
        method: "item/started",
        params: {
          sessionId,
          viewCursor: "cursor-msg",
          item: {
            itemId: "item-msg-1",
            kind: "agentMessage",
            revision: 1,
            status: "inProgress",
            turnId: turn.turnId,
            text: "partial output",
          },
        },
      });
      mockNotificationCallback!({
        method: "item/started",
        params: {
          sessionId,
          viewCursor: "cursor-tool",
          item: {
            itemId: "item-tool-1",
            kind: "toolCall",
            revision: 1,
            status: "inProgress",
            turnId: turn.turnId,
            tool: "powershell",
          },
        },
      });

      const collected = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (
            event,
          ): event is Extract<
            ProviderRuntimeEvent,
            { type: "item.completed" | "turn.completed" | "session.state.changed" }
          > =>
            event.type === "item.completed" ||
            event.type === "turn.completed" ||
            event.type === "session.state.changed",
        ),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.interruptTurn(threadId, turn.turnId);
      const events = yield* Fiber.join(collected);

      const completions = events.filter((event) => event.type === "item.completed");
      expect(completions).toHaveLength(2);
      for (const event of completions) {
        if (event.type === "item.completed") {
          // Valid RuntimeItemStatus: ingestion finalizes streaming messages off this.
          expect(event.payload.status).toBe("completed");
        }
      }
      expect(
        completions
          .map((event) => (event.type === "item.completed" ? event.payload.itemType : null))
          .sort(),
      ).toEqual(["assistant_message", "dynamic_tool_call"]);

      const turnCompleted = events.find((event) => event.type === "turn.completed");
      expect(turnCompleted?.type).toBe("turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        expect(turnCompleted.payload.state).toBe("cancelled");
      }
      const sessionChanged = events.find((event) => event.type === "session.state.changed");
      expect(sessionChanged?.type).toBe("session.state.changed");
      if (sessionChanged?.type === "session.state.changed") {
        expect(sessionChanged.payload.state).toBe("ready");
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "interruptTurn terminates and evicts context when muse process hangs on turn/interrupt",
    () =>
      Effect.gen(function* () {
        mockTurnInterruptShouldHang = true;
        try {
          const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
            environment: process.env,
          });

          const threadId = ThreadId.make("thread-test-interrupt-hang");
          yield* adapter.startSession({
            threadId,
            cwd: "Z:\\test-workspace",
            runtimeMode: "full-access",
          });

          const turn = yield* adapter.sendTurn({
            threadId,
            input: "Turn that hangs on interrupt",
          });

          yield* adapter.interruptTurn(threadId, turn.turnId);

          const sessions = yield* adapter.listSessions();
          const current = sessions.find((s) => s.threadId === threadId);
          expect(current).toBeUndefined();
        } finally {
          mockTurnInterruptShouldHang = false;
        }
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("recovers dropped events via view/page on view/gap without failing session", () =>
    Effect.gen(function* () {
      const pagedRequests: Array<any> = [];
      mockRequestHandler = async (method, params) => {
        if (method === "view/page") {
          pagedRequests.push(params);
          return {
            events: [
              {
                method: "item/started",
                params: {
                  sessionId: params.sessionId,
                  viewCursor: "cursor-recovered",
                  item: {
                    itemId: "item-rec-1",
                    kind: "agentMessage",
                    revision: 1,
                    status: "inProgress",
                    turnId: "turn-gap",
                    text: "Recovered message",
                  },
                },
              },
            ],
            nextCursor: null,
          };
        }
        return {};
      };

      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-gap");
      const session = yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });

      const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;
      yield* adapter.sendTurn({ threadId, input: "Turn with gap" });

      const collected = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "item.started"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      mockNotificationCallback!({
        method: "view/gap",
        params: { sessionId, after: "cursor-1", next: "cursor-3" },
      });

      const events = yield* Fiber.join(collected);
      expect(events).toHaveLength(1);
      expect(pagedRequests.length).toBeGreaterThanOrEqual(1);

      const sessions = yield* adapter.listSessions();
      const current = sessions.find((s) => s.threadId === threadId);
      expect(current?.status).toBe("running");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("interruptTurn drains completed turn from view/page instead of cancelling it", () =>
    Effect.gen(function* () {
      let turnId = "";
      let pagedCalled = false;
      mockRequestHandler = async (method, params) => {
        if (method === "view/page") {
          pagedCalled = true;
          return {
            events: [
              {
                method: "turn/completed",
                params: {
                  sessionId: params.sessionId,
                  viewCursor: "cursor-complete",
                  turnId,
                  terminal: "completed",
                },
              },
            ],
            nextCursor: null,
          };
        }
        return {};
      };

      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-interrupt-drain");
      yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({ threadId, input: "Turn that finished while silent" });
      turnId = turn.turnId;

      const collected = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.interruptTurn(threadId, turn.turnId);
      const events = yield* Fiber.join(collected);

      expect(pagedCalled).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload.state).toBe("completed");

      const sessions = yield* adapter.listSessions();
      const current = sessions.find((s) => s.threadId === threadId);
      expect(current?.status).toBe("ready");
      expect(current?.activeTurnId).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );
});

const TRUNCATED_RETRY_REASON =
  "transport error [body-truncated]: response body ended before completion (meta stream, 185 KiB received, 10s) (after 10 provider attempts)";
const TRUNCATED_TURN_ERROR =
  "model failed after 10 attempts: transport error [body-truncated]: response body ended before completion (meta stream, 185 KiB received, 11s) (request id: 03c4868d-cd28-4358-9811-fa96aa5a920f, response: resp_6aad5c39058c49f7af784eb6)";

describe("MuseAdapter transport truncation mitigation", () => {
  const collectGuidance = (
    adapter: Effect.Success<ReturnType<typeof MuseAdapter.make>>,
    turnId: string,
  ) =>
    adapter.streamEvents.pipe(
      Stream.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "runtime.warning" }> =>
          event.type === "runtime.warning" &&
          event.turnId === turnId &&
          /compact/i.test(event.payload.message),
      ),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild,
    );

  it.effect("interrupts and compacts after identical truncation retries in one turn", () =>
    Effect.gen(function* () {
      mockCommands = [];
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-truncation-loop");
      const session = yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });
      const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;
      const turn = yield* adapter.sendTurn({ threadId, input: "Doomed turn" });
      const guidanceFiber = yield* collectGuidance(adapter, turn.turnId);

      for (let nextAttempt = 1; nextAttempt <= 4; nextAttempt += 1) {
        mockNotificationCallback!({
          method: "turn/retryScheduled",
          params: {
            sessionId,
            viewCursor: `cursor-retry-${nextAttempt}`,
            turnId: turn.turnId,
            nextAttempt,
            maxAttempts: 10,
            reason: TRUNCATED_RETRY_REASON,
            retryDelayMs: 1000,
          },
        });
      }

      const collected = yield* Fiber.join(guidanceFiber).pipe(Effect.timeoutOption("5 seconds"));
      expect(Option.isSome(collected)).toBe(true);
      const methods = mockCommands.map((command) => command.method);
      expect(methods).toContain("turn/interrupt");
      expect(methods).toContain("session/compact");

      const sessions = yield* adapter.listSessions();
      expect(sessions.find((s) => s.threadId === threadId)?.status).toBe("ready");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("leaves non-transport retry storms alone", () =>
    Effect.gen(function* () {
      mockCommands = [];
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-transient-retries");
      const session = yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });
      const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;
      const turn = yield* adapter.sendTurn({ threadId, input: "Flaky turn" });

      for (let nextAttempt = 1; nextAttempt <= 5; nextAttempt += 1) {
        mockNotificationCallback!({
          method: "turn/retryScheduled",
          params: {
            sessionId,
            viewCursor: `cursor-retry-${nextAttempt}`,
            turnId: turn.turnId,
            nextAttempt,
            maxAttempts: 10,
            reason: "rate limited, backing off",
            retryDelayMs: 1000,
          },
        });
      }
      mockNotificationCallback!({
        method: "turn/completed",
        params: {
          sessionId,
          viewCursor: "cursor-done",
          turnId: turn.turnId,
          terminal: "completed",
        },
      });

      const methods = mockCommands.map((command) => command.method);
      expect(methods).not.toContain("turn/interrupt");
      expect(methods).not.toContain("session/compact");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("compacts once per truncation streak and escalates when it recurs", () =>
    Effect.gen(function* () {
      mockCommands = [];
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-truncation-streak");
      const session = yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });
      const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;
      const failTurn = (turnId: string, cursor: string) =>
        mockNotificationCallback!({
          method: "turn/completed",
          params: {
            sessionId,
            viewCursor: cursor,
            turnId,
            terminal: "failed",
            error: { kind: "modelError", message: TRUNCATED_TURN_ERROR, retryable: true },
          },
        });

      const first = yield* adapter.sendTurn({ threadId, input: "First attempt" });
      const firstGuidance = yield* collectGuidance(adapter, first.turnId);
      failTurn(first.turnId, "cursor-fail-1");
      expect(
        Option.isSome(yield* Fiber.join(firstGuidance).pipe(Effect.timeoutOption("5 seconds"))),
      ).toBe(true);
      expect(mockCommands.filter((command) => command.method === "session/compact")).toHaveLength(
        1,
      );

      const second = yield* adapter.sendTurn({ threadId, input: "Second attempt" });
      const secondGuidance = yield* collectGuidance(adapter, second.turnId);
      failTurn(second.turnId, "cursor-fail-2");
      const escalated = yield* Fiber.join(secondGuidance).pipe(Effect.timeoutOption("5 seconds"));
      expect(Option.isSome(escalated)).toBe(true);
      if (Option.isSome(escalated)) {
        const [warning] = Array.from(escalated.value);
        expect(warning?.payload.message).toMatch(/already compacted|lower reasoning effort/);
      }
      expect(mockCommands.filter((command) => command.method === "session/compact")).toHaveLength(
        1,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("resets the truncation streak after a successful turn", () =>
    Effect.gen(function* () {
      mockCommands = [];
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-truncation-reset");
      const session = yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });
      const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;

      const first = yield* adapter.sendTurn({ threadId, input: "First attempt" });
      const firstGuidance = yield* collectGuidance(adapter, first.turnId);
      mockNotificationCallback!({
        method: "turn/completed",
        params: {
          sessionId,
          viewCursor: "cursor-fail",
          turnId: first.turnId,
          terminal: "failed",
          error: { kind: "modelError", message: TRUNCATED_TURN_ERROR, retryable: true },
        },
      });
      expect(
        Option.isSome(yield* Fiber.join(firstGuidance).pipe(Effect.timeoutOption("5 seconds"))),
      ).toBe(true);

      const second = yield* adapter.sendTurn({ threadId, input: "Recovery" });
      mockNotificationCallback!({
        method: "turn/completed",
        params: {
          sessionId,
          viewCursor: "cursor-ok",
          turnId: second.turnId,
          terminal: "completed",
        },
      });

      const third = yield* adapter.sendTurn({ threadId, input: "Later attempt" });
      const thirdGuidance = yield* collectGuidance(adapter, third.turnId);
      mockNotificationCallback!({
        method: "turn/completed",
        params: {
          sessionId,
          viewCursor: "cursor-fail-2",
          turnId: third.turnId,
          terminal: "failed",
          error: { kind: "modelError", message: TRUNCATED_TURN_ERROR, retryable: true },
        },
      });
      expect(
        Option.isSome(yield* Fiber.join(thirdGuidance).pipe(Effect.timeoutOption("5 seconds"))),
      ).toBe(true);
      expect(mockCommands.filter((command) => command.method === "session/compact")).toHaveLength(
        2,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("sends ifBusy: queue on turn/start to prevent turn stealing", () =>
    Effect.gen(function* () {
      mockCommands = [];
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-ifbusy-queue");
      yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({ threadId, input: "Hello world" });
      const startCmd = mockCommands.find((c) => c.method === "turn/start");
      expect(startCmd).toBeDefined();
      expect(startCmd?.params.ifBusy).toBe("queue");
    }).pipe(Effect.provide(testLayer)),
  );

  describe("MuseAdapter transient failure auto-retry", () => {
    const OVERLOADED_503 =
      "API error 503 [request_id=6406c2fd-21a5-44b5-b82b-2eb3cd4f5841]: The backend is temporarily overloaded. Please retry. (server_error) (after 10 provider attempts)";

    const makeAdapter = () =>
      MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
        transientRetryDelaysMs: [0, 0, 0],
      });

    const startThread = (
      adapter: Effect.Success<ReturnType<typeof MuseAdapter.make>>,
      threadId: string,
    ) =>
      Effect.gen(function* () {
        const session = yield* adapter.startSession({
          threadId: ThreadId.make(threadId),
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
        });
        return (session.resumeCursor as { sessionId: string }).sessionId;
      });

    const failTurn = (
      turnId: string,
      sessionId: string,
      cursor: string,
      message: string,
      retryable: boolean,
    ) =>
      mockNotificationCallback!({
        method: "turn/completed",
        params: {
          sessionId,
          viewCursor: cursor,
          turnId,
          terminal: "failed",
          error: { kind: "modelError", message, retryable },
        },
      });

    const completeTurn = (turnId: string, sessionId: string, cursor: string) =>
      mockNotificationCallback!({
        method: "turn/completed",
        params: {
          sessionId,
          viewCursor: cursor,
          turnId,
          terminal: "completed",
        },
      });

    const collectRetryWarning = (
      adapter: Effect.Success<ReturnType<typeof MuseAdapter.make>>,
      turnId: string,
    ) =>
      adapter.streamEvents.pipe(
        Stream.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "runtime.warning" }> =>
            event.type === "runtime.warning" &&
            event.turnId === turnId &&
            /retrying automatically/.test(event.payload.message),
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

    const collectTurnStarted = (
      adapter: Effect.Success<ReturnType<typeof MuseAdapter.make>>,
      turnId: string,
    ) =>
      adapter.streamEvents.pipe(
        Stream.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.started" }> =>
            event.type === "turn.started" && event.turnId === turnId,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

    const turnStartCommands = () =>
      mockCommands.filter((command) => command.method === "turn/start");

    it.live("redrives a transiently failed turn with identical input", () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* makeAdapter();
        const threadId = ThreadId.make("thread-test-transient-retry");
        const sessionId = yield* startThread(adapter, "thread-test-transient-retry");

        const turn = yield* adapter.sendTurn({ threadId, input: "Flaky prompt" });
        const warningFiber = yield* collectRetryWarning(adapter, turn.turnId);
        mockTurnStartResponse = { status: "accepted", turnId: "retry-turn-1" };
        failTurn(turn.turnId, sessionId, "cursor-fail-1", OVERLOADED_503, true);

        const warning = yield* Fiber.join(warningFiber).pipe(Effect.timeoutOption("5 seconds"));
        expect(Option.isSome(warning)).toBe(true);
        if (Option.isSome(warning)) {
          const [first] = Array.from(warning.value);
          expect(first?.payload.message).toMatch(/attempt 1 of 3/);
        }
        const startedFiber = yield* collectTurnStarted(adapter, "retry-turn-1");
        const started = yield* Fiber.join(startedFiber).pipe(Effect.timeoutOption("5 seconds"));
        expect(Option.isSome(started)).toBe(true);

        const starts = turnStartCommands();
        expect(starts).toHaveLength(2);
        expect(starts[1]?.params.input).toEqual(starts[0]?.params.input);

        completeTurn("retry-turn-1", sessionId, "cursor-ok");
        const sessions = yield* adapter.listSessions();
        expect(sessions.find((s) => s.threadId === threadId)?.status).toBe("ready");
      }).pipe(Effect.provide(testLayer)),
    );

    it.live("leaves fatal and vetoed failures alone", () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* makeAdapter();
        const threadId = ThreadId.make("thread-test-transient-fatal");
        const sessionId = yield* startThread(adapter, "thread-test-transient-fatal");

        const first = yield* adapter.sendTurn({ threadId, input: "Auth failure" });
        failTurn(first.turnId, sessionId, "cursor-fail-auth", "authentication expired", false);
        const second = yield* adapter.sendTurn({ threadId, input: "Vetoed overload" });
        failTurn(second.turnId, sessionId, "cursor-fail-veto", OVERLOADED_503, false);

        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
        expect(turnStartCommands()).toHaveLength(2);
        const sessions = yield* adapter.listSessions();
        expect(sessions.find((s) => s.threadId === threadId)?.status).toBe("ready");
      }).pipe(Effect.provide(testLayer)),
    );

    it.live("stops redriving after exhausting the retry budget", () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* makeAdapter();
        const threadId = ThreadId.make("thread-test-transient-exhausted");
        const sessionId = yield* startThread(adapter, "thread-test-transient-exhausted");

        const first = yield* adapter.sendTurn({ threadId, input: "Doomed prompt" });
        let currentTurnId: string = first.turnId;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const nextTurnId = `retry-turn-${attempt}`;
          mockTurnStartResponse = { status: "accepted", turnId: nextTurnId };
          const startedFiber = yield* collectTurnStarted(adapter, nextTurnId);
          failTurn(currentTurnId, sessionId, `cursor-fail-${attempt}`, OVERLOADED_503, true);
          expect(
            Option.isSome(yield* Fiber.join(startedFiber).pipe(Effect.timeoutOption("5 seconds"))),
          ).toBe(true);
          currentTurnId = nextTurnId;
        }
        expect(turnStartCommands()).toHaveLength(4);

        const exhaustedFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "runtime.warning" }> =>
              event.type === "runtime.warning" &&
              event.turnId === currentTurnId &&
              /persisted through 3 automatic retries/.test(event.payload.message),
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        failTurn(currentTurnId, sessionId, "cursor-fail-final", OVERLOADED_503, true);
        expect(
          Option.isSome(yield* Fiber.join(exhaustedFiber).pipe(Effect.timeoutOption("5 seconds"))),
        ).toBe(true);

        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
        expect(turnStartCommands()).toHaveLength(4);
      }).pipe(Effect.provide(testLayer)),
    );

    it.live("lets a user send supersede a pending retry", () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
          environment: process.env,
          transientRetryDelaysMs: [50],
        });
        const threadId = ThreadId.make("thread-test-transient-superseded");
        const sessionId = yield* startThread(adapter, "thread-test-transient-superseded");

        const first = yield* adapter.sendTurn({ threadId, input: "Original prompt" });
        failTurn(first.turnId, sessionId, "cursor-fail-1", OVERLOADED_503, true);
        yield* adapter.sendTurn({ threadId, input: "Follow-up prompt" });

        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 150)));
        const starts = turnStartCommands();
        expect(starts).toHaveLength(2);
        expect(JSON.stringify(starts[1]?.params.input)).toContain("Follow-up prompt");
      }).pipe(Effect.provide(testLayer)),
    );
  });

  describe("MuseAdapter MCP audit auto-retry", () => {
    const AUDIT_FAILURE =
      "invalid run configuration: MCP startup audit failed; MCP is disabled for this runtime";

    const makeAdapter = () =>
      MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
        mcpAuditRetryDelayMs: 0,
      });

    const startThread = (
      adapter: Effect.Success<ReturnType<typeof MuseAdapter.make>>,
      threadId: string,
    ) =>
      Effect.gen(function* () {
        McpProviderSession.setMcpProviderSession({
          environmentId: EnvironmentId.make("env-test"),
          threadId: ThreadId.make(threadId),
          providerSessionId: "provider-session-1",
          providerInstanceId: ProviderInstanceId.make("muse"),
          endpoint: "http://127.0.0.1:13773/mcp",
          authorizationHeader: "Bearer test-token",
          capabilities: new Set(["pull-requests"]),
        });
        const session = yield* adapter.startSession({
          threadId: ThreadId.make(threadId),
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
        });
        return (session.resumeCursor as { sessionId: string }).sessionId;
      });

    const failTurn = (turnId: string, sessionId: string, cursor: string, message: string) =>
      mockNotificationCallback!({
        method: "turn/completed",
        params: {
          sessionId,
          viewCursor: cursor,
          turnId,
          terminal: "failed",
          error: { kind: "configError", message, retryable: false },
        },
      });

    const collectWarning = (
      adapter: Effect.Success<ReturnType<typeof MuseAdapter.make>>,
      pattern: RegExp,
    ) =>
      adapter.streamEvents.pipe(
        Stream.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "runtime.warning" }> =>
            event.type === "runtime.warning" && pattern.test(event.payload.message),
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

    const collectTurnStarted = (
      adapter: Effect.Success<ReturnType<typeof MuseAdapter.make>>,
      turnId: string,
    ) =>
      adapter.streamEvents.pipe(
        Stream.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.started" }> =>
            event.type === "turn.started" && event.turnId === turnId,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

    it.live("re-resumes the same session on a fresh process and redrives once", () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* makeAdapter();
        const threadId = ThreadId.make("thread-test-audit-retry");
        const sessionId = yield* startThread(adapter, "thread-test-audit-retry");
        const firstCallback = mockNotificationCallback;

        const turn = yield* adapter.sendTurn({ threadId, input: "Audit me" });
        const warningFiber = yield* collectWarning(adapter, /retrying once/);
        mockTurnStartResponse = { status: "accepted", turnId: "audit-retry-turn-1" };
        failTurn(turn.turnId, sessionId, "cursor-audit-fail", AUDIT_FAILURE);

        const warning = yield* Fiber.join(warningFiber).pipe(Effect.timeoutOption("5 seconds"));
        expect(Option.isSome(warning)).toBe(true);

        const startedFiber = yield* collectTurnStarted(adapter, "audit-retry-turn-1");
        const started = yield* Fiber.join(startedFiber).pipe(Effect.timeoutOption("5 seconds"));
        expect(Option.isSome(started)).toBe(true);

        // Fresh process (new notification callback), same session resumed without
        // the t3-code MCP server, which is what Muse keeps rejecting.
        expect(mockNotificationCallback).toBeDefined();
        expect(mockNotificationCallback).not.toBe(firstCallback);
        const resumes = mockCommands.filter((command) => command.method === "session/resume");
        expect(resumes).toHaveLength(1);
        expect(resumes[0]?.params.sessionId).toBe(sessionId);
        expect(resumes[0]?.params.config).toBeUndefined();

        // Identical input redriven.
        const starts = mockCommands.filter((command) => command.method === "turn/start");
        expect(starts).toHaveLength(2);
        expect(starts[1]?.params.input).toEqual(starts[0]?.params.input);
        expect(starts[1]?.params.sessionId).toBe(sessionId);
      }).pipe(Effect.provide(testLayer)),
    );

    it.live("surfaces the second consecutive audit failure instead of looping", () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* makeAdapter();
        const threadId = ThreadId.make("thread-test-audit-exhausted");
        const sessionId = yield* startThread(adapter, "thread-test-audit-exhausted");

        const turn = yield* adapter.sendTurn({ threadId, input: "Doomed prompt" });
        mockTurnStartResponse = { status: "accepted", turnId: "audit-retry-turn-1" };
        const startedFiber = yield* collectTurnStarted(adapter, "audit-retry-turn-1");
        failTurn(turn.turnId, sessionId, "cursor-audit-fail-1", AUDIT_FAILURE);
        expect(
          Option.isSome(yield* Fiber.join(startedFiber).pipe(Effect.timeoutOption("5 seconds"))),
        ).toBe(true);

        const exhaustedFiber = yield* collectWarning(adapter, /rejected the resumed session twice/);
        failTurn("audit-retry-turn-1", sessionId, "cursor-audit-fail-2", AUDIT_FAILURE);
        expect(
          Option.isSome(yield* Fiber.join(exhaustedFiber).pipe(Effect.timeoutOption("5 seconds"))),
        ).toBe(true);

        yield* Effect.sleep("50 millis");
        expect(mockCommands.filter((command) => command.method === "session/resume")).toHaveLength(
          1,
        );
        expect(mockCommands.filter((command) => command.method === "turn/start")).toHaveLength(2);
      }).pipe(Effect.provide(testLayer)),
    );

    it.live("refuses the audit retry when the failed turn already executed tools", () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* makeAdapter();
        const threadId = ThreadId.make("thread-test-audit-tools");
        const sessionId = yield* startThread(adapter, "thread-test-audit-tools");

        const turn = yield* adapter.sendTurn({ threadId, input: "Acting prompt" });
        mockNotificationCallback!({
          method: "item/completed",
          params: {
            sessionId,
            viewCursor: "cursor-item-1",
            item: {
              itemId: "tool-item-1",
              kind: "toolCall",
              revision: 2,
              status: "completed",
              turnId: turn.turnId,
              tool: "bash",
              args: "{}",
            },
          },
        });

        const warningFiber = yield* collectWarning(adapter, /already executed tools/);
        failTurn(turn.turnId, sessionId, "cursor-audit-fail", AUDIT_FAILURE);
        expect(
          Option.isSome(yield* Fiber.join(warningFiber).pipe(Effect.timeoutOption("5 seconds"))),
        ).toBe(true);

        yield* Effect.sleep("50 millis");
        expect(mockCommands.filter((command) => command.method === "session/resume")).toHaveLength(
          0,
        );
        expect(mockCommands.filter((command) => command.method === "turn/start")).toHaveLength(1);
      }).pipe(Effect.provide(testLayer)),
    );

    it.live("ignores audit failures for turns it did not start", () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* makeAdapter();
        const threadId = ThreadId.make("thread-test-audit-phantom");
        const sessionId = yield* startThread(adapter, "thread-test-audit-phantom");

        yield* adapter.sendTurn({ threadId, input: "Real prompt" });
        failTurn("phantom-turn-9", sessionId, "cursor-audit-phantom", AUDIT_FAILURE);

        yield* Effect.sleep("50 millis");
        expect(mockCommands.filter((command) => command.method === "session/resume")).toHaveLength(
          0,
        );
        expect(mockCommands.filter((command) => command.method === "turn/start")).toHaveLength(1);
      }).pipe(Effect.provide(testLayer)),
    );

    it.live("routes the next resend to a fresh session when the re-resume is rejected", () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* makeAdapter();
        const threadId = ThreadId.make("thread-test-audit-gone");
        const sessionId = yield* startThread(adapter, "thread-test-audit-gone");

        const turn = yield* adapter.sendTurn({ threadId, input: "Gone prompt" });
        mockResumeShouldFail = true;
        const warningFiber = yield* collectWarning(adapter, /could not re-attach/);
        failTurn(turn.turnId, sessionId, "cursor-audit-fail", AUDIT_FAILURE);
        expect(
          Option.isSome(yield* Fiber.join(warningFiber).pipe(Effect.timeoutOption("5 seconds"))),
        ).toBe(true);

        yield* Effect.sleep("50 millis");
        expect(mockCommands.filter((command) => command.method === "turn/start")).toHaveLength(1);

        // The session is gone from the CLI: the next resend starts fresh.
        mockResumeShouldFail = false;
        yield* adapter.sendTurn({ threadId, input: "Fresh start" });
        const starts = mockCommands.filter((command) => command.method === "session/start");
        expect(starts).toHaveLength(2);
        expect(starts[1]?.params.sessionId).not.toBe(sessionId);
      }).pipe(Effect.provide(testLayer)),
    );
  });

  describe("MuseAdapter silent-completion summary nudge", () => {
    const makeNudgeAdapter = (silentNudgeDelayMs = 0) =>
      MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
        silentNudgeDelayMs,
      });

    const startThread = (
      adapter: Effect.Success<ReturnType<typeof MuseAdapter.make>>,
      threadId: string,
    ) =>
      Effect.gen(function* () {
        const session = yield* adapter.startSession({
          threadId: ThreadId.make(threadId),
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
        });
        return (session.resumeCursor as { sessionId: string }).sessionId;
      });

    const collectNudgeWarning = (
      adapter: Effect.Success<ReturnType<typeof MuseAdapter.make>>,
      pattern: RegExp,
    ) =>
      adapter.streamEvents.pipe(
        Stream.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "runtime.warning" }> =>
            event.type === "runtime.warning" && pattern.test(event.payload.message),
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

    const collectNudgeStarted = (
      adapter: Effect.Success<ReturnType<typeof MuseAdapter.make>>,
      turnId: string,
    ) =>
      adapter.streamEvents.pipe(
        Stream.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.started" }> =>
            event.type === "turn.started" && event.turnId === turnId,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

    const completeTurn = (turnId: string, sessionId: string, cursor: string) =>
      mockNotificationCallback!({
        method: "turn/completed",
        params: {
          sessionId,
          viewCursor: cursor,
          turnId,
          terminal: "completed",
        },
      });

    const completeWithTools = (
      turnId: string,
      sessionId: string,
      itemCursor: string,
      turnCursor: string,
    ) => {
      mockNotificationCallback!({
        method: "item/completed",
        params: {
          sessionId,
          viewCursor: itemCursor,
          item: {
            itemId: `tool-${String(turnId)}`,
            kind: "toolCall",
            revision: 2,
            status: "completed",
            turnId: String(turnId),
            tool: "bash",
            args: "{}",
          },
        },
      });
      completeTurn(turnId, sessionId, turnCursor);
    };

    const sendTextDelta = (sessionId: string, text: string) =>
      mockNotificationCallback!({
        method: "item/delta",
        params: {
          sessionId,
          viewCursor: "cursor-nudge-delta",
          itemId: "assistant-text-item",
          delta: text,
        },
      });

    it.live("asks for a summary when a turn completes with tools but no text", () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* makeNudgeAdapter();
        const threadId = ThreadId.make("thread-test-silent-nudge");
        const sessionId = yield* startThread(adapter, "thread-test-silent-nudge");

        const turn = yield* adapter.sendTurn({ threadId, input: "Build the thing" });
        mockTurnStartResponse = { status: "accepted", turnId: "silent-nudge-turn-1" };
        const warningFiber = yield* collectNudgeWarning(adapter, /asking for a summary/);
        const startedFiber = yield* collectNudgeStarted(adapter, "silent-nudge-turn-1");
        completeWithTools(turn.turnId, sessionId, "cursor-tool-1", "cursor-silent-1");

        expect(
          Option.isSome(yield* Fiber.join(warningFiber).pipe(Effect.timeoutOption("5 seconds"))),
        ).toBe(true);
        expect(
          Option.isSome(yield* Fiber.join(startedFiber).pipe(Effect.timeoutOption("5 seconds"))),
        ).toBe(true);

        const starts = mockCommands.filter((command) => command.method === "turn/start");
        expect(starts).toHaveLength(2);
        expect(starts[1]?.params.input).toEqual([
          { type: "text", text: expect.stringContaining("without any visible response") },
        ]);

        // The nudge turn responds with text: healthy again, no further starts.
        sendTextDelta(sessionId, "Done: all tests pass.");
        completeTurn("silent-nudge-turn-1", sessionId, "cursor-nudge-done");
        yield* Effect.sleep("50 millis");
        expect(mockCommands.filter((command) => command.method === "turn/start")).toHaveLength(2);
      }).pipe(Effect.provide(testLayer)),
    );

    it.live("stays quiet when the turn responded with text", () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* makeNudgeAdapter();
        const threadId = ThreadId.make("thread-test-silent-text");
        const sessionId = yield* startThread(adapter, "thread-test-silent-text");

        const turn = yield* adapter.sendTurn({ threadId, input: "Build the other thing" });
        const warningFiber = yield* collectNudgeWarning(adapter, /asking for a summary/);
        mockNotificationCallback!({
          method: "item/completed",
          params: {
            sessionId,
            viewCursor: "cursor-tool-1",
            item: {
              itemId: `tool-${String(turn.turnId)}`,
              kind: "toolCall",
              revision: 2,
              status: "completed",
              turnId: String(turn.turnId),
              tool: "bash",
              args: "{}",
            },
          },
        });
        sendTextDelta(sessionId, "Built it.");
        completeTurn(turn.turnId, sessionId, "cursor-done-1");

        expect(
          Option.isNone(yield* Fiber.join(warningFiber).pipe(Effect.timeoutOption("500 millis"))),
        ).toBe(true);
        yield* Effect.sleep("50 millis");
        expect(mockCommands.filter((command) => command.method === "turn/start")).toHaveLength(1);
      }).pipe(Effect.provide(testLayer)),
    );

    it.live("stays quiet when the turn ran nothing", () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* makeNudgeAdapter();
        const threadId = ThreadId.make("thread-test-silent-empty");
        const sessionId = yield* startThread(adapter, "thread-test-silent-empty");

        const turn = yield* adapter.sendTurn({ threadId, input: "Just thinking" });
        completeTurn(turn.turnId, sessionId, "cursor-empty-1");

        yield* Effect.sleep("50 millis");
        expect(mockCommands.filter((command) => command.method === "turn/start")).toHaveLength(1);
      }).pipe(Effect.provide(testLayer)),
    );

    it.live("surfaces the second consecutive silent end instead of looping", () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* makeNudgeAdapter();
        const threadId = ThreadId.make("thread-test-silent-loop");
        const sessionId = yield* startThread(adapter, "thread-test-silent-loop");

        const turn = yield* adapter.sendTurn({ threadId, input: "Doomed build" });
        mockTurnStartResponse = { status: "accepted", turnId: "silent-nudge-turn-1" };
        const startedFiber = yield* collectNudgeStarted(adapter, "silent-nudge-turn-1");
        completeWithTools(turn.turnId, sessionId, "cursor-tool-1", "cursor-doomed-1");
        expect(
          Option.isSome(yield* Fiber.join(startedFiber).pipe(Effect.timeoutOption("5 seconds"))),
        ).toBe(true);

        const exhaustedFiber = yield* collectNudgeWarning(adapter, /also ended without a response/);
        completeTurn("silent-nudge-turn-1", sessionId, "cursor-doomed-2");
        expect(
          Option.isSome(yield* Fiber.join(exhaustedFiber).pipe(Effect.timeoutOption("5 seconds"))),
        ).toBe(true);

        yield* Effect.sleep("50 millis");
        expect(mockCommands.filter((command) => command.method === "turn/start")).toHaveLength(2);
      }).pipe(Effect.provide(testLayer)),
    );

    it.live("lets a user send supersede a pending nudge", () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* makeNudgeAdapter(50);
        const threadId = ThreadId.make("thread-test-silent-superseded");
        const sessionId = yield* startThread(adapter, "thread-test-silent-superseded");

        const turn = yield* adapter.sendTurn({ threadId, input: "Original prompt" });
        completeWithTools(turn.turnId, sessionId, "cursor-tool-1", "cursor-silent-1");
        yield* adapter.sendTurn({ threadId, input: "Follow-up prompt" });

        yield* Effect.sleep("150 millis");
        const starts = mockCommands.filter((command) => command.method === "turn/start");
        expect(starts).toHaveLength(2);
        const resendText = starts[1]?.params.input?.[0]?.text as string;
        expect(resendText).toContain("Follow-up prompt");
        expect(resendText).not.toContain("without any visible response");
      }).pipe(Effect.provide(testLayer)),
    );

    it.live("announces quiet settles instead of dropping turns silently", () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
          environment: process.env,
          drainIntervalMs: 20,
          quietSettleThresholdMs: 100,
          silentNudgeDelayMs: 0,
        });

        const threadId = ThreadId.make("thread-test-quiet-notice");
        yield* adapter.startSession({
          threadId,
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({ threadId, input: "quick question" });
        const warningFiber = yield* collectNudgeWarning(adapter, /No provider activity/);
        expect(
          Option.isSome(yield* Fiber.join(warningFiber).pipe(Effect.timeoutOption("10 seconds"))),
        ).toBe(true);
      }).pipe(Effect.provide(testLayer)),
    );
  });

  describe("MuseAdapter skill dispatch", () => {
    const skillCatalog = (selectors: ReadonlyArray<string>) => ({
      skills: selectors.map((selector) => ({
        selector,
        description: `${selector} description`,
        displayName: selector,
        source: "user",
      })),
    });

    it.effect("sends a lone skill part with folded arguments for a $mention", () =>
      Effect.gen(function* () {
        mockCommands = [];
        mockRequestHandler = async (method: string) =>
          method === "skill/list" ? skillCatalog(["html-communication"]) : {};
        const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
          environment: process.env,
        });

        const threadId = ThreadId.make("thread-test-skill-dispatch");
        yield* adapter.startSession({
          threadId,
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId,
          input: "please $html-communication draft the release notes",
        });
        const startCmd = mockCommands.find((c) => c.method === "turn/start");
        expect(startCmd).toBeDefined();
        const input = startCmd?.params.input as Array<Record<string, unknown>>;
        // The host rejects text parts alongside a skill part, so the runtime
        // instructions and user text fold into the skill part's arguments.
        expect(input.map((part) => part.type)).toEqual(["skill"]);
        const skillPart = input[0] as { selector: string; arguments: string };
        expect(skillPart.selector).toBe("html-communication");
        expect(skillPart.arguments).toContain("runtime_info");
        expect(skillPart.arguments).toContain("please draft the release notes");
        expect(skillPart.arguments).not.toContain("$html-communication");
      }).pipe(Effect.provide(testLayer)),
    );

    it.effect("dispatches the last resolving mention when several are present", () =>
      Effect.gen(function* () {
        mockCommands = [];
        mockRequestHandler = async (method: string) =>
          method === "skill/list" ? skillCatalog(["alpha-skill", "beta-skill"]) : {};
        const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
          environment: process.env,
        });

        const threadId = ThreadId.make("thread-test-skill-dispatch-last");
        yield* adapter.startSession({
          threadId,
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({ threadId, input: "$alpha-skill first, then $beta-skill second" });
        const startCmd = mockCommands.find((c) => c.method === "turn/start");
        expect(startCmd).toBeDefined();
        const input = startCmd?.params.input as Array<Record<string, unknown>>;
        // The host allows at most one skill part per submission.
        expect(input.map((part) => part.type)).toEqual(["skill"]);
        const skillPart = input[0] as { selector: string; arguments: string };
        expect(skillPart.selector).toBe("beta-skill");
        expect(skillPart.arguments).toContain("$alpha-skill first, then second");
      }).pipe(Effect.provide(testLayer)),
    );

    it.effect("falls back to a text part when no mention resolves", () =>
      Effect.gen(function* () {
        mockCommands = [];
        mockRequestHandler = async (method: string) =>
          method === "skill/list" ? skillCatalog(["html-communication"]) : {};
        const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
          environment: process.env,
        });

        const threadId = ThreadId.make("thread-test-skill-dispatch-unknown");
        yield* adapter.startSession({
          threadId,
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({ threadId, input: "echo $HOME then done" });
        const startCmd = mockCommands.find((c) => c.method === "turn/start");
        expect(startCmd).toBeDefined();
        const input = startCmd?.params.input as Array<Record<string, unknown>>;
        expect(input.map((part) => part.type)).toEqual(["text"]);
        expect(input[0]?.text).toContain("echo $HOME then done");
      }).pipe(Effect.provide(testLayer)),
    );

    it.effect("folds file notes into arguments and keeps images as parts", () =>
      Effect.gen(function* () {
        mockCommands = [];
        mockRequestHandler = async (method: string) =>
          method === "skill/list" ? skillCatalog(["html-communication"]) : {};
        const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
          environment: process.env,
        });
        const config = yield* ServerConfig.ServerConfig;
        const fileAttachment = {
          type: "file",
          id: "thread-00000000-0000-4000-8000-000000000002-txt",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
        } as const;
        const imageAttachment = {
          type: "image",
          id: "thread-00000000-0000-4000-8000-000000000001",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 68,
        } as const;
        const filePath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: fileAttachment,
        });
        const imagePath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: imageAttachment,
        });
        expect(filePath).not.toBeNull();
        expect(imagePath).not.toBeNull();
        yield* Effect.promise(() => NodeFSP.mkdir(config.attachmentsDir, { recursive: true }));
        yield* Effect.promise(() => NodeFSP.writeFile(filePath!, "notes"));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            imagePath!,
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9kAAAAASUVORK5CYII=",
              "base64",
            ),
          ),
        );

        const threadId = ThreadId.make("thread-test-skill-dispatch-attachments");
        yield* adapter.startSession({
          threadId,
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId,
          input: "$html-communication review this",
          attachments: [fileAttachment, imageAttachment],
        });
        const startCmd = mockCommands.find((c) => c.method === "turn/start");
        expect(startCmd).toBeDefined();
        const input = startCmd?.params.input as Array<Record<string, unknown>>;
        expect(input.map((part) => part.type)).toEqual(["skill", "image"]);
        const skillPart = input[0] as { selector: string; arguments: string };
        expect(skillPart.selector).toBe("html-communication");
        expect(skillPart.arguments).toContain("review this");
        expect(skillPart.arguments).toContain("Attached file:");
        const imagePart = input[1] as { mediaType: string; base64Data: string };
        expect(imagePart.mediaType).toBe("image/png");
        expect(imagePart.base64Data.length).toBeGreaterThan(0);
      }).pipe(Effect.provide(testLayer)),
    );
  });

  it.effect("synthesizes turn.started when turn/start returns steered disposition", () =>
    Effect.gen(function* () {
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-steered-recovery");
      yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });

      mockTurnStartResponse = {
        status: "accepted",
        turnId: "turn-steered-123",
        disposition: "steered",
        startedNewTurn: false,
      };

      const collected = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.started"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      const turn = yield* adapter.sendTurn({ threadId, input: "Steered message" });
      expect(turn.turnId).toBe("turn-steered-123");

      const events = yield* Fiber.join(collected);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("turn.started");
      expect(events[0]?.turnId).toBe("turn-steered-123");

      const sessions = yield* adapter.listSessions();
      const current = sessions.find((s) => s.threadId === threadId);
      expect(current?.status).toBe("running");
      expect(current?.activeTurnId).toBe("turn-steered-123");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("handles queued turn disposition without prematurely marking session running", () =>
    Effect.gen(function* () {
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-queued-disposition");
      const session = yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });
      const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;

      mockTurnStartResponse = {
        status: "accepted",
        turnId: "turn-queued-456",
        disposition: "queued",
        startedNewTurn: false,
      };

      const turn = yield* adapter.sendTurn({ threadId, input: "Queued message" });
      expect(turn.turnId).toBe("turn-queued-456");

      let sessions = yield* adapter.listSessions();
      let current = sessions.find((s) => s.threadId === threadId);
      // Because it is queued, session status does not transition to running yet
      expect(current?.status).toBe("ready");

      // Now Muse dequeues and starts the turn
      mockNotificationCallback!({
        method: "turn/started",
        params: {
          sessionId,
          viewCursor: "cursor-q-start",
          turnId: "turn-queued-456",
        },
      });

      sessions = yield* adapter.listSessions();
      current = sessions.find((s) => s.threadId === threadId);
      expect(current?.status).toBe("running");
      expect(current?.activeTurnId).toBe("turn-queued-456");
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("interrupts the stale host turn when a turn queues with no live turn", () =>
    Effect.gen(function* () {
      mockCommands = [];
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-queued-zombie");
      const session = yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });
      const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;

      // Turn 1 runs, then settles in the adapter while the host keeps working it.
      const first = yield* adapter.sendTurn({ threadId, input: "first" });
      const staleTurnId = String(first.turnId);
      mockNotificationCallback!({
        method: "turn/completed",
        params: {
          sessionId,
          viewCursor: "cursor-zombie-done",
          turnId: staleTurnId,
          terminal: "completed",
        },
      });
      let current = (yield* adapter.listSessions()).find((s) => s.threadId === threadId);
      expect(current?.status).toBe("ready");

      // The follow-up queues behind the still-busy host.
      mockCommands = [];
      mockTurnStartResponse = {
        status: "accepted",
        turnId: "turn-queued-zombie",
        disposition: "queued",
        startedNewTurn: false,
      };
      const warnings = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "runtime.warning" }> =>
            event.type === "runtime.warning",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      const second = yield* adapter.sendTurn({ threadId, input: "second" });
      expect(String(second.turnId)).toBe("turn-queued-zombie");

      // The stale host turn is interrupted so the queued turn can launch.
      const interrupt = mockCommands.find((c) => c.method === "turn/interrupt");
      expect(interrupt?.params).toMatchObject({ sessionId, turnId: staleTurnId });

      const warned = yield* Fiber.join(warnings).pipe(Effect.timeoutOption("5 seconds"));
      expect(Option.isSome(warned)).toBe(true);

      current = (yield* adapter.listSessions()).find((s) => s.threadId === threadId);
      expect(current?.status).toBe("ready");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("leaves a queued turn alone while its predecessor is still live", () =>
    Effect.gen(function* () {
      mockCommands = [];
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-queued-live");
      yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({ threadId, input: "first" });
      mockCommands = [];
      mockTurnStartResponse = {
        status: "accepted",
        turnId: "turn-queued-live",
        disposition: "queued",
        startedNewTurn: false,
      };
      yield* adapter.sendTurn({ threadId, input: "second" });

      expect(mockCommands.find((c) => c.method === "turn/interrupt")).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("does not idle-settle a quiet turn while a tool call is still running", () =>
    Effect.gen(function* () {
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
        drainIntervalMs: 20,
        quietSettleThresholdMs: 100,
      });

      const threadId = ThreadId.make("thread-test-idle-live-tool");
      const session = yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });
      const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;

      const turn = yield* adapter.sendTurn({ threadId, input: "run the slow build" });
      mockNotificationCallback!({
        method: "item/started",
        params: {
          sessionId,
          viewCursor: "cursor-idle-tool",
          item: {
            itemId: "tool-idle-1",
            kind: "toolCall",
            revision: 1,
            status: "inProgress",
            turnId: String(turn.turnId),
            tool: "bash",
          },
        },
      });

      const completions: Array<ProviderRuntimeEvent> = [];
      const tap = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.tap((event) => Effect.sync(() => void completions.push(event))),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* Effect.sleep("500 millis");
      yield* Fiber.interrupt(tap);

      expect(completions).toHaveLength(0);
      const current = (yield* adapter.listSessions()).find((s) => s.threadId === threadId);
      expect(current?.status).toBe("running");
      expect(current?.activeTurnId).toBe(String(turn.turnId));
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("idle-settles a quiet turn once nothing is still running", () =>
    Effect.gen(function* () {
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
        drainIntervalMs: 20,
        quietSettleThresholdMs: 100,
      });

      const threadId = ThreadId.make("thread-test-idle-done");
      yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({ threadId, input: "quick question" });
      const completed = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      const events = yield* Fiber.join(completed).pipe(Effect.timeoutOption("10 seconds"));

      expect(Option.isSome(events)).toBe(true);
      expect(events.pipe(Option.map((chunk) => String(chunk[0]?.turnId)))).toEqual(
        Option.some(String(turn.turnId)),
      );
      const current = (yield* adapter.listSessions()).find((s) => s.threadId === threadId);
      expect(current?.status).toBe("ready");
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("delivers a push-less resumed session's final events before settling", () =>
    Effect.gen(function* () {
      // Muse answers session/resume without a view cursor when it cannot
      // project the session: nothing is pushed and polling is the only source.
      mockResumeViewCursor = "";
      const sessionId = "sess-poll";
      const turnId = "poll-turn-1";
      const museHome = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(process.cwd(), ".muse-home-test-")),
      );
      const now = DateTime.toDateUtc(yield* DateTime.now);
      const dayDir = NodePath.join(
        museHome,
        "sessions",
        String(now.getUTCFullYear()),
        String(now.getUTCMonth() + 1).padStart(2, "0"),
        String(now.getUTCDate()).padStart(2, "0"),
        sessionId,
      );
      yield* Effect.promise(() => NodeFSP.mkdir(dayDir, { recursive: true }));
      // The session record already shows the turn ended.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(dayDir, "session.jsonl"),
          `{"payload":{"kind":"run","run_id":"${turnId}","event":{"kind":"terminal","terminal":"completed"}}}\n`,
        ),
      );
      const priorMuseHome = process.env.MUSE_HOME;
      process.env.MUSE_HOME = museHome;
      mockRequestHandler = async (method, params) => {
        if (method !== "view/page") return {};
        if (params.direction === "backward")
          return {
            events: [
              {
                method: "session/statusChanged",
                params: { sessionId, viewCursor: "v:sess-poll:5" },
              },
            ],
          };
        if (params.cursor !== "v:sess-poll:5") return { events: [], nextCursor: null };
        // Slow page: the session-record check fires while this is in flight.
        await Effect.runPromise(Effect.sleep("150 millis"));
        return {
          events: [
            {
              method: "item/completed",
              params: {
                sessionId,
                viewCursor: "v:sess-poll:6",
                item: {
                  itemId: "final-reply",
                  kind: "agentMessage",
                  revision: 1,
                  status: "completed",
                  turnId,
                  text: "Here is the answer.",
                },
              },
            },
            {
              method: "turn/completed",
              params: { sessionId, viewCursor: "v:sess-poll:7", turnId, terminal: "completed" },
            },
          ],
          nextCursor: "v:sess-poll:7",
        };
      };
      try {
        const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
          environment: process.env,
          drainIntervalMs: 20,
          sessionRecordCheckQuietMs: 50,
        });
        const threadId = ThreadId.make("thread-test-push-less");
        yield* adapter.startSession({
          threadId,
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId, selectedModel: "default" },
        });
        const collected = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn.completed" ||
              event.type === "runtime.warning" ||
              (event.type === "item.completed" && String(event.itemId) === "final-reply"),
          ),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        mockTurnStartResponse = { status: "accepted", turnId };
        yield* adapter.sendTurn({ threadId, input: "question" });

        const events = yield* Fiber.join(collected).pipe(Effect.timeoutOption("5 seconds"));
        expect(Option.isSome(events)).toBe(true);
        const types = Option.getOrThrow(events).map((event) =>
          event.type === "runtime.warning" ? `warning: ${event.payload.message}` : event.type,
        );
        // The reply arrives before the turn settles, and nothing falls back to the record.
        expect(types).toEqual(["item.completed", "turn.completed"]);
      } finally {
        if (priorMuseHome === undefined) delete process.env.MUSE_HOME;
        else process.env.MUSE_HOME = priorMuseHome;
        yield* Effect.promise(() => NodeFSP.rm(museHome, { recursive: true, force: true }));
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "auto-approves tool approvals and suppresses approval prompts in full-access mode via notification",
    () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
          environment: process.env,
        });

        const threadId = ThreadId.make("thread-test-auto-approve-notif");
        const session = yield* adapter.startSession({
          threadId,
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
        });

        const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;
        yield* adapter.sendTurn({
          threadId,
          input: "Run command in full access",
        });

        let openedApprovalEvent: ProviderRuntimeEvent | undefined;
        const sub = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "request.opened" }> =>
              event.type === "request.opened",
          ),
          Stream.tap((event) =>
            Effect.sync(() => {
              openedApprovalEvent = event;
            }),
          ),
          Stream.runDrain,
          Effect.forkChild,
        );

        mockNotificationCallback!({
          method: "approval/requested",
          params: {
            sessionId,
            viewCursor: "cursor-approval",
            turnId: "turn-test",
            itemId: "item-tool-1",
            toolName: "shell",
            rawArgs: JSON.stringify({ command: "dir" }),
            approvalId: "appr-1",
            currentRequirementId: { approvalId: "appr-1", sourceIndex: 0 },
            availableChoices: [
              { choiceId: "c-allow", decision: "approved", label: "Allow", scope: "turn" },
              { choiceId: "c-deny", decision: "denied", label: "Deny", scope: "turn" },
            ],
            subject: { kind: "shell", command: "dir" },
          },
        });

        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));

        const decideCommand = mockCommands.find((c) => c.method === "approval/decide");
        expect(decideCommand).toBeDefined();
        expect(decideCommand?.params).toEqual({
          sessionId,
          approvalId: "appr-1",
          requirementId: { approvalId: "appr-1", sourceIndex: 0 },
          choiceId: "c-allow",
        });

        expect(openedApprovalEvent).toBeUndefined();
        yield* Fiber.interrupt(sub);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "auto-approves tool approvals and suppresses approval prompts in full-access mode via server request",
    () =>
      Effect.gen(function* () {
        mockCommands = [];
        const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
          environment: process.env,
        });

        const threadId = ThreadId.make("thread-test-auto-approve-req");
        const session = yield* adapter.startSession({
          threadId,
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
        });

        const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;
        yield* adapter.sendTurn({
          threadId,
          input: "Run command in full access",
        });

        let openedApprovalEvent: ProviderRuntimeEvent | undefined;
        const sub = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "request.opened" }> =>
              event.type === "request.opened",
          ),
          Stream.tap((event) =>
            Effect.sync(() => {
              openedApprovalEvent = event;
            }),
          ),
          Stream.runDrain,
          Effect.forkChild,
        );

        expect(mockServerRequestHandler).toBeDefined();
        const res = yield* Effect.promise(() =>
          mockServerRequestHandler!({
            method: "approval/request",
            params: {
              sessionId,
              viewCursor: "cursor-approval-req",
              approvalId: "appr-2",
              currentRequirementId: { approvalId: "appr-2", sourceIndex: 0 },
              availableChoices: [
                { choiceId: "c-allow-session", decision: "approvedForSession", scope: "session" },
                { choiceId: "c-deny", decision: "denied", scope: "turn" },
              ],
              subject: { kind: "shell", command: "git push" },
            },
          }),
        );
        expect(res).toEqual({});

        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));

        const decideCommand = mockCommands.find(
          (c) => c.method === "approval/decide" && c.params?.approvalId === "appr-2",
        );
        expect(decideCommand).toBeDefined();
        expect(decideCommand?.params).toEqual({
          sessionId,
          approvalId: "appr-2",
          requirementId: { approvalId: "appr-2", sourceIndex: 0 },
          choiceId: "c-allow-session",
        });

        expect(openedApprovalEvent).toBeUndefined();
        yield* Fiber.interrupt(sub);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "configures stream timeout and auto update environment variables for muse process",
    () =>
      Effect.gen(function* () {
        const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
          environment: process.env,
        });

        const threadId = ThreadId.make("thread-test-env-timeouts");
        yield* adapter.startSession({
          threadId,
          cwd: "Z:\\test-workspace",
        });

        expect(lastSpawnOptions).toBeDefined();
        expect(lastSpawnOptions.env.MUSE_NO_AUTO_UPDATE).toBe("1");
        expect(lastSpawnOptions.env.TBH_STREAM_IDLE_TIMEOUT_SECS).toBe("600");
        expect(lastSpawnOptions.env.TBH_STREAM_FIRST_EVENT_TIMEOUT_SECS).toBe("600");
      }).pipe(Effect.provide(testLayer)),
  );
});

describe("MuseAdapter path and symlink utilities", () => {
  it("compares paths equivalently across slashes and Windows drive casing", () => {
    expect(MuseAdapter.arePathsEquivalent("z:\\Workspaces\\t3code", "Z:\\Workspaces\\t3code")).toBe(
      true,
    );
    expect(MuseAdapter.arePathsEquivalent("Z:/Workspaces/t3code", "Z:\\Workspaces\\t3code")).toBe(
      true,
    );
    expect(MuseAdapter.arePathsEquivalent("z:/Workspaces/t3code", "Z:\\Workspaces\\t3code")).toBe(
      true,
    );
    expect(MuseAdapter.arePathsEquivalent("Z:\\other", "Z:\\Workspaces\\t3code")).toBe(false);
  });

  it("heals broken git symlink files into directory junctions on Windows", async () => {
    if (process.platform !== "win32") return;
    const tempDir = await NodeFSP.mkdtemp(
      NodePath.join(process.env.TEMP || "C:\\Temp", "t3-symlink-test-"),
    );
    try {
      const agentsSkillsDir = NodePath.join(tempDir, ".agents", "skills");
      await NodeFSP.mkdir(agentsSkillsDir, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(agentsSkillsDir, "test-skill.md"), "skill", "utf8");

      const claudeDir = NodePath.join(tempDir, ".claude");
      await NodeFSP.mkdir(claudeDir, { recursive: true });
      const claudeSkillsFile = NodePath.join(claudeDir, "skills");
      await NodeFSP.writeFile(claudeSkillsFile, "../.agents/skills", "utf8");

      const statBefore = await NodeFSP.lstat(claudeSkillsFile);
      expect(statBefore.isFile()).toBe(true);

      await MuseAdapter.healWindowsSkillSymlinks(tempDir);

      const statAfter = await NodeFSP.stat(claudeSkillsFile);
      expect(statAfter.isDirectory()).toBe(true);
      const lstatAfter = await NodeFSP.lstat(claudeSkillsFile);
      expect(lstatAfter.isSymbolicLink()).toBe(true);
      const readContent = await NodeFSP.readFile(
        NodePath.join(claudeSkillsFile, "test-skill.md"),
        "utf8",
      );
      expect(readContent).toBe("skill");
    } finally {
      await NodeFSP.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it.effect("preserves underlying error details when session/start fails", () =>
    Effect.gen(function* () {
      const errorDetail =
        "failed to read skill file: The directory name is invalid. (os error 267)";
      mockStartShouldFail = errorDetail;

      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-error");
      const exit = yield* Effect.exit(
        adapter.startSession({
          threadId,
          cwd: "Z:\\test-workspace",
          runtimeMode: "full-access",
        }),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const failure = exit.cause;
        expect(String(failure)).toContain(errorDetail);
      }

      mockStartShouldFail = false;
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("interruptTurn triggers clean restart on next sendTurn without wedging", () =>
    Effect.gen(function* () {
      mockCommands = [];
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-interrupt-restart");
      const session = yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });

      const turn1 = yield* adapter.sendTurn({
        threadId,
        input: "Turn 1 to be interrupted",
      });

      // Interrupt turn 1
      yield* adapter.interruptTurn(threadId, turn1.turnId);

      let sessions = yield* adapter.listSessions();
      let current = sessions.find((s) => s.threadId === threadId);
      expect(current?.status).toBe("ready");
      expect(current?.activeTurnId).toBeUndefined();

      const initialStartCommands = mockCommands.filter((c) => c.method === "session/start");
      expect(initialStartCommands).toHaveLength(1);

      // Now send Turn 2: should transparently re-initialize and start a new session before turn/start
      const turn2 = yield* adapter.sendTurn({
        threadId,
        input: "Turn 2 after interrupt",
      });

      const secondStartCommands = mockCommands.filter((c) => c.method === "session/start");
      expect(secondStartCommands).toHaveLength(2);

      const turnCommands = mockCommands.filter((c) => c.method === "turn/start");
      expect(turnCommands).toHaveLength(2);

      sessions = yield* adapter.listSessions();
      current = sessions.find((s) => s.threadId === threadId);
      expect(current?.status).toBe("running");
      expect(current?.activeTurnId).toBe(turn2.turnId);
    }).pipe(Effect.provide(testLayer)),
  );

  it("killMuseProcessTree safely handles empty, invalid, and mock inputs without error", () => {
    expect(() => MuseAdapter.killMuseProcessTree(null)).not.toThrow();
    expect(() => MuseAdapter.killMuseProcessTree(undefined)).not.toThrow();
    expect(() => MuseAdapter.killMuseProcessTree({})).not.toThrow();
    expect(() => MuseAdapter.killMuseProcessTree({ child: { pid: -1 } })).not.toThrow();
  });

  it.effect("safely receives session/branchChanged without failing session", () =>
    Effect.gen(function* () {
      const adapter = yield* MuseAdapter.make(decodeMuseSettings({}), {
        environment: process.env,
      });

      const threadId = ThreadId.make("thread-test-branch-changed");
      const session = yield* adapter.startSession({
        threadId,
        cwd: "Z:\\test-workspace",
        runtimeMode: "full-access",
      });

      const sessionId = (session.resumeCursor as { sessionId: string }).sessionId;
      expect(mockNotificationCallback).toBeDefined();

      mockNotificationCallback!({
        method: "session/branchChanged",
        params: {
          sessionId,
          viewCursor: "v:branch:1",
          branch: "main",
          workspaceRoot: "Z:\\test-workspace",
          vcs: "git",
        },
      });

      const sessions = yield* adapter.listSessions();
      const current = sessions.find((s) => s.threadId === threadId);
      expect(current?.status).toBe("ready");
    }).pipe(Effect.provide(testLayer)),
  );
});
