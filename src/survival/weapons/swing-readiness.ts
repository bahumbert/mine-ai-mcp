// One connected bot's estimate of its server-metered swing recovery.
import type { Bot } from "mineflayer";
import { onBodyTick } from "../../runtime/body-ticks.js";
import { serverTickPace, type TickMark } from "../../world/server-tick-pace.js";
import { MS_PER_ON_TIME_TICK } from "../../world/world-age.js";

export interface SwingReadiness extends Disposable {
  restart(): void;
  ready(cooldownTicks: number): boolean;
  clientTicksUntilReady(cooldownTicks: number): number;
}

const observers = new WeakMap<Bot, SwingReadiness>();

/** Main-hand type changes and commanded attacks restart the same recovery, across body owners. */
class BotSwingReadiness implements SwingReadiness {
  #mark: TickMark | null = null;
  #clientTicks = 0;
  #heldType: number | undefined;
  readonly #pace;
  #stopTicks: (() => void) | undefined;
  readonly #onTick = () => { if (this.#mark !== null) this.#clientTicks++; };
  readonly #onHeldItemChanged = () => {
    const type = this.bot.heldItem?.type;
    if (type !== this.#heldType) this.restart();
    this.#heldType = type;
  };

  constructor(private readonly bot: Bot) {
    this.#pace = serverTickPace(bot);
    this.#heldType = bot.heldItem?.type;
    try {
      bot.on("heldItemChanged", this.#onHeldItemChanged);
      // A mount stops physics; body ticks preserve the floor while the server pace still gates recovery (a11 T3c).
      this.#stopTicks = onBodyTick(bot, this.#onTick);
    } catch (cause) {
      this[Symbol.dispose]();
      throw cause;
    }
  }

  restart(): void {
    this.#mark = this.#pace.mark();
    this.#clientTicks = 0;
  }

  ready(cooldownTicks: number): boolean {
    return this.#mark === null || this.#pace.ready(this.#mark, cooldownTicks, this.#clientTicks);
  }

  clientTicksUntilReady(cooldownTicks: number): number {
    if (this.#mark === null || this.ready(cooldownTicks)) return 0;
    return Math.max(1, cooldownTicks - this.#clientTicks, Math.ceil(
      (cooldownTicks - this.#pace.creditedSince(this.#mark)) * this.#pace.msPerTick() / MS_PER_ON_TIME_TICK,
    ));
  }

  [Symbol.dispose](): void {
    this.bot.off("heldItemChanged", this.#onHeldItemChanged);
    this.#stopTicks?.();
    if (observers.get(this.bot) === this) observers.delete(this.bot);
  }
}

/** The runtime installs this before the first equip and disposes it with the connection. */
export function swingReadiness(bot: Bot): SwingReadiness {
  let readiness = observers.get(bot);
  if (!readiness) {
    readiness = new BotSwingReadiness(bot);
    observers.set(bot, readiness);
  }
  return readiness;
}

/** Send immediately; readiness gates belong to the caller's policy, never to this command. */
export function attackAndRestart(bot: Bot, target: Parameters<Bot["attack"]>[0]): void {
  const readiness = swingReadiness(bot);
  bot.attack(target);
  readiness.restart();
}
