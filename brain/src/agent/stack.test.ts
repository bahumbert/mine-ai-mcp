// Situation work retains the ordinary work it interrupted.
import test from "node:test";
import assert from "node:assert/strict";
import { neededWork, pushSituation, situationOf, topWork } from "./stack.ts";
import { newWork, type SituationState, type StepDecision } from "./work.ts";

const planned: StepDecision = { kind: "step", thought: "", step: { skill: "go_to", x: 1, y: 64, z: 0 } };
const state = (kind: SituationState["info"]["kind"]): SituationState => ({ info: { kind, cause: kind, raisedAt: 0 }, order: null, told: false });

test("situations preserve the planned step and do not abort work; lookups skip them", () => {
  const goal = newWork({ text: "get materials", requester: null, purpose: null });
  goal.step = new AbortController();
  const stack = [goal];
  const night = pushSituation(stack, state("night"), "night", planned);
  const health = pushSituation(stack, state("low_health"), "health", planned);
  assert.equal(goal.step.signal.aborted, false);
  assert.equal(night.planned, planned);
  assert.equal(topWork(stack), goal);
  assert.equal(situationOf(stack, "night"), night);
  assert.equal(situationOf(stack, "respawn"), undefined);
  assert.equal(neededWork(stack, health), goal);
});

test("situations without ordinary work retain the bottom situation's needs", () => {
  const stack = [];
  const respawn = pushSituation(stack, state("respawn"), "respawn", planned);
  const health = pushSituation(stack, state("low_health"), "health", planned);
  assert.equal(topWork(stack), undefined);
  assert.equal(neededWork(stack, health), respawn);
  assert.equal(neededWork(stack, respawn), respawn);
});
