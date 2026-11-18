// Quarry windows shared by the physical fights of one engagement.
import type { Budgets, ProgressBudget } from "../../state/budgets.js";
import { serverPacedWallMs } from "../../../world/world-age.js";
import { RefugeClock } from "./attack-progress.js";

type WindowKind = "return" | "provocation" | "roof";

interface ActiveWindow {
  readonly targetId: number;
  readonly clock: RefugeClock;
  readonly budget: ProgressBudget;
  recovering: boolean;
  seenAge: number | null;
  lastAge: number | null;
}

/** Each boundary discards the unknown partial time-packet interval (C16, 2026-11-18). */
function resetAgeBoundary(window: ActiveWindow, age: number | null): void {
  window.seenAge = age;
  window.lastAge = null;
}

/** Credit only complete forward packet intervals observed while this window is running. */
function countWorldAge(window: ActiveWindow, age: number | null): void {
  if (age === null || window.seenAge === null || age < window.seenAge) {
    resetAgeBoundary(window, age);
    return;
  }
  if (age === window.seenAge) return;
  if (window.lastAge !== null) window.clock.ticks += age - window.lastAge;
  window.seenAge = age;
  window.lastAge = age;
}

/** A deflect or recovery between fights pauses quarry time without renewing it (P4-29 a8). */
export class EndermanProgress implements Disposable {
  readonly #spent = new Map<string, RefugeClock>();
  readonly #active = new Map<string, ActiveWindow>();
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
      wall: { measure: () => clock.wallMs, startedAt: 0, limitMs: serverPacedWallMs(this.limit) },
      progress: "confirmed_target_damage",
      exhaustion: kind === "provocation"
        ? "Return without constructing a roof when no hostility was observed."
        : "Return unreachable or reject this observed position; defensive hits and commands do not renew quarry progress.",
    });
    this.#active.set(key, { targetId, clock, budget, recovering: false, seenAge: null, lastAge: null });
    return budget;
  }

  tick(recovering: boolean, age?: number | null): void {
    for (const window of this.#active.values()) {
      if (window.recovering !== recovering) {
        window.recovering = recovering;
        resetAgeBoundary(window, age ?? null);
        if (recovering) window.clock.pause();
        else window.clock.resume();
      }
      if (!recovering) countWorldAge(window, age ?? null);
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
      resetAgeBoundary(entry, null);
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
