import type {
  CustomModelSetting,
  ProviderDriverKind,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ServerProviderModel,
  ServerProviderState,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { readCustomModelEntries } from "@t3tools/shared/model";
import { isWindowsCommandNotFound } from "../processRunner.ts";
import { createProviderVersionAdvisory } from "./providerMaintenance.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

export const DEFAULT_TIMEOUT_MS = 4_000;
// Auth status checks involve disk/network lookups and can be slow on first run (especially Windows)
export const AUTH_PROBE_TIMEOUT_MS = 10_000;

export const BTW_SLASH_COMMAND = {
  name: "btw",
  description: "Ask a quick side question without adding to conversation history",
  input: { hint: "question" },
} satisfies ServerProviderSlashCommand;

export const COMPACT_SLASH_COMMAND = {
  name: "compact",
  description: "Summarize the conversation and reduce context usage",
} satisfies ServerProviderSlashCommand;

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export class ProviderCommandNotFoundError extends Schema.TaggedError<ProviderCommandNotFoundError>()(
  "ProviderCommandNotFoundError",
  {
    binaryPath: Schema.String,
    exitCode: Schema.Number,
    stdoutLength: Schema.Number,
    stderrLength: Schema.Number,
  },
) {
  override get message(): string {
    return `Provider command ${this.binaryPath} was not found (exit code ${this.exitCode}).`;
  }
}

const isProviderCommandNotFoundError = Schema.is(ProviderCommandNotFoundError);

export interface ProviderProbeResult {
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
  readonly usageLimits?: ServerProviderUsageLimits;
}

export interface ServerProviderPresentation {
  readonly displayName: string;
  readonly badgeLabel?: string;
  readonly showInteractionModeToggle?: boolean;
  readonly reportsContextWindow?: boolean;
  readonly requiresNewThreadForModelChange?: boolean;
  readonly supportsConversationRollback?: boolean;
  readonly runtimeModeDescriptions?: ServerProvider["runtimeModeDescriptions"];
}

export type ServerProviderDraft = Omit<ServerProvider, "instanceId" | "driver">;

export function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isCommandMissingCause(error: unknown): boolean {
  if (isProviderCommandNotFoundError(error)) return true;
  return error instanceof PlatformError.PlatformError && error.reason._tag === "NotFound";
}

const isNotFoundError = (error: unknown): boolean =>
  error instanceof PlatformError.PlatformError && error.reason._tag === "NotFound";

/**
 * Why a provider CLI failed to spawn with a missing-command error.
 *
 * A bare `spawn ENOENT` cannot tell "never installed" apart from "was
 * installed, then deleted" — and on posix it cannot even tell a missing
 * binary apart from a dangling symlink on PATH (both surface as ENOENT).
 * Probes run this diagnosis in their missing-command branch so the snapshot
 * message names the actual filesystem state instead of guessing.
 */
export type CliCommandDiagnosis =
  | { readonly kind: "missing" }
  | { readonly kind: "dangling-symlink"; readonly linkPath: string; readonly target: string }
  | { readonly kind: "found"; readonly path: string }
  | { readonly kind: "unknown" };

const diagnoseCliCandidate = (
  candidatePath: string,
): Effect.Effect<CliCommandDiagnosis, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // `readLink` succeeds only for symlinks; the following `stat` (which
    // follows links) then separates a healthy link from a dangling one.
    const linkTarget = yield* fs.readLink(candidatePath).pipe(Effect.option);
    const statResult = yield* fs.stat(candidatePath).pipe(Effect.result);
    if (Result.isSuccess(statResult)) {
      return { kind: "found", path: candidatePath } as const;
    }
    const statError = statResult.failure;
    if (Option.isSome(linkTarget) && isNotFoundError(statError)) {
      return {
        kind: "dangling-symlink",
        linkPath: candidatePath,
        target: linkTarget.value,
      } as const;
    }
    if (Option.isNone(linkTarget) && isNotFoundError(statError)) {
      return { kind: "missing" } as const;
    }
    return { kind: "unknown" } as const;
  });

const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".com", ".ps1"] as const;

