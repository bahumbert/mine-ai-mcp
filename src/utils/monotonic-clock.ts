/**
 * Durations, deadlines and stand-downs read this clock, never `Date.now()`: WSL steps its wall clock back about 2 s
 * every 30 s, which stretches, shrinks or negates a difference of two wall readings. A time of day that is shown,
 * logged, persisted or sent to another process stays on `Date.now()`; a monotonic reading never leaves its process.
 */

/** Milliseconds on the monotonic clock, read at each call so an installed fake clock (`createFakeClock`) drives it. */
export function monotonicNow(): number {
  return performance.now();
}

/** A start read on both clocks: `at` an epoch time of day to show, `began` a monotonic reading to measure from. */
export interface ClockStart {
  readonly at: number;
  readonly began: number;
}

/** Two readings of one moment, for a value that is both a record and a duration base; the two are never mixed. */
export function clockStart(): ClockStart {
  return { at: Date.now(), began: monotonicNow() };
}

/** Whole milliseconds since a `monotonicNow()` reading, for the `int()` duration fields. */
export function elapsedSince(startedAt: number): number {
  return Math.round(monotonicNow() - startedAt);
}
