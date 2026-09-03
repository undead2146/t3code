import { describe, expect, it } from "@effect/vitest";
import {
  ANTIGRAVITY_CHECKPOINT_BUFFER_TOKENS,
  ANTIGRAVITY_SKILLS_TOKENS,
  ANTIGRAVITY_SYSTEM_PROMPT_TOKENS,
  ANTIGRAVITY_SYSTEM_TOOLS_TOKENS,
  syncTokenTrackerFromDb,
  type TokenTracker,
} from "./AntigravityAdapter.ts";

describe("Antigravity token tracking", () => {
  it("has the correct base tokens matching Antigravity CLI", () => {
    expect(ANTIGRAVITY_SYSTEM_PROMPT_TOKENS).toBe(7900);
    expect(ANTIGRAVITY_SYSTEM_TOOLS_TOKENS).toBe(13800);
    expect(ANTIGRAVITY_SKILLS_TOKENS).toBe(2900);
    expect(ANTIGRAVITY_CHECKPOINT_BUFFER_TOKENS).toBe(3200);
  });

  it("syncs active conversation steps from SQLite database if present", () => {
    const tracker: TokenTracker = {
      userMessagesChars: 0,
      agentResponsesChars: 0,
      toolCallsChars: 0,
      subagentsChars: 0,
      systemPromptTokens: ANTIGRAVITY_SYSTEM_PROMPT_TOKENS,
      systemToolsTokens: ANTIGRAVITY_SYSTEM_TOOLS_TOKENS,
      skillsTokens: ANTIGRAVITY_SKILLS_TOKENS,
      checkpointBufferTokens: ANTIGRAVITY_CHECKPOINT_BUFFER_TOKENS,
      totalLifetimeProcessedTokens: 0,
      toolUses: 0,
    };

    syncTokenTrackerFromDb({
      nativeSessionId: "268f47ba-c1ef-43bc-b18a-1a80d404d6f6",
      tokenTracker: tracker,
    });

    expect(tracker.userMessagesChars).toBeGreaterThan(0);
    expect(tracker.agentResponsesChars).toBeGreaterThan(0);
    expect(tracker.toolCallsChars).toBeGreaterThan(0);
    // Tool calls should be realistic, not inflated to 250k
    const toolTokens = Math.round(tracker.toolCallsChars / 4.2);
    expect(toolTokens).toBeLessThan(100_000);
  });

  it("tracks delta increments for tool calls to prevent repeated buffer inflation", () => {
    const tracker: TokenTracker = {
      userMessagesChars: 0,
      agentResponsesChars: 0,
      toolCallsChars: 0,
      subagentsChars: 0,
      systemPromptTokens: ANTIGRAVITY_SYSTEM_PROMPT_TOKENS,
      systemToolsTokens: ANTIGRAVITY_SYSTEM_TOOLS_TOKENS,
      skillsTokens: ANTIGRAVITY_SKILLS_TOKENS,
      checkpointBufferTokens: ANTIGRAVITY_CHECKPOINT_BUFFER_TOKENS,
      totalLifetimeProcessedTokens: 0,
      toolUses: 0,
      toolCallCharsById: new Map(),
    };

    // Simulate streaming tool output for the same toolCallId
    const toolCallId = "call_12345";
    const chunks = [1000, 2500, 5000, 10000]; // progressively larger output buffer

    for (const size of chunks) {
      const prevChars = tracker.toolCallCharsById!.get(toolCallId) ?? 0;
      const delta = Math.max(0, size - prevChars);
      if (delta > 0) {
        tracker.toolCallCharsById!.set(toolCallId, size);
        tracker.toolCallsChars += delta;
      }
    }

    // toolCallsChars should equal the final buffer size (10000), not the sum of all chunks (18500)
    expect(tracker.toolCallsChars).toBe(10000);
  });
});
