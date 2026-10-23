import test from "node:test";
import assert from "node:assert/strict";
import { lanePlacement, ownPlacement, SchedulerRig } from "./scheduler-rig.ts";

const resultNames = (rig: SchedulerRig): string[] => rig.events.flatMap(event => (event.type === "result" ? [`${event.name}:${event.outcome}`] : []));
const runningNames = (rig: SchedulerRig): string[] => rig.running.map(trial => trial.input.scenario.name ?? "");

test("trials of one key share a server: the first starts it, the others take lanes 2 and 3 at once, and each result is emitted", async () => {
  const rig = new SchedulerRig();
  const handle = rig.submit([{ name: "a", placement: lanePlacement("k") }, { name: "b", placement: lanePlacement("k") }, { name: "c", placement: lanePlacement("k") }]);
  rig.sample();
  await rig.settle();
  assert.equal(rig.factory.created.length, 1, "one server for the key");
  assert.deepEqual(rig.lanesInFlight().sort(), [1, 2, 3]);
  for (const trial of [...rig.running]) trial.finish();
  const summary = await handle.finished;
  assert.deepEqual(summary, { runs: 3, passed: 3, failed: 0, cancelled: 0 });
  assert.deepEqual(resultNames(rig).sort(), ["a:pass", "b:pass", "c:pass"]);
});

test("a trial that settles lets the next queued one in without waiting for another sample", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_TARGET_START: "1" });
  const handle = rig.submit([{ name: "a", placement: lanePlacement("k") }, { name: "b", placement: lanePlacement("k") }]);
  rig.sample();
  await rig.settle();
  assert.equal(rig.running.length, 1, "the target of 1 holds the second back");
  rig.running[0]!.finish();
  await rig.settle();
  assert.equal(rig.running.length, 1);
  rig.running[0]!.finish();
  assert.deepEqual(await handle.finished, { runs: 2, passed: 2, failed: 0, cancelled: 0 });
});

test("600 random submissions, settlements, cancels and samples never put two trials on one lane of one server", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_MAX_PLAYERS: "8" });
  let seed = 4242;
  const random = (limit: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % limit;
  };
  const handles: { finished: Promise<unknown>; cancel(reason: string): void }[] = [];
  rig.sample();
  for (let step = 0; step < 600; step++) {
    const action = random(5);
    if (action === 0) handles.push(rig.submit(Array.from({ length: 1 + random(3) }, (_, index) => ({ name: `s${step}-${index}`, placement: lanePlacement(`k${random(2)}`) }))));
    else if (action === 1 && handles.length > 0) handles[random(handles.length)]!.cancel("test cancel");
    else if (action === 2) { rig.clock += 5_000; rig.sample({ memAvailableMb: 4_000 + random(26_000) }); }
    else if (rig.running.length > 0) rig.running[random(rig.running.length)]!.finish(random(4) === 0 ? "cancelled" : "pass");
    await rig.settle();
    const used = rig.running.map(trial => `${trial.input.server.id}/${trial.input.arena?.id}`);
    assert.equal(new Set(used).size, used.length, `a lane was given twice at step ${step}: ${used.join(" ")}`);
  }
  rig.clock += 5_000;
  rig.sample();
  while (rig.running.length > 0 || rig.scheduler.queuedCount > 0) {
    for (const trial of [...rig.running]) trial.finish();
    rig.clock += 5_000;
    rig.sample();
    await rig.settle();
  }
  await Promise.all(handles.map(handle => handle.finished));
});

test("a refused admission leaves the trial queued with the bound that holds it, and the wait report names it", async () => {
  const rig = new SchedulerRig();
  const handle = rig.submit([{ name: "a", placement: lanePlacement("k") }]);
  rig.sample({ memAvailableMb: 200 });
  await rig.settle();
  assert.equal(rig.running.length, 0);
  assert.match(rig.scheduler.waitReport(handle.id) ?? "", /memory/u);
  rig.sample();
  await rig.settle();
  assert.equal(rig.running.length, 1);
  assert.equal(rig.scheduler.waitReport(handle.id), null, "nothing waits any more");
  rig.running[0]!.finish();
  await handle.finished;
});

test("a trial whose key cannot start a server does not block the trial behind it that has a server with room", async () => {
  const rig = new SchedulerRig();
  const first = rig.submit([{ name: "warm", placement: lanePlacement("b") }]);
  rig.sample();
  await rig.settle();
  const second = rig.submit([{ name: "needs-new-server", placement: lanePlacement("a") }, { name: "fits-warm", placement: lanePlacement("b") }]);
  rig.clock += 5_000;
  rig.sample({ memAvailableMb: 6_000 });
  await rig.settle();
  assert.deepEqual(runningNames(rig), ["warm", "fits-warm"]);
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.equal(rig.running.length, 3, "with room again the first key gets its server");
  while (rig.running.length > 0) {
    rig.running[0]!.finish();
    await rig.settle();
  }
  await Promise.all([first.finished, second.finished]);
});

test("a submission capped at 1 lane runs its trials one at a time", async () => {
  const rig = new SchedulerRig();
  const handle = rig.submit([{ name: "a", placement: lanePlacement("k") }, { name: "b", placement: lanePlacement("k") }, { name: "c", placement: lanePlacement("k") }], { maxLanes: 1 });
  rig.sample();
  for (let step = 0; step < 3; step++) {
    await rig.settle();
    assert.equal(rig.running.length, 1);
    rig.running[0]!.finish();
  }
  assert.equal((await handle.finished).passed, 3);
});

