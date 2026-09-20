import {
  EventId,
  NonNegativeInt,
  PositiveInt,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  decodeMuseNotification,
  mapMuseNotification,
  museTransportTruncationSignature,
  type MuseEventContext,
} from "./MuseRuntimeEvents.ts";

const TRUNCATED_STREAM_FAILURE =
  "model failed after 10 attempts: transport error [body-truncated]: response body ended before completion (meta stream, 185 KiB received, 11s) (request id: 03c4868d-cd28-4358-9811-fa96aa5a920f, response: resp_6aad5c39058c49f7af784eb6)";
const TRUNCATED_STREAM_RETRY_REASON =
  "transport error [body-truncated]: response body ended before completion (meta stream, 185 KiB received, 10s) (after 10 provider attempts)";
const TRUNCATED_STREAM_WALL_CLOCK =
  "model call chain exceeded the 12m wall-clock ceiling measured from its first failed attempt: 5 failed attempts (43 provider requests) over 16m12s, all [transport_stream_error:body-truncated]. dominant failure [transport_stream_error]";

function createMockContext(overrides?: Partial<MuseEventContext>): MuseEventContext {
  let counter = 0;
  return {
    threadId: ThreadId.make("thread-1"),
    providerInstanceId: ProviderInstanceId.make("instance-1"),
    createdAt: "2026-03-31T00:00:00.000Z",
    nextEventId: () => EventId.make(`event-${++counter}`),
    itemById: () => undefined,
    streamedText: () => "",
    ...overrides,
  };
}

