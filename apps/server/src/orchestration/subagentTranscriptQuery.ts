// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  OrchestrationGetSubagentTranscriptError,
  type OrchestrationGetSubagentTranscriptInput,
  type OrchestrationGetSubagentTranscriptResult,
  type SubagentTranscriptItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

function findTranscriptPath(conversationId: string): string | null {
  const home = NodeOS.homedir();
  const candidates = [
    NodePath.join(
      home,
      ".gemini",
      "antigravity-cli",
      "brain",
      conversationId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    ),
    NodePath.join(
      home,
      ".gemini",
      "antigravity-backup",
      "brain",
      conversationId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    ),
    NodePath.join(
      home,
      ".gemini",
      "antigravity-ide",
      "brain",
      conversationId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    ),
    NodePath.join(
      home,
      ".gemini",
      "antigravity",
      "brain",
      conversationId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    ),
  ];

  for (const candidate of candidates) {
    try {
      if (NodeFS.existsSync(candidate)) {
        return candidate;
      }
    } catch {}
  }
  return null;
}

function parseToolSummary(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "run_command" && typeof args.CommandLine === "string") {
    return args.CommandLine;
  }
  if (typeof args.toolAction === "string" && args.toolAction.length > 0) {
    return args.toolAction;
  }
  if (typeof args.toolSummary === "string" && args.toolSummary.length > 0) {
    return args.toolSummary;
  }
  if (typeof args.Prompt === "string") {
    return args.Prompt.slice(0, 100);
  }
  if (typeof args.AbsolutePath === "string") {
    return `${toolName}: ${args.AbsolutePath.split(/[/\\]/).pop()}`;
  }
  if (typeof args.TargetFile === "string") {
    return `${toolName}: ${args.TargetFile.split(/[/\\]/).pop()}`;
  }
  return toolName;
}

function parseToolDetail(toolName: string, args: Record<string, unknown>): string | null {
  if (typeof args.CommandLine === "string") {
    return args.CommandLine;
  }
  if (typeof args.Prompt === "string") {
    return args.Prompt;
  }
  if (typeof args.TargetFile === "string") {
    return args.TargetFile;
  }
  if (typeof args.AbsolutePath === "string") {
    return args.AbsolutePath;
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return null;
  }
}

export const readSubagentTranscript = Effect.fn("orchestration.readSubagentTranscript")(function* (
  input: OrchestrationGetSubagentTranscriptInput,
): Effect.Effect<
  OrchestrationGetSubagentTranscriptResult,
  OrchestrationGetSubagentTranscriptError
> {
  const conversationId = input.conversationId.trim();
  if (
    !conversationId ||
    conversationId.includes("..") ||
    conversationId.includes("/") ||
    conversationId.includes("\\")
  ) {
    return yield* Effect.fail(
      new OrchestrationGetSubagentTranscriptError({
        reason: "invalid-id",
        conversationId,
      }),
    );
  }

  const transcriptPath = findTranscriptPath(conversationId);
  if (!transcriptPath) {
    return yield* Effect.fail(
      new OrchestrationGetSubagentTranscriptError({
        reason: "not-found",
        conversationId,
      }),
    );
  }

  const rawContent = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(transcriptPath, "utf8"),
    catch: (cause) =>
      new OrchestrationGetSubagentTranscriptError({
        reason: "read-failed",
        conversationId,
        cause,
      }),
  });

  const lines = rawContent
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const allItems: Array<SubagentTranscriptItem> = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as {
        step_index?: number;
        type?: string;
        content?: string;
        created_at?: string;
        tool_calls?: Array<{
          name?: string;
          args?: Record<string, unknown>;
        }>;
      };

      const stepIdx = Number(obj.step_index) || allItems.length + 1;
      const timestamp = obj.created_at ?? null;

      if (obj.type === "USER_INPUT") {
        allItems.push({
          stepIndex: stepIdx,
          type: "USER_INPUT",
          toolName: null,
          summary: "Instruction",
          detail: obj.content ?? null,
          output: null,
          timestamp,
        });
      } else if (obj.type === "PLANNER_RESPONSE") {
        if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
          for (const tool of obj.tool_calls) {
            const toolName = tool.name || "tool";
            const args = (tool.args || {}) as Record<string, unknown>;
            allItems.push({
              stepIndex: stepIdx,
              type: "TOOL_CALL",
              toolName,
              summary: parseToolSummary(toolName, args),
              detail: parseToolDetail(toolName, args),
              output: null,
              timestamp,
            });
          }
        } else if (typeof obj.content === "string" && obj.content.trim().length > 0) {
          allItems.push({
            stepIndex: stepIdx,
            type: "PLANNER_RESPONSE",
            toolName: null,
            summary: obj.content.slice(0, 120),
            detail: obj.content,
            output: null,
            timestamp,
          });
        }
      } else if (obj.type === "GENERIC") {
        const lastItem = allItems[allItems.length - 1];
        if (lastItem && lastItem.type === "TOOL_CALL" && !lastItem.output && obj.content) {
          lastItem.output = obj.content;
        }
      }
    } catch {}
  }

  const totalSteps = allItems.length;
  const limit = input.limit && input.limit > 0 ? input.limit : undefined;
  const items = limit !== undefined && allItems.length > limit ? allItems.slice(-limit) : allItems;

  return {
    conversationId,
    items,
    totalSteps,
    transcriptPath,
  };
});
