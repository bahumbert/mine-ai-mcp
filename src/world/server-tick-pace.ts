// Estimate server-metered durations from time packets; this never proves the server handled a request.
import type { Bot } from "mineflayer";
import { monotonicNow } from "../utils/index.js";
import { AGE_PACKET_TICKS, MS_PER_ON_TIME_TICK, STALE_AGE_TICKS } from "./world-age.js";

export interface TickMark {
  readonly ms: number;
  readonly age: number | null;
}

export interface ServerTickPace extends Disposable {
  mark(): TickMark;
  msPerTick(): number;
  creditedSince(mark: TickMark, nowMs?: number): number;
  ready(mark: TickMark, ticks: number, clientTicks: number): boolean;
  toServerTicks(perClientTick: number): number;
}

const observers = new WeakMap<Bot, ServerTickPace>();
const PACE_INTERVALS = 3;

/** One listener and the last three advancing packet intervals, owned by the connected runtime. */
class PacketTickPace implements ServerTickPace {
  readonly #intervals: number[] = [];
  #previous: TickMark | null = null;
  #latestAge: number | null;
  readonly #onTime = () => this.observeTime();

  constructor(private readonly bot: Bot) {
    this.#latestAge = bot.time.age ?? null;
    bot.on("time", this.#onTime);
  }

  /** Same-age `/time set` packets must not shorten the next measured interval (a11 T2, 2026-11-17). */
  private observeTime(): void {
    const age = this.bot.time.age ?? null;
    const previousAge = this.#previous?.age;
    if (age === null || (previousAge !== undefined && previousAge !== null && age <= previousAge)) return;
    const ms = monotonicNow();
    if (this.#previous !== null && this.#previous.age !== null) {
      this.#intervals.push((ms - this.#previous.ms) / (age - this.#previous.age));
      if (this.#intervals.length > PACE_INTERVALS) this.#intervals.shift();
    }
    this.#previous = { age, ms };
    this.#latestAge = age;
  }

  mark(): TickMark {
    return { ms: monotonicNow(), age: this.bot.time.age ?? null };
  }

  msPerTick(): number {
    return Math.max(MS_PER_ON_TIME_TICK, ...this.#intervals);
  }

  /**
   * A stopped clock can still earn up to 39 unrun ticks; a sent swing also precedes server handling by its latency.
   * These are duration estimates only; the reflex watchdog owns stopped clocks (owner choice a11 D1, 2026-11-17).
   */
  creditedSince(mark: TickMark, nowMs = monotonicNow()): number {
    if (mark.age === null || this.#latestAge === null) return 0;
    if (this.#intervals.length === 0) return Math.max(0, this.#latestAge - mark.age - STALE_AGE_TICKS);
    return Math.max(0, Math.min(
      (nowMs - mark.ms) / this.msPerTick(),
      this.#latestAge + AGE_PACKET_TICKS - mark.age,
    ));
  }

  ready(mark: TickMark, ticks: number, clientTicks: number): boolean {
    return clientTicks >= ticks && this.creditedSince(mark) >= ticks;
  }

  toServerTicks(perClientTick: number): number {
    return perClientTick * this.msPerTick() / MS_PER_ON_TIME_TICK;
  }

  [Symbol.dispose](): void {
    this.bot.off("time", this.#onTime);
    if (observers.get(this.bot) === this) observers.delete(this.bot);
  }
}

/** Get the connected bot's observer; the runtime installs it before any action and owns its disposal. */
export function serverTickPace(bot: Bot): ServerTickPace {
  let pace = observers.get(bot);
  if (!pace) {
    pace = new PacketTickPace(bot);
    observers.set(bot, pace);
  }
  return pace;
}
