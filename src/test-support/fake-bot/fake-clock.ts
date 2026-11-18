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
  /**
   * Move time on in `stepMs` slices: timers, server, physics, then the promise queue drained, once per slice. A clock retired
   * by the test-start cleanup (its test ended with this call still running) never settles it.
   */
  advance(ms: number, stepMs?: number): Promise<void>;
  /**
   * Move time on in `stepMs` slices until `promise` settles, then return its value or rethrow its error; reject naming
   * `maxMs` when it is still pending after that much clock. For code under test that waits on this clock while it runs.
   * A clock retired by the test-start cleanup (its test ended with this call still running) never settles it.
   */
  settle<T>(promise: Promise<T>, maxMs: number, stepMs?: number): Promise<T>;
  /** Run `step` once per slice at `stage`, with the slice's length; the returned function removes it. */
  onSlice(stage: SliceStage, step: (sliceMs: number) => void): () => void;
  /** Timers (`after`, `every`, `sleep`) still waiting: a wait that is over leaves none. */
  pendingTimers(): number;
  /**
   * `mocked` and installed: the global `setTimeout`/`setInterval` timers the code under test made that have neither fired
   * (a timeout) nor been cleared; counted apart from `pendingTimers`. A subject that must leave no wall timer takes this
   * before and after (T6): the clock's own timers do not see it.
   */
  pendingGlobalTimers(): number;
  /**
   * `mocked` and installed only: move `Date.now()` by `deltaMs` and nothing else (not `performance.now`, `now()` or a
   * timer's due time), as WSL steps its wall clock under a running process. Steps add up; disposing undoes them.
   * `new Date()` is not moved (it reads the mock's own time): code under test reads `Date.now()` for a wall step.
   */
  stepWallClock(deltaMs: number): void;
  /** `mocked` only: take over the global timers and `performance.now` until disposed (`using`). */
  install(): Disposable;
}

/** The node mock timer APIs a mocked clock takes over. `setImmediate` stays real: `flush` needs it. */
const MOCKED_APIS = ["setTimeout", "setInterval", "Date"] as const;

/** One installed clock at a time: node's mock timers are global, so two would fight over them. `by` is where it was installed (a `file:line`). */
let installed: { restore(): void; retire(): void; readonly by: string } | null = null;

/** The retire function of each clock with an `advance` or `settle` running (`inFlight > 0`): the test-start cleanup retires them all. */
const pumping = new Set<() => void>();

/**
 * Bun fails a test at its time limit and runs no hook of it, and lets its body run on: a clock that test had installed is
 * still installed when the next test starts, and an `advance` or `settle` it was awaiting keeps pumping. The preload
 * `scripts/test-clock-cleanup.ts` (`bunfig.toml`) calls this at the start of every test, found under a `Symbol.for` key
 * because `src/` is typechecked with Node types only and cannot import it. It restores the leftover installed clock, then
 * retires it and every clock still running an `advance` or `settle`: those never settle, so an orphan pump stops silently
 * instead of throwing into whichever test runs next (spec `2026-11-18-unit-reds` D1).
 */
(globalThis as { [key: symbol]: unknown })[Symbol.for("mine-ai.restore-leftover-fake-clock")] = () => {
  const leftover = installed;
  leftover?.restore();
  leftover?.retire();
  for (const retire of [...pumping]) retire();
};

/**
 * One clock's retire flag and its running `advance`/`settle` calls. `retire` is set by the test-start cleanup (or by an outside
 * reset of the mock timers): every call of that clock then never settles. `track` counts a call as running from its
 * synchronous start to its end (a `settle`'s own `advance` counts apart), and keeps `retire` in `pumping` meanwhile.
 */
function pumpTracker(): { readonly retire: () => void; readonly isRetired: () => boolean; readonly track: <T>(run: () => Promise<T>) => Promise<T> } {
  let retired = false;
  let inFlight = 0;
  const retire = () => {
    retired = true;
    pumping.delete(retire);
  };
  const track = <T>(run: () => Promise<T>): Promise<T> => {
    inFlight += 1;
    if (!retired) pumping.add(retire);
    return run().finally(() => {
      inFlight -= 1;
      if (inFlight === 0) pumping.delete(retire);
    });
  };
  return { retire, isRetired: () => retired, track };
}

