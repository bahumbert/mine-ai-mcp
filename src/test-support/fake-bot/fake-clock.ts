/** The fake bot's clock: time a test moves by hand, in 50 ms slices, optionally standing in for the global timers. */
import { after, mock } from "node:test";
import type { StallClock } from "../../actions/stall-watch.js";

export type FakeClockMode = "manual" | "mocked";

/** What runs in each slice after the timers, in this order: the server's packets, then the client's physics tick. */
export type SliceStage = "server" | "physics";

export interface FakeClockOptions {
  /**
   * `manual`: only code that reads this clock sees time move. `mocked`: `install()` also drives node's mock timers
   * (`setTimeout`, `setInterval`, `Date`) and `performance.now`, for code under test that reads the globals.
   */
  readonly mode: FakeClockMode;
  /** The clock's reading before any `advance`, and `Date.now()` once installed. */
  readonly startMs?: number;
}

export interface FakeClock extends StallClock {
  readonly mode: FakeClockMode;
  /** Milliseconds of clock: `startMs` plus every `advance` so far. */
  readonly now: () => number;
  /** Call `tick` each time `ms` of clock have passed, until the returned function is called. */
  readonly every: (tick: () => void, ms: number) => () => void;
  /** Call `fire` once, `ms` of clock from now; the returned function cancels it. */
  after(ms: number, fire: () => void): () => void;
  /** Resolve after `ms` of clock (`WorldAgeOptions.sleep`, `DropClock.sleep`); reject with the signal's reason on abort. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Move time on in `stepMs` slices: timers, server, physics, then the promise queue drained, once per slice. */
  advance(ms: number, stepMs?: number): Promise<void>;
  /**
   * Move time on in `stepMs` slices until `promise` settles, then return its value or rethrow its error; reject naming
   * `maxMs` when it is still pending after that much clock. For code under test that waits on this clock while it runs.
   */
  settle<T>(promise: Promise<T>, maxMs: number, stepMs?: number): Promise<T>;
  /** Run `step` once per slice at `stage`, with the slice's length; the returned function removes it. */
  onSlice(stage: SliceStage, step: (sliceMs: number) => void): () => void;
  /** Timers (`after`, `every`, `sleep`) still waiting: a wait that is over leaves none. */
  pendingTimers(): number;
  /** `mocked` only: take over the global timers and `performance.now` until disposed (`using`). */
  install(): Disposable;
}

/** The node mock timer APIs a mocked clock takes over. `setImmediate` stays real: `flush` needs it. */
const MOCKED_APIS = ["setTimeout", "setInterval", "Date"] as const;

/** One installed clock at a time: node's mock timers are global, so two would fight over them. `by` is where it was installed (a `file:line`). */
let installed: { restore(): void; readonly by: string } | null = null;

/** The first `file:line` of the stack outside this file: the test that called `install()`. */
function installerOfThisCall(): string {
  const frames = (new Error().stack ?? "").split("\n").slice(1);
  const outside = frames.find((frame) => !frame.includes("fake-clock.ts"));
  return outside?.match(/(?:\(|\bat )(.+?:\d+):\d+\)?\s*$/)?.[1] ?? "an unknown caller";
}

/** Lets every promise reaction already queued run, timers included. */
export async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Restore the globals of a mocked clock a test forgot to dispose, and fail that test naming it. `install()` registers
 * it as the test's `after` hook, so a leaked clock never runs into the next test's timers.
 */
export function failIfFakeClockLeftInstalled(): void {
  if (installed === null) return;
  installed.restore();
  throw new Error("fake clock left installed: dispose it (`using installed = clock.install()`) before the test ends");
}

interface ClockTimer {
  due: number;
  readonly fire: () => void;
  /** Set for `every`: the timer comes back this long after each firing. */
  readonly periodMs?: number;
}

/** Fire every timer due by `now`, earliest first, a periodic one as many times as its period fits. */
function fireDueTimers(timers: Set<ClockTimer>, now: number): void {
  for (;;) {
    let next: ClockTimer | undefined;
    for (const timer of timers) if (timer.due <= now && (next === undefined || timer.due < next.due)) next = timer;
    if (next === undefined) return;
    if (next.periodMs === undefined) timers.delete(next);
    else next.due += next.periodMs;
    next.fire();
  }
}

