import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { ModelCapabilities } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  cliProbeMissingMessage,
  diagnoseCliCommand,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "./snapshotProbe.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const OPENCODE_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [{ id: "medium", label: "Medium", isDefault: true }],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
      currentValue: "build",
    },
  ],
});

describe("providerModelsFromSettings", () => {
  it("applies the provided capabilities to custom models", () => {
    const models = providerModelsFromSettings(
      [],
      ["openai/gpt-5"],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "openai/gpt-5",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
    ]);
  });

  it("keeps an entry's own name and capabilities over the driver default", () => {
    const capabilities = createModelCapabilities({
      optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
    });
    const models = providerModelsFromSettings(
      [],
      ["bare", { slug: "named", name: "Named", capabilities }],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "bare",
        name: "bare",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
      { slug: "named", name: "Named", isCustom: true, capabilities },
    ]);
  });

  it("renames a built-in model when a named entry uses its slug", () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const models = providerModelsFromSettings(
      [
        {
          slug: "gpt-5.5",
          name: "GPT-5.5",
          shortName: "5.5",
          isCustom: false,
          capabilities,
        },
      ],
      [{ slug: "gpt-5.5", name: "Team GPT" }],
      capabilities,
    );

    expect(models).toEqual([{ slug: "gpt-5.5", name: "Team GPT", isCustom: false, capabilities }]);
  });

  it("preserves a custom slug that collides with a provider alias", () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const models = providerModelsFromSettings(
      [
        {
          slug: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          isCustom: false,
          capabilities,
        },
      ],
      [" opus "],
      capabilities,
    );

    expect(models.map((model) => model.slug)).toEqual(["claude-opus-4-8", "opus"]);
    expect(models[1]?.isCustom).toBe(true);
  });
});

describe("parseGenericCliVersion", () => {
  it("parses a bare version", () => {
    expect(parseGenericCliVersion("1.14.19")).toBe("1.14.19");
  });

  it("parses a v-prefixed version", () => {
    expect(parseGenericCliVersion("opencode v2.0.3")).toBe("2.0.3");
    expect(parseGenericCliVersion("v22.19.0")).toBe("22.19.0");
  });

  it("parses a version embedded in other output", () => {
    expect(parseGenericCliVersion("codex-cli 0.53.0 (build abc)")).toBe("0.53.0");
  });

  it("returns null when no version is present", () => {
    expect(parseGenericCliVersion("no version here")).toBeNull();
  });

  it("ignores versions glued to other word characters", () => {
    expect(parseGenericCliVersion("build2.0.3artifact")).toBeNull();
  });
});

describe("ProviderCommandNotFoundError", () => {
  it("classifies normalized platform failures without parsing messages", () => {
    expect(
      isCommandMissingCause(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "arbitrary host detail",
        }),
      ),
    ).toBe(true);
    expect(isCommandMissingCause(new Error("spawn provider ENOENT"))).toBe(false);
  });

  it.effect("retains safe failed-command diagnostics without process output", () => {
    const stderr = "'codex' is not recognized: secret-token-value";
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9009)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.encodeText(Stream.make(stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    return Effect.gen(function* () {
      const error = yield* spawnAndCollect(
        "C:\\tools\\codex.cmd",
        ChildProcess.make("codex", ["--version"]),
      ).pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.flip,
      );

      if (error._tag !== "ProviderCommandNotFoundError") {
        throw new Error(`Unexpected error: ${error._tag}`);
      }

      expect(error.binaryPath).toBe("C:\\tools\\codex.cmd");
      expect(error.exitCode).toBe(9009);
      expect(error.stdoutLength).toBe(0);
      expect(error.stderrLength).toBe(stderr.length);
      expect(error.message).toBe(
        "Provider command C:\\tools\\codex.cmd was not found (exit code 9009).",
      );
      expect(isCommandMissingCause(error)).toBe(true);
      expect(error).not.toHaveProperty("stdout");
      expect(error).not.toHaveProperty("stderr");
      expect(error.message).not.toContain("secret-token-value");
    });
  });
});

