// The steps that failed lately for any objective, kept for the work tier, which refuses a second repeat.
import { FAILED_STEP_MINUTES, MOVED_BLOCKS, type EarlierFailure, type Objective } from "../mind.ts";
import { monotonicNow } from "../monotonic-clock.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";
import { carriedOf } from "./work.ts";

/** How many failed steps are kept (live 2026-10-10). */
const FAILED_STEP_MEMORY = 8;

export class FailedSteps {
  /** Steps that failed lately, whatever the objective, newest last: shown to the work tier, which refuses a second repeat. */
  private readonly failedSteps: { readonly objective: Objective; readonly step: string; readonly key: string; readonly detail: string; readonly at: number; readonly failures: readonly number[]; readonly carried: string | null; readonly position: Position | null }[] = [];

  /** A failed step, kept {@link FAILED_STEP_MINUTES} minutes (the latest of each step, with when it failed; at most {@link FAILED_STEP_MEMORY}). */
  remember(objective: Objective, step: string, key: string, detail: string, carried: string | null, position: Position | null): void {
    const now = monotonicNow();
    const before = this.failedSteps.find((failure) => failure.key === key)?.failures ?? [];
    const kept = this.failedSteps.filter((failure) => failure.key !== key);
    kept.push({ objective, step, key, detail, at: now, failures: [...before.filter((at) => now - at <= FAILED_STEP_MINUTES * 60_000), now], carried, position });
    this.failedSteps.splice(0, this.failedSteps.length, ...kept.slice(-FAILED_STEP_MEMORY));
  }

  /**
   * The steps that failed lately for any objective, this one included, most recent first. `changed`: the inventory or
   * the place in `snapshot` differs from the state after the step's last failure (unknown state: not changed).
   */
  earlier(snapshot: BotSnapshot): EarlierFailure[] {
    const carried = carriedOf(snapshot);
    const now = monotonicNow();
    return this.failedSteps
      .filter((failure) => now - failure.at <= FAILED_STEP_MINUTES * 60_000)
      .reverse()
      .map(({ step, key, detail, objective, at, failures, carried: after, position }) => ({
        step, key, detail, objective: objective.text, minutesAgo: Math.max(1, Math.round((now - at) / 60_000)), count: failures.filter((failed) => now - failed <= FAILED_STEP_MINUTES * 60_000).length,
        changed: (after !== null && after !== carried) || (position !== null && snapshot.position !== null && Math.hypot(position.x - snapshot.position.x, position.y - snapshot.position.y, position.z - snapshot.position.z) >= MOVED_BLOCKS),
      }));
  }
}