/**
 * Resolve `command` the way the OS spawner does and report what the
 * filesystem says. Bare names are searched across `environment.PATH` in
 * order; anything containing a separator is examined directly.
 *
 * The scan mimics `execvp` selection: the first `found` candidate wins even
 * when an earlier directory holds a dangling link, because the spawner skips
 * past ENOENT entries. Total: every unexpected failure collapses to
 * `missing` (nothing matched) or `unknown` so probes never fail to report.
 */
export const diagnoseCliCommand = (
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<CliCommandDiagnosis, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const trimmed = command.trim();
    if (trimmed.length === 0) {
      return { kind: "missing" } as const;
    }
    const isPathLike = trimmed.includes("/") || trimmed.includes("\\") || path.isAbsolute(trimmed);
    // Effect's `Path` service exposes no `delimiter`; the separator implies it (`\` only on Windows).
    const isWindowsPaths = path.sep === "\\";
    const pathDelimiter = isWindowsPaths ? ";" : ":";
    const directories = isPathLike
      ? []
      : (environment.PATH ?? process.env.PATH ?? "")
          .split(pathDelimiter)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
    const candidates = isPathLike
      ? [trimmed]
      : directories.map((directory) => path.join(directory, trimmed));
    const withWindowsFallbacks =
      isWindowsPaths && !isPathLike
        ? candidates.flatMap((candidate) => [
            candidate,
            ...WINDOWS_EXECUTABLE_EXTENSIONS.map((extension) => `${candidate}${extension}`),
          ])
        : candidates;
    let sawUnknown = false;
    let firstDangling: Extract<CliCommandDiagnosis, { kind: "dangling-symlink" }> | undefined;
    for (const candidate of withWindowsFallbacks) {
      const diagnosis = yield* diagnoseCliCandidate(candidate);
      if (diagnosis.kind === "found") {
        return diagnosis;
      }
      if (diagnosis.kind === "dangling-symlink") {
        firstDangling ??= diagnosis;
      } else if (diagnosis.kind === "unknown") {
        sawUnknown = true;
      }
    }
    if (firstDangling !== undefined) {
      return firstDangling;
    }
    return sawUnknown ? ({ kind: "unknown" } as const) : ({ kind: "missing" } as const);
  });

export interface CliProbeMissingMessageInput {
  /** The driver's existing "not installed" sentence, kept when nothing on PATH explains the failure. */
  readonly missingMessage: string;
  /** Short CLI label, e.g. "Kiro CLI (`kiro-cli`)". */
  readonly binaryLabel: string;
  /** Remediation, e.g. "Reinstall the Kiro CLI, then refresh the provider." */
  readonly reinstallHint: string;
  readonly docsUrl?: string | undefined;
  readonly diagnosis: CliCommandDiagnosis;
}

/**
 * Render the probe message for a missing-command failure. A dangling
 * symlink gets its own sentence naming the link and its absent target —
 * the plain "not found / check PATH" text actively misleads there, since
 * the command *is* on PATH and only its target is gone.
 */
export function cliProbeMissingMessage(input: CliProbeMissingMessageInput): string {
  if (input.diagnosis.kind === "dangling-symlink") {
    const docs = input.docsUrl ? ` See ${input.docsUrl}.` : "";
    return (
      `${input.binaryLabel} is broken: \`${input.diagnosis.linkPath}\` is a symlink to ` +
      `\`${input.diagnosis.target}\`, which no longer exists. ${input.reinstallHint}${docs}`
    );
  }
  return input.missingMessage;
}

export const spawnAndCollect = (binaryPath: string, command: ChildProcess.Command) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    const result: CommandResult = { stdout, stderr, code: exitCode };
    if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
      return yield* new ProviderCommandNotFoundError({
        binaryPath,
        exitCode,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      });
    }
    return result;
  }).pipe(Effect.scoped);

/**
 * Return the first semantic version found in CLI output, or null. Accepts a
 * leading "v" (for example `opencode v2.0.3`).
 */
