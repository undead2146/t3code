// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { MuseSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as ServerConfig from "../../config.ts";
import * as MuseAdapter from "./MuseAdapter.ts";

const decodeMuseSettings = Schema.decodeSync(MuseSettings);

let mockNotificationCallback: ((notification: any) => void) | undefined;
let mockSessionResultHistory: any = undefined;
let mockResumeShouldFail = false;
let mockStartShouldFail: string | false = false;
let mintCommandIdCounter = 0;
let mockCommands: Array<{ method: string; params: any }> = [];

vi.mock("@muse-code/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muse-code/sdk")>();
  return {
    ...actual,
    spawnMspConnection: () => ({
      close: vi.fn(async () => {}),
      initialize: vi.fn(async () => ({
        connection: {
          onNotification: vi.fn((cb) => {
            mockNotificationCallback = cb;
          }),
          onProtocolError: vi.fn(() => {}),
          onServerRequest: vi.fn(() => {}),
          closed: new Promise(() => {}),
          mintCommandId: () => `cmd-${++mintCommandIdCounter}`,
          command: vi.fn(async (method: string, params: any) => {
            mockCommands.push({ method, params });
            if (method === "session/compact") return { status: "accepted" };
            if (method === "session/start" && mockStartShouldFail)
              throw new Error(mockStartShouldFail);
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
              };
            }
            if (method === "turn/start") {
              return {
                status: "accepted",
                turnId: `turn-${++mintCommandIdCounter}`,
              };
            }
            return {};
          }),
          request: vi.fn(async () => ({})),
        },
        child: {
          exit: new Promise(() => {}),
          close: vi.fn(async () => {}),
        },
      })),
    }),
  };
});

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-muse-adapter-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

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
});
