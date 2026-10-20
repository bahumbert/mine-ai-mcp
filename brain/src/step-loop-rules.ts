// The rules that end an objective whose steps loop (moved out of Agent.advance, so each is tested alone).
import type { StepRecord } from "./mind.ts";

/** What the rules read of an objective's work; `failing` is the one field they update. */
export interface LoopState {
  /** Newest last, the step just run included. */
  readonly steps: readonly StepRecord[];
  /** What was carried after each of `steps` (name:count, sorted; null when unknown). */
  readonly carried: readonly (string | null)[];
  /** The skill whose steps failed last, and how many times in a row. */
  failing: { skill: string; count: number };
}

export interface LoopLimits {
  readonly maxSameStepInARow: number;
  readonly maxSkillFailuresInARow: number;
}

/**
 * Why the objective must end now, or null when its steps are not looping. `record` is the step just run (the last of
 * `state.steps`) and `skill` its skill. A model that keeps choosing a step that ends the same way is stuck; the loop
 * must not spin until the step cap.
 */
export function loopVerdict(state: LoopState, record: StepRecord, skill: string, limits: LoopLimits): string | null {
  const same = limits.maxSameStepInARow;
  const last = state.steps.slice(-same);
  const stuckInARow = record.outcome !== "interrupted" && !gainedInventory(state, record, skill, same) && last.length === same
    && last.every((step) => step.step === record.step && step.outcome === record.outcome && step.detail === record.detail);
  if (stuckInARow) return `${record.step} ${record.outcome === "done" ? "changed nothing" : "failed the same way"} ${same} times in a row: ${record.detail}`;
  // The same step done `same` times in a row ends the objective as failed, gaining or not (a requester must not be told
  // done) (live 2026-10-11 run 10: "collect 16 dirt" 60+ times, "get 1 oak_boat" 13): a gain that never ends the
  // objective is no progress for it. A failed or another step in between resets the count.
  if (record.outcome === "done" && last.length === same && last.every((step) => step.step === record.step && step.outcome === "done")) {
    return `the same step (${record.step}) was done ${same} times in a row and the objective is not reached`;
  }
  // The same failure between other steps is the same loop (live 2026-10-09: Ayla's farm in a cave failed "25 not
  // tillable (air)" 20 times in 11 minutes, each time after a different step; Vex's explore for coal_ore, 9 times in
  // four ways). The detail names what failed, so a step written differently that fails the same way counts too.
  if (record.outcome === "failed" && state.steps.filter((step) => step.outcome === "failed" && step.detail === record.detail).length >= same) {
    return `${record.step} failed the same way ${same} times: ${record.detail}`;
  }
  return skillFailureVerdict(state, record, skill, limits.maxSkillFailuresInARow);
}

/**
 * A step done each time but leaving the inventory different gained something (live 2026-10-09: three "collected 32
 * cobblestone" in a row ended an objective as "changed nothing"): only an unchanged inventory means it is stuck. A drop
 * is never "gaining": one that worked needs no repeat, and drop, pick up, drop moves the inventory too (live 2026-10-10
 * run 7: one drop step 26 times in a row).
 */
function gainedInventory(state: LoopState, record: StepRecord, skill: string, same: number): boolean {
  const carriedLast = state.carried.slice(-same);
  return record.outcome === "done" && skill !== "drop_item" && carriedLast.some((kept) => kept !== carriedLast[0]);
}

/** Counts one skill's failures in a row (any other outcome resets it; an interrupted step leaves it) and ends the objective at the limit. */
function skillFailureVerdict(state: LoopState, record: StepRecord, skill: string, limit: number): string | null {
  if (record.outcome === "interrupted") return null;
  state.failing = record.outcome === "failed"
    ? { skill, count: state.failing.skill === skill ? state.failing.count + 1 : 1 }
    : { skill: "", count: 0 };
  if (state.failing.count < limit) return null;
  return `${skill.replaceAll("_", " ")} failed ${state.failing.count} times in a row, whichever way it was tried; the last: ${record.detail}`;
}
