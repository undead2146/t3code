import {
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { StalledTurnWatchdog } from "../Services/StalledTurnWatchdog.ts";
import { makeStalledTurnWatchdogLive, selectStalledTurns } from "./StalledTurnWatchdog.ts";

const STALL_THRESHOLD_MS = 15 * 60_000;

const projectId = ProjectId.make("project-stalled-turn-watchdog");

function unsafeDateTime(iso: string): DateTime.Utc {
  return Option.getOrThrow(DateTime.make(iso));
}

function minutesBefore(base: DateTime.Utc, minutes: number): string {
  return DateTime.formatIso(DateTime.subtract(base, { minutes }));
}

function makeShell(overrides: Partial<OrchestrationThreadShell> & { id: ThreadId }) {
  const now = "2026-09-19T00:00:00.000Z";
  return {
    projectId,
    title: `Thread ${overrides.id}`,
    modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as unknown as OrchestrationThreadShell;
}

function runningSession(threadId: ThreadId, turnId: TurnId | null, updatedAt: string) {
  return {
    threadId,
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: turnId,
    lastError: null,
    updatedAt,
  } as unknown as NonNullable<OrchestrationThreadShell["session"]>;
}

describe("selectStalledTurns", () => {
  const threadId = ThreadId.make("thread-stalled");
  const turnId = TurnId.make("turn-stalled");
  const now = unsafeDateTime("2026-09-19T00:00:00.000Z");
  const nowMs = DateTime.toEpochMillis(now);

  it("selects a running turn silent past the threshold", () => {
    const silentAt = minutesBefore(now, 20);
    const threads = [
      makeShell({
        id: threadId,
        updatedAt: silentAt,
        session: runningSession(threadId, turnId, silentAt),
      }),
    ];
    const stalled = selectStalledTurns(threads, nowMs, STALL_THRESHOLD_MS);
    expect(stalled).toHaveLength(1);
    expect(stalled[0]?.threadId).toBe(threadId);
    expect(stalled[0]?.turnId).toBe(turnId);
  });

  it("ignores running turns with recent progress", () => {
    const freshAt = minutesBefore(now, 2);
    const threads = [
      makeShell({
        id: threadId,
        updatedAt: freshAt,
        session: runningSession(threadId, turnId, freshAt),
      }),
    ];
    expect(selectStalledTurns(threads, nowMs, STALL_THRESHOLD_MS)).toHaveLength(0);
  });

  it("ignores running turns with active background work (backgroundLiveness is not null)", () => {
    const silentAt = minutesBefore(now, 60);
    const threads = [
      makeShell({
        id: threadId,
        updatedAt: silentAt,
        backgroundLiveness: "working",
        session: runningSession(threadId, turnId, silentAt),
      }),
      makeShell({
        id: ThreadId.make("thread-monitoring"),
        updatedAt: silentAt,
        backgroundLiveness: "monitoring",
        session: runningSession(ThreadId.make("thread-monitoring"), turnId, silentAt),
      }),
    ];
    expect(selectStalledTurns(threads, nowMs, STALL_THRESHOLD_MS)).toHaveLength(0);
  });

  it("ignores silent turns blocked on the user, settled sessions, and archived threads", () => {
    const silentAt = minutesBefore(now, 60);
    const threads = [
      makeShell({
        id: ThreadId.make("thread-approval"),
        updatedAt: silentAt,
        hasPendingApprovals: true,
        session: runningSession(ThreadId.make("thread-approval"), turnId, silentAt),
      }),
      makeShell({
        id: ThreadId.make("thread-input"),
        updatedAt: silentAt,
        hasPendingUserInput: true,
        session: runningSession(ThreadId.make("thread-input"), turnId, silentAt),
      }),
      makeShell({
        id: ThreadId.make("thread-ready"),
        updatedAt: silentAt,
        session: {
          ...runningSession(ThreadId.make("thread-ready"), null, silentAt),
          status: "ready",
        } as unknown as NonNullable<OrchestrationThreadShell["session"]>,
      }),
      makeShell({
        id: ThreadId.make("thread-archived"),
        updatedAt: silentAt,
        archivedAt: silentAt,
        session: runningSession(ThreadId.make("thread-archived"), turnId, silentAt),
      }),
      makeShell({ id: ThreadId.make("thread-no-session"), updatedAt: silentAt, session: null }),
      makeShell({
        id: ThreadId.make("thread-no-turn"),
        updatedAt: silentAt,
        session: runningSession(ThreadId.make("thread-no-turn"), null, silentAt),
      }),
      makeShell({
        id: ThreadId.make("thread-bad-date"),
        updatedAt: "not-a-date",
        session: runningSession(ThreadId.make("thread-bad-date"), turnId, silentAt),
      }),
    ];
    expect(selectStalledTurns(threads, nowMs, STALL_THRESHOLD_MS)).toHaveLength(0);
  });
});

describe("StalledTurnWatchdog sweep", () => {
  function sweepLayer(input: {
    readonly buildThreads: (now: DateTime.Utc) => ReadonlyArray<OrchestrationThreadShell>;
    readonly dispatched: Array<OrchestrationCommand>;
    readonly failThreads?: ReadonlySet<ThreadId>;
  }) {
    const failThreads = input.failThreads ?? new Set<ThreadId>();
    return makeStalledTurnWatchdogLive().pipe(
      Layer.provideMerge(
        Layer.effect(
          ProjectionSnapshotQuery,
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const threads = input.buildThreads(now);
            return {
              getUserInputActivity: () => Effect.die("unused"),
              listActivitiesByKind: () => Effect.die("unused"),
              getCommandReadModel: () => Effect.die("unused"),
              getSnapshot: () => Effect.die("unused"),
              getShellSnapshot: () =>
                Effect.succeed({
                  snapshotSequence: 0,
                  projects: [],
                  threads: [...threads],
                  updatedAt: DateTime.formatIso(now),
                }),
              getArchivedShellSnapshot: () => Effect.die("unused"),
              getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
              getCounts: () => Effect.die("unused"),
              getEventReplayStats: () => Effect.die("unused"),
              getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
              getProjectShells: () => Effect.die("unused"),
              getProjectShellById: () => Effect.die("unused"),
              getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
              getImportedAgentSessionSources: () => Effect.die("unused"),
              getThreadCheckpointContext: () => Effect.die("unused"),
              getFullThreadDiffContext: () => Effect.die("unused"),
              getThreadRuntimeContext: () => Effect.die("unused"),
              getTurnStartMessage: () => Effect.die("unused"),
              getThreadShellById: () => Effect.die("unused"),
              getThreadDetailById: () => Effect.die("unused"),
              getThreadDetailSnapshot: () => Effect.die("unused"),
              searchThreads: () => Effect.die("unused"),
            };
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused"),
          dispatch: (command: OrchestrationCommand) =>
            "threadId" in command && failThreads.has(command.threadId)
              ? Effect.fail({
                  _tag: "OrchestrationDispatchError",
                  message: "boom",
                } as never)
              : Effect.sync(() => {
                  input.dispatched.push(command);
                  return { sequence: input.dispatched.length };
                }),
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.die("unused"),
          latestSequence: Effect.succeed(0),
        }),
      ),
    );
  }

  function silentShell(now: DateTime.Utc, id: ThreadId, turnId: TurnId) {
    const silentAt = DateTime.formatIso(DateTime.subtract(now, { minutes: 40 }));
    return makeShell({ id, updatedAt: silentAt, session: runningSession(id, turnId, silentAt) });
  }

  it.effect("interrupts a stalled turn with an explanatory activity", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const threadId = ThreadId.make("thread-sweep-stalled");
      const turnId = TurnId.make("turn-sweep-stalled");
      const layer = sweepLayer({
        dispatched,
        buildThreads: (now) => [silentShell(now, threadId, turnId)],
      });
      const watchdog = yield* StalledTurnWatchdog.pipe(Effect.provide(layer));
      yield* watchdog.runSweep();

      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.activity.append",
        "thread.turn.interrupt",
      ]);
      const activity = dispatched[0];
      if (activity?.type !== "thread.activity.append") {
        throw new Error("Expected activity.append first");
      }
      expect(activity.threadId).toBe(threadId);
      expect(activity.activity.kind).toBe("provider.turn.interrupted");
      expect(activity.activity.turnId).toBe(turnId);
      expect(activity.activity.summary).toContain("automatically");
      const interrupt = dispatched[1];
      if (interrupt?.type !== "thread.turn.interrupt") {
        throw new Error("Expected turn.interrupt second");
      }
      expect(interrupt.threadId).toBe(threadId);
      expect(interrupt.turnId).toBe(turnId);
    }),
  );

  it.effect("uses deterministic command ids so repeats dedupe", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const threadId = ThreadId.make("thread-sweep-idempotent");
      const turnId = TurnId.make("turn-sweep-idempotent");
      const layer = sweepLayer({
        dispatched,
        buildThreads: (now) => [silentShell(now, threadId, turnId)],
      });
      const watchdog = yield* StalledTurnWatchdog.pipe(Effect.provide(layer));
      yield* watchdog.runSweep();
      yield* watchdog.runSweep();

      expect(dispatched).toHaveLength(4);
      expect(dispatched[0]?.commandId).toBe(dispatched[2]?.commandId);
      expect(dispatched[1]?.commandId).toBe(dispatched[3]?.commandId);
    }),
  );

  it.effect("continues past a thread whose interrupt fails", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const failingId = ThreadId.make("thread-sweep-failing");
      const healthyId = ThreadId.make("thread-sweep-healthy");
      const layer = sweepLayer({
        dispatched,
        failThreads: new Set([failingId]),
        buildThreads: (now) => [
          silentShell(now, failingId, TurnId.make("turn-failing")),
          silentShell(now, healthyId, TurnId.make("turn-healthy")),
        ],
      });
      const watchdog = yield* StalledTurnWatchdog.pipe(Effect.provide(layer));
      yield* watchdog.runSweep();

      expect(
        dispatched.map((command) => ("threadId" in command ? command.threadId : null)),
      ).toEqual([healthyId, healthyId]);
    }),
  );
});