test("repeat queues every scenario that many times", async () => {
  const rig = new SchedulerRig();
  const handle = rig.submit([{ name: "a", placement: lanePlacement("k") }], { repeat: 3 });
  rig.sample();
  await rig.settle();
  assert.equal(rig.running.length, 3);
  for (const trial of [...rig.running]) trial.finish();
  assert.equal((await handle.finished).runs, 3);
});

test("a locked batch waits for running trials to drain, runs alone, and the others start after it ends", async () => {
  const rig = new SchedulerRig();
  const other = rig.submit([{ name: "before", placement: lanePlacement("k") }]);
  rig.sample();
  await rig.settle();
  const locked = rig.submit([{ name: "timed-1", placement: lanePlacement("k") }, { name: "timed-2", placement: lanePlacement("k") }], { lock: true });
  const later = rig.submit([{ name: "after", placement: lanePlacement("k") }]);
  rig.sample();
  await rig.settle();
  assert.deepEqual(runningNames(rig), ["before"], "the locked batch waits for the drain; nothing new is admitted");
  rig.running[0]!.finish();
  await rig.settle();
  assert.deepEqual(runningNames(rig).sort(), ["timed-1", "timed-2"], "the batch runs alone");
  assert.match(rig.scheduler.waitReport(later.id) ?? "", /lock/u);
  for (const trial of [...rig.running]) trial.finish();
  await locked.finished;
  await rig.settle();
  assert.deepEqual(runningNames(rig), ["after"]);
  rig.running[0]!.finish();
  await Promise.all([other.finished, later.finished]);
});

test("cancelling a submission aborts its running trials, drops its queue and finishes once the trials end", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_TARGET_START: "1" });
  const handle = rig.submit([{ name: "a", placement: lanePlacement("k") }, { name: "b", placement: lanePlacement("k") }]);
  rig.sample();
  await rig.settle();
  const running = rig.running[0]!;
  handle.cancel("submitter left");
  assert.equal(running.input.signal.aborted, true);
  running.finish("cancelled");
  const summary = await handle.finished;
  assert.deepEqual(summary, { runs: 2, passed: 0, failed: 0, cancelled: 2 });
  assert.equal(rig.running.length, 0, "the queued trial never started");
});

test("a scenario placed on its own server starts a single server at once and gets no arena", async () => {
  const rig = new SchedulerRig();
  const handle = rig.submit([{ name: "nat", placement: ownPlacement("own:w") }]);
  rig.sample();
  await rig.settle();
  assert.equal(rig.factory.created[0]?.kind, "single");
  assert.equal(rig.running[0]?.input.arena, undefined);
  assert.equal(rig.running[0]?.input.reuseServer, true);
  rig.running[0]!.finish();
  await handle.finished;
});

test("the next scenario of the same key reuses an idle reusable server of its own instead of starting another", async () => {
  const rig = new SchedulerRig();
  const first = rig.submit([{ name: "n1", placement: ownPlacement("own:w") }]);
  rig.sample();
  await rig.settle();
  rig.running[0]!.finish();
  await first.finished;
  const second = rig.submit([{ name: "n2", placement: ownPlacement("own:w") }]);
  rig.sample();
  await rig.settle();
  assert.equal(rig.factory.created.length, 1);
  rig.running[0]!.finish();
  await second.finished;
});

test("a scenario that cannot be reset runs without reuse and its server is stopped after it", async () => {
  const rig = new SchedulerRig();
  const handle = rig.submit([{ name: "dirty", placement: ownPlacement("own:d", false) }]);
  rig.sample();
  await rig.settle();
  assert.equal(rig.running[0]?.input.reuseServer, false);
  rig.running[0]!.finish();
  await handle.finished;
  await rig.pool.reap(rig.clock + 1, new Set());
  assert.equal(rig.factory.created[0]?.stopped, true);
});

test("two refused scenarios of different worlds each get a server of their own, one new server per sample", async () => {
  const rig = new SchedulerRig();
  const handle = rig.submit([{ name: "n1", placement: ownPlacement("own:1") }, { name: "n2", placement: ownPlacement("own:2") }]);
  rig.sample();
  await rig.settle();
  assert.equal(rig.running.length, 1);
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.equal(rig.running.length, 2);
  for (const trial of [...rig.running]) trial.finish();
  await handle.finished;
});

test("a server that fails to start ends its trial as an error with the cause, never retried silently", async () => {
  const rig = new SchedulerRig();
  rig.factory.failNextStart = true;
  const handle = rig.submit([{ name: "a", placement: lanePlacement("k") }]);
  rig.sample();
  await rig.settle();
  const summary = await handle.finished;
  assert.equal(summary.failed, 1);
  const event = rig.events.find(candidate => candidate.type === "result");
  assert.match(event?.type === "result" ? event.error ?? "" : "", /no port/u);
  assert.equal(rig.factory.created.length, 0);
});

test("nothing is admitted before the first sample", async () => {
  const rig = new SchedulerRig();
  rig.submit([{ name: "a", placement: lanePlacement("k") }]);
  await rig.settle();
  assert.equal(rig.running.length, 0);
});

test("queuedKeys lists the keys still waiting so their servers are kept warm", () => {
  const rig = new SchedulerRig();
  rig.submit([{ name: "a", placement: lanePlacement("k1") }, { name: "b", placement: ownPlacement("own:x") }]);
  assert.deepEqual([...rig.scheduler.queuedKeys()].sort(), ["k1", "own:x"]);
});
