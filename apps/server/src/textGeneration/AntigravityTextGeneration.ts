/**
 * AntigravityTextGeneration – Text generation layer using the Antigravity CLI (agy).
 *
 * Implements the TextGeneration service contract by delegating to the `agy` CLI
 * (`agy -p`) with structured JSON output.
 *
 * @module AntigravityTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type AntigravitySettings, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

const ANTIGRAVITY_TIMEOUT_MS = 180_000;

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const makeAntigravityTextGeneration = Effect.fn("makeAntigravityTextGeneration")(function* (
  antigravitySettings: AntigravitySettings,
  environment?: NodeJS.ProcessEnv,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolvedEnvironment = environment ?? process.env;

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("agy", operation, cause, "Failed to collect process output"),
      ),
    );

  const encodeJsonForOperation = (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle",
    value: unknown,
    detail: string,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail,
            cause,
          }),
      ),
    );

  const runAntigravityJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const jsonSchemaObj = toJsonSchemaObject(outputSchemaJson);
      const jsonSchemaStr = yield* encodeJsonForOperation(
        operation,
        jsonSchemaObj,
        "Failed to encode output JSON schema.",
      );

      const effortOption = getModelSelectionStringOptionValue(modelSelection.options, "effort");

      const runAgyCommand = Effect.fn("runAntigravityJson.runAgyCommand")(function* () {
        const binaryPath = antigravitySettings.binaryPath || "agy";
        const args = [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          jsonSchemaStr,
          "--dangerously-skip-permissions",
        ];

        if (modelSelection.model && modelSelection.model.trim().length > 0) {
          args.push("--model", modelSelection.model.trim());
        }
        if (effortOption) {
          args.push("--effort", effortOption);
        }

        const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, {
          env: resolvedEnvironment,
        });

        const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: resolvedEnvironment,
          cwd,
          shell: spawnCommand.shell,
          stdin: {
            stream: Stream.encodeText(Stream.make(prompt)),
          },
        });

        const child = yield* commandSpawner
          .spawn(command)
          .pipe(
            Effect.mapError((cause) =>
              normalizeCliError("agy", operation, cause, "Failed to spawn Antigravity CLI process"),
            ),
          );

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            readStreamAsString(operation, child.stdout),
            readStreamAsString(operation, child.stderr),
            child.exitCode.pipe(
              Effect.mapError((cause) =>
                normalizeCliError(
                  "agy",
                  operation,
                  cause,
                  "Failed to read Antigravity CLI exit code",
                ),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );

        if (exitCode !== 0) {
          const stderrDetail = stderr.trim();
          const stdoutDetail = stdout.trim();
          const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
          return yield* new TextGenerationError({
            operation,
            detail:
              detail.length > 0
                ? `Antigravity CLI command failed: ${detail}`
                : `Antigravity CLI command failed with code ${exitCode}.`,
          });
        }

        return stdout;
      });

      const rawStdout = yield* runAgyCommand().pipe(
        Effect.scoped,
        Effect.timeoutOption(ANTIGRAVITY_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Antigravity CLI request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );

      // Parse JSON output from agy
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawStdout);
        // Handle possible wrapping envelope { "structured_output": ... } or { "response": ... }
        if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
          const record = parsedJson as Record<string, unknown>;
          if ("structured_output" in record) {
            parsedJson = record.structured_output;
          } else if ("response" in record && typeof record.response === "object") {
            parsedJson = record.response;
          }
        }
      } catch (err) {
        return yield* new TextGenerationError({
          operation,
          detail: "Antigravity CLI returned non-JSON output.",
          cause: err,
        });
      }

      const decodeOutput = Schema.decodeEffect(outputSchemaJson);
      return yield* decodeOutput(parsedJson).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            new TextGenerationError({
              operation,
              detail: "Antigravity CLI output failed schema validation.",
              cause,
            }),
        }),
      );
    });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const result = yield* runAntigravityJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(result.subject),
        body: result.body?.trim() ? result.body.trim() : "",
        ...("branch" in result && typeof result.branch === "string"
          ? { branch: sanitizeFeatureBranchName(result.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const result = yield* runAntigravityJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizePrTitle(result.title),
        body: result.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const result = yield* runAntigravityJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        branch: sanitizeBranchFragment(result.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const result = yield* runAntigravityJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizeThreadTitle(result.title),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
