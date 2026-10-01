// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeSqlite from "node:sqlite";

import { sanitizeAntigravitySessionDatabase } from "./AntigravitySessionFiles.ts";

const STEPS_TABLE = `CREATE TABLE steps (
  idx INTEGER PRIMARY KEY,
  step_type INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  step_payload BLOB
)`;
const METADATA_TABLE = "CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB)";

/** Shaped like a real row: field 1 = 2, then the error string the harness records. */
const doneChFailureRow = () =>
  Buffer.concat([
    Buffer.from([0x08, 0x02, 0x10, 0x01]),
    Buffer.from("could not find doneCh for checkpoint"),
  ]);
const healthyRow = () => Buffer.from([0x08, 0x04, 0x10, 0x1f]);

const makeConversation = Effect.fn("makeConversation")(function* (
  sessionId: string,
  seed: (db: NodeSqlite.DatabaseSync) => void,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profileDirectory = yield* fs.makeTempDirectoryScoped();
  const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
  yield* fs.makeDirectory(conversations, { recursive: true });
  const dbPath = path.join(conversations, `${sessionId}.db`);
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec(`${STEPS_TABLE}; ${METADATA_TABLE};`);
  seed(db);
  db.close();
  return { profileDirectory, dbPath };
});

const insertStep = (db: NodeSqlite.DatabaseSync, idx: number, stepType: number, status: number) =>
  db
    .prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)")
    .run(idx, stepType, status, Buffer.from(`step ${idx}`));

const insertMetadata = (db: NodeSqlite.DatabaseSync, idx: number, data: Buffer) =>
  db.prepare("INSERT INTO executor_metadata (idx, data) VALUES (?, ?)").run(idx, data);

describe("AntigravitySessionFiles", () => {
  it.effect("safely ignores non-existent or invalid session ids", () =>
    Effect.gen(function* () {
      const nothing = { repairedCheckpoints: 0, removedErrorSteps: 0, resumable: true };
      expect(
        yield* sanitizeAntigravitySessionDatabase({
          profileDirectory: "C:/non/existent",
          sessionId: "invalid-uuid",
        }),
      ).toEqual(nothing);
      expect(
        yield* sanitizeAntigravitySessionDatabase({
          profileDirectory: "C:/non/existent",
          sessionId: "00000000-0000-4000-8000-000000000000",
        }),
      ).toEqual(nothing);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels an interrupted checkpoint so the conversation can resume", () =>
    Effect.gen(function* () {
      const sessionId = "415a1999-e5a2-41e2-a0c2-f4eb9e999dfd";
      const { profileDirectory, dbPath } = yield* makeConversation(sessionId, (db) => {
        insertStep(db, 52, 15, 3);
        insertStep(db, 53, 23, 2); // checkpoint left running by a killed process
        insertStep(db, 54, 23, 3);
        insertStep(db, 120, 14, 3);
        insertStep(db, 121, 14, 3);
        insertMetadata(db, 0, doneChFailureRow());
        insertMetadata(db, 1, doneChFailureRow());
      });

      const first = yield* sanitizeAntigravitySessionDatabase({ profileDirectory, sessionId });
      expect(first).toEqual({ repairedCheckpoints: 1, removedErrorSteps: 0, resumable: true });

      const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      const checkpoints = db
        .prepare("SELECT idx, status FROM steps WHERE step_type = 23 ORDER BY idx")
        .all();
      const metadata = db
        .prepare("SELECT data FROM executor_metadata ORDER BY idx")
        .all() as Array<{
        data: Uint8Array;
      }>;
      db.close();
      expect(checkpoints).toEqual([
        { idx: 53, status: 5 },
        { idx: 54, status: 3 },
      ]);
      // Harness-owned metadata is left alone.
      expect(metadata.map((row) => Buffer.from(row.data).equals(doneChFailureRow()))).toEqual([
        true,
        true,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("gives up on resuming once a repair did not stop the checkpoint failure", () =>
    Effect.gen(function* () {
      const sessionId = "4ba207e8-0000-4000-8000-000000000001";
      const { profileDirectory } = yield* makeConversation(sessionId, (db) => {
        insertStep(db, 1263, 23, 5); // repaired on the previous start
        insertStep(db, 1337, 14, 3);
        insertMetadata(db, 0, healthyRow());
        insertMetadata(db, 1, doneChFailureRow()); // the resume after the repair failed again
      });

      expect(yield* sanitizeAntigravitySessionDatabase({ profileDirectory, sessionId })).toEqual({
        repairedCheckpoints: 0,
        removedErrorSteps: 0,
        resumable: false,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stops trusting the repair after repeated failures", () =>
    Effect.gen(function* () {
      const sessionId = "5f1f81a6-0000-4000-8000-000000000002";
      const { profileDirectory } = yield* makeConversation(sessionId, (db) => {
        insertStep(db, 332, 23, 2);
        for (let idx = 0; idx < 6; idx++) insertMetadata(db, idx, doneChFailureRow());
      });

      const result = yield* sanitizeAntigravitySessionDatabase({ profileDirectory, sessionId });
      expect(result.repairedCheckpoints).toBe(1);
      expect(result.resumable).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a healthy conversation untouched", () =>
    Effect.gen(function* () {
      const sessionId = "01a40f1e-0000-4000-8000-000000000003";
      const { profileDirectory } = yield* makeConversation(sessionId, (db) => {
        insertStep(db, 17, 23, 5);
        insertStep(db, 18, 23, 3);
        insertMetadata(db, 0, doneChFailureRow()); // an old failure, recovered since
        insertMetadata(db, 1, healthyRow());
      });

      expect(yield* sanitizeAntigravitySessionDatabase({ profileDirectory, sessionId })).toEqual({
        repairedCheckpoints: 0,
        removedErrorSteps: 0,
        resumable: true,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes fatal executor construction and MCP failure crash steps", () =>
    Effect.gen(function* () {
      const sessionId = "58b9fc5a-8f4b-4d24-a4dc-6e7a12260a32";
      const { profileDirectory, dbPath } = yield* makeConversation(sessionId, (db) => {
        insertStep(db, 2770, 14, 3);
        db.prepare(
          "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)",
        ).run(
          2771,
          17,
          3,
          Buffer.from(
            '(Agent execution terminated due to error. failed to construct executor: MCP load failed for t3-code: context canceled client is closing: sending "notifications/cancelled": Bad Request',
          ),
        );
      });

      expect(yield* sanitizeAntigravitySessionDatabase({ profileDirectory, sessionId })).toEqual({
        repairedCheckpoints: 0,
        removedErrorSteps: 1,
        resumable: true,
      });

      const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      const remaining = db.prepare("SELECT idx, step_type FROM steps").all();
      db.close();
      expect(remaining).toEqual([{ idx: 2770, step_type: 14 }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
