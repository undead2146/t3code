import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { BtwOverlayHUD } from "./BtwOverlayHUD";

describe("BtwOverlayHUD", () => {
  it("renders loading state with query", () => {
    const markup = renderToStaticMarkup(
      <BtwOverlayHUD
        state={{
          query: "what port was chosen in vite.config.ts?",
          status: "loading",
        }}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain("/btw");
    expect(markup).toContain("what port was chosen in vite.config.ts?");
    expect(markup).toContain("Consulting Antigravity with active conversation model...");
    expect(markup).toContain("Dismiss");
  });

  it("renders error state with message", () => {
    const markup = renderToStaticMarkup(
      <BtwOverlayHUD
        state={{
          query: "how does auth work?",
          status: "error",
          error: "Antigravity process exited unexpectedly",
        }}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain("how does auth work?");
    expect(markup).toContain("Antigravity process exited unexpectedly");
    expect(markup).toContain("Dismiss");
  });

  it("renders done state with text and action buttons", () => {
    const onInsert = vi.fn();
    const markup = renderToStaticMarkup(
      <BtwOverlayHUD
        state={{
          query: "where is the config?",
          status: "done",
          text: "The config is in `vite.config.ts` on port 3000.",
        }}
        onDismiss={() => {}}
        onInsertToComposer={onInsert}
      />,
    );

    expect(markup).toContain("where is the config?");
    expect(markup).toContain("The config is in");
    expect(markup).toContain("Copy text");
    expect(markup).toContain("Insert into draft");
    expect(markup).toContain("Dismiss");
  });
});
