import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AntigravitySettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { makeAntigravityAdapter } from "./AntigravityAdapter.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

const makeMockAgyScript = (lines: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({ prefix: "agy-mock-" });
    const isWin = process.platform === "win32";
    const jsPath = path.join(dir, "fake-agy.cjs");
    const jsContent = `
const lines = ${JSON.stringify(lines)};
for (const line of lines) {
  console.log(line);
}
process.exit(0);
`;
    yield* fs.writeFileString(jsPath, jsContent);
    if (isWin) {
      const cmdPath = path.join(dir, "fake-agy.cmd");
      yield* fs.writeFileString(cmdPath, `@node "${jsPath}" %*\r\n`);
      return cmdPath;
    }
    const scriptPath = path.join(dir, "fake-agy.sh");
    yield* fs.writeFileString(scriptPath, `#!/bin/sh\nnode "${jsPath}" "$@"\n`);
    yield* fs.chmod(scriptPath, 0o755);
    return scriptPath;
  });

const makeMockAgyArgsScript = (argsLog: string, lines: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({ prefix: "agy-mock-args-" });
    const isWin = process.platform === "win32";
    const jsPath = path.join(dir, "fake-agy-args.cjs");
    const jsContent = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsLog)}, process.argv.slice(2).join(' '));
const lines = ${JSON.stringify(lines)};
for (const line of lines) {
  console.log(line);
}
process.exit(0);
`;
    yield* fs.writeFileString(jsPath, jsContent);
    if (isWin) {
      const cmdPath = path.join(dir, "fake-agy.cmd");
      yield* fs.writeFileString(cmdPath, `@node "${jsPath}" %*\r\n`);
      return cmdPath;
    }
    const scriptPath = path.join(dir, "fake-agy.sh");
    yield* fs.writeFileString(scriptPath, `#!/bin/sh\nnode "${jsPath}" "$@"\n`);
    yield* fs.chmod(scriptPath, 0o755);
    return scriptPath;
  });

