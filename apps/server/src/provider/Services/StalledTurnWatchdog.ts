import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface StalledTurnWatchdogShape {
  /**
   * Start the background stalled-turn watchdog within the provided scope.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Run one stall-detection sweep immediately. Used by `start` on its
   * schedule; exposed so tests and operators can trigger a sweep directly.
   */
  readonly runSweep: () => Effect.Effect<void>;
}

export class StalledTurnWatchdog extends Context.Service<
  StalledTurnWatchdog,
  StalledTurnWatchdogShape
>()("t3/provider/Services/StalledTurnWatchdog") {}