/** A promise that never settles: what a retired clock's `advance` and `settle` return, so the orphan body that awaits it just stays suspended. */
function parked<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/** The `file:line` of the test that called `install()`: the first stack frame in a `*.test.ts` file (a shared helper may call `install()` for it), else the first frame outside this file. */
function installerOfThisCall(): string {
  const frames = (new Error().stack ?? "").split("\n").slice(1).filter((frame) => !frame.includes("fake-clock.ts"));
  const caller = frames.find((frame) => /\.test\.ts:\d+/.test(frame)) ?? frames[0];
  return (caller?.match(/\((.+?:\d+):\d+\)\s*$/) ?? caller?.match(/\bat (.+?:\d+):\d+\s*$/))?.[1] ?? "an unknown caller";
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

/** The global timers made while a clock is installed that have not fired (a timeout) or been cleared: `FakeClock.pendingGlobalTimers`. */
const liveGlobalTimers = new Set<unknown>();

/**
 * A mocked create function that also remembers each handle it returns (the handles a clear must send to the mock) and
 * keeps it in `liveGlobalTimers` until its callback has run (a timeout; an interval stays) or a clear removes it.
 */
function recordMockHandles<Create extends (...args: never[]) => unknown>(createMocked: Create, mockHandles: Set<unknown>, once: boolean): Create {
  return ((callback: unknown, ...rest: unknown[]) => {
    const wrapped = typeof callback === "function" && once
      ? (...args: unknown[]) => { liveGlobalTimers.delete(handle); return Reflect.apply(callback, undefined, args); }
      : callback;
    const handle = Reflect.apply(createMocked, globalThis, [wrapped, ...rest]);
    mockHandles.add(handle);
    liveGlobalTimers.add(handle);
    return handle;
  }) as unknown as Create;
}

/** A clear that sends a handle the mock created to the mock's clear, and any other handle (a real timer made before the install) to the real one. */
function clearByHandleOrigin<Clear extends (handle: never) => void>(clearMocked: Clear, clearReal: Clear, mockHandles: Set<unknown>): Clear {
  return ((handle: unknown) => {
    liveGlobalTimers.delete(handle);
    if (mockHandles.has(handle)) Reflect.apply(clearMocked, globalThis, [handle]);
    else Reflect.apply(clearReal, globalThis, [handle]);
  }) as unknown as Clear;
}

/**
 * Take over node's mock timers and `performance.now` for `clock`; the returned function gives them back. While installed,
 * `clearTimeout`/`clearInterval` are the mock's, so a real timer created before the install would never be cleared: the
 * clears are routed by the handle's origin instead. The returned function puts the four real functions back.
 */
function installGlobals(now: () => number): () => void {
  const realPerformanceNow = performance.now;
  const realTimers = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval };
  mock.timers.enable({ apis: [...MOCKED_APIS], now: now() });
  performance.now = now;
  const mockHandles = new Set<unknown>();
  liveGlobalTimers.clear();
  globalThis.setTimeout = recordMockHandles(globalThis.setTimeout, mockHandles, true);
  globalThis.setInterval = recordMockHandles(globalThis.setInterval, mockHandles, false);
  globalThis.clearTimeout = clearByHandleOrigin(globalThis.clearTimeout, realTimers.clearTimeout, mockHandles);
  globalThis.clearInterval = clearByHandleOrigin(globalThis.clearInterval, realTimers.clearInterval, mockHandles);
  return () => {
    mock.timers.reset();
    liveGlobalTimers.clear();
    performance.now = realPerformanceNow;
    // Guard: `reset()` already gives back the four functions on Bun 1.4.2, but the wrapper must not outlive the install.
    globalThis.setTimeout = realTimers.setTimeout;
    globalThis.setInterval = realTimers.setInterval;
    globalThis.clearTimeout = realTimers.clearTimeout;
    globalThis.clearInterval = realTimers.clearInterval;
  };
}

/**
 * What `install()` checks first: a manual clock has nothing to install, and a mocked clock whose test has ended must not
 * install. Bun fails a test at its limit but lets its body run on, so a body that was slow before `install()` installs
 * after its own teardown and nothing would ever restore the globals for it.
 */
function installRefusal(mode: FakeClockOptions["mode"]): () => void {
  let testEnded = false;
  if (mode === "mocked") after(() => void (testEnded = true));
  return () => {
    if (mode !== "mocked") throw new Error("a manual fake clock does not install: create it with mode mocked");
    if (testEnded) throw new Error("this fake clock was made by a test that has ended (Bun lets a body run on past its time limit), so it is not installed: create the clock in the test that installs it, and keep the setup that can be slow before that test or at module level");
  };
}

