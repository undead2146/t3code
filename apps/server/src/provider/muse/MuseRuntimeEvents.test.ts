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
  type MuseEventContext,
} from "./MuseRuntimeEvents.ts";

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
});
