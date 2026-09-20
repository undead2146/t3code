import { describe, expect, it } from "vite-plus/test";

import { planMuseSkillDispatch } from "./MuseSkills.ts";

const SELECTORS = new Set(["html-communication", "implement", "plugin:pack:ship", "review"]);

describe("planMuseSkillDispatch", () => {
  it("leaves a prompt without a known skill untouched", () => {
    expect(planMuseSkillDispatch("fix the build", SELECTORS)).toBeUndefined();
    // Not a catalog selector, so it stays prose rather than becoming an invocation.
    expect(planMuseSkillDispatch("echo $HOME then $unknown", SELECTORS)).toBeUndefined();
  });

  it("dispatches a mid-prompt mention and folds surrounding text into arguments", () => {
    expect(planMuseSkillDispatch("ok, now $implement all the tickets", SELECTORS)).toEqual({
      selector: "implement",
      argumentsText: "ok, now all the tickets",
    });
  });

  it("dispatches a mention that opens the prompt with trailing arguments", () => {
    expect(planMuseSkillDispatch("$review\nfocus on auth", SELECTORS)).toEqual({
      selector: "review",
      argumentsText: "focus on auth",
    });
  });

  it("dispatches a lone mention with empty arguments", () => {
    expect(planMuseSkillDispatch("$review", SELECTORS)).toEqual({
      selector: "review",
      argumentsText: "",
    });
  });

  it("dispatches the last resolving mention and keeps earlier ones literal", () => {
    expect(planMuseSkillDispatch("$review the diff, then $implement the fixes", SELECTORS)).toEqual(
      {
        selector: "implement",
        argumentsText: "$review the diff, then the fixes",
      },
    );
  });

  it("skips an unknown trailing mention and dispatches the last known one", () => {
    expect(planMuseSkillDispatch("$implement this, then $unknown that", SELECTORS)).toEqual({
      selector: "implement",
      argumentsText: "this, then $unknown that",
    });
  });

  it("dispatches plugin-qualified selectors", () => {
    expect(planMuseSkillDispatch("please $plugin:pack:ship it", SELECTORS)).toEqual({
      selector: "plugin:pack:ship",
      argumentsText: "please it",
    });
  });

  it("ignores a dollar token glued to other text", () => {
    expect(planMuseSkillDispatch("cost is 5$implement", SELECTORS)).toBeUndefined();
  });

  it("ignores currency amounts", () => {
    const withCurrency = new Set([...SELECTORS, "20"]);
    expect(planMuseSkillDispatch("pay $20 tomorrow", withCurrency)).toBeUndefined();
  });
});
