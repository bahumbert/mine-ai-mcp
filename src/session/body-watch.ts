// The limits an owner of the body is held to (no physics tick, a ceiling, no progress) and how a watched run ends.
import { watchForStall, type StallClock } from "../actions/stall-watch.js";
import type { BodyAbort, ReflexLimitKind } from "./abort.js";

/** The first limit an owner of the body ran into; the owner's controller was aborted with `abort`. */
export interface BodyLimitHit {
  readonly limit: ReflexLimitKind;
  /** How long the limit measured: the silence since the last tick or the first check owing one (`physics_stalled`), the claim's age (`ceiling`), the window (`no_progress`). */
  readonly elapsedMs: number;
  readonly abort: BodyAbort;
}

/** What `watchBodyOwner` needs to know about one owner of the body and the clock it is held against. */
export interface BodyWatchOptions {
  /** The action or reflex that owns the body: named in the texts and handed to `onLimit`'s texts. */
  readonly owner: string;
  /** The owner's cancel signal: a cancel the owner cannot act on (no physics tick) ends the watch after the grace. */
  readonly signal: AbortSignal;
  /** Aborted with `abortFor`'s abort when a limit trips: this is how a limit tells the owner to stop. */
  readonly controller: AbortController;
  /** The monotonic clock every limit reads: limits that wait for a tick are blind in exactly the case they guard. */
  readonly clock: StallClock;
  /** How long the owner may go without a physics tick while `physicsExpected()`; unset: no stall limit, no cancel grace. */
  readonly stallMs?: number;
  /** How long the owner may hold the body, however well it progresses; unset: none. */
  readonly ceilingMs?: number;
  /** How long `marks()` may stay unchanged; any change of the count is progress; unset: none. */
  readonly noProgress?: { readonly ms: number; readonly marks: () => number };
  /** How long an owner told to stop (a limit, a cancel with no tick) has to settle before the body is released anyway. */
  readonly cancelGraceMs: number;
  /** The clock reading of the last physics tick, read at every check. */
  readonly lastPhysicsTickAt: () => number;
  /**
   * False while the bot is a passenger: Mineflayer turns physics off for the ride, so no tick is owed. The stall limit
   * counts the silence from the first check that sees this true again after a check that saw it false.
   */
  readonly physicsExpected: () => boolean;
  /** Ends the watch without a verdict when it aborts: the connection ended, the pending work can never settle. */
  readonly abandon?: AbortSignal;
  /** The abort a limit tells the owner to stop with (its cause and its text). */
  readonly abortFor: (limit: ReflexLimitKind, elapsedMs: number) => BodyAbort;
  readonly cancelledWithoutTicks: (owner: string, reason: string) => string;
  /** Called once, right after the owner's controller is aborted: the caller records it and restarts physics. */
  readonly onLimit: (hit: BodyLimitHit) => void;
}

/**
 * How a watched run ended. `settled` and `threw` are the run's own end (a hit before it is still reported: the owner
 * stopped inside the grace); `released` is the watch giving up on a run that did not stop, which may settle later and
 * changes nothing then. `cancelled` is set when the release was a cancel with no tick to carry it out.
 */
export type BodyWatchEnd<Value> =
  | { readonly kind: "settled"; readonly value: Value; readonly hit: BodyLimitHit | null }
  | { readonly kind: "threw"; readonly cause: unknown; readonly hit: BodyLimitHit | null }
  | { readonly kind: "released"; readonly hit: BodyLimitHit | null; readonly cancelled: string | null };

/** How often the limits are checked: a quarter of the shortest one, 10 to 250 ms. */
const checkEveryMs = (shortestMs: number) => Math.max(10, Math.min(250, Math.floor(shortestMs / 4)));

/** Calls `onStalled` once when `marks()` stays unchanged for `noProgress.ms`; returns the stop. */
function watchNoProgress(noProgress: NonNullable<BodyWatchOptions["noProgress"]>, clock: StallClock, onStalled: () => void): () => void {
  // The position is not read: `watchForStall` only reports how far the body walked in its description.
  const stalled = watchForStall({
    work: noProgress.marks,
    position: () => ({ x: 0, y: 0, z: 0 }),
    stallMs: noProgress.ms,
    sampleMs: checkEveryMs(noProgress.ms),
    clock,
    describe: () => "no progress",
  });
  stalled.signal.addEventListener("abort", onStalled, { once: true });
  return stalled.close;
}

