// A timing trial starts only on a calm machine, and the others start only under CPU_CALM while one runs.
import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_TALLY, initialAdmissionState } from "./admission.ts";
import { config, sample, ask, refusedBound } from "./admission-fixtures.ts";
import { loadScenarioServerConfig } from "./config.ts";

const CALM = config.cpuCalm;
const timing = { candidates: ["s1"], newServerHeapMb: config.sharedHeapMb, timing: true };

test("a timing trial starts only on a calm machine, even with none of ours running (no skip of the cpu bound)", () => {
  const idleOwn = { ownTrials: 0 };
  assert.equal(refusedBound(ask(sample({ ...idleOwn, cpuBusy: CALM + 0.05 }), initialAdmissionState(config), EMPTY_TALLY, timing)), "cpu");
  assert.equal(ask(sample({ ...idleOwn, cpuBusy: CALM - 0.05 }), initialAdmissionState(config), EMPTY_TALLY, timing).admit, true);
});

test("a timing trial waits for a cpu reading: the first sample has no window", () => {
  const decision = ask(sample({ cpuBusy: null, ownTrials: 0 }), initialAdmissionState(config), EMPTY_TALLY, timing);
  assert.equal(refusedBound(decision), "cpu");
  assert.match(decision.admit ? "" : decision.detail, /reading/u);
});

test("while a timing trial runs, other trials start only under CPU_CALM, and the refusal names the timing trial", () => {
  const withTiming = { candidates: ["s1"], newServerHeapMb: config.sharedHeapMb, timingRunning: 1 };
  const decision = ask(sample({ cpuBusy: CALM + 0.05 }), initialAdmissionState(config), EMPTY_TALLY, withTiming);
  assert.equal(refusedBound(decision), "cpu");
  assert.match(decision.admit ? "" : decision.detail, /timing/u);
  assert.equal(ask(sample({ cpuBusy: CALM - 0.05 }), initialAdmissionState(config), EMPTY_TALLY, withTiming).admit, true);
});

test("CPU_CALM is under CPU_ADMIT and is read from MINE_AI_SCENARIO_CPU_CALM", () => {
  assert.ok(config.cpuCalm < config.cpuAdmit);
  assert.equal(loadScenarioServerConfig({ MINE_AI_SCENARIO_CPU_CALM: "0.4" }).cpuCalm, 0.4);
});

test("a timing trial still starts only under CPU_CALM while the target is kept for foreign load", () => {
  const busy = sample({ cpuBusy: CALM + 0.05, ownCpu: 0.01, ownTrials: 0 });
  assert.equal(refusedBound(ask(busy, initialAdmissionState(config), EMPTY_TALLY, timing)), "cpu");
});
