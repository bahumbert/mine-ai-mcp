import type { StallClock } from "../actions/stall-watch.js";
import { flush } from "./fake-bot/fake-clock.js";

export { flush };

/** A `StallClock` the test steps by hand: `advance` moves time forward and runs every live timer once per step. */
export function handClock() {
  let now = 0;
  const timers = new Set<() => void>();
  const clock: StallClock = {
    now: () => now,
    every: (tick) => {
      timers.add(tick);
      return () => void timers.delete(tick);
    },
  };
  return {
    clock,
    /** How many timers are live: a watch that is over leaves none. */
    timers: () => timers.size,
    /** Time passes in `stepMs` slices, as a real interval would run, with the promise queue drained after each. */
    async advance(ms: number, stepMs = 50): Promise<void> {
      for (let passed = 0; passed < ms; passed += stepMs) {
        now += stepMs;
        for (const tick of [...timers]) tick();
        await flush();
      }
    },
  };
}
