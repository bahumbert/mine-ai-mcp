// T7c: the target growing under demand, foreign load, and the sample report.
import test from "node:test";
import assert from "node:assert/strict";
import { SchedulerRig } from "./scheduler-rig.ts";
import { lanes } from "./scheduler-queue-fixtures.ts";

test("a batch that admits every sample still grows its target: +1 after 60 s, then one per GROW_EVERY, trials waiting at the target", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_TARGET_START: "2", MINE_AI_SCENARIO_MAX_PLAYERS: "100" });
  rig.submit(lanes(200));
  const targets: number[] = [];
  for (let step = 0; step <= 24; step++) {
    rig.sample();
    await rig.settle();
    targets.push(rig.scheduler.sampleReport()!.target);
    for (const trial of [...rig.running].slice(0, 1)) trial.finish();
    await rig.settle();
    rig.clock += 5_000;
  }
  assert.deepEqual(targets.slice(0, 12), Array(12).fill(2), "the first 55 s: still the start");
  assert.deepEqual([targets[12], targets[15], targets[18], targets[24]], [3, 4, 5, 7], "+1 at 60 s and per 15 s after");
});

test("nothing waits at the target: the target stays however long the batch runs", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_TARGET_START: "5" });
  const handle = rig.submit(lanes(2));
  for (let step = 0; step <= 30; step++) {
    rig.sample();
    await rig.settle();
    rig.clock += 5_000;
  }
  assert.equal(rig.scheduler.sampleReport()!.target, 5);
  for (const trial of [...rig.running]) trial.finish();
  await handle.finished;
});

test("a foreign cpu breach with trials running keeps the target and the report says foreign load; our own breach halves it", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_TARGET_START: "8" });
  rig.submit(lanes(3));
  rig.sample();
  await rig.settle();
  rig.scheduler.onSample({ cpuBusy: 0.95, ownCpu: 0.1, load1: 3, memAvailableMb: 28_000, threads: 24 }, rig.clock + 5_000);
  assert.equal(rig.scheduler.sampleReport()!.target, 8);
  assert.equal(rig.scheduler.sampleReport()!.event, "foreign load");
  rig.scheduler.onSample({ cpuBusy: 0.95, ownCpu: 0.9, load1: 3, memAvailableMb: 28_000, threads: 24 }, rig.clock + 10_000);
  assert.equal(rig.scheduler.sampleReport()!.target, 4);
  assert.equal(rig.scheduler.sampleReport()!.event, "halved");
});

test("the sample report carries the machine, the ledger, the target, the counts and the trials held per bound", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_TARGET_START: "2" });
  assert.equal(rig.scheduler.sampleReport(), null, "before the first sample");
  rig.submit(lanes(5));
  rig.scheduler.onSample({ cpuBusy: 0.4, ownCpu: 0.3, load1: 2.5, memAvailableMb: 28_000, threads: 24 }, rig.clock);
  await rig.settle();
  const report = rig.scheduler.sampleReport()!;
  assert.equal(report.cpuBusy, 0.4);
  assert.equal(report.ownCpu, 0.3);
  assert.equal(report.load1, 2.5);
  assert.equal(report.memAvailableMb, 28_000);
  assert.equal(report.target, 2);
  assert.equal(report.running, 2);
  assert.equal(report.queued, 3);
  assert.equal(report.servers, 1);
  assert.equal(report.starts, 1);
  assert.deepEqual(report.held, { target: 3 });
  assert.equal(report.ledgerMb, 28_000 - (3_072 + 512) - 2 * 250, "MemAvailable less what the server still grows into and the two young clients");
});

test("a sample's held count counts only that sample's refusals, per bound", async () => {
  const rig = new SchedulerRig();
  rig.submit(lanes(4));
  rig.sample({ memAvailableMb: 200 });
  await rig.settle();
  assert.deepEqual(rig.scheduler.sampleReport()!.held, { memory: 4 });
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.deepEqual(rig.scheduler.sampleReport()!.held, {});
});
