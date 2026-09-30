import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeKeyedDrainableWorker } from "./KeyedDrainableWorker.ts";

interface Item {
  readonly key: string;
  readonly id: string;
}

describe("makeKeyedDrainableWorker", () => {
  it.live("keeps processing other keys while one key is blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const blockedStarted = yield* Deferred.make<void>();
        const releaseBlocked = yield* Deferred.make<void>();
        const otherDone = yield* Deferred.make<void>();

        const worker = yield* makeKeyedDrainableWorker({
          key: (item: Item) => item.key,
          process: (item: Item) =>
            Effect.gen(function* () {
              if (item.id === "a1") {
                yield* Deferred.succeed(blockedStarted, undefined);
                yield* Deferred.await(releaseBlocked);
              }
              processed.push(item.id);
              if (item.id === "b1") yield* Deferred.succeed(otherDone, undefined);
            }),
        });

        yield* worker.enqueue({ key: "a", id: "a1" });
        yield* Deferred.await(blockedStarted);
        yield* worker.enqueue({ key: "a", id: "a2" });
        yield* worker.enqueue({ key: "b", id: "b1" });

        // b1 finishes while a1 is still blocked; a2 stays queued behind a1.
        yield* Deferred.await(otherDone);
        expect(processed).toEqual(["b1"]);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(Effect.andThen(Deferred.succeed(drained, undefined))),
        );
        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseBlocked, undefined);
        yield* Deferred.await(drained);
        expect(processed).toEqual(["b1", "a1", "a2"]);
      }),
    ),
  );

  it.live("continues a key after an item fails or interrupts itself", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const worker = yield* makeKeyedDrainableWorker({
          key: (item: Item) => item.key,
          process: (item: Item) =>
            item.id === "fail"
              ? Effect.fail("boom")
              : item.id === "interrupt"
                ? Effect.interrupt
                : Effect.sync(() => void processed.push(item.id)),
        });

        yield* worker.enqueue({ key: "a", id: "fail" });
        yield* worker.enqueue({ key: "a", id: "interrupt" });
        yield* worker.enqueue({ key: "a", id: "after" });
        yield* worker.drain;

        expect(processed).toEqual(["after"]);
      }),
    ),
  );
});
