/**
 * An outer bound on a long action: stop it once its work stops changing.
 *
 * The inner loops of a long action have guards of their own, but a loop that
 * keeps finding something new to try passes every one of them. Observed live
 * on 2026-10-02: `collect_block stone 32` walked 881 blocks in 27 minutes and
 * ended 8 blocks from where it started, with 7 stone gained, until a server
 * kick settled it. Whatever spins, the work it reports does not change, and
 * that is what this watches, the way `smelt_item` watches cook progress.
 */
import { AnchorTravel } from "../session/anchor-travel.js";
import type { Position3 } from "../utils/index.js";

/** How often the work and the position are sampled when the caller does not say. */
const SAMPLE_MS = 1_000;

export interface StallFacts {
  /** How long nothing changed, in seconds. */
  readonly seconds: number;
  /** Blocks walked while nothing changed, rounded. */
  readonly walked: number;
}

/** Time and repetition, injectable so a test steps them by hand instead of waiting. */
export interface StallClock {
  /** Milliseconds on a monotonic clock. */
  readonly now: () => number;
  /** Call `tick` every `ms` until the returned function is called. */
  readonly every: (tick: () => void, ms: number) => () => void;
}

/** Monotonic: a wall clock that steps (NTP, WSL host sync) must not stretch or cut the stall window. */
export const MONOTONIC_CLOCK: StallClock = {
  now: () => performance.now(),
  every: (tick, ms) => {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  },
};

export interface StallWatchOptions {
  /** Anything that changes when the action makes progress, such as `blocks broken:items gained`. */
  readonly work: () => string | number;
  readonly position: () => Position3;
  /** Whether the bot is in water now: bobbing there is not walking. Default: never. */
  readonly inWater?: () => boolean;
  readonly stallMs: number;
  readonly sampleMs?: number;
  readonly clock?: StallClock;
  readonly describe: (facts: StallFacts) => string;
}

export interface StallWatch {
  /** Aborted, with the described reason, once the work has not changed for `stallMs`. */
  readonly signal: AbortSignal;
  /** The described reason once stalled, else null. */
  readonly reason: () => string | null;
  /** Stop sampling; call it when the action settles. */
  readonly close: () => void;
}

export function watchForStall(options: StallWatchOptions): StallWatch {
  const controller = new AbortController();
  let reason: string | null = null;
  let lastWork = options.work();
  const clock = options.clock ?? MONOTONIC_CLOCK;
  let lastChange = clock.now();
  const travel = new AnchorTravel();
  travel.add(options.position(), false);
  let walked = 0;
  const stop = clock.every(() => {
    const here = options.position();
    walked += travel.add(here, options.inWater?.() ?? false);
    const work = options.work();
    if (work !== lastWork) {
      lastWork = work;
      lastChange = clock.now();
      walked = 0;
      return;
    }
    if (clock.now() - lastChange < options.stallMs) return;
    reason = options.describe({ seconds: options.stallMs / 1_000, walked: Math.round(walked) });
    stop();
    controller.abort(new Error(reason));
  }, options.sampleMs ?? SAMPLE_MS);
  return {
    signal: controller.signal,
    reason: () => reason,
    close: stop,
  };
}
