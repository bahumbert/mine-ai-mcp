import assert from "node:assert/strict";
import test from "node:test";
import type { StepRecord } from "./mind.ts";
import { loopVerdict, type LoopState } from "./step-loop-rules.ts";

const LIMITS = { maxSameStepInARow: 3, maxSkillFailuresInARow: 6 };

const failed = (step: string, detail: string): StepRecord => ({ step, outcome: "failed", detail });
const done = (step: string, detail: string): StepRecord => ({ step, outcome: "done", detail });

/** The state after `steps` ran, each leaving the inventory in `carried` (one entry per step). */
function stateAfter(steps: StepRecord[], carried: (string | null)[] = steps.map(() => "dirt:1")): LoopState {
  return { steps, carried, failing: { skill: "", count: 0 } };
}

function verdictOf(state: LoopState, skill = "collect_block", limits = LIMITS): string | null {
  return loopVerdict(state, state.steps.at(-1)!, skill, limits);
}

test("the same step failing the same way in a row ends the objective", () => {
  const lost = failed("collect 5 birch_log", "no birch_log within 64 blocks");
  assert.equal(verdictOf(stateAfter([lost, lost])), null);
  assert.equal(verdictOf(stateAfter([lost, lost, lost])), "collect 5 birch_log failed the same way 3 times in a row: no birch_log within 64 blocks");
});

test("the same step done in a row with the inventory unchanged changed nothing; with it changing, it is the same step not reaching the objective", () => {
  const collect = done("collect 32 cobblestone", "collected 32 cobblestone");
  assert.equal(verdictOf(stateAfter([collect, collect, collect], ["a:1", "a:1", "a:1"])), "collect 32 cobblestone changed nothing 3 times in a row: collected 32 cobblestone");
  assert.equal(verdictOf(stateAfter([collect, collect, collect], ["a:1", "a:33", "a:65"])), "the same step (collect 32 cobblestone) was done 3 times in a row and the objective is not reached");
});

test("a drop that worked is never counted as gaining, whatever the inventory did", () => {
  const drop = done("drop 4 dirt", "dropped 4 dirt");
  assert.equal(verdictOf(stateAfter([drop, drop, drop], ["a:9", "a:5", "a:9"]), "drop_item"), "drop 4 dirt changed nothing 3 times in a row: dropped 4 dirt");
});

test("a failure or another step in between breaks the in-a-row count of the same step", () => {
  const collect = done("collect 16 dirt", "collected 16 dirt");
  const sand = done("collect 16 sand", "collected 16 sand");
  assert.equal(verdictOf(stateAfter([collect, sand, collect], ["a:1", "a:2", "a:3"])), null);
  assert.equal(verdictOf(stateAfter([collect, failed("collect 16 dirt", "no dirt"), collect], ["a:1", "a:2", "a:3"])), null);
});

test("the same failure between other steps ends the objective", () => {
  const lost = failed("collect 5 birch_log", "no birch_log within 64 blocks");
  const craft = failed("craft 1 birch_thing", "no such item");
  assert.equal(verdictOf(stateAfter([lost, craft, lost, craft, lost])), "collect 5 birch_log failed the same way 3 times: no birch_log within 64 blocks");
  assert.equal(verdictOf(stateAfter([lost, craft, lost])), null);
});

test("a failed step written differently but with the same detail counts as the same failure", () => {
  const detail = "25 not tillable (air)";
  const steps = [failed("farm wheat", detail), failed("farm wheat 5x5", detail), failed("farm carrots", detail)];
  assert.equal(verdictOf(stateAfter(steps)), "farm carrots failed the same way 3 times: 25 not tillable (air)");
});

test("one skill failing in a row, however it is tried, ends the objective at the limit and any other outcome resets the count", () => {
  const state = stateAfter([failed("a", "x1")]);
  state.failing = { skill: "collect_block", count: 5 };
  assert.equal(verdictOf(state, "collect_block"), "collect block failed 6 times in a row, whichever way it was tried; the last: x1");
  assert.deepEqual(state.failing, { skill: "collect_block", count: 6 });
  const other = stateAfter([done("b", "ok")]);
  other.failing = { skill: "collect_block", count: 5 };
  assert.equal(verdictOf(other, "craft_item"), null);
  assert.deepEqual(other.failing, { skill: "", count: 0 });
});

test("an interrupted step ends nothing and leaves the failure streak as it was", () => {
  const state = stateAfter([done("a", "ok"), done("a", "ok"), { step: "a", outcome: "interrupted", detail: "set aside" }]);
  state.failing = { skill: "collect_block", count: 4 };
  assert.equal(verdictOf(state), null);
  assert.deepEqual(state.failing, { skill: "collect_block", count: 4 });
});
