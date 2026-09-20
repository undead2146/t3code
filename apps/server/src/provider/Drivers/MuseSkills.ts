import { spawnMspConnection } from "@muse-code/sdk";
import {
  TrimmedNonEmptyString,
  type MuseSettings,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";

import { spawnAndCollect } from "../providerSnapshot.ts";

class MuseSkillsProbeError extends Schema.TaggedError<MuseSkillsProbeError>()(
  "MuseSkillsProbeError",
  { exitCode: Schema.Number },
) {
  override get message(): string {
    return `Muse skill discovery exited with code ${this.exitCode}.`;
  }
}

const SkillFiles = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      name: TrimmedNonEmptyString,
      path: TrimmedNonEmptyString,
      scope: TrimmedNonEmptyString,
      activation: Schema.String,
    }),
  ),
});
export const MuseSkillCatalog = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      selector: TrimmedNonEmptyString,
      description: Schema.String,
      displayName: Schema.String,
      source: TrimmedNonEmptyString,
      pluginId: Schema.optional(Schema.String),
    }),
  ),
});
const SessionResult = Schema.Struct({ session: Schema.Struct({ sessionId: Schema.String }) });
const decodeSkillFiles = Schema.decodeUnknownEffect(Schema.fromJsonString(SkillFiles));
const decodeSessionResult = Schema.decodeUnknownEffect(SessionResult);
const decodeSkillCatalog = Schema.decodeUnknownEffect(MuseSkillCatalog);

/** The native command catalog owns invocability; CLI metadata supplies source paths. */
export const discoverMuseSkills = Effect.fn("discoverMuseSkills")(function* (
  settings: Pick<MuseSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const path = yield* Path.Path;
  const command = settings.binaryPath || "muse";
  const args = [
    "skills",
    "list",
    "--enabled-only",
    "--workspace",
    cwd,
    "--trust-workspace",
    "--json",
  ];
  const result = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    const output = yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd,
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
    if (output.code !== 0)
      return yield* new MuseSkillsProbeError({
        exitCode: output.code,
      });
    const files = yield* decodeSkillFiles(output.stdout);
    const handshake = yield* Effect.acquireRelease(
      Effect.try(() =>
        spawnMspConnection({
          command,
          args: ["serve", "--no-session-log", "--trust-workspace"],
          cwd,
          env: environment,
          shutdownTimeoutMs: 1_000,
        }),
      ),
      (host) => Effect.tryPromise(() => host.close()).pipe(Effect.ignore),
    );
    const host = yield* Effect.tryPromise(() =>
      handshake.initialize({ clientInfo: { name: "t3_code", version: "0.0.0" } }),
    );
    const session = yield* Effect.tryPromise(() =>
      host.connection.command("session/start", {
        workspaceRoot: cwd,
        approvalMode: "denyUnmatched",
      }),
    ).pipe(Effect.flatMap(decodeSessionResult));
    const catalog = yield* Effect.tryPromise(() =>
      host.connection.request("skill/list", { sessionId: session.session.sessionId }),
    ).pipe(Effect.flatMap(decodeSkillCatalog));
    const skills: ServerProviderSkill[] = [];
    for (const native of catalog.skills) {
      const bareName =
        native.pluginId && native.selector.startsWith(`${native.pluginId}:`)
          ? native.selector.slice(native.pluginId.length + 1)
          : native.selector;
      const id =
        native.source === "bundled"
          ? `bundled:${bareName}`
          : native.source === "plugin" && native.pluginId
            ? `plugin:${native.pluginId}:${bareName}`
            : native.selector;
      const file = files.skills.find(
        (entry) =>
          entry.scope === native.source && (entry.id === id || entry.name === native.selector),
      );
      if (!file) continue;
      const home = environment.HOME ?? environment.USERPROFILE;
      const sourcePath =
        file.path.startsWith("$HOME/") && home
          ? path.join(home, file.path.slice(6))
          : /^[a-z][a-z\d+.-]*:\/\//i.test(file.path) || path.isAbsolute(file.path)
            ? file.path
            : path.resolve(cwd, file.path);
      skills.push({
        name: native.selector,
        path: sourcePath,
        scope: native.source,
        enabled: true,
        userInvocable: true,
        ...(native.displayName.trim() ? { displayName: native.displayName.trim() } : {}),
        ...(native.description.trim() ? { description: native.description.trim() } : {}),
        ...(file.activation === "user-invocable-only" ? { userInvocationOnly: true } : {}),
      });
    }
    return skills;
  }).pipe(Effect.timeout("10 seconds"), Effect.scoped);
  return result;
});

export function museSkillMentions(prompt: string) {
  return collectComposerInlineTokens(`${prompt} `).filter((token) => token.type === "skill");
}

export interface MuseSkillDispatch {
  /** Catalog selector to invoke. */
  readonly selector: string;
  /** Prompt with the dispatched `$token` removed; folded into the skill `arguments`. */
  readonly argumentsText: string;
}

/**
 * Split `prompt` around the last `$skill` mention that names a live catalog
 * selector. Returns `undefined` when there is nothing to dispatch, in which
 * case the prompt should go out as a plain text part. Mentions that do not
 * match a catalog selector stay literal: a `$HOME` in prose must not become
 * an invocation, and an unknown selector would fail the turn with the typed
 * `skillNotFound` request error.
 *
 * Only the last resolving mention dispatches. Verified against the host, a
 * turn carrying a skill part rejects every text part (`a skill input part is
 * combinable only with image parts`) and rejects a second skill part (`at
 * most one skill input part per submission`), so user text on either side of
 * the token cannot travel as its own part and is folded into `arguments`
 * instead. Earlier mentions stay literal inside `arguments`, where the model
 * still reads them.
 */
export function planMuseSkillDispatch(
  prompt: string,
  selectors: ReadonlySet<string>,
): MuseSkillDispatch | undefined {
  const last = museSkillMentions(prompt).findLast((token) => selectors.has(token.value));
  if (!last) {
    return undefined;
  }
  const leading = prompt.slice(0, last.start).trimEnd();
  const trailing = prompt.slice(last.end).trim();
  return {
    selector: last.value,
    argumentsText: leading ? (trailing ? `${leading} ${trailing}` : leading) : trailing,
  };
}
