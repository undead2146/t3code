// @effect-diagnostics nodeBuiltinImport:off
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeSqlite from "node:sqlite";

const isNativeSessionId = Schema.is(Schema.String.check(Schema.isUUID(4)));
const decodeSessionMetadata = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ cwd: Schema.String })),
);

/**
 * Repairs Antigravity SQLite conversation databases that were corrupted by an
 * interrupted context checkpoint or fatal executor error.
 *
 * Root Cause & Prevention:
 * 1. Context Compaction Checkpoints:
 *    When an Antigravity ACP conversation approaches the context compaction threshold (~110k tokens),
 *    the internal Go harness (localharness_external) registers an in-progress checkpoint in
 *    `executor_metadata` (status = 1 / protobuf varint sequence 0x08 0x01) and sets up an in-memory
 *    Go channel `doneCh`.
 *    If concurrent tool calls, crash, or PC reboot interrupt this checkpoint, `status = 1` remains written to disk.
 *    On every subsequent process boot or session resume, `checkpoint_validation.go` scans `executor_metadata`.
 *    Seeing an active checkpoint without its ephemeral in-memory `doneCh`, it immediately panics with:
 *      "agent executor error: could not find doneCh for checkpoint"
 *
 * 2. Unhandled Fatal Executor / MCP Crash Steps:
 *    If an executor construction or MCP initialization fails on reboot or cancellation, Antigravity records
 *    a fatal terminal error step (`step_type == 17`) with payload like:
 *      "(Agent execution terminated due to error. failed to construct executor: MCP load failed..."
 *    Resuming a session with this trailing terminal step causes the internal Go executor to hang or stall
 *    on subsequent `session/prompt` calls until the turn watchdog times out.
 *
 * This sanitizer neutralizes that poisoned state:
 * 1. Checks `executor_metadata` for any checkpoint row where status == 1 (IN_PROGRESS, 0x08 0x01).
 *    Transitions it to status == 2 (SKIPPED, 0x08 0x02) so the Go validation hook does not expect `doneCh`.
 * 2. Removes any trailing panic or fatal executor termination step (step_type == 17) in `steps`.
 */
export const sanitizeAntigravitySessionDatabase = Effect.fn("sanitizeAntigravitySessionDatabase")(
  function* (input: { readonly profileDirectory: string; readonly sessionId: string | undefined }) {
    if (input.sessionId === undefined || !isNativeSessionId(input.sessionId)) {
      return { repairedCheckpoints: 0, removedErrorSteps: 0 };
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const acpDirectory = path.join(input.profileDirectory, "antigravity-acp");
    const dbPath = path.join(acpDirectory, "conversations", `${input.sessionId}.db`);

    const exists = yield* fs.exists(dbPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return { repairedCheckpoints: 0, removedErrorSteps: 0 };
    }

    return yield* Effect.sync(() => {
      let repairedCheckpoints = 0;
      let removedErrorSteps = 0;

      try {
        const db = new NodeSqlite.DatabaseSync(dbPath);

        try {
          const tableCheck = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='executor_metadata'",
            )
            .get() as { name?: string } | undefined;

          if (tableCheck?.name === "executor_metadata") {
            const rows = db.prepare("SELECT idx, data FROM executor_metadata").all() as Array<{
              idx: number;
              data: Uint8Array | Buffer;
            }>;

            for (const row of rows) {
              const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
              // Protobuf field 1 tag is 0x08 (field 1, wire type 0 varint).
              // Value 0x01 is status 1 (IN_PROGRESS).
              if (buf.length >= 2 && buf[0] === 0x08 && buf[1] === 0x01) {
                // Change status 1 (IN_PROGRESS) to 2 (SKIPPED: 0x08 0x02)
                buf[1] = 0x02;
                db.prepare("UPDATE executor_metadata SET data = ? WHERE idx = ?").run(buf, row.idx);
                repairedCheckpoints++;
              }
            }
          }

          const stepsCheck = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='steps'")
            .get() as { name?: string } | undefined;

          if (stepsCheck?.name === "steps") {
            const lastSteps = db
              .prepare("SELECT idx, step_type, step_payload FROM steps ORDER BY idx DESC LIMIT 10")
              .all() as Array<{
              idx: number;
              step_type: number;
              step_payload?: Uint8Array | Buffer | null;
            }>;

            for (const step of lastSteps) {
              if (step.step_type === 17) {
                const payloadStr = step.step_payload
                  ? Buffer.from(step.step_payload).toString("utf8")
                  : "";
                if (
                  payloadStr.includes("could not find doneCh for checkpoint") ||
                  payloadStr.includes("agent executor error") ||
                  payloadStr.includes("failed to construct executor") ||
                  payloadStr.includes("Agent execution terminated due to error") ||
                  payloadStr.includes("MCP load failed")
                ) {
                  db.prepare("DELETE FROM steps WHERE idx = ?").run(step.idx);
                  removedErrorSteps++;
                }
              }
            }
          }
        } finally {
          db.close();
        }
      } catch {
        // Best effort: if database is temporarily locked or inaccessible, do not abort
      }

      return { repairedCheckpoints, removedErrorSteps };
    });
  },
  Effect.orElseSucceed(() => ({ repairedCheckpoints: 0, removedErrorSteps: 0 })),
);

/** Call after the process closes. The unique temporary cwd proves which session we own. */
export const removeAntigravitySessionFiles = Effect.fn("removeAntigravitySessionFiles")(
  function* (input: {
    readonly profileDirectory: string;
    readonly sessionId: string | undefined;
    readonly cwd: string;
  }) {
    if (input.sessionId === undefined || !isNativeSessionId(input.sessionId)) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const acpDirectory = path.join(input.profileDirectory, "antigravity-acp");
    const base = path.join(acpDirectory, "conversations", input.sessionId);
    if (!(yield* fs.exists(`${base}.meta`))) {
      return;
    }
    const metadata = yield* fs
      .readFileString(`${base}.meta`)
      .pipe(Effect.flatMap(decodeSessionMetadata));
    if (metadata.cwd !== input.cwd) {
      return;
    }
    for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"]) {
      yield* fs.remove(`${base}${suffix}`, { force: true });
    }
    yield* fs.remove(path.join(acpDirectory, "brain", input.sessionId), {
      recursive: true,
      force: true,
    });
  },
  Effect.catch(() => Effect.logWarning("Could not remove temporary Antigravity session files.")),
);
