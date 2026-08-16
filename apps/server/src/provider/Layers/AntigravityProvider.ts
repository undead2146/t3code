import {
  type AntigravitySettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities, buildSelectOptionDescriptor } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const ANTIGRAVITY_PRESENTATION = {
  displayName: "Antigravity",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;

const ANTIGRAVITY_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "effort",
      label: "Reasoning Effort",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "xhigh", label: "Extra High" },
        { value: "max", label: "Max" },
      ],
    }),
    buildSelectOptionDescriptor({
      id: "mode",
      label: "Execution Mode",
      options: [
        { value: "accept-edits", label: "Accept Edits", isDefault: true },
        { value: "plan", label: "Plan Mode" },
      ],
    }),
  ],
});

const DEFAULT_ANTIGRAVITY_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gemini-3.7-flash-high",
    name: "Gemini 3.7 Flash (High)",
    isDefault: true,
    isCustom: false,
    capabilities: ANTIGRAVITY_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.7-flash-medium",
    name: "Gemini 3.7 Flash (Medium)",
    isCustom: false,
    capabilities: ANTIGRAVITY_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.7-flash-low",
    name: "Gemini 3.7 Flash (Low)",
    isCustom: false,
    capabilities: ANTIGRAVITY_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.1-pro-high",
    name: "Gemini 3.1 Pro (High)",
    isCustom: false,
    capabilities: ANTIGRAVITY_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.1-pro-low",
    name: "Gemini 3.1 Pro (Low)",
    isCustom: false,
    capabilities: ANTIGRAVITY_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    isCustom: false,
    capabilities: ANTIGRAVITY_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    isCustom: false,
    capabilities: ANTIGRAVITY_MODEL_CAPABILITIES,
  },
  {
    slug: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    isCustom: false,
    capabilities: ANTIGRAVITY_MODEL_CAPABILITIES,
  },
];

const VERSION_PROBE_TIMEOUT_MS = 5_000;
const MODELS_PROBE_TIMEOUT_MS = 10_000;

export function parseAntigravityModelsOutput(output: string): ReadonlyArray<ServerProviderModel> {
  const lines = output.split("\n");
  const models: Array<ServerProviderModel> = [];
  const seenSlugs = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("⠋") || trimmed.startsWith("⠙") || trimmed.startsWith("⠹") || trimmed.startsWith("Fetching")) {
      continue;
    }

    // Split on multiple whitespace
    const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s+(.+)$/);
    if (match && match[1]) {
      const slug = match[1].trim();
      const name = (match[2] || slug).trim();
      if (!seenSlugs.has(slug)) {
        seenSlugs.add(slug);
        models.push({
          slug,
          name,
          isDefault: slug === "gemini-3.7-flash-high",
          isCustom: false,
          capabilities: ANTIGRAVITY_MODEL_CAPABILITIES,
        });
      }
    }
  }

  return models.length > 0 ? models : DEFAULT_ANTIGRAVITY_MODELS;
}

export function buildInitialAntigravityProviderSnapshot(
  settings: AntigravitySettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      DEFAULT_ANTIGRAVITY_MODELS,
      settings.customModels ?? [],
      ANTIGRAVITY_MODEL_CAPABILITIES,
    );

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Antigravity CLI is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: ANTIGRAVITY_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Antigravity CLI availability...",
      },
    });
  });
}

export function checkAntigravityProviderStatus(
  settings: AntigravitySettings,
  environment?: NodeJS.ProcessEnv,
): Effect.Effect<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const resolvedEnv = environment ?? process.env;
    const binaryPath = settings.binaryPath || "agy";

    if (!settings.enabled) {
      return yield* buildInitialAntigravityProviderSnapshot(settings);
    }

    // 1. Probe version
    const versionSpawn = yield* resolveSpawnCommand(binaryPath, ["--version"], {
      env: resolvedEnv,
    });
    const versionResult = yield* spawnAndCollect(versionSpawn, {
      env: resolvedEnv,
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
    }).pipe(Effect.exit);

    if (versionResult._tag === "Failure") {
      const isMissing = isCommandMissingCause(versionResult.cause);
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: true,
        checkedAt,
        models: DEFAULT_ANTIGRAVITY_MODELS,
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isMissing
            ? `Antigravity CLI (${binaryPath}) was not found in PATH.`
            : `Failed to execute Antigravity CLI (${binaryPath}).`,
        },
      });
    }

    const { stdout, exitCode } = versionResult.value;
    const parsedVersion = parseGenericCliVersion(stdout) ?? (exitCode === 0 ? "installed" : null);

    // 2. Probe models via `agy models`
    let dynamicModels = DEFAULT_ANTIGRAVITY_MODELS;
    const modelsSpawn = yield* resolveSpawnCommand(binaryPath, ["models"], {
      env: resolvedEnv,
    });
    const modelsResult = yield* spawnAndCollect(modelsSpawn, {
      env: resolvedEnv,
      timeoutMs: MODELS_PROBE_TIMEOUT_MS,
    }).pipe(Effect.exit);

    if (modelsResult._tag === "Success" && modelsResult.value.exitCode === 0) {
      const parsed = parseAntigravityModelsOutput(modelsResult.value.stdout);
      if (parsed.length > 0) {
        dynamicModels = parsed;
      }
    }

    const finalModels = providerModelsFromSettings(
      dynamicModels,
      settings.customModels ?? [],
      ANTIGRAVITY_MODEL_CAPABILITIES,
    );

    return buildServerProvider({
      presentation: ANTIGRAVITY_PRESENTATION,
      enabled: true,
      checkedAt,
      models: finalModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: exitCode === 0 ? "ready" : "warning",
        auth: { status: "authenticated" },
        message: exitCode === 0 ? undefined : "Antigravity CLI returned non-zero version check.",
      },
    });
  });
}

export function enrichAntigravitySnapshot(input: {
  readonly snapshot: ServerProviderDraft;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot?: (snapshot: ServerProviderDraft) => Effect.Effect<void>;
  readonly httpClient?: HttpClient.HttpClient;
}): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    return input.snapshot;
  });
}
