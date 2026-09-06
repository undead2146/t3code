import { describe, expect, it } from "vite-plus/test";
import { parseBtwCommand } from "./threadBtw.ts";

describe("parseBtwCommand", () => {
  it("returns null for non-btw commands", () => {
    expect(parseBtwCommand("hello world")).toBeNull();
    expect(parseBtwCommand("/plan do something")).toBeNull();
    expect(parseBtwCommand("btw what is this")).toBeNull();
  });

  it("parses bare /btw command with empty query", () => {
    expect(parseBtwCommand("/btw")).toEqual({});
    expect(parseBtwCommand("/BTW")).toEqual({});
    expect(parseBtwCommand("  /btw   ")).toEqual({});
  });

  it("parses /btw with query text", () => {
    expect(parseBtwCommand("/btw what port was chosen?")).toEqual({
      query: "what port was chosen?",
    });
    expect(parseBtwCommand("/btw   explain this function in detail   ")).toEqual({
      query: "explain this function in detail",
    });
    expect(parseBtwCommand("/BTW\nmulti-line\nquestion")).toEqual({
      query: "multi-line\nquestion",
    });
  });
});