/**
 * Holds the owner of the body to its limits and settles with `run`, or earlier when the owner does not stop.
 *
 * Three limits, one clock: no physics tick for `stallMs` while one is owed, counted from the later of the last tick and
 * the first check that owes one after a span that owed none, so a ride is not silence (a seated span shorter than one
 * check goes unseen and counts as silence; live run 14: twelve
 * bots left mounted at sea never ticked again, their navigate never returned and ignored its cancel; run 20: a 36 s ride
 * tripped it the moment the get-off made a tick owed), a ceiling on how long the body is held, and no
 * progress mark for the no-progress window (SRV-01: a reflex that waits on ticks or events that never come held the
 * body for good). The first to trip aborts the owner's controller and calls `onLimit` (the runtime records an incident
 * and restarts physics); the owner then has `cancelGraceMs` to settle on the returning ticks before the body is
 * released (run 14b: left running, the old navigate held the navigation for good). A cancelled owner that cannot stop
 * for want of ticks is released after the grace too. Every timer stops when the watch ends, on any path.
 */
export function watchBodyOwner<Value>(run: Promise<Value>, options: BodyWatchOptions): Promise<BodyWatchEnd<Value>> {
  const { clock, stallMs, ceilingMs, noProgress } = options;
  if (stallMs === undefined && ceilingMs === undefined && noProgress === undefined) {
    return run.then(
      (value): BodyWatchEnd<Value> => ({ kind: "settled", value, hit: null }),
      (cause: unknown): BodyWatchEnd<Value> => ({ kind: "threw", cause, hit: null }),
    );
  }
  const startedAt = clock.now();
  return new Promise((resolve) => {
    let hit: BodyLimitHit | null = null;
    let hitAt = 0;
    let cancelledAt: number | null = null;
    let owedSince = startedAt;
    let owedAtLastCheck = true;
    let finished = false;
    const stops: Array<() => void> = [];
    const finish = (end: BodyWatchEnd<Value>) => {
      if (finished) return;
      finished = true;
      for (const stop of stops) stop();
      resolve(end);
    };
    const trip = (limit: ReflexLimitKind, elapsedMs: number) => {
      if (hit !== null || finished) return;
      hit = { limit, elapsedMs, abort: options.abortFor(limit, elapsedMs) };
      hitAt = clock.now();
      options.controller.abort(hit.abort);
      options.onLimit(hit);
    };
    const check = () => {
      const now = clock.now();
      if (hit !== null) {
        if (now - hitAt >= options.cancelGraceMs) finish({ kind: "released", hit, cancelled: null });
        return;
      }
      if (stallMs !== undefined) {
        if (options.signal.aborted && cancelledAt === null) cancelledAt = now;
        const owed = options.physicsExpected();
        // A passenger owes no tick (Mineflayer emits no physicsTick while seated: facts navigation-and-boats.md "Reflexes sense seated through onBodyTick"): the silence counts from the first check that owes one again (run 20, Vex).
        if (owed && !owedAtLastCheck) owedSince = now;
        owedAtLastCheck = owed;
        const lastTick = Math.max(options.lastPhysicsTickAt(), startedAt);
        if (cancelledAt !== null && now - Math.max(lastTick, cancelledAt) >= options.cancelGraceMs) {
          const reason = options.signal.reason instanceof Error ? options.signal.reason.message : "cancelled";
          finish({ kind: "released", hit: null, cancelled: options.cancelledWithoutTicks(options.owner, reason) });
          return;
        }
        const silentMs = now - Math.max(lastTick, owedSince);
        if (owed && silentMs >= stallMs) {
          trip("physics_stalled", silentMs);
          return;
        }
      }
      if (ceilingMs !== undefined && now - startedAt >= ceilingMs) trip("ceiling", now - startedAt);
    };
    const shortest = Math.min(...[stallMs, ceilingMs].filter((ms): ms is number => ms !== undefined));
    if (Number.isFinite(shortest)) stops.push(clock.every(check, checkEveryMs(shortest)));
    if (noProgress !== undefined) stops.push(watchNoProgress(noProgress, clock, () => trip("no_progress", noProgress.ms)));
    const onAbandon = () => finish({ kind: "released", hit, cancelled: null });
    if (options.abandon?.aborted) onAbandon();
    options.abandon?.addEventListener("abort", onAbandon, { once: true });
    stops.push(() => options.abandon?.removeEventListener("abort", onAbandon));
    run.then(
      (value) => finish({ kind: "settled", value, hit }),
      (cause: unknown) => finish({ kind: "threw", cause, hit }),
    );
  });
}