export function parseGenericCliVersion(output: string): string | null {
  // "opencode v2.0.3"-style output: the optional "v" has to be consumed first,
  // since "v2" itself contains no word boundary.
  const match = output.match(/\bv?(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

/**
 * Append the user's custom models after the built-ins. A custom entry that
 * declares its own capabilities keeps them; a bare slug gets the driver's
 * default set. Slugs that collide with a built-in are dropped.
 */
export function providerModelsFromSettings(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<CustomModelSetting>,
  customModelCapabilities: ModelCapabilities,
): ReadonlyArray<ServerProviderModel> {
  const resolvedBuiltInModels = [...builtInModels];
  const seen = new Set(resolvedBuiltInModels.map((model) => model.slug));
  const customEntries: ServerProviderModel[] = [];

  for (const entry of readCustomModelEntries(customModels)) {
    if (seen.has(entry.slug)) {
      continue;
    }
    seen.add(entry.slug);
    customEntries.push({
      slug: entry.slug,
      name: entry.name,
      isCustom: true,
      capabilities: entry.capabilities ?? customModelCapabilities,
    });
  }

  return [...resolvedBuiltInModels, ...customEntries];
}

export function buildSelectOptionDescriptor(input: {
  readonly id: string;
  readonly label: string;
  readonly options:
    | ReadonlyArray<{
        value: string;
        label: string;
        description?: string | undefined;
        isDefault?: boolean | undefined;
      }>
    | undefined;
  readonly description?: string;
  readonly promptInjectedValues?: ReadonlyArray<string>;
}) {
  const options = (input.options ?? []).map((option) => ({
    id: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    ...(option.isDefault ? { isDefault: true } : {}),
  }));
  const currentValue = options.find((option) => option.isDefault)?.id;
  return {
    id: input.id,
    label: input.label,
    type: "select" as const,
    options,
    ...(currentValue ? { currentValue } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.promptInjectedValues && input.promptInjectedValues.length > 0
      ? { promptInjectedValues: [...input.promptInjectedValues] }
      : {}),
  };
}

export function buildBooleanOptionDescriptor(input: {
  readonly id: string;
  readonly label: string;
  readonly currentValue?: boolean;
  readonly description?: string;
}) {
  return {
    id: input.id,
    label: input.label,
    type: "boolean" as const,
    ...(input.description ? { description: input.description } : {}),
    ...(typeof input.currentValue === "boolean" ? { currentValue: input.currentValue } : {}),
  };
}

export function buildServerProvider(input: {
  driver?: ProviderDriverKind;
  presentation: ServerProviderPresentation;
  enabled: boolean;
  checkedAt: string;
  models: ReadonlyArray<ServerProviderModel>;
  slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  skills?: ReadonlyArray<ServerProviderSkill>;
  probe: ProviderProbeResult;
}): ServerProviderDraft {
  const versionAdvisory = input.driver
    ? createProviderVersionAdvisory({
        driver: input.driver,
        currentVersion: input.probe.version,
        checkedAt: input.checkedAt,
      })
    : undefined;
  return {
    displayName: input.presentation.displayName,
    ...(input.presentation.runtimeModeDescriptions
      ? { runtimeModeDescriptions: input.presentation.runtimeModeDescriptions }
      : {}),
    ...(typeof input.presentation.supportsConversationRollback === "boolean"
      ? { supportsConversationRollback: input.presentation.supportsConversationRollback }
      : {}),
    ...(input.presentation.badgeLabel ? { badgeLabel: input.presentation.badgeLabel } : {}),
    ...(typeof input.presentation.showInteractionModeToggle === "boolean"
      ? { showInteractionModeToggle: input.presentation.showInteractionModeToggle }
      : {}),
    ...(typeof input.presentation.reportsContextWindow === "boolean"
      ? { reportsContextWindow: input.presentation.reportsContextWindow }
      : {}),
    ...(typeof input.presentation.requiresNewThreadForModelChange === "boolean"
      ? { requiresNewThreadForModelChange: input.presentation.requiresNewThreadForModelChange }
      : {}),
    enabled: input.enabled,
    installed: input.probe.installed,
    version: input.probe.version,
    status: input.enabled ? input.probe.status : "disabled",
    auth: input.probe.auth,
    checkedAt: input.checkedAt,
    ...(input.probe.message ? { message: input.probe.message } : {}),
    models: input.models,
    slashCommands: [...(input.slashCommands ?? [])],
    skills: [...(input.skills ?? [])],
    ...(input.probe.usageLimits ? { usageLimits: input.probe.usageLimits } : {}),
    ...(versionAdvisory ? { versionAdvisory } : {}),
  };
}

export const collectStreamAsString = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  options?: { readonly maxBytes?: number | undefined },
): Effect.Effect<string, E> =>
  collectUint8StreamText({ stream, ...options }).pipe(Effect.map((collected) => collected.text));
