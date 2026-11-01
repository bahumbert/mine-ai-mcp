/**
 * Durations, deadlines and quiet windows read this clock, never `Date.now()`: WSL steps its wall clock back about 2 s
 * every 30 s, which stretches, shrinks or negates a difference of two wall readings. A time of day that is shown,
 * written to a note or compared with an ISO time (the chat history, `Date.parse(iso)`) stays on `Date.now()`; a
 * monotonic reading never leaves the process. The brain is its own package, so this mirrors `src/utils/monotonic-clock.ts`.
 */

/** Milliseconds on the monotonic clock, read at each call so a test that moves `performance.now` drives it. */
export function monotonicNow(): number {
  return performance.now();
}

/** Whole milliseconds since a `monotonicNow()` reading. */
export function elapsedSince(startedAt: number): number {
  return Math.round(monotonicNow() - startedAt);
}
