import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/**
 * Resolve the Claude config directory the CLI would use: the instance's
 * `homePath` (exported as `CLAUDE_CONFIG_DIR`), then an inherited
 * `CLAUDE_CONFIG_DIR`, then Claude's default `~/.claude`. Empty must not
 * fall back to bare `$HOME` — that leftover from the old HOME override
 * produced a different continuation group than an explicit `~/.claude`.
 */
export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(NodeOS.homedir(), ".claude"));
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath"> & Partial<Pick<ClaudeSettings, "apiBaseUrl" | "apiKey">>,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath?.trim() ?? "";
  const apiBaseUrl = config.apiBaseUrl?.trim() ?? "";
  const apiKey = config.apiKey?.trim() ?? "";

  if (homePath.length === 0 && apiBaseUrl.length === 0 && apiKey.length === 0) {
    return resolvedBaseEnv;
  }

  let nextEnv: NodeJS.ProcessEnv = { ...resolvedBaseEnv };
  if (homePath.length > 0) {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    nextEnv.CLAUDE_CONFIG_DIR = resolvedHomePath;
  }
  if (apiBaseUrl.length > 0) {
    nextEnv.ANTHROPIC_BASE_URL = apiBaseUrl;
  }
  if (apiKey.length > 0) {
    nextEnv.ANTHROPIC_API_KEY = apiKey;
    nextEnv.ANTHROPIC_AUTH_TOKEN = apiKey;
  }
  return nextEnv;
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath"> &
      Partial<Pick<ClaudeSettings, "apiBaseUrl">>,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    const endpointFragment = config.apiBaseUrl?.trim() ? `\0${config.apiBaseUrl.trim()}` : "";
    return `${config.binaryPath}\0${resolvedHomePath}${endpointFragment}\0${cwd ?? ""}`;
  },
);

/**
 * Describe the spawned CLI's environment separately from the login command so
 * paths remain literal on every shell, including relative inherited values.
 */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
