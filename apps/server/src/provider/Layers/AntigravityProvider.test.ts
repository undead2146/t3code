import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AntigravitySettings } from "@t3tools/contracts";

import {
  buildInitialAntigravityProviderSnapshot,
  checkAntigravityProviderStatus,
  parseAntigravityModelsOutput,
} from "./AntigravityProvider.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

describe("buildInitialAntigravityProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAntigravityProviderSnapshot(
        decodeAntigravitySettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAntigravityProviderSnapshot(
        decodeAntigravitySettings({}),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Antigravity");
    }),
  );
});

describe("parseAntigravityModelsOutput", () => {
  it("parses model output lines correctly", () => {
    const raw = `⠋ Fetching available models...
gemini-3.7-flash-high     Gemini 3.7 Flash (High)
gemini-3.1-pro-high       Gemini 3.1 Pro (High)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)`;

    const models = parseAntigravityModelsOutput(raw);
    expect(models.length).toBe(3);
    expect(models[0]?.slug).toBe("gemini-3.7-flash-high");
    expect(models[0]?.name).toBe("Gemini 3.7 Flash (High)");
    expect(models[0]?.isDefault).toBe(true);
    expect(models[1]?.slug).toBe("gemini-3.1-pro-high");
    expect(models[2]?.slug).toBe("claude-sonnet-4-6");
  });
});

it.layer(NodeServices.layer)("checkAntigravityProviderStatus", (it) => {
  it.effect("reports missing binary when path is invalid", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAntigravityProviderStatus(
        decodeAntigravitySettings({
          enabled: true,
          binaryPath: "/nonexistent/agy/binary",
        }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not found|Failed to execute/);
    }),
  );

  it.effect("reports ready when agy mock is executable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-test-" });
          const agyPath = path.join(dir, "agy");
          yield* fs.writeFileString(
            agyPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then echo "agy 1.2.0"; exit 0; fi',
              'if [ "$1" = "models" ]; then echo "gemini-3.7-flash-high Gemini 3.7 Flash (High)"; exit 0; fi',
              "exit 0",
            ].join("\n"),
          );
          yield* fs.chmod(agyPath, 0o755);

          return yield* checkAntigravityProviderStatus(
            decodeAntigravitySettings({ enabled: true, binaryPath: agyPath }),
          );
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.some((m) => m.slug === "gemini-3.7-flash-high")).toBe(true);
    }),
  );
});
