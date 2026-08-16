import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AntigravitySettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { makeAntigravityTextGeneration } from "./AntigravityTextGeneration.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

const AntigravityTextGenTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-antigravity-textgen-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(AntigravityTextGenTestLayer)("makeAntigravityTextGeneration", (it) => {
  it.effect("generates branch name using mock agy executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-textgen-" });
        const agyPath = path.join(dir, "agy");

        yield* fs.writeFileString(
          agyPath,
          [
            "#!/bin/sh",
            'printf \'{"branchName": "feature/antigravity-integration"}\\n\'',
            "exit 0",
          ].join("\n"),
        );
        yield* fs.chmod(agyPath, 0o755);

        const settings = decodeAntigravitySettings({
          enabled: true,
          binaryPath: agyPath,
        });

        const textGen = yield* makeAntigravityTextGeneration(settings);
        const result = yield* textGen.generateBranchName({
          cwd: dir,
          prompt: "Implement Antigravity CLI",
          modelSelection: createModelSelection({
            instanceId: ProviderInstanceId.make("antigravity"),
            model: "gemini-3.7-flash-high",
          }),
        });

        expect(result.branchName).toBe("feature/antigravity-integration");
      }),
    ),
  );

  it.effect("generates commit message using mock agy executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-commit-" });
        const agyPath = path.join(dir, "agy");

        yield* fs.writeFileString(
          agyPath,
          [
            "#!/bin/sh",
            'printf \'{"subject": "feat: add antigravity provider", "body": "implement agy harness"}\\n\'',
            "exit 0",
          ].join("\n"),
        );
        yield* fs.chmod(agyPath, 0o755);

        const settings = decodeAntigravitySettings({
          enabled: true,
          binaryPath: agyPath,
        });

        const textGen = yield* makeAntigravityTextGeneration(settings);
        const result = yield* textGen.generateCommitMessage({
          cwd: dir,
          diff: "+ added antigravity",
          modelSelection: createModelSelection({
            instanceId: ProviderInstanceId.make("antigravity"),
            model: "gemini-3.7-flash-high",
          }),
        });

        expect(result.subject).toBe("feat: add antigravity provider");
        expect(result.body).toBe("implement agy harness");
      }),
    ),
  );
});
