/**
 * The brain's own copy of `src/utils/wall-timers.ts`, as it is a separate package (like `monotonic-clock.ts`).
 * Global timers let mocked clocks reach sleeps and request deadlines (plan 2026-11-15-unit-suite-parallel T9a).
 */

/** Resolves after `ms`, or rejects with an abort's reason, releasing its timer and abort listener on either path. */
export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Aborts after `ms` with TimeoutError, like AbortSignal.timeout, without keeping the process alive. */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
  if (typeof timer?.unref === "function") timer.unref();
  return controller.signal;
}
