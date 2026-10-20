/**
 * The wait for an airborne body to land, bounded by the wall clock.
 *
 * `stabilize` counts physics ticks, so a body whose physics has stopped (a
 * ride, an unloaded chunk, a death waiting for the respawn) would wait for
 * ticks that never come, with the run's hold and listeners still on the bot.
 * Twenty ticks are one second; two seconds of wall clock without them read as
 * stopped physics.
 */
import type { NavigationBot } from "../bot.js";

/** Twice the 20 ticks `stabilize` observes: enough for a server that stalls briefly, short enough to answer the model. */
export const LANDING_WALL_MS = 2_000;

export type LandingResult =
  | { readonly kind: "stable" }
  | { readonly kind: "failed"; readonly observation: string }
  | { readonly kind: "stopped" };

/**
 * `signal` is the run's: its abort ends the wait as `stopped`. `null` bounds the
 * wait by the wall clock only, for the search's `finally`, which keeps its hold
 * through a cancel on purpose until the landing is seen or the bound passes.
 */
export async function awaitLanding(
  bot: Pick<NavigationBot, "stabilize" | "observe">,
  signal: AbortSignal | null,
  wallMs = LANDING_WALL_MS,
): Promise<LandingResult> {
  const wall = new AbortController();
  const timer = setTimeout(() => wall.abort(new Error(`no landing within ${wallMs} ms`)), wallMs);
  try {
    return await bot.stabilize(signal ? AbortSignal.any([signal, wall.signal]) : wall.signal);
  } catch (cause) {
    if (signal?.aborted) return { kind: "stopped" };
    if (!wall.signal.aborted) throw cause;
    const { x, y, z } = bot.observe().position;
    return {
      kind: "failed",
      observation:
        `No physics tick for ${wallMs / 1000} s while airborne at ${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}; ` +
        `the landing could not be observed. Wait until the bot stands on the ground, then give the order again.`,
    };
  } finally {
    clearTimeout(timer);
  }
}
