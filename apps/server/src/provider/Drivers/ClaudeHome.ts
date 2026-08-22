import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
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
  function* (config: Pick<ClaudeSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath"> &
      Partial<Pick<ClaudeSettings, "apiBaseUrl">>,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    const endpointFragment = config.apiBaseUrl?.trim() ? `\0${config.apiBaseUrl.trim()}` : "";
    return `${config.binaryPath}\0${resolvedHomePath}${endpointFragment}\0${cwd ?? ""}`;
  },
);
