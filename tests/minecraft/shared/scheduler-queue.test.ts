// T7c: the arrangement queue as a placement bound, and a warm idle server out of the sample's ledger.
import test from "node:test";
import assert from "node:assert/strict";
import { lanePlacement, ownPlacement, SchedulerRig } from "./scheduler-rig.ts";
import { lanes, queued } from "./scheduler-queue-fixtures.ts";

/** One trial of the key ran and finished: the key has a warm, idle server s1, and a new sample has just begun (one new server per sample is free again). */
async function warmServer(rig: SchedulerRig, nextSample: { memAvailableMb?: number } = {}): Promise<void> {
  const warm = rig.submit([{ name: "warm", placement: lanePlacement("k") }]);
  rig.sample();
  await rig.settle();
  rig.running[0]!.finish();
  await warm.finished;
  rig.clock += 5_000;
  rig.sample(nextSample);
}

test("the 7th lane trial of a key does not wait 5.6 s on a server's mutex: the sample may start a second server, which takes it and the trials after it", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_MAX_PLAYERS: "30" });
  await warmServer(rig);
  rig.holdArrangements();
  rig.submit(lanes(9));
  await rig.settle();
  assert.equal(rig.scheduler.runningCount, 9);
  assert.deepEqual(queued(rig), { s1: 6, s2: 3 }, "6 arrangements queued at 800 ms fit 5 s, the 7th would not");
  assert.match(rig.logs.find(line => line.includes("server s2 (shared")) ?? "", /starting: key's servers refused it \(arrangement queue/u);
});

test("the first server of a key starts once per sample like any server: the trials it cannot take in time wait on the shortest queue, not outside the target", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_MAX_PLAYERS: "30" });
  rig.holdArrangements();
  rig.submit(lanes(9));
  rig.sample();
  await rig.settle();
  assert.equal(rig.scheduler.runningCount, 9);
  assert.deepEqual(queued(rig), { s1: 9 });
  assert.equal(rig.factory.created.length, 1);
});

test("the queue empties as trials are arranged and restored", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_MAX_PLAYERS: "30" });
  const open = rig.holdArrangements();
  rig.submit(lanes(8));
  rig.sample();
  await rig.settle();
  assert.deepEqual(queued(rig), { s1: 8 });
  open();
  await rig.settle();
  assert.deepEqual(queued(rig), { s1: 0 }, "arranged: off the queue");
  for (const trial of [...rig.running]) trial.finish();
  await rig.settle();
  assert.deepEqual(queued(rig), { s1: 0 }, "restored: off the queue");
});

test("a new server refused for memory: the trial goes to the shortest queue instead of waiting, and no server starts", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_MAX_PLAYERS: "30" });
  // 2000 MB of ledger are left when the 7th trial is asked: a client and the server margin fit (250 + 1024), a new server (4346) does not.
  await warmServer(rig, { memAvailableMb: 3_584 + 250 + 6 * 250 + 2_000 });
  rig.holdArrangements();
  rig.submit(lanes(9));
  await rig.settle();
  assert.equal(rig.factory.created.length, 1);
  assert.equal(rig.scheduler.runningCount, 9);
  assert.deepEqual(queued(rig), { s1: 9 });
});

test("a server of its own is not a candidate for the queue bound: any number of reusable scenarios queue on their own servers as before", async () => {
  const rig = new SchedulerRig();
  rig.holdArrangements();
  rig.submit([{ name: "n1", placement: ownPlacement("own:1") }, { name: "n2", placement: ownPlacement("own:2") }]);
  rig.sample();
  await rig.settle();
  assert.equal(rig.scheduler.runningCount, 1);
  assert.deepEqual(queued(rig), {}, "a server of its own has no queue");
});

test("a server whose trials settled takes its hold from them: a measured 2 s hold takes two lanes in queue, not six", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_MAX_PLAYERS: "30" });
  rig.submit(lanes(3));
  rig.sample();
  await rig.settle();
  const server = rig.pool.list()[0]!;
  for (let trial = 0; trial < 3; trial++) {
    const lane = rig.pool.leaseLane(server.id)!;
    rig.pool.finishTrial(server.id, lane, { result: { scenario: "x", outcome: "pass", elapsedMs: 1, goal: { state: "passed", detail: "" }, goalText: "" },
      lane: "free", serverSick: false, hitWallBound: false, restored: true, mutexWaitMs: 0, arranged: true,
      phases: { mutexWaitMs: 0, arrangeMs: 1_500, joinMs: 0, trialMs: 0, restoreWaitMs: 0, restoreMs: 500 } }, rig.clock);
  }
  assert.equal(rig.pool.queues([server.id]).get(server.id)?.holdMs, 2_000);
});

test("a warm idle server is out of the sample's ledger; the trial admitted onto it puts its growth in at once, with its client", async () => {
  const rig = new SchedulerRig();
  await warmServer(rig);
  rig.pool.setHealth("s1", { msptP95: 5, residentMb: 1_000 });
  rig.clock += rig.config.clientRampMs;
  rig.scheduler.onSample({ cpuBusy: 0.2, memAvailableMb: 20_000, threads: 24 }, rig.clock);
  assert.equal(rig.scheduler.sampleReport()!.ledgerMb, 20_000, "idle: nothing to grow into");
  rig.submit(lanes(1));
  rig.clock += 5_000;
  rig.scheduler.onSample({ cpuBusy: 0.2, memAvailableMb: 20_000, threads: 24 }, rig.clock);
  await rig.settle();
  assert.equal(rig.scheduler.sampleReport()!.ledgerMb, 20_000 - (3_072 + 512 - 1_000) - 250, "the server is busy with the trial: its growth and the young client");
});
