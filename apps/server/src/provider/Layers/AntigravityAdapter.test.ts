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

      const usageEvent = Array.from(eventsChunk).find(
        (e) => e.type === "thread.token-usage.updated",
      );
      expect(usageEvent).toBeDefined();
      if (usageEvent && usageEvent.type === "thread.token-usage.updated") {
        expect(usageEvent.payload.usage.usedTokens).toBe(100);
        expect(usageEvent.payload.usage.inputTokens).toBe(40);
        expect(usageEvent.payload.usage.outputTokens).toBe(60);
      }

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

  it.effect(
    "retains main turn token usage when checkpoint sub-step occurs and updates totalProcessedTokens",
    () =>
      Effect.gen(function* () {
        const mockScript = yield* makeMockAgyScript([
          '{"event":"init","conversation_id":"conv-usage-test"}',
          '{"event":"step_update","step_update":{"step_index":0,"step_type":"agent_response","text_delta":"Response text","state":"DONE","usage":{"input_tokens":14474,"output_tokens":89,"thinking_tokens":80,"total_tokens":14563}}}',
          '{"event":"step_update","step_update":{"step_index":1,"step_type":"checkpoint","state":"DONE","usage":{"input_tokens":94,"output_tokens":3,"total_tokens":97}}}',
          '{"event":"result","result":{"conversation_id":"conv-usage-test","usage":{"input_tokens":29334,"output_tokens":161,"total_tokens":29495}}}',
        ]);

        const adapter = yield* makeAntigravityAdapter(
          decodeAntigravitySettings({
            enabled: true,
            binaryPath: mockScript,
          }),
        );

        const threadId = ThreadId.make("thread-usage-test");
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("antigravity"),
            model: "claude-sonnet-4-6",
          },
        });

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* Effect.yieldNow;

        yield* adapter.sendTurn({
          threadId,
          input: "Test usage",
          modelSelection: {
            instanceId: ProviderInstanceId.make("antigravity"),
            model: "claude-sonnet-4-6",
          },
        });

        const eventsChunk = yield* Fiber.join(runtimeEventsFiber);
        const usageEvents = Array.from(eventsChunk).filter(
          (e) => e.type === "thread.token-usage.updated",
        );

        expect(usageEvents.length).toBeGreaterThanOrEqual(1);
        const lastUsageEvent = usageEvents[usageEvents.length - 1];
        if (lastUsageEvent && lastUsageEvent.type === "thread.token-usage.updated") {
          expect(lastUsageEvent.payload.usage.usedTokens).toBe(14563);
          expect(lastUsageEvent.payload.usage.maxTokens).toBe(200_000);
          expect(lastUsageEvent.payload.usage.totalProcessedTokens).toBe(29495);
        }

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect(
    "includes cached prompt tokens in active context window and prevents result totals from inflating usage",
    () =>
      Effect.gen(function* () {
        const mockScript = yield* makeMockAgyScript([
          '{"event":"init","conversation_id":"conv-cache-test"}',
          '{"event":"step_update","step_update":{"step_index":0,"step_type":"agent_response","text_delta":"Cached response","state":"DONE","usage":{"input_tokens":4215,"cache_read_tokens":211285,"output_tokens":142,"thinking_tokens":51,"total_tokens":4357}}}',
          '{"event":"result","result":{"conversation_id":"conv-cache-test","usage":{"input_tokens":2650687,"output_tokens":148356,"total_tokens":2799043}}}',
        ]);

        const adapter = yield* makeAntigravityAdapter(
          decodeAntigravitySettings({
            enabled: true,
            binaryPath: mockScript,
          }),
        );

        const threadId = ThreadId.make("thread-cache-test");
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("antigravity"),
            model: "gemini-3.7-flash",
          },
        });

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* Effect.yieldNow;

        yield* adapter.sendTurn({
          threadId,
          input: "Test cache usage",
          modelSelection: {
            instanceId: ProviderInstanceId.make("antigravity"),
            model: "gemini-3.7-flash",
          },
        });

        const eventsChunk = yield* Fiber.join(runtimeEventsFiber);
        const usageEvents = Array.from(eventsChunk).filter(
          (e) => e.type === "thread.token-usage.updated",
        );

        expect(usageEvents.length).toBeGreaterThanOrEqual(1);
        const lastUsageEvent = usageEvents[usageEvents.length - 1];
        if (lastUsageEvent && lastUsageEvent.type === "thread.token-usage.updated") {
          // 4215 uncached + 211285 cached + 142 output = 215642 tokens used in 1M window (~21.6%)
          expect(lastUsageEvent.payload.usage.usedTokens).toBe(215642);
          expect(lastUsageEvent.payload.usage.cachedInputTokens).toBe(211285);
          expect(lastUsageEvent.payload.usage.inputTokens).toBe(4215);
          expect(lastUsageEvent.payload.usage.outputTokens).toBe(142);
          expect(lastUsageEvent.payload.usage.maxTokens).toBe(1_000_000);
          expect(lastUsageEvent.payload.usage.totalProcessedTokens).toBe(2799043);
        }

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("parses categorical token usage when provided by agy telemetry", () =>
    Effect.gen(function* () {
      const mockScript = yield* makeMockAgyScript([
        '{"event":"init","conversation_id":"conv-cat-test"}',
        '{"event":"step_update","step_update":{"step_index":0,"step_type":"agent_response","text_delta":"Response with categories","state":"DONE","usage":{"input_tokens":4215,"cache_read_tokens":211285,"output_tokens":142,"categories":{"user_messages":319,"agent_responses":115900,"tool_calls":32600,"system_prompt":10600,"system_tools":13100,"skills":1300,"subagents":653,"checkpoint_buffer":34300}}}}',
        '{"event":"result","result":{"conversation_id":"conv-cat-test","status":"SUCCESS","response":"Done"}}',
      ]);

      const adapter = yield* makeAntigravityAdapter(
        decodeAntigravitySettings({
          enabled: true,
          binaryPath: mockScript,
        }),
      );

      const threadId = ThreadId.make("thread-cat-test");
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
      });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Effect.yieldNow;

      yield* adapter.sendTurn({
        threadId,
        input: "Test categorical usage",
      });

      const eventsChunk = yield* Fiber.join(runtimeEventsFiber);
      const usageEvents = Array.from(eventsChunk).filter(
        (e) => e.type === "thread.token-usage.updated",
      );

      expect(usageEvents.length).toBeGreaterThanOrEqual(1);
      const lastUsageEvent = usageEvents[0];
      if (lastUsageEvent && lastUsageEvent.type === "thread.token-usage.updated") {
        expect(lastUsageEvent.payload.usage.categories).toEqual({
          userMessages: 319,
          agentResponses: 115900,
          toolCalls: 32600,
          systemPrompt: 10600,
          systemTools: 13100,
          skills: 1300,
          subagents: 653,
          checkpointBuffer: 34300,
        });
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "translates invoke_subagent, send_message, and manage_subagents to task lifecycle events",
    () =>
      Effect.gen(function* () {
        const mockScript = yield* makeMockAgyScript([
          '{"event":"init","conversation_id":"conv-subagent-test"}',
          '{"event":"step_update","step_update":{"step_index":0,"step_type":"tool","tool_name":"invoke_subagent","state":"ACTIVE","tool_info":{"name":"invoke_subagent","parameters":{"Subagents":[{"Role":"Codebase Researcher","TypeName":"research","Prompt":"Search for components","Model":"inherit"},{"Role":"Unit Tester","TypeName":"tester","Prompt":"Run test suite","Model":"gemini-3.7-flash"}]}}}}',
          '{"event":"step_update","step_update":{"step_index":0,"step_type":"tool","tool_name":"invoke_subagent","state":"DONE","tool_info":{"name":"invoke_subagent"}}}',
          '{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","tool_name":"send_message","state":"ACTIVE","tool_info":{"name":"send_message","parameters":{"Recipient":"subagent-thread-subagent-test-s0-i0","Message":"Please check the auth files"}}}}',
          '{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","tool_name":"send_message","state":"DONE","tool_info":{"name":"send_message"}}}',
          '{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","tool_name":"manage_subagents","state":"ACTIVE","tool_info":{"name":"manage_subagents","parameters":{"Action":"kill","ConversationIds":["subagent-thread-subagent-test-s0-i1"]}}}}',
          '{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","tool_name":"manage_subagents","state":"DONE","tool_info":{"name":"manage_subagents"}}}',
          '{"event":"result","result":{"conversation_id":"conv-subagent-test","status":"SUCCESS","response":"Subagents orchestrated successfully"}}',
        ]);

        const adapter = yield* makeAntigravityAdapter(
          decodeAntigravitySettings({
            enabled: true,
            binaryPath: mockScript,
          }),
        );

        const threadId = ThreadId.make("thread-subagent-test");
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("antigravity"),
            model: "gemini-3.7-flash",
          },
        });

        const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((e) => e.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* Effect.yieldNow;

        yield* adapter.sendTurn({
          threadId,
          input: "Launch subagents",
        });

        const eventsChunk = yield* Fiber.join(runtimeEventsFiber);
        const events = Array.from(eventsChunk);

        const taskStartedEvents = events.filter((e) => e.type === "task.started");
        expect(taskStartedEvents.length).toBe(2);

        const firstTask = taskStartedEvents[0];
        if (firstTask && firstTask.type === "task.started") {
          expect(firstTask.payload.title).toBe("Codebase Researcher");
          expect(firstTask.payload.role).toBe("Codebase Researcher");
          expect(firstTask.payload.taskType).toBe("subagent");
          expect(firstTask.payload.model).toBe("gemini-3.7-flash");
        }

        const secondTask = taskStartedEvents[1];
        if (secondTask && secondTask.type === "task.started") {
          expect(secondTask.payload.title).toBe("Unit Tester");
          expect(secondTask.payload.role).toBe("Unit Tester");
          expect(secondTask.payload.taskType).toBe("subagent");
          expect(secondTask.payload.model).toBe("gemini-3.7-flash");
        }

        const taskProgressEvents = events.filter((e) => e.type === "task.progress");
        expect(taskProgressEvents.length).toBe(1);
        const progressEvent = taskProgressEvents[0];
        if (progressEvent && progressEvent.type === "task.progress") {
          expect(progressEvent.payload.summary).toContain(
            "Sent message: Please check the auth files",
          );
        }

        const taskCompletedEvents = events.filter((e) => e.type === "task.completed");
        expect(taskCompletedEvents.length).toBe(1);
        const completedEvent = taskCompletedEvents[0];
        if (completedEvent && completedEvent.type === "task.completed") {
          expect(completedEvent.payload.status).toBe("cancelled");
        }

        yield* adapter.stopSession(threadId);
      }),
  );
});
