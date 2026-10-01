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

/** Context checkpoint step. Status 2 is running, 3 done, 5 cancelled. */
const CHECKPOINT_STEP_TYPE = 23;
const STEP_STATUS_RUNNING = 2;
const STEP_STATUS_CANCELLED = 5;
const DONE_CH_ERROR = "could not find doneCh for checkpoint";
/** Past this many failures in a row, a repair is not trusted to help. */
const MAX_CONSECUTIVE_DONE_CH_FAILURES = 5;

export interface AntigravitySessionRepair {
  readonly repairedCheckpoints: number;
  readonly removedErrorSteps: number;
  /** False when resuming would hit the same harness error again. Start fresh instead. */
  readonly resumable: boolean;
}

const nothingToRepair: AntigravitySessionRepair = {
  repairedCheckpoints: 0,
  removedErrorSteps: 0,
  resumable: true,
};

/**
 * Repairs an Antigravity conversation database before T3 resumes it, and
 * after the process that owned it exits.
 *
 * Interrupted checkpoints: when the harness compacts context it writes a
 * checkpoint step (`step_type` 23) as running and waits on an in-memory Go
 * channel (`doneCh`). If the process dies first, the step stays running on
 * disk. Every later prompt on that conversation then fails with
 * "could not find doneCh for checkpoint", and the harness appends one
 * `executor_metadata` row carrying that error per attempt. Healthy
 * conversations finish checkpoints as done (3) or cancelled (5), so a running
 * checkpoint is marked cancelled.
 *
 * If the newest `executor_metadata` rows still report the doneCh error and
 * nothing was left to repair, the last repair did not help, so the
 * conversation is reported as not resumable. A repair that keeps finding a
 * running checkpoint is trusted for at most a few failures in a row. Either
 * way a thread falls back to a fresh conversation instead of looping.
 *
 * Fatal executor steps: an executor or MCP start failure leaves a terminal
 * error step (`step_type` 17) that stalls later prompts. Those are removed.
 */
export const sanitizeAntigravitySessionDatabase = Effect.fn("sanitizeAntigravitySessionDatabase")(
  function* (input: {
    readonly profileDirectory: string;
    readonly sessionId: string | undefined;
  }): Effect.fn.Return<AntigravitySessionRepair, never, FileSystem.FileSystem | Path.Path> {
    if (input.sessionId === undefined || !isNativeSessionId(input.sessionId)) {
      return nothingToRepair;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const acpDirectory = path.join(input.profileDirectory, "antigravity-acp");
    const dbPath = path.join(acpDirectory, "conversations", `${input.sessionId}.db`);

    const exists = yield* fs.exists(dbPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return nothingToRepair;
    }

    return yield* Effect.sync((): AntigravitySessionRepair => {
      let repairedCheckpoints = 0;
      let removedErrorSteps = 0;
      let resumable = true;

      try {
        const db = new NodeSqlite.DatabaseSync(dbPath);

        try {
          const hasTable = (name: string) =>
            db
              .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
              .get(name) !== undefined;

          if (hasTable("steps")) {
            repairedCheckpoints = Number(
              db
                .prepare("UPDATE steps SET status = ? WHERE step_type = ? AND status = ?")
                .run(STEP_STATUS_CANCELLED, CHECKPOINT_STEP_TYPE, STEP_STATUS_RUNNING).changes,
            );

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
                  payloadStr.includes(DONE_CH_ERROR) ||
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

          if (hasTable("executor_metadata")) {
            // Each failed prompt appends one row; the error is a plain protobuf
            // string, so a byte search finds it.
            const recent = db
              .prepare("SELECT data FROM executor_metadata ORDER BY idx DESC LIMIT ?")
              .all(MAX_CONSECUTIVE_DONE_CH_FAILURES + 1) as Array<{
              data?: Uint8Array | Buffer | null;
            }>;
            let failures = 0;
            for (const row of recent) {
              if (!row.data || !Buffer.from(row.data).toString("latin1").includes(DONE_CH_ERROR)) {
                break;
              }
              failures++;
            }
            if (
              failures > 0 &&
              (repairedCheckpoints === 0 || failures > MAX_CONSECUTIVE_DONE_CH_FAILURES)
            ) {
              resumable = false;
            }
          }
        } finally {
          db.close();
        }
      } catch {
        // Best effort: if database is temporarily locked or inaccessible, do not abort
      }

      return { repairedCheckpoints, removedErrorSteps, resumable };
    });
  },
  Effect.orElseSucceed(() => nothingToRepair),
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

/**
 * Removes every per-process runtime temp directory under an instance's root.
 * Call once when the driver starts, before it launches any process, so a
 * previous server that was killed mid-session cannot leave unpacked runtimes
 * behind. Only T3-owned directories are touched. The system temp directory
 * belongs to other programs and Windows does not lock data files, so sweeping
 * it could gut a live extraction.
 */
export const removeAntigravityRuntimeTempDirs = Effect.fn("removeAntigravityRuntimeTempDirs")(
  function* (tempDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(tempDirectory, { recursive: true, force: true });
  },
  Effect.catch(() =>
    Effect.logWarning("Could not remove leftover Antigravity runtime temp files."),
  ),
);
