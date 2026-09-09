// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeSqlite from "node:sqlite";

import {
  removeAntigravitySessionFiles,
  sanitizeAntigravitySessionDatabase,
} from "./AntigravitySessionFiles.ts";

describe("AntigravitySessionFiles", () => {
  it.effect("safely ignores non-existent or invalid session ids", () =>
    Effect.gen(function* () {
      const result = yield* sanitizeAntigravitySessionDatabase({
        profileDirectory: "C:/non/existent",
        sessionId: "invalid-uuid",
      });
      expect(result).toEqual({ repairedCheckpoints: 0, removedErrorSteps: 0 });

      const nonExistent = yield* sanitizeAntigravitySessionDatabase({
        profileDirectory: "C:/non/existent",
        sessionId: "00000000-0000-4000-8000-000000000000",
      });
      expect(nonExistent).toEqual({ repairedCheckpoints: 0, removedErrorSteps: 0 });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("repairs poisoned in-progress checkpoints and removes panic steps", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const tempDir = yield* fs.makeTempDirectoryScoped();
      const acpDir = path.join(tempDir, "antigravity-acp", "conversations");
      yield* fs.makeDirectory(acpDir, { recursive: true });

      const sessionId = "461ec98b-c308-443b-bce6-fabbae5b5569";
      const dbPath = path.join(acpDir, `${sessionId}.db`);

      // Initialize synthetic database mimicking the exact checkpoint crash state
      const db = new NodeSqlite.DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
        CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB);
      `);

      // Row 13: status 4 (COMMITTED)
      const committedBuf = Buffer.from([0x08, 0x04, 0x10, 0x1f]);
      // Row 14: status 1 (IN_PROGRESS) -> the poison that causes "could not find doneCh for checkpoint"
      const inProgressBuf = Buffer.from([0x08, 0x01, 0x10, 0x20]);
      db.prepare("INSERT INTO executor_metadata (idx, data) VALUES (?, ?)").run(13, committedBuf);
      db.prepare("INSERT INTO executor_metadata (idx, data) VALUES (?, ?)").run(14, inProgressBuf);

      // Normal tool call step
      db.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)").run(
        2864,
        21,
        Buffer.from("run_command git status"),
      );
      // Panic crash step
      db.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)").run(
        2865,
        17,
        Buffer.from("agent executor error: could not find doneCh for checkpoint"),
      );
      db.close();

      // First run: repairs the database
      const firstRun = yield* sanitizeAntigravitySessionDatabase({
        profileDirectory: tempDir,
        sessionId,
      });
      expect(firstRun).toEqual({ repairedCheckpoints: 1, removedErrorSteps: 1 });

      // Verify the state of the database after sanitization
      const verifyDb = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });

      const meta13 = verifyDb
        .prepare("SELECT data FROM executor_metadata WHERE idx = 13")
        .get() as { data: Uint8Array };
      expect(Buffer.from(meta13.data)[1]).toBe(0x04); // Untouched

      const meta14 = verifyDb
        .prepare("SELECT data FROM executor_metadata WHERE idx = 14")
        .get() as { data: Uint8Array };
      expect(Buffer.from(meta14.data)[1]).toBe(0x02); // Successfully transitioned to SKIPPED (2)

      const remainingSteps = verifyDb.prepare("SELECT idx FROM steps").all() as Array<{
        idx: number;
      }>;
      expect(remainingSteps).toEqual([{ idx: 2864 }]); // Crash step 2865 was removed

      verifyDb.close();

      // Second run: idempotent, nothing left to repair
      const secondRun = yield* sanitizeAntigravitySessionDatabase({
        profileDirectory: tempDir,
        sessionId,
      });
      expect(secondRun).toEqual({ repairedCheckpoints: 0, removedErrorSteps: 0 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