describe("cliProbeMissingMessage", () => {
  it("keeps the driver's message when the binary is simply absent", () => {
    expect(
      cliProbeMissingMessage({
        missingMessage: "Kiro CLI (`kiro-cli`) is not installed or not on PATH.",
        binaryLabel: "Kiro CLI (`kiro-cli`)",
        reinstallHint: "Reinstall the Kiro CLI, then refresh the provider.",
        diagnosis: { kind: "missing" },
      }),
    ).toBe("Kiro CLI (`kiro-cli`) is not installed or not on PATH.");
  });

  it("names the link and its absent target for a dangling symlink", () => {
    expect(
      cliProbeMissingMessage({
        missingMessage: "Cursor CLI command `cursor-agent` was not found.",
        binaryLabel: "Cursor CLI command `cursor-agent`",
        reinstallHint: "Reinstall the Cursor CLI, then refresh the provider.",
        docsUrl: "https://cursor.com/docs/cli/installation",
        diagnosis: {
          kind: "dangling-symlink",
          linkPath: "/usr/local/bin/cursor-agent",
          target: "/home/ubuntu/.local/bin/cursor-agent",
        },
      }),
    ).toBe(
      "Cursor CLI command `cursor-agent` is broken: `/usr/local/bin/cursor-agent` is a symlink to " +
        "`/home/ubuntu/.local/bin/cursor-agent`, which no longer exists. " +
        "Reinstall the Cursor CLI, then refresh the provider. " +
        "See https://cursor.com/docs/cli/installation.",
    );
  });
});

it.layer(NodeServices.layer)("diagnoseCliCommand", (it) => {
  it.effect("reports a bare command missing from every PATH entry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-cli-diagnosis-" });
      expect(yield* diagnoseCliCommand("t3-definitely-not-a-cli", { PATH: dir })).toEqual({
        kind: "missing",
      });
      expect(yield* diagnoseCliCommand("   ", { PATH: dir })).toEqual({ kind: "missing" });
    }),
  );

  it.effect("reports an absolute path missing from disk", () =>
    Effect.gen(function* () {
      expect(
        yield* diagnoseCliCommand("/definitely/not/installed/t3-cursor-agent", {
          PATH: "/nonexistent",
        }),
      ).toEqual({ kind: "missing" });
    }),
  );

  it.effect("finds a regular file on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-cli-diagnosis-" });
      const binary = path.join(dir, "t3-fake-cli");
      yield* fs.writeFileString(binary, "#!/bin/sh\nexit 0\n");
      expect(yield* diagnoseCliCommand("t3-fake-cli", { PATH: dir })).toEqual({
        kind: "found",
        path: binary,
      });
    }),
  );

  // Symlink fixtures need elevated privileges on Windows.
  it.effect.skipIf(windowsHost)("names a dangling symlink and its absent target", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-cli-diagnosis-" });
      const linkPath = path.join(dir, "t3-dangling-cli");
      const target = path.join(dir, "deleted-target", "t3-dangling-cli");
      yield* fs.symlink(target, linkPath);
      expect(yield* diagnoseCliCommand("t3-dangling-cli", { PATH: dir })).toEqual({
        kind: "dangling-symlink",
        linkPath,
        target,
      });
      expect(yield* diagnoseCliCommand(linkPath, { PATH: "" })).toEqual({
        kind: "dangling-symlink",
        linkPath,
        target,
      });
    }),
  );

  it.effect.skipIf(windowsHost)("prefers a working later PATH entry like execvp does", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const first = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-cli-diagnosis-a-" });
      const second = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-cli-diagnosis-b-" });
      yield* fs.symlink(path.join(first, "gone"), path.join(first, "t3-shadowed-cli"));
      const binary = path.join(second, "t3-shadowed-cli");
      yield* fs.writeFileString(binary, "#!/bin/sh\nexit 0\n");
      expect(
        yield* diagnoseCliCommand("t3-shadowed-cli", {
          PATH: `${first}${path.sep === "\\" ? ";" : ":"}${second}`,
        }),
      ).toEqual({ kind: "found", path: binary });
    }),
  );
});
