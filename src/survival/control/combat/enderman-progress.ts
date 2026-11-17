// Quarry windows shared by the physical fights of one engagement.
import type { Budgets, ProgressBudget } from "../../state/budgets.js";
import { RefugeClock } from "./attack-progress.js";
import { tickBudgetWallMs } from "./progress.js";

type WindowKind = "return" | "provocation" | "roof";

/** A deflect or recovery between fights pauses quarry time without renewing it (P4-29 a8). */
export class EndermanProgress implements Disposable {
  readonly #spent = new Map<string, RefugeClock>();
  readonly #active = new Map<string, { targetId: number; clock: RefugeClock; budget: ProgressBudget }>();
  constructor(readonly budgets: Budgets, readonly limit: number) {}

  open(kind: WindowKind, targetId: number, cell: string | null): ProgressBudget {
    const key = `${kind}:${targetId}${cell === null ? "" : `:${cell}`}`;
    const current = this.#active.get(key);
    if (current) return current.budget;
    const clock = this.#spent.get(key) ?? new RefugeClock();
    this.#spent.set(key, clock);
    clock.resume();
    const budget = this.budgets.progress({
      name: kind === "return" ? "enderman_return" : kind === "roof" ? "enderman_roof" : "enderman_provocation",
      scope: `target:${targetId}${cell === null ? "" : `:cell:${cell}`}`,
      unit: "ticks",
      measure: () => clock.ticks,
      startedAt: 0,
      limit: this.limit,
      wall: { measure: () => clock.wallMs, startedAt: 0, limitMs: tickBudgetWallMs(this.limit) },
      progress: "confirmed_target_damage",
      exhaustion: kind === "provocation"
        ? "Return without constructing a roof when no hostility was observed."
        : "Return unreachable or reject this observed position; defensive hits and commands do not renew quarry progress.",
    });
    this.#active.set(key, { targetId, clock, budget });
    return budget;
  }

  tick(recovering: boolean): void {
    for (const { clock } of this.#active.values()) {
      if (recovering) clock.pause();
      else {
        clock.ticks++;
        clock.resume();
      }
    }
  }

  /** The receipt counts actual quarry ticks even when the wall twin exhausted first. */
  ticks(key: string): number {
    return this.#spent.get(key)?.ticks ?? 0;
  }

  confirmedTargetDamage(targetId: number): void {
    for (const entry of this.#active.values()) {
      if (entry.targetId !== targetId) continue;
      entry.clock.reset();
      entry.budget.observe("confirmed_target_damage");
    }
  }

  close(key: string): void {
    this.#active.get(key)?.clock.pause();
    this.#active.get(key)?.budget[Symbol.dispose]();
    this.#active.delete(key);
  }

  leave(): void {
    for (const key of this.#active.keys()) this.close(key);
  }

  [Symbol.dispose](): void {
    this.leave();
    this.#spent.clear();
  }
}
