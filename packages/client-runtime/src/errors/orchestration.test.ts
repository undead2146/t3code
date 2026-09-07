import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isBootstrapThreadAlreadyExists,
  shouldRotateBootstrapThreadId,
  wasBootstrapThreadDeleted,
} from "./orchestration.ts";

describe("wasBootstrapThreadDeleted", () => {
  it("accepts only a confirmed deleted bootstrap thread", () => {
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(true);
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({ message: "Failed to create worktree." }),
      ),
    ).toBe(false);
    expect(wasBootstrapThreadDeleted(new Error("connection lost"))).toBe(false);
  });
});

describe("isBootstrapThreadAlreadyExists", () => {
  it("detects thread already exists invariant errors", () => {
    expect(
      isBootstrapThreadAlreadyExists(
        new OrchestrationDispatchCommandError({
          message:
            "Orchestration command invariant failed (thread.create): Thread '9ebeeb11-cc51-48f6-ad86-5bf85033a4ce' already exists and cannot be created twice.",
        }),
      ),
    ).toBe(true);
    expect(
      isBootstrapThreadAlreadyExists(
        new Error("Thread 'abc' already exists and cannot be created twice."),
      ),
    ).toBe(true);
    expect(
      isBootstrapThreadAlreadyExists(
        new OrchestrationDispatchCommandError({ message: "Failed to create worktree." }),
      ),
    ).toBe(false);
    expect(isBootstrapThreadAlreadyExists(null)).toBe(false);
  });
});

describe("shouldRotateBootstrapThreadId", () => {
  it("returns true for deleted bootstrap thread or thread collision", () => {
    expect(
      shouldRotateBootstrapThreadId(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(true);
    expect(
      shouldRotateBootstrapThreadId(
        new OrchestrationDispatchCommandError({
          message: "Thread '123' already exists and cannot be created twice.",
        }),
      ),
    ).toBe(true);
    expect(
      shouldRotateBootstrapThreadId(
        new OrchestrationDispatchCommandError({ message: "Network error" }),
      ),
    ).toBe(false);
  });
});
