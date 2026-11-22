// One engagement's confirmed-quarry-damage clock, paused during defence and recovery.
import type { Budgets, ProgressBudget } from "../../state/budgets.js";
import { serverPacedWallMs } from "../../../world/world-age.js";
import { RefugeClock } from "./attack-progress.js";

/** Partial time-packet intervals never charge time from before a hit or a pause (P4-29 a10). */
export class QuarryProgress implements Disposable {
  readonly #clock = new RefugeClock();
  #budget: ProgressBudget | null = null;
  #paused = true;
  #seenAge: number | null = null;
  #lastAge: number | null = null;
  constructor(readonly budgets: Budgets, readonly targetId: number, readonly limit: number,
    readonly age: () => number | null | undefined) {}

  /** A physical fight resumes the same engagement count, with one visible budget handle. */
  open(): ProgressBudget {
    if (this.#budget) return this.#budget;
    this.#paused = false;
    this.#clock.resume();
    this.#boundary();
    return this.#budget = this.budgets.progress({
      name: "quarry_progress", scope: `target:${this.targetId}`, unit: "ticks",
      measure: () => this.#clock.ticks, startedAt: 0, limit: this.limit,
      wall: { measure: () => this.#clock.wallMs, startedAt: 0, limitMs: serverPacedWallMs(this.limit) },
      progress: "confirmed_target_damage",
      exhaustion: "End the fight as unreachable; the hostile reflex remembers the target as answered.",
    });
  }

  #boundary(): void {
    this.#seenAge = this.age() ?? null;
    this.#lastAge = null;
  }

  /** Guard and recovery boundaries discard the unknown partial packet interval on each side. */
  tick(paused: boolean): void {
    if (!this.#budget) return;
    if (this.#paused !== paused) {
      this.#paused = paused;
      this.#boundary();
      if (paused) this.#clock.pause();
      else this.#clock.resume();
    }
    if (paused) return;
    const age = this.age() ?? null;
    if (age === null) { this.#clock.ticks++; return; }
    if (age === this.#seenAge) return;
    if (this.#lastAge !== null) this.#clock.ticks += Math.max(0, age - this.#lastAge);
    this.#seenAge = age;
    this.#lastAge = age;
  }

  /** Only a server receipt for damage to the requested quarry renews the bound. */
  confirmedTargetDamage(): void {
    if (!this.#budget) return;
    this.#clock.reset();
    this.#boundary();
    this.#budget.observe("confirmed_target_damage");
  }

  ticks(): number { return this.#clock.ticks; }

  /** A different engagement response keeps the spent ticks and wall time for the next fight. */
  leave(): void {
    this.#clock.pause();
    this.#paused = true;
    this.#budget?.[Symbol.dispose]();
    this.#budget = null;
  }
  [Symbol.dispose](): void { this.leave(); }
}