it.layer(NodeServices.layer)("makeAntigravityAdapter", (it) => {
  it.effect("starts and stops a session", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAntigravityAdapter(decodeAntigravitySettings({ enabled: true }));
      const threadId = ThreadId.make("thread-1");

      const session = yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
      });

      expect(session.threadId).toBe(threadId);
      expect(session.provider).toBe("antigravity");
      expect(session.providerInstanceId).toBe("antigravity");
      expect(session.status).toBe("ready");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("binds custom instanceId to session", () =>
    Effect.gen(function* () {
      const customInstanceId = ProviderInstanceId.make("antigravity-secondary");
      const adapter = yield* makeAntigravityAdapter(decodeAntigravitySettings({ enabled: true }), {
        instanceId: customInstanceId,
      });
      const threadId = ThreadId.make("thread-2");

      const session = yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
      });

      expect(session.providerInstanceId).toBe(customInstanceId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("executes a turn and translates stream events", () =>
    Effect.gen(function* () {
      const mockScript = yield* makeMockAgyScript([
        '{"event":"init","conversation_id":"conv-123"}',
        '{"event":"step_update","step_update":{"step_index":0,"step_type":"agent_response","text_delta":"Hello from Antigravity!","state":"DONE","usage":{"total_tokens":100,"input_tokens":40,"output_tokens":60}}}',
        '{"event":"result","result":{"conversation_id":"conv-123"}}',
      ]);

      const adapter = yield* makeAntigravityAdapter(
        decodeAntigravitySettings({
          enabled: true,
          binaryPath: mockScript,
        }),
      );

      const threadId = ThreadId.make("thread-turn-test");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Effect.yieldNow;

      const result = yield* adapter.sendTurn({
        threadId,
        input: "Hi",
      });

      expect(result.threadId).toBe(threadId);
      expect(result.turnId).toBeDefined();

      const eventsChunk = yield* Fiber.join(runtimeEventsFiber);
      const types = Array.from(eventsChunk).map((e) => e.type);

      expect(types).toContain("turn.started");
      expect(types).toContain("session.state.changed");
      expect(types).toContain("content.delta");
      expect(types).toContain("thread.token-usage.updated");
      expect(types).toContain("turn.completed");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("handles turn interruption safely", () =>
    Effect.gen(function* () {
      const mockScript = yield* makeMockAgyScript([
        '{"event":"init","conversation_id":"conv-long"}',
      ]);

      const adapter = yield* makeAntigravityAdapter(
        decodeAntigravitySettings({
          enabled: true,
          binaryPath: mockScript,
        }),
      );

      const threadId = ThreadId.make("thread-interrupt-test");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      const turnResult = yield* adapter.sendTurn({
        threadId,
        input: "Test interrupt",
      });

      yield* adapter.interruptTurn(threadId, turnResult.turnId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("passes selected model and effort to agy CLI arguments", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "agy-mock-args-" });
      const argsLog = path.join(dir, "args.log");
      const scriptPath = yield* makeMockAgyArgsScript(argsLog, [
        '{"event":"init","conversation_id":"conv-args"}',
        '{"event":"result","result":{"conversation_id":"conv-args"}}',
      ]);

      const adapter = yield* makeAntigravityAdapter(
        decodeAntigravitySettings({
          enabled: true,
          binaryPath: scriptPath,
        }),
      );

      const threadId = ThreadId.make("thread-args-test");
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("antigravity"),
          model: "gemini-3.7-flash",
          options: [{ id: "effort", value: "high" }],
        },
      });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* adapter.sendTurn({
        threadId,
        input: "Hello with high effort",
        modelSelection: {
          instanceId: ProviderInstanceId.make("antigravity"),
          model: "gemini-3.7-flash",
          options: [{ id: "effort", value: "high" }],
        },
      });

      yield* Fiber.join(runtimeEventsFiber);

      const loggedArgs = yield* fs.readFileString(argsLog);
      expect(loggedArgs).toContain("--model gemini-3.7-flash");
      expect(loggedArgs).toContain("--effort high");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("defaults effort to medium when not specified", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "agy-mock-default-effort-" });
      const argsLog = path.join(dir, "args.log");
      const scriptPath = yield* makeMockAgyArgsScript(argsLog, [
        '{"event":"init","conversation_id":"conv-effort"}',
        '{"event":"result","result":{"conversation_id":"conv-effort"}}',
      ]);

      const adapter = yield* makeAntigravityAdapter(
        decodeAntigravitySettings({
          enabled: true,
          binaryPath: scriptPath,
        }),
      );

      const threadId = ThreadId.make("thread-default-effort-test");
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
      });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* adapter.sendTurn({
        threadId,
        input: "Hello with default effort",
      });

      yield* Fiber.join(runtimeEventsFiber);

      const loggedArgs = yield* fs.readFileString(argsLog);
      expect(loggedArgs).toContain("--effort medium");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("completes tool item on ERROR state and translates error notices", () =>
    Effect.gen(function* () {
      const mockScript = yield* makeMockAgyScript([
        '{"event":"init","conversation_id":"conv-err"}',
        '{"event":"step_update","step_update":{"step_index":0,"step_type":"tool","tool_name":"run_command","state":"ACTIVE","tool_info":{"name":"run_command","parameters":{"CommandLine":"failing_cmd"}}}}',
        '{"event":"step_update","step_update":{"step_index":0,"step_type":"tool","tool_name":"run_command","state":"ERROR","tool_info":{"name":"run_command"}}}',
        '{"event":"step_update","step_update":{"step_index":1,"step_type":"error_message","state":"DONE","error":"Model temporarily unavailable"}}',
        '{"event":"result","result":{"conversation_id":"conv-err","status":"SUCCESS","response":"Recovered"}}',
      ]);

      const adapter = yield* makeAntigravityAdapter(
        decodeAntigravitySettings({
          enabled: true,
          binaryPath: mockScript,
        }),
      );

      const threadId = ThreadId.make("thread-tool-err-test");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Effect.yieldNow;

      yield* adapter.sendTurn({
        threadId,
        input: "Do something",
      });

      const eventsChunk = yield* Fiber.join(runtimeEventsFiber);
      const events = Array.from(eventsChunk);
      const itemCompleted = events.find((e) => e.type === "item.completed");
      expect(itemCompleted).toBeDefined();
      if (itemCompleted && itemCompleted.type === "item.completed") {
        expect(itemCompleted.payload.status).toBe("failed");
      }

      const noticeDelta = events.find(
        (e) =>
          e.type === "content.delta" && e.payload.delta.includes("Model temporarily unavailable"),
      );
      expect(noticeDelta).toBeDefined();

      yield* adapter.stopSession(threadId);
    }),
  );
});
