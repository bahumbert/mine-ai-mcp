import type { Bot } from "mineflayer";
import { z } from "zod";
import { defineAction } from "../../actions/action.js";
import { onBodyTick, type BodyTick } from "../../runtime/body-ticks.js";
import { BodyAbort } from "../../session/abort.js";
import type { ActionRunner } from "../../session/action-runner.js";
import { pendingLifeSavingPlacements, removeLifeSavingPlacements, setLifeSavingRemovalContext, type LifeSavingRemovalContext } from "../../world/life-saving-placements.js";
import { isBurning, isInFire, isInLava } from "../perception/body.js";
import { hasFireDanger } from "../perception/fire-danger.js";
import { Answered } from "../state/answered.js";
import { Budgets } from "../state/budgets.js";
import type { ReflexDefinition, ReflexName, ReflexSnapshot, SurvivalTransition } from "./contract.js";
import { REFLEX_PRIORITY } from "./priority.js";
import { ReflexRegistration, type RegisteredReflex } from "./reflex-registration.js";

export interface ReflexDriverOptions {
  /** The monotonic clock the answered scopes' expiries are counted on (default `monotonicNow`); a test drives it. */
  readonly now?: () => number;
  readonly lifeSaving?: LifeSavingRemovalContext;
}

/** One ranked loop and one settlement path for all six survival responses. */
export class ReflexDriver implements AsyncDisposable {
  readonly answered: Answered;
  readonly budgets = new Budgets();
  readonly #registrations = new Map<ReflexName, RegisteredReflex>();
  readonly #observers = new Set<(transition: SurvivalTransition) => void>();
  #closed = false;
  #stopListening: (() => void) | null = null;
  #world = 0;
  #dimension: string;
  #removal: Promise<void> | null = null;
  #removalController: AbortController | null = null;
  #removalAt: string | null = null;
  readonly #retryRemoval = (): void => { this.#removalAt = null; };

  constructor(
    readonly bot: Bot,
    readonly runner: ActionRunner,
    options: ReflexDriverOptions = {},
  ) {
    this.answered = new Answered(options.now);
    if (options.lifeSaving) setLifeSavingRemovalContext(bot, options.lifeSaving);
    this.#dimension = bot.game?.dimension;
    bot.on("death", this.#death);
    bot.on("game", this.#game);
    // New terrain or supplies can make an unchanged stance safe to clean from (T9 review, 2026-11-09).
    bot.on("blockUpdate", this.#retryRemoval);
    bot.inventory.on("updateSlot", this.#retryRemoval);
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
    this.#removeWhenSafe();
  };

  /** The tick after settlement sees released registrations, unlike the outcome callback itself. */
  #removeWhenSafe(): void {
    if (this.#removal) return;
    if (this.runner.ownership().current !== null || !this.bot.entity.onGround ||
      isBurning(this.bot) || isInFire(this.bot) || isInLava(this.bot) ||
      this.snapshot().some((reflex) => reflex.response !== null)) {
      this.#removalAt = null;
      return;
    }
    const pending = pendingLifeSavingPlacements(this.bot).filter(entry => entry.dimension === this.bot.game.dimension);
    if (pending.length === 0) { this.#removalAt = null; return; }
    const at = `${this.bot.game.dimension}|${this.bot.entity.position}|${pending.map(entry => `${entry.cell}:${entry.recordedAt}`).join(";")}`;
    if (at === this.#removalAt) return;
    this.#removalAt = at;
    this.#removalController = new AbortController();
    this.#removal = this.#removePlacements(this.#removalController.signal).finally(() => {
      this.#removal = null;
      this.#removalController = null;
    });
  }

  /** A foreground body owner lets every reflex preempt cleanup through the runner's existing release path. */
  async #removePlacements(signal: AbortSignal): Promise<void> {
    const input = z.strictObject({});
    const action = defineAction({
      name: "remove_life_saving_placements", description: "Remove this bot's emergency placements when safe.",
      inputSchema: input, resultSchema: z.strictObject({ status: z.literal("succeeded") }),
      parse: (value) => input.parse(value), execution: { kind: "task" }, formatResult: () => "Emergency placement cleanup settled.",
      execute: async (_request, context) => {
        const result = await removeLifeSavingPlacements(this.bot, context.signal!, (left) => this.#publish({
          kind: "outcome", reflex: "recover_footing",
          evidence: { response: "remove_life_saving_placements", outcome: { kind: "placements_left", error: left.why } },
        }), () => hasFireDanger(this.bot));
        if (result.removed.length) this.#publish({
          kind: "outcome", reflex: "recover_footing",
          evidence: { response: "remove_life_saving_placements", outcome: {
            kind: "placements_removed",
            removed: result.removed.map(({ x, y, z }) => ({ x, y, z })),
          } },
        });
        return { status: "succeeded" as const };
      },
    });
    const output = await this.runner.run(action, {}, signal);
    if (output.result.status === "failed") this.#publish({
      kind: "outcome", reflex: "recover_footing",
      evidence: { response: action.name, kind: "cleanup_failed", why: output.result.error },
    });
  }

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
    this.#retryRemoval();
    this.#removalController?.abort(cause);
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
    this.#removalController?.abort(new Error("The survival driver closed."));
    this.#stopListening?.();
    this.bot.off("death", this.#death);
    this.bot.off("game", this.#game);
    this.bot.off("blockUpdate", this.#retryRemoval);
    this.bot.inventory.off("updateSlot", this.#retryRemoval);
    const closing = [...this.#registrations.values()].map((registration) => registration.close());
    await Promise.all(closing);
    await this.#removal;
    this.answered.clear();
    this.#registrations.clear();
  }
}