/** `stepWallClock`: moves the mock `Date.now` by the sum of the steps; `undo` gives the mock's own `Date.now` back and forgets the steps. */
function wallStepper(): { readonly step: (deltaMs: number) => void; readonly undo: () => void } {
  let undoStep: (() => void) | null = null;
  let offsetMs = 0;
  return {
    step(deltaMs) {
      if (undoStep === null) {
        const mockDate = Date;
        const ownNow = mockDate.now;
        mockDate.now = () => ownNow.call(mockDate) + offsetMs;
        undoStep = () => {
          mockDate.now = ownNow;
        };
      }
      offsetMs += deltaMs;
    },
    undo() {
      undoStep?.();
      undoStep = null;
      offsetMs = 0;
    },
  };
}

/** One slice after the clock moved: the timers due, then the server stage, then the physics stage. */
function runSlice(timers: Set<ClockTimer>, stages: Record<SliceStage, Set<(sliceMs: number) => void>>, now: number, sliceMs: number): void {
  fireDueTimers(timers, now);
  for (const step of [...stages.server]) step(sliceMs);
  for (const step of [...stages.physics]) step(sliceMs);
}

export function createFakeClock(options: FakeClockOptions): FakeClock {
  const startMs = options.startMs ?? 0;
  let elapsed = 0;
  let ownsGlobals = false;
  /** The mock `Date` right after `install()`: Bun's reset of the mock timers between files shows as `globalThis.Date` being another. */
  let mockDate: DateConstructor | null = null;
  const pump = pumpTracker();
  const refuseInstall = installRefusal(options.mode);
  const wall = wallStepper();
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
    advance: (ms, stepMs = 50) => pump.track(async () => {
      if (!(ms >= 0) || !(stepMs > 0)) throw new RangeError(`advance(${ms}, ${stepMs}): ms >= 0 and stepMs > 0`);
      if (pump.isRetired()) return parked<void>();
      // What the test started before advancing (a dig's look, a packet) runs at the time it was started.
      await flush();
      for (let passed = 0; passed < ms; ) {
        if (pump.isRetired()) return parked<void>();
        if (ownsGlobals && globalThis.Date !== mockDate) {
          // Bun reset the mock timers under this pump (between files): `tick` would throw `Invalid state`, so stop silently.
          installed?.restore();
          pump.retire();
          return parked<void>();
        }
        const sliceMs = Math.min(stepMs, ms - passed);
        passed += sliceMs;
        elapsed += sliceMs;
        if (ownsGlobals) mock.timers.tick(sliceMs);
        runSlice(timers, stages, now(), sliceMs);
        await flush();
      }
      if (pump.isRetired()) return parked<void>();
    }),
    settle: (promise, maxMs, stepMs = 50) => pump.track(() => settleOnClock(clock, promise, maxMs, stepMs, pump.isRetired)),
    onSlice(stage, step) {
      stages[stage].add(step);
      return () => void stages[stage].delete(step);
    },
    pendingTimers: () => timers.size, pendingGlobalTimers: () => liveGlobalTimers.size,
    stepWallClock(deltaMs) {
      if (options.mode !== "mocked") throw new Error("a manual fake clock has no Date to step: create it with mode mocked");
      if (!ownsGlobals) throw new Error("this fake clock is not installed: install it (`using installed = clock.install()`) before stepping its wall clock");
      wall.step(deltaMs);
    },
    install() {
      refuseInstall();
      const by = installerOfThisCall();
      if (installed !== null) throw new Error(`a fake clock is already installed by ${installed.by}: dispose it (\`using installed = clock.install()\`) before installing another`);
      const restoreGlobals = installGlobals(now);
      ownsGlobals = true;
      mockDate = globalThis.Date;
      const handle = {
        by,
        retire: pump.retire,
        restore() {
          if (installed !== handle) return;
          wall.undo();
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

/**
 * `FakeClock.settle`: one slice at a time, so the clock stops in the slice the promise settled in. The handlers go on the
 * input first, so a retired settle (never settles: `isRetired`, checked at entry, after the first flush and before the
 * outcome is read) leaves no unhandled rejection of its input.
 */
async function settleOnClock<T>(clock: FakeClock, promise: Promise<T>, maxMs: number, stepMs: number, isRetired: () => boolean): Promise<T> {
  let outcome: { readonly value: T } | { readonly error: unknown } | null = null;
  promise.then(
    (value) => void (outcome = { value }),
    (error: unknown) => void (outcome = { error }),
  );
  if (isRetired()) return parked<T>();
  await flush();
  if (isRetired()) return parked<T>();
  for (let passed = 0; outcome === null && passed < maxMs; passed += stepMs) await clock.advance(Math.min(stepMs, maxMs - passed), stepMs);
  if (isRetired()) return parked<T>();
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
