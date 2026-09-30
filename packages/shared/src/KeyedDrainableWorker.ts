/**
 * KeyedDrainableWorker - A drainable worker that serializes items per key and
 * runs different keys concurrently.
 *
 * Items sharing a key are processed one at a time in enqueue order, so a slow
 * or hung item only delays later items with the same key. `drain` resolves
 * when every enqueued item, across all keys, has finished processing.
 *
 * A failing or interrupted item does not stop its key: the next item for that
 * key still runs.
 *
 * @module KeyedDrainableWorker
 */
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as TxRef from "effect/TxRef";

import type { DrainableWorker } from "./DrainableWorker.ts";

export const makeKeyedDrainableWorker = <A, K, E, R>(options: {
  readonly key: (item: A) => K;
  readonly process: (item: A) => Effect.Effect<void, E, R>;
}): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    const outstanding = yield* TxRef.make(0);
    // Keys with a live runner, mapped to the items still waiting behind it.
    const pendingByKey = new Map<K, A[]>();

    const runKey = (key: K): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          const next = yield* Effect.sync(() => {
            const pending = pendingByKey.get(key);
            const item = pending?.shift();
            if (item === undefined) pendingByKey.delete(key);
            return item;
          });
          if (next === undefined) return;
          yield* Effect.exit(options.process(next)).pipe(
            Effect.ensuring(TxRef.update(outstanding, (n) => n - 1).pipe(Effect.tx)),
          );
        }
      }).pipe(Effect.provideContext(context));

    const enqueue: DrainableWorker<A>["enqueue"] = (item) =>
      Effect.gen(function* () {
        yield* TxRef.update(outstanding, (n) => n + 1).pipe(Effect.tx);
        const key = options.key(item);
        const startRunner = yield* Effect.sync(() => {
          const pending = pendingByKey.get(key);
          if (pending) {
            pending.push(item);
            return false;
          }
          pendingByKey.set(key, [item]);
          return true;
        });
        if (startRunner) yield* Effect.forkIn(runKey(key), scope);
      }).pipe(Effect.uninterruptible);

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });
