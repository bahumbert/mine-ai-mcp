import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadScenarioServerConfig, portBlockOf, SCENARIO_SERVER_ENV_NAMES } from "./config.ts";

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

test("the clients booted ahead: the booted size measured by T7h-b, one wave per submission, two in all, the boot bound and the failure limit", () => {
  const config = loadScenarioServerConfig({});
  assert.equal(config.clientBootedMemMb, 125);
  assert.ok(config.clientBootedMemMb < config.clientMemMb, "a booted client is smaller than a logged-in one: the difference is what its trial reserves");
  assert.equal(config.clientBootCpuSeconds, 1.2);
  assert.equal(config.clientsAhead, config.targetStart);
  assert.equal(config.clientsAheadMax, 2 * config.clientsAhead);
  assert.equal(config.clientBootBoundMs, 60_000);
  assert.equal(config.clientBootFailureLimit, 2);
});

test("a failure limit that is not a whole number is refused, naming its variable", () => {
  assert.throws(() => loadScenarioServerConfig({ MINE_AI_SCENARIO_CLIENT_BOOT_FAILURE_LIMIT: "1.5" }), /MINE_AI_SCENARIO_CLIENT_BOOT_FAILURE_LIMIT/u);
});

test("the scenario mirror: on, its sync bound from X3 (3 x 7 912 ms), its install bound from X2 (3 x 1 288 ms), and a directory on ext4", () => {
  const config = loadScenarioServerConfig({});
  assert.equal(config.mirror, 1);
  assert.equal(config.mirrorSyncBoundMs, 23_736);
  assert.equal(config.modulesInstallBoundMs, 3_864);
  assert.equal(config.mirrorDir, join(homedir(), ".cache/mine-ai/scenario-mirror"));
});

test("MINE_AI_SCENARIO_MIRROR=0 turns the mirror off, the bounds and the directory take overrides, and 2 or 0.5 is refused naming the variable", () => {
  const config = loadScenarioServerConfig({
    MINE_AI_SCENARIO_MIRROR: "0", MINE_AI_SCENARIO_MIRROR_SYNC_BOUND_MS: "5000", MINE_AI_SCENARIO_MODULES_INSTALL_BOUND_MS: "7000", MINE_AI_SCENARIO_MIRROR_DIR: "/tmp/m",
  });
  assert.equal(config.mirror, 0);
  assert.equal(config.mirrorSyncBoundMs, 5_000);
  assert.equal(config.modulesInstallBoundMs, 7_000);
  assert.equal(config.mirrorDir, "/tmp/m");
  assert.throws(() => loadScenarioServerConfig({ MINE_AI_SCENARIO_MIRROR: "2" }), /MINE_AI_SCENARIO_MIRROR=2/u);
  assert.throws(() => loadScenarioServerConfig({ MINE_AI_SCENARIO_MIRROR: "0.5" }), /MINE_AI_SCENARIO_MIRROR=0\.5/u);
  assert.throws(() => loadScenarioServerConfig({ MINE_AI_SCENARIO_MODULES_INSTALL_BOUND_MS: "0" }), /MINE_AI_SCENARIO_MODULES_INSTALL_BOUND_MS/u);
});

test("the template world: on, 28 lanes (Q4), the build bound from P0 (3 x 59.9 s), the copy bound from P0b (3 x 17 377 ms), a directory on ext4", () => {
  const config = loadScenarioServerConfig({});
  assert.equal(config.worldTemplate, 1);
  assert.equal(config.templateLanes, 28);
  assert.equal(config.templateBuildBoundMs, 180_000);
  assert.equal(config.templateCopyBoundMs, 52_131);
  assert.equal(config.templateDir, join(homedir(), ".cache/mine-ai/world-templates"));
});

test("MINE_AI_SCENARIO_WORLD_TEMPLATE=0 turns the template off, the lanes, bounds and directory take overrides, and a switch of 2 or 0.5, lanes of 0 or 2.5 are refused naming the variable", () => {
  const config = loadScenarioServerConfig({
    MINE_AI_SCENARIO_WORLD_TEMPLATE: "0", MINE_AI_SCENARIO_TEMPLATE_LANES: "4", MINE_AI_SCENARIO_TEMPLATE_BUILD_BOUND_MS: "9000",
    MINE_AI_SCENARIO_TEMPLATE_COPY_BOUND_MS: "8000", MINE_AI_SCENARIO_TEMPLATE_DIR: "/tmp/t",
  });
  assert.equal(config.worldTemplate, 0);
  assert.equal(config.templateLanes, 4);
  assert.equal(config.templateBuildBoundMs, 9_000);
  assert.equal(config.templateCopyBoundMs, 8_000);
  assert.equal(config.templateDir, "/tmp/t");
  assert.throws(() => loadScenarioServerConfig({ MINE_AI_SCENARIO_WORLD_TEMPLATE: "2" }), /MINE_AI_SCENARIO_WORLD_TEMPLATE=2/u);
  assert.throws(() => loadScenarioServerConfig({ MINE_AI_SCENARIO_WORLD_TEMPLATE: "0.5" }), /MINE_AI_SCENARIO_WORLD_TEMPLATE=0\.5/u);
  assert.throws(() => loadScenarioServerConfig({ MINE_AI_SCENARIO_TEMPLATE_LANES: "0" }), /MINE_AI_SCENARIO_TEMPLATE_LANES/u);
  assert.throws(() => loadScenarioServerConfig({ MINE_AI_SCENARIO_TEMPLATE_LANES: "2.5" }), /MINE_AI_SCENARIO_TEMPLATE_LANES=2\.5/u);
});

test("the daemon's template variables are its own: a submitter does not forward them to the clients", () => {
  for (const name of ["WORLD_TEMPLATE", "TEMPLATE_LANES", "TEMPLATE_BUILD_BOUND_MS", "TEMPLATE_COPY_BOUND_MS", "TEMPLATE_DIR"]) {
    assert.ok(SCENARIO_SERVER_ENV_NAMES.has(`MINE_AI_SCENARIO_${name}`), name);
  }
});

test("the daemon's mirror variables are its own: a submitter does not forward them to the clients", () => {
  for (const name of ["MINE_AI_SCENARIO_MIRROR", "MINE_AI_SCENARIO_MIRROR_SYNC_BOUND_MS", "MINE_AI_SCENARIO_MODULES_INSTALL_BOUND_MS", "MINE_AI_SCENARIO_MIRROR_DIR"]) {
    assert.ok(SCENARIO_SERVER_ENV_NAMES.has(name), name);
  }
});
