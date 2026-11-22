// The one clock of an emergency evade: server ticks (world age) with a real-time wall only as the backstop.
import type { Bot } from "mineflayer";
import { monotonicNow } from "../../utils/index.js";
import { MS_PER_ON_TIME_TICK } from "../../world/world-age.js";
import { EVADE_AGE_STALE_BACKSTOP_MS, EVADE_AGE_STALE_TICKS } from "./evade-reach.js";
import { PacketCadence } from "./packet-cadence.js";

/**
 * The wall backstop is this many times the time the ticks take at 20 tps (owner rule 2026-11-16, "Server-paced budgets
 * count server ticks"): 300 ticks take 15 s at 20 tps and 30 s at 10 tps, plus up to one packet interval (2 s at 10)
 * before the age shows it, so 45 s is wider than both. A server at 5 tps (stress) is ended by the wall at ~225 ticks.
 * Local to the evade: the shared `tickBudgetWallMs` (2x) keeps its other callers.
 */
export const EVADE_WALL_FACTOR = 3;

/** The evade's budget in server ticks: `evade_timeout_ms` read as game time at 20 ticks a second. */
export function evadeBudgetTicks(policy: { readonly evade_timeout_ms: number }): number {
  return Math.ceil(policy.evade_timeout_ms / MS_PER_ON_TIME_TICK);
}

/**
 * Counts the world age the server sends (`bot.on("time")`, independent of physics) from the age at construction, or
 * from the first age heard when none was yet. Its `signal` aborts once: ticks spent or the wall passed. Disposing removes
 * the listener and the timer and never aborts.
 */
export class EvadeClock implements Disposable {
  readonly startedAtMs: number;
  readonly wallMs: number;
  readonly #bot: Bot;
  readonly #ticks: number;
  readonly #now: () => number;
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  #origin: number | null;
  #latest: number | null;
  /** When the age last changed: the construction if an age was known then, else the arrival of the first packet. */
  #movedAtMs: number | null;
  /** The server's own packet pace, for `staleAfterMs`. */
  readonly #cadence = new PacketCadence();
  #reason: "ticks" | "wall" | null = null;
  #disposed = false;

  constructor(bot: Bot, ticks: number, now: () => number = monotonicNow) {
    this.#bot = bot;
    this.#ticks = ticks;
    this.#now = now;
    this.startedAtMs = now();
    this.wallMs = ticks * MS_PER_ON_TIME_TICK * EVADE_WALL_FACTOR;
    const age = bot.time?.age;
    this.#origin = this.#latest = typeof age === "number" ? age : null;
    this.#movedAtMs = this.#origin === null ? null : this.startedAtMs;
    bot.on("time", this.#heard);
    this.#timer = setTimeout(() => this.#end("wall"), this.wallMs);
  }

  get signal(): AbortSignal { return this.#controller.signal; }

  get reason(): "ticks" | "wall" | null {
    this.#checkWall();
    return this.#reason;
  }

  get exhausted(): boolean { return this.reason !== null; }

  /** Server ticks since the origin; null until an age was heard. */
  elapsedTicks(): number | null {
    return this.#origin === null || this.#latest === null ? null : this.#latest - this.#origin;
  }

  /** Wall time left, at least 1 while not exhausted. */
  remainingMs(): number {
    return this.exhausted ? 0 : Math.max(1, this.wallMs - (this.#now() - this.startedAtMs));
  }

  /** When a time packet last changed the world age (the construction if an age was known then); null before any age. */
  ageMovedAtMs(): number | null { return this.#movedAtMs; }

  /**
   * How long the world age may stand still and still be fresh: `EVADE_AGE_STALE_TICKS` ticks at the pace of the last
   * packets (`PacketCadence`: the slowest of the last three paced intervals, 50 ms on time before any), at most the backstop.
   */
  staleAfterMs(): number {
    return Math.min(EVADE_AGE_STALE_TICKS * this.#cadence.msPerTick(), EVADE_AGE_STALE_BACKSTOP_MS);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#bot.off("time", this.#heard);
  }

  readonly #heard = (): void => {
    const age = this.#bot.time.age;
    if (typeof age !== "number") return;
    this.#origin ??= age;
    if (age !== this.#latest) {
      // A resent age is no move.
      this.#cadence.hear(age, this.#now());
      this.#movedAtMs = this.#now();
    }
    this.#latest = age;
    if (age - this.#origin >= this.#ticks) this.#end("ticks");
  };

  /** A timer that has not fired yet cannot hide a spent wall (the clock read is the truth). */
  #checkWall(): void {
    if (this.#reason === null && !this.#disposed && this.#now() - this.startedAtMs >= this.wallMs) this.#end("wall");
  }

  #end(reason: "ticks" | "wall"): void {
    if (this.#reason !== null || this.#disposed) return;
    this.#reason = reason;
    this.#controller.abort(new Error(reason === "ticks"
      ? `The evade spent its ${this.#ticks} server ticks.` : `The evade's ${this.wallMs} ms wall passed.`));
  }
}