describe("MuseRuntimeEvents", () => {
  describe("workflow item mapping", () => {
    it("maps workflow item to collab_agent_tool_call and task.started with scriptId title", () => {
      const raw = {
        method: "item/started",
        params: {
          sessionId: "sess-1",
          viewCursor: "cur-1",
          item: {
            itemId: "wf-1",
            kind: "workflow",
            revision: PositiveInt.make(1),
            status: "inProgress",
            scriptId: "deploy-pipeline",
            message: "Deploying to production",
          },
        },
      };
      const decoded = decodeMuseNotification(raw);
      expect(decoded.method).toBe("item/started");

      const events = mapMuseNotification(decoded, createMockContext());
      expect(events).toHaveLength(2);

      const event = events[0];
      expect(event?.type).toBe("item.started");
      if (event?.type === "item.started") {
        expect(event.payload.itemType).toBe("collab_agent_tool_call");
        expect(event.payload.status).toBe("inProgress");
        expect(event.payload.title).toBe("Workflow: deploy-pipeline");
        expect(event.payload.detail).toBe("Deploying to production");
        expect(event.payload.data).toMatchObject({
          kind: "workflow",
          scriptId: "deploy-pipeline",
          message: "Deploying to production",
        });
      }

      const taskEvent = events[1];
      expect(taskEvent?.type).toBe("task.started");
      if (taskEvent?.type === "task.started") {
        expect(taskEvent.payload.taskId).toBe("wf-1");
        expect(taskEvent.payload.taskType).toBe("local_workflow");
        expect(taskEvent.payload.title).toBe("Workflow: deploy-pipeline");
        expect(taskEvent.payload.description).toBe("Deploying to production");
        expect(taskEvent.payload.workflowName).toBe("deploy-pipeline");
      }
    });

    it("maps workflow item fallback titles correctly (entryId, workflowRunId, generic)", () => {
      const ctx = createMockContext();

      // With entryId
      const withEntry = decodeMuseNotification({
        method: "item/updated",
        params: {
          sessionId: "sess-1",
          viewCursor: "cur-2",
          item: {
            itemId: "wf-2",
            kind: "workflow",
            revision: PositiveInt.make(2),
            status: "inProgress",
            entryId: "entry-step-a",
          },
        },
      });
      const events1 = mapMuseNotification(withEntry, ctx);
      expect(events1[0]?.type).toBe("item.updated");
      if (events1[0]?.type === "item.updated") {
        expect(events1[0].payload.title).toBe("Workflow: entry-step-a");
      }

      // With workflowRunId
      const withRunId = decodeMuseNotification({
        method: "item/updated",
        params: {
          sessionId: "sess-1",
          viewCursor: "cur-3",
          item: {
            itemId: "wf-3",
            kind: "workflow",
            revision: PositiveInt.make(3),
            status: "inProgress",
            workflowRunId: "run-999",
          },
        },
      });
      const events2 = mapMuseNotification(withRunId, ctx);
      if (events2[0]?.type === "item.updated") {
        expect(events2[0].payload.title).toBe("Workflow: run-999");
      }

      // Without any ID
      const generic = decodeMuseNotification({
        method: "item/completed",
        params: {
          sessionId: "sess-1",
          viewCursor: "cur-4",
          item: {
            itemId: "wf-4",
            kind: "workflow",
            revision: PositiveInt.make(4),
            status: "completed",
            text: "All workflow steps completed successfully",
          },
        },
      });
      const events3 = mapMuseNotification(generic, ctx);
      expect(events3[0]?.type).toBe("item.completed");
      if (events3[0]?.type === "item.completed") {
        expect(events3[0].payload.itemType).toBe("collab_agent_tool_call");
        expect(events3[0].payload.status).toBe("completed");
        expect(events3[0].payload.title).toBe("Workflow");
        expect(events3[0].payload.detail).toBe("All workflow steps completed successfully");
      }
    });

    it("prefers item.text over item.message for detail, but falls back to message", () => {
      const ctx = createMockContext();

      const withBoth = decodeMuseNotification({
        method: "item/updated",
        params: {
          sessionId: "sess-1",
          viewCursor: "cur-5",
          item: {
            itemId: "wf-5",
            kind: "workflow",
            revision: PositiveInt.make(2),
            status: "inProgress",
            scriptId: "flow",
            text: "Explicit text output",
            message: "Progress update message",
          },
        },
      });
      const events = mapMuseNotification(withBoth, ctx);
      if (events[0]?.type === "item.updated") {
        expect(events[0].payload.detail).toBe("Explicit text output");
      }

      const withOnlyMessage = decodeMuseNotification({
        method: "item/updated",
        params: {
          sessionId: "sess-1",
          viewCursor: "cur-6",
          item: {
            itemId: "wf-6",
            kind: "workflow",
            revision: PositiveInt.make(2),
            status: "inProgress",
            scriptId: "flow",
            message: "Only message available",
          },
        },
      });
      const eventsMsg = mapMuseNotification(withOnlyMessage, ctx);
      if (eventsMsg[0]?.type === "item.updated") {
        expect(eventsMsg[0].payload.detail).toBe("Only message available");
      }
    });
  });

  describe("reminderChild and subagent mapping", () => {
    it("maps reminderChild to collab_agent_tool_call with reminder title", () => {
      const raw = {
        method: "item/started",
        params: {
          sessionId: "sess-1",
          viewCursor: "cur-7",
          item: {
            itemId: "rem-1",
            kind: "reminderChild",
            revision: PositiveInt.make(1),
            status: "inProgress",
            reminderAgentId: "timer-agent",
            childSessionId: "child-sess-1",
            taskId: "task-1",
            generationId: NonNegativeInt.make(1),
          },
        },
      };
      const decoded = decodeMuseNotification(raw);
      const events = mapMuseNotification(decoded, createMockContext());
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.type).toBe("item.started");
      if (event?.type === "item.started") {
        expect(event.payload.itemType).toBe("collab_agent_tool_call");
        expect(event.payload.title).toBe("Reminder: timer-agent");
      }
    });

    it("maps subagent item to collab_agent_tool_call and task.started with role/objective title", () => {
      const raw = {
        method: "item/started",
        params: {
          sessionId: "sess-1",
          viewCursor: "cur-8",
          item: {
            itemId: "sub-1",
            kind: "subagent",
            revision: PositiveInt.make(1),
            status: "inProgress",
            role: "Code Reviewer",
            objective: "Review PR diff",
          },
        },
      };
      const decoded = decodeMuseNotification(raw);
      const events = mapMuseNotification(decoded, createMockContext());
      expect(events).toHaveLength(2);

      const event = events[0];
      if (event?.type === "item.started") {
        expect(event.payload.itemType).toBe("collab_agent_tool_call");
        expect(event.payload.title).toBe("Subagent: Code Reviewer");
      }

      const taskEvent = events[1];
      expect(taskEvent?.type).toBe("task.started");
      if (taskEvent?.type === "task.started") {
        expect(taskEvent.payload.taskId).toBe("sub-1");
        expect(taskEvent.payload.taskType).toBe("subagent");
        expect(taskEvent.payload.title).toBe("Subagent: Code Reviewer");
        expect(taskEvent.payload.role).toBe("Code Reviewer");
      }
    });
  });

  describe("token and context usage mapping", () => {
    it("maps session/tokenUsage even when contextUsedTokens is undefined", () => {
      const raw = {
        method: "session/tokenUsage",
        params: {
          sessionId: "sess-1",
          viewCursor: "cur-9",
          turnId: "turn-1",
          promptTokens: NonNegativeInt.make(1200),
          totalTokens: NonNegativeInt.make(1500),
          usage: {
            inputTokens: NonNegativeInt.make(1000),
            outputTokens: NonNegativeInt.make(300),
            cachedTokens: NonNegativeInt.make(200),
            reasoningTokens: NonNegativeInt.make(0),
          },
          cumulative: {
            promptTokens: NonNegativeInt.make(5000),
            outputTokens: NonNegativeInt.make(1200),
            totalTokens: NonNegativeInt.make(6200),
          },
        },
      };
      const decoded = decodeMuseNotification(raw);
      const events = mapMuseNotification(decoded, createMockContext());
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.type).toBe("thread.token-usage.updated");
      if (event?.type === "thread.token-usage.updated") {
        expect(event.payload.usage.usedTokens).toBe(1500);
        expect(event.payload.usage.maxTokens).toBe(1_000_000);
        expect(event.payload.usage.totalProcessedTokens).toBe(6200);
        expect(event.payload.usage.inputTokens).toBe(5000);
        expect(event.payload.usage.outputTokens).toBe(1200);
        expect(event.payload.usage.lastInputTokens).toBe(1200);
        expect(event.payload.usage.lastOutputTokens).toBe(300);
        expect(event.payload.usage.lastCachedInputTokens).toBe(200);
      }
    });

    it("prefers explicit contextUsedTokens and contextWindowTokens when provided", () => {
      const raw = {
        method: "session/tokenUsage",
        params: {
          sessionId: "sess-1",
          viewCursor: "cur-10",
          turnId: "turn-2",
          promptTokens: NonNegativeInt.make(1000),
          totalTokens: NonNegativeInt.make(1200),
          usage: {
            inputTokens: NonNegativeInt.make(800),
            outputTokens: NonNegativeInt.make(200),
            cachedTokens: NonNegativeInt.make(0),
            reasoningTokens: NonNegativeInt.make(0),
          },
          cumulative: {
            promptTokens: NonNegativeInt.make(2000),
            outputTokens: NonNegativeInt.make(400),
            totalTokens: NonNegativeInt.make(2400),
          },
        },
      };
      const decoded = decodeMuseNotification(raw);
      const events = mapMuseNotification(
        decoded,
        createMockContext({ contextUsedTokens: 1150, contextWindowTokens: 200_000 }),
      );
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event?.type === "thread.token-usage.updated") {
        expect(event.payload.usage.usedTokens).toBe(1150);
        expect(event.payload.usage.maxTokens).toBe(200_000);
      }
    });

    it("maps session/contextUsage correctly", () => {
      const raw = {
        method: "session/contextUsage",
        params: {
          sessionId: "sess-1",
          viewCursor: "cur-11",
          usedTokens: NonNegativeInt.make(3500),
          windowTokens: NonNegativeInt.make(500_000),
        },
      };
      const decoded = decodeMuseNotification(raw);
      const events = mapMuseNotification(decoded, createMockContext());
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.type).toBe("thread.token-usage.updated");
      if (event?.type === "thread.token-usage.updated") {
        expect(event.payload.usage.usedTokens).toBe(3500);
        expect(event.payload.usage.maxTokens).toBe(500_000);
      }
    });
  });

  describe("tool-spawned subagent mapping", () => {
    const spawnArgs = JSON.stringify({
      command_id: "review-001",
      objective: "Review the auth module",
      role: "Reviewer",
      task_name: "auth-review",
    });
    const acceptedOutput = JSON.stringify({
      status: "accepted",
      subagent_id: "sub-child-1",
      agent_path: "main/auth-review/10",
      task_ref: "task/abc#0",
    });

    function toolItem(method: "item/started" | "item/completed", item: Record<string, unknown>) {
      return {
        method,
        params: {
          sessionId: "sess-1",
          viewCursor: "cur-sub",
          item: {
            itemId: "tool-1",
            kind: "toolCall",
            revision: method === "item/started" ? NonNegativeInt.make(1) : NonNegativeInt.make(2),
            status: method === "item/started" ? "inProgress" : "completed",
            turnId: "turn-1",
            ...item,
          },
        },
      };
    }

    it("maps an accepted spawn to task.started with the child identity", () => {
      const decoded = decodeMuseNotification(
        toolItem("item/completed", {
          tool: "subagent_spawn",
          args: spawnArgs,
          visibleOutput: acceptedOutput,
        }),
      );
      const events = mapMuseNotification(decoded, createMockContext());
      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe("item.completed");

      const taskEvent = events[1];
      expect(taskEvent?.type).toBe("task.started");
      if (taskEvent?.type === "task.started") {
        expect(taskEvent.payload.taskId).toBe("sub-child-1");
        expect(taskEvent.payload.taskType).toBe("subagent");
        expect(taskEvent.payload.title).toBe("Subagent: auth-review");
        expect(taskEvent.payload.description).toBe("Review the auth module");
        expect(taskEvent.payload.role).toBe("Reviewer");
        expect(taskEvent.payload.toolUseId).toBe("tool-1");
        expect(taskEvent.payload.agentPath).toBe("main/auth-review/10");
        expect(taskEvent.turnId).toBe("turn-1");
      }
    });

    it("emits no task event for spawn started or rejected spawns", () => {
      const started = mapMuseNotification(
        decodeMuseNotification(
          toolItem("item/started", { tool: "subagent_spawn", args: spawnArgs }),
        ),
        createMockContext(),
      );
      expect(started.map((event) => event.type)).toEqual(["item.started"]);

      const rejected = mapMuseNotification(
        decodeMuseNotification(
          toolItem("item/completed", {
            tool: "subagent_spawn",
            args: spawnArgs,
            visibleOutput: JSON.stringify({ status: "rejected", reason: "busy" }),
          }),
        ),
        createMockContext(),
      );
      expect(rejected.map((event) => event.type)).toEqual(["item.completed"]);
    });

    it("maps wait started to task.updated running", () => {
      const decoded = decodeMuseNotification(
        toolItem("item/started", {
          tool: "subagent_wait",
          args: JSON.stringify({ command_id: "wait-1", subagent_id: "sub-child-1" }),
        }),
      );
      const events = mapMuseNotification(decoded, createMockContext());
      expect(events).toHaveLength(2);
      const taskEvent = events[1];
      expect(taskEvent?.type).toBe("task.updated");
      if (taskEvent?.type === "task.updated") {
        expect(taskEvent.payload.taskId).toBe("sub-child-1");
        expect(taskEvent.payload.taskType).toBe("subagent");
        expect(taskEvent.payload.status).toBe("running");
      }
    });

    it("maps a ready wait result to task.completed with the summary", () => {
      const decoded = decodeMuseNotification(
        toolItem("item/completed", {
          tool: "subagent_wait",
          args: JSON.stringify({ command_id: "wait-1", subagent_id: "sub-child-1" }),
          visibleOutput: JSON.stringify({
            status: "ready",
            subagent_id: "sub-child-1",
            summary: "Found 3 issues",
          }),
        }),
      );
      const events = mapMuseNotification(decoded, createMockContext());
      expect(events).toHaveLength(2);
      const taskEvent = events[1];
      expect(taskEvent?.type).toBe("task.completed");
      if (taskEvent?.type === "task.completed") {
        expect(taskEvent.payload.taskId).toBe("sub-child-1");
        expect(taskEvent.payload.status).toBe("completed");
        expect(taskEvent.payload.summary).toBe("Found 3 issues");
      }
    });

    it("keeps the child running when a wait times out", () => {
      const decoded = decodeMuseNotification(
        toolItem("item/completed", {
          tool: "subagent_wait",
          args: JSON.stringify({ command_id: "wait-1", subagent_id: "sub-child-1" }),
          visibleOutput: JSON.stringify({ status: "timeout", subagent_id: "sub-child-1" }),
        }),
      );
      const events = mapMuseNotification(decoded, createMockContext());
      expect(events).toHaveLength(2);
      const taskEvent = events[1];
      expect(taskEvent?.type).toBe("task.updated");
      if (taskEvent?.type === "task.updated") {
        expect(taskEvent.payload.taskId).toBe("sub-child-1");
        expect(taskEvent.payload.status).toBe("running");
      }
    });

    it("maps read_result envelopes to terminal task states", () => {
      const readResult = (output: Record<string, unknown>) =>
        mapMuseNotification(
          decodeMuseNotification(
            toolItem("item/completed", {
              tool: "subagent_read_result",
              args: JSON.stringify({ subagent_id: "sub-child-1" }),
              visibleOutput: JSON.stringify(output),
            }),
          ),
          createMockContext(),
        );

      const completed = readResult({ status: "ready", summary: "done" })[1];
      expect(completed?.type).toBe("task.completed");
      if (completed?.type === "task.completed") {
        expect(completed.payload.status).toBe("completed");
      }

      const failed = readResult({ status: "failed", summary: "crashed" })[1];
      expect(failed?.type).toBe("task.completed");
      if (failed?.type === "task.completed") {
        expect(failed.payload.status).toBe("failed");
      }
    });
  });

  describe("transport truncation signature", () => {
    it("classifies truncated response streams across failure shapes with one signature", () => {
      const failure = museTransportTruncationSignature(TRUNCATED_STREAM_FAILURE);
      const retry = museTransportTruncationSignature(TRUNCATED_STREAM_RETRY_REASON);
      const wallClock = museTransportTruncationSignature(TRUNCATED_STREAM_WALL_CLOCK);
      expect(failure).toBeDefined();
      expect(retry).toBe(failure);
      expect(wallClock).toBe(failure);
    });

    it("ignores recoverable failures that must keep retrying untouched", () => {
      expect(museTransportTruncationSignature("rate limited, backing off")).toBeUndefined();
      expect(museTransportTruncationSignature("authentication expired")).toBeUndefined();
      expect(museTransportTruncationSignature("")).toBeUndefined();
      expect(museTransportTruncationSignature(undefined)).toBeUndefined();
    });
  });

  describe("turn/completed mapping", () => {
    it("drops interim incomplete turn completions so outer turn stays active", () => {
      const raw = {
        method: "turn/completed",
        params: {
          sessionId: "sess-1",
          viewCursor: "cur-100",
          turnId: "turn-interim",
          terminal: "failed",
          reason: "incomplete",
        },
      };
      const decoded = decodeMuseNotification(raw);
      const events = mapMuseNotification(decoded, createMockContext());
      expect(events).toEqual([]);
    });

    it("maps normal completed and failed turns", () => {
      const rawCompleted = {
        method: "turn/completed",
        params: {
          sessionId: "sess-1",
          viewCursor: "cur-101",
          turnId: "turn-done",
          terminal: "completed",
        },
      };
      const eventsCompleted = mapMuseNotification(
        decodeMuseNotification(rawCompleted),
        createMockContext(),
      );
      expect(eventsCompleted).toHaveLength(1);
      expect(eventsCompleted[0]?.type).toBe("turn.completed");
      if (eventsCompleted[0]?.type === "turn.completed") {
        expect(eventsCompleted[0].payload.state).toBe("completed");
      }

      const rawFailed = {
        method: "turn/completed",
        params: {
          sessionId: "sess-1",
          viewCursor: "cur-102",
          turnId: "turn-err",
          terminal: "failed",
          reason: "error",
        },
      };
      const eventsFailed = mapMuseNotification(
        decodeMuseNotification(rawFailed),
        createMockContext(),
      );
      expect(eventsFailed).toHaveLength(1);
      expect(eventsFailed[0]?.type).toBe("turn.completed");
      if (eventsFailed[0]?.type === "turn.completed") {
        expect(eventsFailed[0].payload.state).toBe("failed");
        expect(eventsFailed[0].payload.stopReason).toBe("error");
      }
    });
  });
});
