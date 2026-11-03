// The launcher's two clocks. A duration or a deadline reads `monotonicNow()`; only a time compared with an epoch time
// written by another process (a host's ISO `at`, the lock's `startedAt`) reads `wallNow()`. WSL steps its wall clock back
// about 2 s every 30 s and NTP steps it forward, which stretches, shrinks or negates a difference of two wall readings
// (the server's 30 s save wait cut short kills Java mid-save). A monotonic reading never leaves the process.

/** Milliseconds on the monotonic clock, read at each call. */
export function monotonicNow(): number {
  return performance.now();
}

/** The epoch time in milliseconds: for a record or a comparison with another process's record, never for a duration. */
export function wallNow(): number {
  return Date.now();
}