/** Take over node's mock timers and `performance.now` for `clock`; the returned function gives them back. */
function installGlobals(now: () => number): () => void {
  const realPerformanceNow = performance.now;
  mock.timers.enable({ apis: [...MOCKED_APIS], now: now() });
  performance.now = now;
  return () => {
    mock.timers.reset();
    performance.now = realPerformanceNow;
  };
}

export function createFakeClock(options: FakeClockOptions): FakeClock {
  const startMs = options.startMs ?? 0;
  let elapsed = 0;
  let ownsGlobals = false;
  const timers = new Set<ClockTimer>();
  const stages: Record<SliceStage, Set<(sliceMs: number) => void>> = { server: new Set(), physics: new Set() };
  const now = () => startMs + elapsed;
  const schedule = (timer: ClockTimer) => {
    timers.add(timer);
    return () => void timers.delete(timer);
  };
  const clock: FakeClock = {
    mode: options.mode,
    now,
    every: (tick, ms) => schedule({ due: now() + ms, fire: tick, periodMs: Math.max(1, ms) }),
    after: (ms, fire) => schedule({ due: now() + ms, fire }),
    sleep: (ms, signal) => sleepOnClock(clock, ms, signal),
    async advance(ms, stepMs = 50) {
      if (!(ms >= 0) || !(stepMs > 0)) throw new RangeError(`advance(${ms}, ${stepMs}): ms >= 0 and stepMs > 0`);
      // What the test started before advancing (a dig's look, a packet) runs at the time it was started.
      await flush();
      for (let passed = 0; passed < ms; ) {
        const sliceMs = Math.min(stepMs, ms - passed);
        passed += sliceMs;
        elapsed += sliceMs;
        if (ownsGlobals) mock.timers.tick(sliceMs);
        fireDueTimers(timers, now());
        for (const step of [...stages.server]) step(sliceMs);
        for (const step of [...stages.physics]) step(sliceMs);
        await flush();
      }
    },
    settle: (promise, maxMs, stepMs = 50) => settleOnClock(clock, promise, maxMs, stepMs),
    onSlice(stage, step) {
      stages[stage].add(step);
      return () => void stages[stage].delete(step);
    },
    pendingTimers: () => timers.size,
    install() {
      if (options.mode !== "mocked") throw new Error("a manual fake clock does not install: create it with mode mocked");
      const by = installerOfThisCall();
      if (installed !== null) throw new Error(`a fake clock is already installed by ${installed.by}: dispose it (\`using installed = clock.install()\`) before installing another`);
      const restoreGlobals = installGlobals(now);
      ownsGlobals = true;
      const handle = {
        by,
        restore() {
          if (installed !== handle) return;
          restoreGlobals();
          ownsGlobals = false;
          installed = null;
        },
      };
      installed = handle;
      after(failIfFakeClockLeftInstalled);
      return { [Symbol.dispose]: () => handle.restore() };
    },
  };
  return clock;
}

/** `FakeClock.settle`: one slice at a time, so the clock stops in the slice the promise settled in. */
async function settleOnClock<T>(clock: FakeClock, promise: Promise<T>, maxMs: number, stepMs: number): Promise<T> {
  let outcome: { readonly value: T } | { readonly error: unknown } | null = null;
  promise.then(
    (value) => void (outcome = { value }),
    (error: unknown) => void (outcome = { error }),
  );
  await flush();
  for (let passed = 0; outcome === null && passed < maxMs; passed += stepMs) await clock.advance(Math.min(stepMs, maxMs - passed), stepMs);
  const settled = outcome as { readonly value: T } | { readonly error: unknown } | null;
  if (settled === null) throw new Error(`the promise did not settle within ${maxMs} ms of clock`);
  if ("error" in settled) throw settled.error;
  return settled.value;
}

/** A sleep on the fake clock, with its abort listener and timer removed in one place whichever ends it. */
function sleepOnClock(clock: FakeClock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      cancel();
      reject(signal?.reason);
    };
    const cancel = clock.after(ms, () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
