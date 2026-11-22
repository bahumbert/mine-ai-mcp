// Per-connection hit costs, attributed only to an unambiguous hurt followed by a health update.
import type { Bot } from "mineflayer";
import { botDefence } from "../../../world/combat-stats.js";
import { MELEE_RANGE } from "../../weapons/equipment.js";
import { MOB_MELEE_INTERVAL_TICKS } from "./threat-assessment.js";

type Entity = Bot["entity"];
interface Hit {
  readonly entity: Entity;
  readonly damage: number;
  readonly intervalTicks: number | null;
  readonly tick: number | null;
}

/** Health and absorption use the same unit, including a hit absorbed entirely by hearts. */
function effectiveHealth(bot: Bot): number {
  const { health, absorption } = botDefence(bot);
  return health + absorption;
}

/** Receives the perception's connection events without acquiring another set of bot listeners. */
export class ObservedHits {
  readonly #hits = new Map<number, Hit>();
  #dimension: string;
  #pending: { entity: Entity | undefined; before: number; tick: number } | null = null;

  constructor(readonly bot: Bot, readonly tick: () => number) {
    this.#dimension = bot.game.dimension;
  }

  /** A new life or dimension cannot inherit another fight's measurements. */
  reset(): void {
    this.#hits.clear();
    this.#pending = null;
    this.#dimension = this.bot.game.dimension;
  }

  /** The entity's removal also invalidates an outstanding attribution. */
  forget(entity: Entity): void {
    this.#hits.delete(entity.id);
    if (this.#pending?.entity === entity) this.#pending.entity = undefined;
  }

  /** Wait for the health packet before pricing this event; multiple causes are ambiguous. */
  hurt(entity: Entity | undefined, source: Entity | undefined): void {
    this.checkDimension();
    if (entity?.id !== this.bot.entity.id) return;
    if (this.#pending) {
      // An unattributable hit also breaks the proof that the next known hit is consecutive.
      for (const attacker of [this.#pending.entity, source]) {
        const previous = attacker && this.#hits.get(attacker.id);
        if (previous) this.#hits.set(previous.entity.id, { ...previous, tick: null, intervalTicks: null });
      }
      this.#pending.entity = undefined;
    } else this.#pending = { entity: source, before: effectiveHealth(this.bot), tick: this.tick() };
  }

  private checkDimension(): void {
    if (this.bot.game.dimension !== this.#dimension) this.reset();
  }

  private inReach(entity: Entity): boolean {
    return entity.isValid && this.bot.entities[entity.id] === entity &&
      entity.position.distanceTo(this.bot.entity.position) <= MELEE_RANGE;
  }

  /** A gap in melee reach breaks the evidence for the interval between consecutive hits. */
  checkReach(): void {
    this.checkDimension();
    for (const [id, hit] of this.#hits) {
      if (!this.inReach(hit.entity)) this.#hits.set(id, { ...hit, tick: null, intervalTicks: null });
    }
  }

  /** Use packet health: Mineflayer's health event and the shared fake file the packet at different times. */
  recordHealth(health: number): void {
    this.checkDimension();
    const pending = this.#pending;
    this.#pending = null;
    if (!pending?.entity || this.bot.entities[pending.entity.id] !== pending.entity) return;
    const damage = pending.before - health - botDefence(this.bot).absorption;
    if (!(damage > 0) || !Number.isFinite(damage)) return;
    const previous = this.#hits.get(pending.entity.id);
    const inReach = this.inReach(pending.entity);
    const elapsed = previous?.entity === pending.entity && previous.tick !== null && previous.tick !== undefined
      ? pending.tick - previous.tick : null;
    this.#hits.set(pending.entity.id, {
      entity: pending.entity, damage, tick: inReach ? pending.tick : null,
      intervalTicks: inReach && elapsed !== null && elapsed > 0 ? Math.min(elapsed, MOB_MELEE_INTERVAL_TICKS) : null,
    });
  }

  /** Unseen or forgotten damage is unknown; it is never recorded as a harmless hit. */
  read(entityId: number): { damage: number | null; intervalTicks: number | null } {
    this.checkReach();
    const hit = this.#hits.get(entityId);
    if (hit?.entity !== this.bot.entities[entityId]) return { damage: null, intervalTicks: null };
    return { damage: hit?.damage ?? null, intervalTicks: hit?.intervalTicks ?? null };
  }
}
