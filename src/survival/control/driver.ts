import type { Bot } from "mineflayer";
import { onBodyTick, type BodyTick } from "../../runtime/body-ticks.js";
import { BodyAbort } from "../../session/abort.js";
import type { ActionRunner } from "../../session/action-runner.js";
import { Answered } from "../state/answered.js";
import { Budgets } from "../state/budgets.js";
import type { ReflexDefinition, ReflexName, ReflexSnapshot, SurvivalTransition } from "./contract.js";
import { REFLEX_PRIORITY } from "./priority.js";
import { ReflexRegistration, type RegisteredReflex } from "./reflex-registration.js";

export interface ReflexDriverOptions {
  /** The wall clock the answered scopes and their expiries read; a test steps it. */
  readonly now?: () => number;
}

/** One ranked loop and one settlement path for all six survival responses. */
export class ReflexDriver implements AsyncDisposable {
  readonly answered: Answered;
  readonly budgets = new Budgets();
  readonly #registrations = new Map<ReflexName, RegisteredReflex>();
  readonly #observers = new Set<(transition: SurvivalTransition) => void>();
  readonly #now: () => number;
  #closed = false;
  #stopListening: (() => void) | null = null;
  #world = 0;
  #dimension: string;

  constructor(
    readonly bot: Bot,
    readonly runner: ActionRunner,
    options: ReflexDriverOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.answered = new Answered(this.#now);
    this.#dimension = bot.game?.dimension;
    bot.on("death", this.#death);
    bot.on("game", this.#game);
  }

  onTransition(observer: (transition: SurvivalTransition) => void): () => void {
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }

  #publish(transition: SurvivalTransition): void {
    for (const observer of this.#observers) observer(transition);
  }

  /** The one place the driver learns that the body ticked: a physics tick, or while seated a wall-clock pace tick. */
  #listen(listener: (tick: BodyTick) => void): () => void {
    return onBodyTick(this.bot, listener);
  }

  /** A seated tick (the bot is a passenger, physics is off) reaches only the reflexes that can act from a seat. */
  readonly #tick = (tick: BodyTick): void => {
    if (this.#closed || this.bot.health <= 0 || !this.runner.ownership().connected) return;
    for (const name of REFLEX_PRIORITY) {
      const registration = this.#registrations.get(name);
      if (registration && (!tick.seated || registration.seated)) registration.tick();
    }
  };

  readonly #death = (): void => {
    this.#reset(new BodyAbort({ kind: "death" }, "The bot died."));
  };

  readonly #game = (): void => {
    const to = this.bot.game.dimension;
    if (to === this.#dimension) return;
    const from = this.#dimension;
    this.#dimension = to;
    this.#reset(new BodyAbort({ kind: "dimension_changed", from, to }, `Dimension changed from ${from} to ${to}.`));
  };

  #reset(cause: BodyAbort): void {
    this.#world++;
    this.answered.clear();
    for (const registration of this.#registrations.values()) registration.stop(cause);
  }

  /** Policy settlement waits for this response's effects, without unregistering its sensor. */
  async cancel(name: ReflexName, cause: BodyAbort): Promise<void> {
    const registration = this.#registrations.get(name);
    registration?.stop(cause);
    await registration?.settled();
  }

  register<Danger, Response, Outcome>(definition: ReflexDefinition<Danger, Response, Outcome>): AsyncDisposable {
    if (this.#closed) throw new Error("The survival driver is closed.");
    if (this.#registrations.has(definition.name)) throw new Error(`Duplicate reflex: ${definition.name}`);
    const registration = new ReflexRegistration(definition, {
      bot: this.bot,
      runner: this.runner,
      answered: this.answered,
      publish: (transition) => this.#publish(transition),
      world: () => this.#world,
      now: this.#now,
    });
    this.#registrations.set(definition.name, registration);
    // Register after shared packet/physics observers, so decisions use this tick's attribution.
    this.#stopListening ??= this.#listen(this.#tick);
    return {
      [Symbol.asyncDispose]: async () => {
        this.#registrations.delete(definition.name);
        await registration.close();
      },
    };
  }

  snapshot(): ReflexSnapshot[] {
    return REFLEX_PRIORITY.flatMap((name) => {
      const registration = this.#registrations.get(name);
      return registration ? [registration.snapshot()] : [];
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopListening?.();
    this.bot.off("death", this.#death);
    this.bot.off("game", this.#game);
    const closing = [...this.#registrations.values()].map((registration) => registration.close());
    await Promise.all(closing);
    this.answered.clear();
    this.#registrations.clear();
  }
}
