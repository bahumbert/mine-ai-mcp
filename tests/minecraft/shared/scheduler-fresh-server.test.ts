// T10 through the scheduler: a fresh shared server takes the bound of lanes before its first tick sample, the rest once a sample is under MSPT_ADMIT.
import test from "node:test";
import assert from "node:assert/strict";
import { SchedulerRig } from "./scheduler-rig.ts";
import { lanes } from "./scheduler-queue-fixtures.ts";

const TWENTY_EIGHT = { MINE_AI_SCENARIO_MAX_PLAYERS: "30" };

test("28 lanes on a fresh shared server: the bound runs before its first sample, no second server starts, the rest run once the sample is under MSPT_ADMIT", async () => {
  const rig = new SchedulerRig(TWENTY_EIGHT);
  rig.submit(lanes(28));
  rig.sample();
  await rig.settle();
  assert.equal(rig.scheduler.runningCount, rig.config.freshServerLanes, "the bound, before any tick sample");
  assert.equal(rig.factory.created.length, 1, "the held trials wait for the sample, they do not start a second server");
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.equal(rig.scheduler.runningCount, rig.config.freshServerLanes, "a sample with no tick answer still holds them");
  rig.pool.setHealth("s1", { msptP95: rig.config.msptAdmitMs - 10, residentMb: 1_000 });
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.equal(rig.scheduler.runningCount, 28);
});

test("SERVERS_PER_KEY 2 at the default bound: a key with 20 trials queued still starts both servers in its first pass", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_MAX_PLAYERS: "22", MINE_AI_SCENARIO_SERVERS_PER_KEY: "2", MINE_AI_SCENARIO_TARGET_START: "60" });
  rig.holdArrangements();
  rig.submit(lanes(20));
  rig.sample();
  await rig.settle();
  assert.equal(rig.factory.created.length, 2);
  assert.equal(rig.scheduler.runningCount, 20);
});
