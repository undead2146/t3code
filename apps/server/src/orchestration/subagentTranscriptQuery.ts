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

export function findTranscriptPath(conversationId: string): string | null {
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
  const usage = computeSubagentUsage(conversationId, transcriptPath);

  return {
    conversationId,
    items,
    totalSteps,
    ...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
    ...(usage?.toolUses !== undefined ? { toolUses: usage.toolUses } : {}),
    transcriptPath,
  };
});

export function computeSubagentUsage(
  conversationId: string,
  customPath?: string,
):
  | {
      readonly totalTokens: number;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly toolUses?: number;
    }
  | undefined {
  try {
    const transcriptPath = customPath || findTranscriptPath(conversationId);
    if (!transcriptPath || !NodeFS.existsSync(transcriptPath)) {
      return undefined;
    }
    const rawContent = NodeFS.readFileSync(transcriptPath, "utf8");
    const lines = rawContent
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    let toolUses = 0;
    let inputChars = 0;
    let outputChars = 0;

    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as {
          type?: string;
          content?: string;
          thinking?: string;
          tool_calls?: Array<unknown>;
        };
        if (obj.type === "USER_INPUT") {
          inputChars += (obj.content || "").length;
        } else if (obj.type === "PLANNER_RESPONSE") {
          if (Array.isArray(obj.tool_calls)) {
            toolUses += obj.tool_calls.length;
            outputChars += JSON.stringify(obj.tool_calls).length;
          }
          if (obj.content) {
            outputChars += obj.content.length;
          }
          if (obj.thinking) {
            outputChars += obj.thinking.length;
          }
        } else if (obj.type === "GENERIC" || obj.type === "SYSTEM_MESSAGE") {
          inputChars += (obj.content || "").length;
        }
      } catch {}
    }

    const inputTokens = Math.round(inputChars / 3.8);
    const outputTokens = Math.round(outputChars / 3.8);
    const totalTokens = inputTokens + outputTokens;

    return {
      totalTokens: Math.max(1, totalTokens),
      inputTokens,
      outputTokens,
      toolUses,
    };
  } catch {
    return undefined;
  }
}

export function extractConversationIdsFromText(text: unknown): ReadonlyArray<string> {
  if (typeof text !== "string") {
    if (typeof text === "object" && text !== null) {
      try {
        text = JSON.stringify(text);
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }
  const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const matches = (text as string).match(uuidRegex);
  return matches ? [...new Set(matches.map((m) => m.toLowerCase()))] : [];
}

export function checkSubagentTranscriptStatus(
  conversationId: string,
  customPath?: string,
): {
  readonly status: "completed" | "failed" | "running";
  readonly summary?: string;
  readonly lastToolName?: string;
} {
  try {
    const transcriptPath = customPath || findTranscriptPath(conversationId);
    if (!transcriptPath || !NodeFS.existsSync(transcriptPath)) {
      return { status: "running" };
    }
    const rawContent = NodeFS.readFileSync(transcriptPath, "utf8");
    const lines = rawContent
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return { status: "running" };
    }

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]!) as {
          type?: string;
          status?: string;
          content?: string;
          tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>;
        };
        if (obj.type === "PLANNER_RESPONSE") {
          if (!Array.isArray(obj.tool_calls) || obj.tool_calls.length === 0) {
            return {
              status: "completed",
              summary: obj.content ? obj.content.slice(0, 150) : "Subagent completed",
            };
          }
          const lastTool = obj.tool_calls[obj.tool_calls.length - 1];
          return {
            status: "running",
            lastToolName: lastTool?.name,
            summary: lastTool?.name ? `Running tool: ${lastTool.name}` : undefined,
          };
        }
        if (obj.type === "ERROR" || obj.status === "ERROR" || obj.status === "FAILED") {
          return {
            status: "failed",
            summary: obj.content ? obj.content.slice(0, 150) : "Subagent failed",
          };
        }
      } catch {}
    }
    return { status: "running" };
  } catch {
    return { status: "running" };
  }
}
