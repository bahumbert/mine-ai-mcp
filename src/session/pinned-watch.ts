/**
 * Notices a bot that cannot get out of one place (run 15: Dirk 216 min, Sana 164 min, Finn 75 min, Lena 149 min, about
 * 14 % of all bot time). Pinned means the bot stayed within one block of one point for ten minutes while three
 * movement actions in a row failed. The watch reads the position itself on the injectable monotonic clock, so it
 * counts when physics ticks stop, and a death, a dimension change or a move of two blocks ends it.
 *
 * One watch per runtime, never shared: each pinned bot escapes and is refused on its own.
 */
import { MONOTONIC_CLOCK, type StallClock } from "../actions/stall-watch.js";
import type { ProgressPosition } from "./progress.js";

/** How long the bot must stay put while its movement actions fail (owner, 2026-10-18). */
const PINNED_WINDOW_MS = 10 * 60_000;
/** Movement actions that failed in a row since the bot last moved. */
const PINNED_FAILURES = 3;
/** Within this of the anchor the bot has not moved. */
const STAYED_BLOCKS = 1;
/** A move this far ends a pinned state, whatever moved the bot. */
const FREED_BLOCKS = 2;
const SAMPLE_MS = 5_000;
/** The last refusal text kept for the `[PINNED]` message. */
const REASON_CHARS = 400;

export interface PinnedWatchOptions {
  readonly position: () => ProgressPosition | null;
  /** Default monotonic; a test steps it by hand. */
  readonly clock?: StallClock;
  /** How long the bot must stay put (default ten minutes); a scenario shortens it to see the watch within seconds. */
  readonly windowMs?: number;
}

/** A span for the model to read: seconds up to two minutes, minutes after. */
function describeSpan(ms: number): string {
  return ms < 120_000 ? `${Math.ceil(ms / 1_000)} s` : `${Math.round(ms / 60_000)} min`;
}

function distance(a: ProgressPosition, b: ProgressPosition): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export class PinnedWatch {
  readonly #position: () => ProgressPosition | null;
  readonly #clock: StallClock;
  readonly #windowMs: number;
  readonly #stopSampling: () => void;
  #anchor: ProgressPosition | null = null;
  #anchoredAt = 0;
  #failures = 0;
  #lastRefusal = "";
  #pinned = false;
  /** When the last escape failed and left the bot in place; null when none is held against it. */
  #escapeFailedAt: number | null = null;

  constructor(options: PinnedWatchOptions) {
    this.#position = options.position;
    this.#clock = options.clock ?? MONOTONIC_CLOCK;
    this.#windowMs = options.windowMs ?? PINNED_WINDOW_MS;
    this.#stopSampling = this.#clock.every(() => this.#sample(), SAMPLE_MS);
    this.#sample();
  }

  /** A movement action failed with this text: the count that, with ten minutes in one place, pins the bot. */
  recordFailure(reason: string): void {
    this.#sample();
    this.#failures += 1;
    this.#lastRefusal = reason.slice(0, REASON_CHARS);
    this.#sample();
  }

  /** A movement action succeeded: the failures that count are in a row, and a pinned bot that got somewhere is not. */
  recordSuccess(): void {
    this.#sample();
    this.#failures = 0;
    this.#pinned = false;
    this.#escapeFailedAt = null;
  }

  isPinned(): boolean {
    this.#sample();
    return this.#pinned;
  }

  /** The escape ran and left the bot where it was: movement actions fail at once until a window passes or it moves. */
  escapeFailed(): void {
    this.#sample();
    if (this.#pinned) this.#escapeFailedAt = this.#clock.now();
  }

  /**
   * The `[PINNED]` failure a movement action gets without running, or null when it may run: always null before an
   * escape failed, and again once a full window has passed since the last failed escape (it runs the escape again).
   */
  refusal(): string | null {
    this.#sample();
    const failedAt = this.#escapeFailedAt;
    if (failedAt === null || this.#anchor === null) return null;
    const untilRetry = failedAt + this.#windowMs - this.#clock.now();
    if (untilRetry <= 0) return null;
    const { x, y, z } = this.#anchor;
    return (
      `[PINNED] Pinned within ${STAYED_BLOCKS} block of ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)} for ` +
      `${describeSpan(this.#clock.now() - this.#anchoredAt)}: ${this.#failures} movement actions failed there and an escape ` +
      `failed too (last refusal: ${this.#lastRefusal}). Movement will try an escape again in about ${describeSpan(untilRetry)} ` +
      `(or at once if something moves it ${FREED_BLOCKS} blocks); until then do work that needs no walking.`
    );
  }

  /** Forget the place: a death or a respawn starts the watch over. */
  clear(): void {
    this.#anchor = null;
    this.#failures = 0;
    this.#lastRefusal = "";
    this.#pinned = false;
    this.#escapeFailedAt = null;
    this.#sample();
  }

  close(): void {
    this.#stopSampling();
  }

  #restart(at: ProgressPosition): void {
    this.#anchor = at;
    this.#anchoredAt = this.#clock.now();
    this.#failures = 0;
    this.#pinned = false;
    this.#escapeFailedAt = null;
  }

  #sample(): void {
    const here = this.#position();
    if (here === null) return;
    const anchor = this.#anchor;
    if (anchor === null || here.dimension !== anchor.dimension) return this.#restart(here);
    const moved = distance(here, anchor);
    if (moved >= FREED_BLOCKS || (!this.#pinned && moved > STAYED_BLOCKS)) return this.#restart(here);
    if (this.#failures >= PINNED_FAILURES && this.#clock.now() - this.#anchoredAt >= this.#windowMs) this.#pinned = true;
  }
}

/** What the runtime does to get a pinned bot out; the runner calls it for a movement action while the bot is pinned. */
export interface PinnedEscape {
  /** Gets the body out of a boat, or swims it to the nearest breathable cell; best effort, bounded on the wall clock. */
  readonly leave: (signal: AbortSignal) => Promise<void>;
  /** While the handle is open, every route of this bot starts as an escape (`escape: true`). */
  readonly routesAsEscape: () => Disposable;
}
