import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import {
  CommandId,
  EventId,
  type OrchestrationThreadShell,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";

import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  StalledTurnWatchdog,
  type StalledTurnWatchdogShape,
} from "../Services/StalledTurnWatchdog.ts";

const DEFAULT_STALL_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface StalledTurnWatchdogLiveOptions {
  readonly stallThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

export interface StalledTurn {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly idleMs: number;
}

/**
 * A running turn whose thread projection has seen no provider progress
 * (messages, activities, usage, session transitions all bump updatedAt)
 * for longer than the threshold is wedged, not busy: every provider emits
 * something observable within minutes while a turn is alive. Turns blocked
 * on the user (pending approvals / input) or active in background tasks/subagents
 * (backgroundLiveness is "working" or "monitoring") are never stalled.
 */
export function selectStalledTurns(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  nowMs: number,
  stallThresholdMs: number,
): Array<StalledTurn> {
  const stalled: Array<StalledTurn> = [];
  for (const thread of threads) {
    const activeTurnId = thread.session?.activeTurnId ?? null;
    if (thread.session?.status !== "running" || activeTurnId === null) {
      continue;
    }
    if (thread.archivedAt !== null) {
      continue;
    }
    if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
      continue;
    }
    if (thread.backgroundLiveness != null) {
      continue;
    }
    const updatedMs = Date.parse(thread.updatedAt);
    if (Number.isNaN(updatedMs)) {
      continue;
    }
    const idleMs = nowMs - updatedMs;
    if (idleMs < stallThresholdMs) {
      continue;
    }
    stalled.push({ threadId: thread.id, turnId: activeTurnId, idleMs });
  }
  return stalled;
}

const makeStalledTurnWatchdog = (options?: StalledTurnWatchdogLiveOptions) =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;

    const stallThresholdMs = Math.max(1, options?.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS);
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const interruptStalledTurn = (stalled: StalledTurn, createdAt: string) =>
      Effect.gen(function* () {
        // Deterministic ids: a wedged provider that never settles still only
        // ever records one interrupt + one explanation, since the engine
        // dedupes on command id across sweeps and restarts.
        const idBase = `stalled-turn-watchdog:${stalled.threadId}:${stalled.turnId}`;
        const minutes = Math.max(1, Math.round(stalled.idleMs / 60_000));
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`${idBase}:activity`),
          threadId: stalled.threadId,
          activity: {
            id: EventId.make(`${idBase}:activity`),
            tone: "info",
            kind: "provider.turn.interrupted",
            summary: "Turn stopped automatically",
            payload: {
              detail:
                `No provider progress for ${minutes} minute${minutes === 1 ? "" : "s"}. ` +
                "The provider may have stalled, so the turn was stopped automatically. " +
                "Send a new message to retry.",
            },
            turnId: stalled.turnId,
            createdAt,
          },
          createdAt,
        });
        // Same command the Stop button sends: the decider records the
        // interrupt and the provider reactor settles the session, so the
        // watchdog reuses the exact user-interrupt path per provider.
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make(`${idBase}:interrupt`),
          threadId: stalled.threadId,
          turnId: stalled.turnId,
          createdAt,
        });
        yield* Effect.logInfo("stalled-turn-watchdog.interrupted", {
          threadId: stalled.threadId,
          turnId: stalled.turnId,
          idleMs: stalled.idleMs,
        });
      });

    const sweep = Effect.gen(function* () {
      const snapshot = yield* query.getShellSnapshot();
      const nowMs = yield* Clock.currentTimeMillis;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const stalled = selectStalledTurns(snapshot.threads, nowMs, stallThresholdMs);
      for (const turn of stalled) {
        yield* interruptStalledTurn(turn, createdAt).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("stalled-turn-watchdog.interrupt-failed", {
              threadId: turn.threadId,
              turnId: turn.turnId,
              cause,
            }),
          ),
        );
      }
    });

    const runSweep: StalledTurnWatchdogShape["runSweep"] = () =>
      sweep.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("stalled-turn-watchdog.sweep-failed", { cause }),
        ),
      );

    const start: StalledTurnWatchdogShape["start"] = () =>
      Effect.gen(function* () {
        yield* forkParked(
          sweep.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("stalled-turn-watchdog.sweep-failed", { cause }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("stalled-turn-watchdog.sweep-defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("stalled-turn-watchdog.started", {
          stallThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
      runSweep,
    } satisfies StalledTurnWatchdogShape;
  });

export const makeStalledTurnWatchdogLive = (options?: StalledTurnWatchdogLiveOptions) =>
  Layer.effect(StalledTurnWatchdog, makeStalledTurnWatchdog(options));

export const StalledTurnWatchdogLive = makeStalledTurnWatchdogLive();
