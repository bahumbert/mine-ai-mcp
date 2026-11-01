/**
 * Freezes this thread (timers, IPC and HTTP included) for `ms`, counted on the monotonic clock.
 *
 * Not `Atomics.wait`: Bun keeps its deadline on the wall clock, so a step back of the machine's clock stretches it by
 * the step. WSL's time sync steps back ~2 s about every 30 s (2026-10-30: 8 of 8 steps stretched a 50 ms wait to
 * 2.1-2.2 s), which turned a 3 s child pause into 5 s and failed a supervisor test once in ~70 runs.
 */
export function blockThread(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Spin: nothing here may yield to the event loop.
  }
}
