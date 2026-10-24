// Submissions take turns (no batch waits behind another's whole queue), and a trial that waits for room for a server is not starved.
import test from "node:test";
import assert from "node:assert/strict";
import { lanePlacement, SchedulerRig } from "./scheduler-rig.ts";

const named = (prefix: string, count: number, key = "k") => Array.from({ length: count }, (_, index) => ({ name: `${prefix}${index}`, placement: lanePlacement(key) }));

test("two submissions take turns for the slots that free up, instead of the first one's queue going first", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_TARGET_START: "1" });
  const first = rig.submit(named("a", 3));
  const second = rig.submit(named("b", 3));
  rig.sample();
  await rig.settle();
  const startOrder: string[] = [...rig.runningNames()];
  for (let turn = 0; turn < 5; turn++) {
    rig.running[0]!.finish();
    await rig.settle();
    startOrder.push(...rig.runningNames());
  }
  assert.deepEqual(startOrder, ["a0", "b0", "a1", "b1", "a2", "b2"]);
  rig.running[0]!.finish();
  await Promise.all([first.finished, second.finished]);
});

test("a locked batch queued behind a 79-trial plain batch starts within 3 samples, on its own server", async () => {
  const rig = new SchedulerRig();
  const plain = rig.submit(named("p", 79));
  rig.sample();
  await rig.settle();
  assert.equal(rig.running.length, 10, "the plain batch fills the target");
  const locked = rig.submit(named("t", 3), { lock: true, maxLanes: 1 });
  let samples = 0;
  while (!rig.runningNames().includes("t0") && samples < 3) {
    rig.finishNamed(rig.runningNames().find(name => name.startsWith("p"))!);
    rig.clock += 5_000;
    rig.sample({ cpuBusy: 0.3 });
    await rig.settle();
    samples += 1;
  }
  assert.ok(rig.runningNames().includes("t0"), `the locked batch had not started after ${samples} samples: ${rig.scheduler.waitReport(locked.id)}`);
  assert.notEqual(rig.serverOf("t0"), rig.serverOf(rig.runningNames().find(name => name.startsWith("p"))!));
  await rig.drain();
  await Promise.all([plain.finished, locked.finished]);
});

test("a trial that waited 3 samples for room for a new server holds back the later trials that would use that room", async () => {
  const rig = new SchedulerRig();
  const warm = rig.submit(named("warm", 1));
  rig.sample();
  await rig.settle();
  const needsServer = rig.submit(named("new", 1, "other-key"));
  const later = rig.submit(named("c", 6), { maxLanes: 1 });
  const START_ROOM = 6_000;
  for (let sample = 1; sample <= 3; sample++) {
    rig.clock += 5_000;
    rig.sample({ memAvailableMb: START_ROOM });
    await rig.settle();
    assert.equal(rig.running.some(trial => trial.input.scenario.name === "new0"), false);
    const running = rig.runningNames().find(name => name.startsWith("c"));
    assert.ok(running, `a later trial runs while the wait is young (sample ${sample})`);
    rig.finishNamed(running);
    await rig.settle();
  }
  const still = rig.runningNames().filter(name => name.startsWith("c"));
  assert.deepEqual(still, [], "after 3 samples of waiting, the next trial of the later batch is held back");
  assert.match(rig.scheduler.waitReport(later.id) ?? "", /new0.*room/u);
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.ok(rig.runningNames().includes("new0"), "once memory allows, the waiting trial gets its server first");
  await rig.drain();
  await Promise.all([warm.finished, needsServer.finished, later.finished]);
});

test("the room hold never deadlocks: with none of ours running the later trials go whatever the waiting trial needs", async () => {
  const rig = new SchedulerRig();
  const warm = rig.submit(named("warm", 1));
  rig.sample();
  await rig.settle();
  rig.pool.setHealth(rig.serverOf("warm0"), { msptP95: 5, residentMb: 3_000 });
  rig.running[0]!.finish();
  await warm.finished;
  const needsServer = rig.submit(named("new", 1, "other-key"));
  const TIGHT = 1_200;
  for (let sample = 0; sample < 4; sample++) {
    rig.clock += 5_000;
    rig.sample({ memAvailableMb: TIGHT });
    await rig.settle();
  }
  assert.deepEqual(rig.runningNames(), [], "a client fits, a new server does not: the trial waits and is starved");
  const later = rig.submit(named("c", 1));
  rig.clock += 5_000;
  rig.sample({ memAvailableMb: TIGHT });
  await rig.settle();
  assert.deepEqual(rig.runningNames(), ["c0"], "nothing of ours runs, so the hold does not apply");
  await rig.drain();
  await Promise.all([needsServer.finished, later.finished]);
});
