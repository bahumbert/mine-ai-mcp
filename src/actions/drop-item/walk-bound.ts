// The bound on a walk off a toss or a hole: blocks of path and wall-clock time, as one abort signal for `navigate`.
import type { Bot } from "mineflayer";

/** The most path a walk off a toss or a hole may cover: three times the 4-block clearance it walks for. */
export const WALK_AWAY_MAX_BLOCKS = 12;

/** The most wall-clock time such a walk may take (the 100-tick hand-over settle): a stalled route or a lagging server ends it. */
export const WALK_AWAY_MAX_MS = 5_000;

export interface WalkBound extends Disposable {
  /** Aborted with the reason `walk bound: <n> blocks walked` or `walk bound: <ms> ms`; handed to `navigate` as `stopSignal`. */
  readonly signal: AbortSignal;
  /** Blocks of path covered since the bound started (a server reposition included). */
  walked(): number;
}

/**
 * Bound a walk by its path and by the wall clock, whichever comes first. The path is the sum of the body's 3-D movement
 * per client tick (a circling or underground route has covered far more than its distance from the start: live s3l,
 * 106 and 167 blocks); the clock covers a body that does not tick (a lagging server, an unloaded chunk, a route search
 * that never answers). One bound serves all the sides of a walk; dispose it (`using`) to remove the listener and timer.
 */
export function startWalkBound(bot: Bot, limits: { readonly maxBlocks: number; readonly maxMs: number }): WalkBound {
  const controller = new AbortController();
  let walkedBlocks = 0;
  let last = bot.entity.position.clone();
  const onTick = () => {
    walkedBlocks += last.distanceTo(bot.entity.position);
    last = bot.entity.position.clone();
    if (walkedBlocks > limits.maxBlocks && !controller.signal.aborted) controller.abort(`walk bound: ${Math.round(walkedBlocks)} blocks walked`);
  };
  const timer = setTimeout(() => controller.abort(`walk bound: ${limits.maxMs} ms`), limits.maxMs);
  bot.on("physicsTick", onTick);
  return {
    signal: controller.signal,
    walked: () => Math.round(walkedBlocks),
    [Symbol.dispose]() {
      clearTimeout(timer);
      bot.off("physicsTick", onTick);
    },
  };
}
