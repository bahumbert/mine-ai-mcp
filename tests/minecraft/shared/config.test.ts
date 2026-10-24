import test from "node:test";
import assert from "node:assert/strict";
import { loadScenarioServerConfig, portBlockOf } from "./config.ts";

test("the defaults are the plan's constants", () => {
  const config = loadScenarioServerConfig({});
  assert.equal(config.sampleEveryMs, 5_000);
  assert.equal(config.msptAdmitMs, 25);
  assert.equal(config.msptStopMs, 35);
  assert.equal(config.cpuAdmit, 0.85);
  assert.equal(config.targetStart, 28);
  assert.equal(config.growEveryMs, 15_000);
  assert.equal(config.ownShareHalve, 0.5);
  assert.equal(config.arrangeHoldMs, 800);
  assert.equal(config.arrangeQueueMs, 5_000);
  assert.equal(config.serversPerKey, 1);
  assert.equal(config.sharedHeapMb, 3_072);
  assert.equal(config.singleHeapMb, 2_048);
  assert.equal(config.socketPath, "/tmp/mine-ai-scenarios.sock");
});

test("an env variable MINE_AI_SCENARIO_* overrides one constant and leaves the others", () => {
  const config = loadScenarioServerConfig({ MINE_AI_SCENARIO_MSPT_ADMIT_MS: "12", MINE_AI_SCENARIO_SOCKET_PATH: "/tmp/x.sock" });
  assert.equal(config.msptAdmitMs, 12);
  assert.equal(config.socketPath, "/tmp/x.sock");
  assert.equal(config.msptStopMs, 35);
});

test("MINE_AI_SCENARIO_TARGET_START still overrides the default target", () => {
  assert.equal(loadScenarioServerConfig({ MINE_AI_SCENARIO_TARGET_START: "3" }).targetStart, 3);
});

test("the share of the busy cpu that makes a breach ours is a fraction: above 1 is refused", () => {
  assert.throws(() => loadScenarioServerConfig({ MINE_AI_SCENARIO_OWN_SHARE_HALVE: "2" }), /MINE_AI_SCENARIO_OWN_SHARE_HALVE/u);
});

test("a number that is not a number names the variable instead of becoming NaN", () => {
  assert.throws(() => loadScenarioServerConfig({ MINE_AI_SCENARIO_SAMPLE_EVERY_MS: "fast" }), /MINE_AI_SCENARIO_SAMPLE_EVERY_MS/u);
});

test("a cpu fraction above 1 is refused", () => {
  assert.throws(() => loadScenarioServerConfig({ MINE_AI_SCENARIO_CPU_ADMIT: "85" }), /MINE_AI_SCENARIO_CPU_ADMIT/u);
});

test("the default daemon owns 25400-25559 and a --port daemon owns 40 ports from its base", () => {
  assert.deepEqual(portBlockOf(undefined), { first: 25_400, last: 25_559 });
  assert.deepEqual(portBlockOf(25_300), { first: 25_300, last: 25_339 });
});

test("a port block that meets another daemon, the isolated runs or the live hosts is refused", () => {
  assert.throws(() => portBlockOf(25_500), /25400-25559/u);
  assert.throws(() => portBlockOf(25_370), /25400-25559/u);
  assert.throws(() => portBlockOf(25_540), /25400-25559/u);
  assert.throws(() => portBlockOf(25_560), /25566-25574/u);
  assert.throws(() => portBlockOf(25_570), /25566-25574/u);
  assert.throws(() => portBlockOf(25_575), /25575/u);
  assert.throws(() => portBlockOf(26_000), /25575/u);
  assert.throws(() => portBlockOf(0), /port/u);
});
