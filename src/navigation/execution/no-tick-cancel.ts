/**
 * The cancel of a moving step when physics has stopped.
 *
 * The executor notices an abort on a physics tick. With no tick (a ride, an
 * unloaded chunk under the feet, a death waiting for the respawn) it would
 * wait for the runner's 30 s physics stall. Without client physics nothing is
 * in flight and no control has any effect, so a second of silence after the
 * abort is enough to settle the step as cancelled.
 */

/** Silence after an abort that reads as stopped physics: 20 client ticks. */
export const NO_TICK_CANCEL_MS = 1_000;

export interface NoTickCancelOptions {
  readonly signal: AbortSignal;
  /** When the last physics tick came, on `now`'s clock. */
  readonly lastTickAt: () => number;
  /** Called once, when the abort has met `noTickMs` without a tick. */
  readonly settle: () => void;
  /** Monotonic clock in ms; `performance.now` unless a test supplies one. */
  readonly now?: () => number;
  readonly noTickMs?: number;
}

/**
 * Nothing is armed until the signal aborts (an already aborted signal arms at
 * once). Then a timer checks the silence and settles once, or re-arms for the
 * time left. Disposing removes the listener and the timer.
 */
export function armNoTickCancel(options: NoTickCancelOptions): Disposable {
  const { signal, lastTickAt, settle, now = () => performance.now(), noTickMs = NO_TICK_CANCEL_MS } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const check = () => {
    timer = undefined;
    if (done) return;
    const silent = now() - lastTickAt();
    if (silent < noTickMs) {
      timer = setTimeout(check, noTickMs - silent);
      return;
    }
    done = true;
    settle();
  };
  const onAbort = () => {
    if (!done && timer === undefined) timer = setTimeout(check, noTickMs);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return {
    [Symbol.dispose]() {
      done = true;
      signal.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
