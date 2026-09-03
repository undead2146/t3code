// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics tryCatchInEffectGen:off
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

  const providerRoots = [
    NodePath.join(home, ".t3", "userdata", "providers", "antigravity"),
    NodePath.join(process.cwd(), ".t3", "userdata", "providers", "antigravity"),
  ];
  for (const root of providerRoots) {
    try {
      if (NodeFS.existsSync(root)) {
        const hashes = NodeFS.readdirSync(root);
        for (const h of hashes) {
          candidates.push(
            NodePath.join(
              root,
              h,
              "antigravity-acp",
              "brain",
              conversationId,
              ".system_generated",
              "logs",
              "transcript.jsonl",
            ),
            NodePath.join(
              root,
              h,
              "antigravity-acp",
              "brain",
              conversationId,
              ".system_generated",
              "logs",
              "transcript_full.jsonl",
            ),
          );
        }
      }
    } catch {}
  }

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
) {
  const conversationId = input.conversationId.trim();
  if (
    !conversationId ||
    conversationId.includes("..") ||
    conversationId.includes("/") ||
    conversationId.includes("\\")
  ) {
    return yield* new OrchestrationGetSubagentTranscriptError({
      reason: "invalid-id",
      conversationId,
    });
  }

  const transcriptPath = findTranscriptPath(conversationId);
  if (!transcriptPath) {
    const logItems = extractTranscriptItemsFromLogs(conversationId);
    if (logItems && logItems.length > 0) {
      const usage = computeSubagentUsageFromLogs(conversationId);
      return {
        conversationId,
        items: logItems,
        totalSteps: logItems.length,
        ...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
        ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(usage?.toolUses !== undefined ? { toolUses: usage.toolUses } : {}),
        transcriptPath: "provider-logs",
      };
    }
    return yield* new OrchestrationGetSubagentTranscriptError({
      reason: "not-found",
      conversationId,
    });
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
  interface MutableTranscriptItem {
    stepIndex: number;
    type: string;
    toolName: string | null;
    summary: string;
    detail: string | null;
    output: string | null;
    timestamp: string | null;
  }
  const allItems: Array<MutableTranscriptItem> = [];

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

export function extractTranscriptItemsFromLogs(
  conversationId: string,
): Array<SubagentTranscriptItem> {
  try {
    const candidateDirs = [
      NodePath.join(NodeOS.homedir(), ".t3", "userdata", "logs", "provider"),
      NodePath.join(process.cwd(), ".t3", "userdata", "logs", "provider"),
    ];
    const items: Array<SubagentTranscriptItem> = [];
    let stepIndex = 1;

    for (const dir of candidateDirs) {
      if (!NodeFS.existsSync(dir)) continue;
      const files = NodeFS.readdirSync(dir);
      for (const f of files) {
        if (!f.startsWith("events.") || !f.endsWith(".log")) continue;
        const filePath = NodePath.join(dir, f);
        const content = NodeFS.readFileSync(filePath, "utf8");
        if (!content.includes(conversationId)) continue;
        const lines = content.split("\n");
        for (const line of lines) {
          if (!line.includes(conversationId)) continue;
          const idx = line.indexOf("{");
          if (idx === -1) continue;
          try {
            const obj = JSON.parse(line.slice(idx));
            const update = obj?.raw?.payload?.update || obj?.payload;
            if (update?.sessionUpdate === "tool_call_update") {
              const rawOutput = update.rawOutput;
              let detail: string | null = null;
              let output: string | null = null;
              if (typeof rawOutput === "string") {
                detail = rawOutput;
              } else if (rawOutput && typeof rawOutput === "object") {
                detail = rawOutput.commandLine || JSON.stringify(rawOutput);
                if (rawOutput.combinedOutput !== undefined) {
                  output = String(rawOutput.combinedOutput);
                }
              }
              const toolName = detail?.split(/\s+/)[0] || "tool";
              items.push({
                stepIndex: stepIndex++,
                type: "TOOL_CALL",
                toolName,
                summary: detail || "Tool execution",
                detail,
                output,
                timestamp: obj.timestamp || null,
              });
            }
          } catch {}
        }
      }
    }
    return items;
  } catch {
    return [];
  }
}

export function computeSubagentUsageFromLogs(conversationId: string):
  | {
      readonly totalTokens: number;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly toolUses?: number;
    }
  | undefined {
  try {
    const candidateDirs = [
      NodePath.join(NodeOS.homedir(), ".t3", "userdata", "logs", "provider"),
      NodePath.join(process.cwd(), ".t3", "userdata", "logs", "provider"),
    ];
    let toolUses = 0;
    const inputChars = 200;
    let outputChars = 0;
    let found = false;

    for (const dir of candidateDirs) {
      if (!NodeFS.existsSync(dir)) continue;
      const files = NodeFS.readdirSync(dir);
      for (const f of files) {
        if (!f.startsWith("events.") || !f.endsWith(".log")) continue;
        const filePath = NodePath.join(dir, f);
        const content = NodeFS.readFileSync(filePath, "utf8");
        if (!content.includes(conversationId)) continue;
        found = true;
        const lines = content.split("\n");
        for (const line of lines) {
          if (!line.includes(conversationId)) continue;
          const idx = line.indexOf("{");
          if (idx === -1) continue;
          try {
            const obj = JSON.parse(line.slice(idx));
            outputChars += line.length;
            const update = obj?.raw?.payload?.update || obj?.payload;
            if (update?.sessionUpdate === "tool_call_update") {
              toolUses += 1;
            }
          } catch {}
        }
      }
    }
    if (!found) return undefined;
    const inputTokens = Math.max(1, Math.round(inputChars / 3.8));
    const outputTokens = Math.max(1, Math.round(outputChars / 3.8));
    return {
      totalTokens: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      toolUses,
    };
  } catch {
    return undefined;
  }
}

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
      return computeSubagentUsageFromLogs(conversationId);
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
            ...(lastTool?.name
              ? { lastToolName: lastTool.name, summary: `Running tool: ${lastTool.name}` }
              : {}),
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
