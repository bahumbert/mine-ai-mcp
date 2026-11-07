import { monotonicNow } from "../../../utils/index.js";
import type { Budgets, ProgressBudget } from "../../state/budgets.js";
import { tickBudgetWallMs } from "./progress.js";

/** Time spent at one refuge: its physics ticks, and the wall time those ticks would span (`tickBudgetWallMs`). */
class RefugeClock {
  ticks = 0;
  #bankedMs = 0;
  #runningSince: number | null = null;

  /** Wall milliseconds counted so far, including the stretch still running. */
  get wallMs(): number {
    return this.#bankedMs + (this.#runningSince === null ? 0 : monotonicNow() - this.#runningSince);
  }

  /** Count wall time from now on (a no-op while counting). */
  resume(): void {
    this.#runningSince ??= monotonicNow();
  }

  /** Stop counting wall time; what passed is kept. */
  pause(): void {
    this.#bankedMs = this.wallMs;
    this.#runningSince = null;
  }

  /** Confirmed quarry damage: ticks and wall time both start over (counting goes on if it was). */
  reset(): void {
    this.ticks = 0;
    this.#bankedMs = 0;
    if (this.#runningSince !== null) this.#runningSince = monotonicNow();
  }
}

/** One engagement remembers time spent at each refuge across temporary loss of
 * cover, retargeting and recovery. Recreating a plan cannot buy another wait.
 * The wait is counted in physics ticks and, as its wall twin, in wall time that
 * pauses while recovering and renews on confirmed damage exactly as the ticks do. */
export class ProtectedAttackProgress implements Disposable {
  readonly #spent = new Map<string, RefugeClock>();
  #current: { cell: string; clock: RefugeClock; budget: ProgressBudget } | null = null;

  constructor(
    readonly budgets: Budgets,
    readonly targetId: number,
    readonly limit: number,
  ) {}

  enter(cell: string): ProgressBudget {
    if (this.#current?.cell === cell) return this.#current.budget;
    this.leave();
    const clock = this.#spent.get(cell) ?? new RefugeClock();
    this.#spent.set(cell, clock);
    clock.resume();
    const budget = this.budgets.progress({
      name: "protected_attack",
      scope: `target:${this.targetId}:cell:${cell}`,
      unit: "ticks",
      measure: () => clock.ticks,
      startedAt: 0,
      limit: this.limit,
      wall: { limitMs: tickBudgetWallMs(this.limit), measure: () => clock.wallMs, startedAt: 0 },
      progress: "confirmed_target_damage",
      exhaustion: "Reject this attack position; recovery has a separate clock.",
    });
    this.#current = { cell, clock, budget };
    return budget;
  }

  tick(recovering: boolean): void {
    if (!this.#current) return;
    if (recovering) this.#current.clock.pause();
    else {
      this.#current.clock.ticks++;
      this.#current.clock.resume();
    }
  }

  confirmedTargetDamage(): void {
    if (!this.#current) return;
    this.#current.clock.reset();
    this.#current.budget.observe("confirmed_target_damage");
  }

  leave(): void {
    this.#current?.clock.pause();
    this.#current?.budget[Symbol.dispose]();
    this.#current = null;
  }

  [Symbol.dispose](): void {
    this.leave();
  }
}
