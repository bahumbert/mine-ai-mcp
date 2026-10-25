/**
 * Wall-clock waits built on the global `setTimeout`, so node's mock timers (and the fake clock of
 * `src/test-support/fake-bot/`) reach them. `node:timers/promises` and `AbortSignal.timeout` keep their own timers,
 * which `mock.timers.tick` never fires (spec 2026-10-21-shared-fake-bot, "What the time can be faked with"): code
 * under test waits on these two instead.
 */

/**
 * Resolves after `ms`. An abort, before or during the wait, rejects with the signal's reason (what
 * `signal.throwIfAborted()` throws) and leaves neither the timer nor the abort listener behind.
 */
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

/**
 * An `AbortSignal` aborted after `ms` with a `TimeoutError` `DOMException`, the reason `AbortSignal.timeout` gives
 * (`describeAbort` reads it as a timeout). Like `AbortSignal.timeout`, its timer does not keep the process alive.
 */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
  if (typeof timer?.unref === "function") timer.unref();
  return controller.signal;
}
