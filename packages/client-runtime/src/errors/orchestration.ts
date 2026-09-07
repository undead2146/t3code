import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "deleted"
  );
}

export function isBootstrapThreadAlreadyExists(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return (
      error.message.includes("already exists and cannot be created twice") ||
      (error.message.includes("thread.create") && error.message.includes("already exists"))
    );
  }
  return false;
}

export function shouldRotateBootstrapThreadId(error: unknown): boolean {
  return wasBootstrapThreadDeleted(error) || isBootstrapThreadAlreadyExists(error);
}
