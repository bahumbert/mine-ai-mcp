// A `--lock` batch (a timing batch) runs on servers reserved for it beside everything else; `--load`'s hold is the one remaining hold.
import test from "node:test";
import assert from "node:assert/strict";
import { lanePlacement, ownPlacement, SchedulerRig } from "./scheduler-rig.ts";

const lanes = (...names: string[]) => names.map(name => ({ name, placement: lanePlacement("k") }));

test("a locked batch and a plain batch of one key run at once, on different servers", async () => {
  const rig = new SchedulerRig();
  const plain = rig.submit(lanes("plain-1", "plain-2"));
  const locked = rig.submit(lanes("timed-1", "timed-2"), { lock: true });
  rig.sample({ cpuBusy: 0.2 });
  await rig.settle();
  rig.clock += 5_000;
  rig.sample({ cpuBusy: 0.2 });
  await rig.settle();
  assert.deepEqual(rig.runningNames().sort(), ["plain-1", "plain-2", "timed-1", "timed-2"]);
  assert.equal(rig.serverOf("timed-1"), rig.serverOf("timed-2"), "a batch's lanes share its reserved server");
  assert.notEqual(rig.serverOf("timed-1"), rig.serverOf("plain-1"));
  assert.equal(rig.serverOf("plain-1"), rig.serverOf("plain-2"));
  await rig.drain();
  await Promise.all([plain.finished, locked.finished]);
});

test("a reserved server never gets a trial of another submission, even with lanes free and the key the same", async () => {
  const rig = new SchedulerRig();
  const locked = rig.submit(lanes("timed"), { lock: true });
  rig.sample();
  await rig.settle();
  const reserved = rig.serverOf("timed");
  const plain = rig.submit(lanes("p1", "p2", "p3", "p4"));
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.equal(rig.runningNames().length, 5);
  for (const name of ["p1", "p2", "p3", "p4"]) assert.notEqual(rig.serverOf(name), reserved, `${name} must not use the reserved server`);
  await rig.drain();
  await Promise.all([plain.finished, locked.finished]);
});

test("a reserved server is stopped when its batch ends, without waiting SERVER_IDLE, and the next batch of the key never reuses it", async () => {
  const rig = new SchedulerRig();
  const locked = rig.submit(lanes("timed"), { lock: true });
  rig.sample();
  await rig.settle();
  rig.running[0]!.finish();
  await locked.finished;
  await rig.pool.reap(rig.clock + 1, new Set());
  assert.equal(rig.factory.created[0]?.stopped, true, "stopped one millisecond after the batch, not after SERVER_IDLE");
  const next = rig.submit(lanes("again"), { lock: true });
  const plain = rig.submit(lanes("plain"));
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.equal(rig.factory.created.length, 3, "the second locked batch and the plain batch each got a server of their own");
  await rig.drain();
  await Promise.all([next.finished, plain.finished]);
});

test("a plain server stays after its batch for the next one: only reserved servers go with their batch", async () => {
  const rig = new SchedulerRig();
  const first = rig.submit(lanes("a"));
  rig.sample();
  await rig.settle();
  rig.running[0]!.finish();
  await first.finished;
  await rig.pool.reap(rig.clock + 1, new Set());
  assert.equal(rig.factory.created[0]?.stopped, false);
  const second = rig.submit(lanes("b"));
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.equal(rig.factory.created.length, 1);
  await rig.drain();
  await second.finished;
});

test("two locked batches at once each get servers of their own", async () => {
  const rig = new SchedulerRig();
  const one = rig.submit(lanes("t1"), { lock: true });
  const two = rig.submit(lanes("t2"), { lock: true });
  rig.sample();
  await rig.settle();
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.deepEqual(rig.runningNames().sort(), ["t1", "t2"]);
  assert.notEqual(rig.serverOf("t1"), rig.serverOf("t2"));
  await rig.drain();
  await Promise.all([one.finished, two.finished]);
});

test("a locked batch whose server cannot be created yet (memory ledger) waits while plain trials still run, and says which bound", async () => {
  const rig = new SchedulerRig();
  const plain = rig.submit(lanes("warm-1", "warm-2", "warm-3"));
  rig.sample();
  await rig.settle();
  const locked = rig.submit(lanes("timed"), { lock: true });
  rig.clock += 5_000;
  rig.sample({ memAvailableMb: 6_000 });
  await rig.settle();
  assert.deepEqual(rig.runningNames().sort(), ["warm-1", "warm-2", "warm-3"]);
  assert.match(rig.scheduler.waitReport(locked.id) ?? "", /memory/u);
  rig.finishNamed("warm-1");
  await rig.settle();
  assert.deepEqual(rig.runningNames().sort(), ["warm-2", "warm-3"], "plain trials keep running beside the waiting batch");
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.ok(rig.runningNames().includes("timed"));
  await rig.drain();
  await Promise.all([plain.finished, locked.finished]);
});

test("a locked batch starts on a calm machine only: its first trial waits for CPU under CPU_CALM although none of ours runs", async () => {
  const rig = new SchedulerRig();
  const locked = rig.submit(lanes("timed"), { lock: true });
  rig.sample({ cpuBusy: rig.config.cpuCalm + 0.1 });
  await rig.settle();
  assert.equal(rig.running.length, 0);
  assert.match(rig.scheduler.waitReport(locked.id) ?? "", /cpu.*timing trial/u);
  rig.clock += 5_000;
  rig.sample({ cpuBusy: rig.config.cpuCalm - 0.1 });
  await rig.settle();
  assert.deepEqual(rig.runningNames(), ["timed"]);
  await rig.drain();
  await locked.finished;
});

test("while a locked trial runs, plain trials start only while CPU is under CPU_CALM", async () => {
  const rig = new SchedulerRig();
  const locked = rig.submit(lanes("timed"), { lock: true });
  rig.sample({ cpuBusy: 0.2 });
  await rig.settle();
  const plain = rig.submit(lanes("plain"));
  rig.clock += 5_000;
  rig.sample({ cpuBusy: rig.config.cpuCalm + 0.1 });
  await rig.settle();
  assert.deepEqual(rig.runningNames(), ["timed"]);
  assert.match(rig.scheduler.waitReport(plain.id) ?? "", /cpu.*timing trial runs/u);
  rig.clock += 5_000;
  rig.sample({ cpuBusy: rig.config.cpuCalm - 0.1 });
  await rig.settle();
  assert.deepEqual(rig.runningNames().sort(), ["plain", "timed"]);
  await rig.drain();
  await Promise.all([plain.finished, locked.finished]);
});

test("a scenario tagged exclusive is a timing trial too: it waits for a calm machine and holds the others to it while it runs", async () => {
  const rig = new SchedulerRig();
  const exclusive = rig.submit([{ name: "ticks", placement: ownPlacement("own:w", true, true) }]);
  rig.sample({ cpuBusy: rig.config.cpuCalm + 0.1 });
  await rig.settle();
  assert.equal(rig.running.length, 0, "no cpu skip for it");
  rig.clock += 5_000;
  rig.sample({ cpuBusy: 0.2 });
  await rig.settle();
  assert.deepEqual(rig.runningNames(), ["ticks"]);
  const plain = rig.submit(lanes("plain"));
  rig.clock += 5_000;
  rig.sample({ cpuBusy: rig.config.cpuCalm + 0.1 });
  await rig.settle();
  assert.deepEqual(rig.runningNames(), ["ticks"]);
  await rig.drain();
  await Promise.all([exclusive.finished, plain.finished]);
});

test("a plain trial with none of ours running still starts whatever the foreign load (no starvation)", async () => {
  const rig = new SchedulerRig();
  const plain = rig.submit(lanes("plain"));
  rig.sample({ cpuBusy: 1 });
  await rig.settle();
  assert.deepEqual(rig.runningNames(), ["plain"]);
  await rig.drain();
  await plain.finished;
});

test("the MSPT bound applies to a reserved server: a second trial of the batch does not go to it while it lags", async () => {
  const rig = new SchedulerRig();
  const locked = rig.submit(lanes("t1", "t2"), { lock: true, maxLanes: 1 });
  rig.sample();
  await rig.settle();
  const lagging = rig.serverOf("t1");
  rig.pool.setHealth(lagging, { msptP95: 40, residentMb: 1_000 });
  rig.running[0]!.finish();
  await rig.settle();
  rig.clock += 5_000;
  rig.sample({ memAvailableMb: 1_500 });
  await rig.settle();
  assert.deepEqual(rig.runningNames(), [], "the lagging reserved server takes no lane and the ledger has no room for another");
  assert.match(rig.scheduler.waitReport(locked.id) ?? "", /tick time|server|memory/u);
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.equal(rig.runningNames().length, 1, "a lagging reserved server is replaced by a new one for the batch once memory allows");
  await rig.drain();
  await locked.finished;
});

test("a locked batch with --lanes 3 runs three trials at once on its reserved server", async () => {
  const rig = new SchedulerRig();
  const locked = rig.submit(lanes("a", "b", "c", "d", "e"), { lock: true, maxLanes: 3 });
  rig.sample();
  await rig.settle();
  assert.equal(rig.running.length, 3);
  assert.equal(new Set(rig.running.map(trial => trial.input.server.id)).size, 1);
  await rig.drain();
  assert.equal((await locked.finished).passed, 5);
});

test("a locked batch of an exclusive scenario gets a server of its own, reused inside the batch and stopped after it", async () => {
  const rig = new SchedulerRig();
  const locked = rig.submit([{ name: "x1", placement: ownPlacement("own:w", true, true) }, { name: "x2", placement: ownPlacement("own:w", true, true) }], { lock: true, maxLanes: 1 });
  rig.sample();
  await rig.settle();
  rig.running[0]!.finish();
  await rig.settle();
  assert.equal(rig.factory.created.length, 1, "the second trial of the batch reuses the batch's own server");
  rig.running[0]!.finish();
  await locked.finished;
  await rig.pool.reap(rig.clock + 1, new Set());
  assert.equal(rig.factory.created[0]?.stopped, true);
  const outside = rig.submit([{ name: "x3", placement: ownPlacement("own:w", true, true) }]);
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.equal(rig.factory.created.length, 2, "never reused after the batch");
  await rig.drain();
  await outside.finished;
});

test("an exclusive scenario outside a locked batch stays reusable across submissions", async () => {
  const rig = new SchedulerRig();
  const first = rig.submit([{ name: "x1", placement: ownPlacement("own:w", true, true) }]);
  rig.sample();
  await rig.settle();
  rig.running[0]!.finish();
  await first.finished;
  const second = rig.submit([{ name: "x2", placement: ownPlacement("own:w", true, true) }]);
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.equal(rig.factory.created.length, 1);
  await rig.drain();
  await second.finished;
});

test("a submitter that disconnects mid-batch: its trials are cancelled and its reserved server is stopped once they end", async () => {
  const rig = new SchedulerRig();
  const locked = rig.submit(lanes("t1", "t2"), { lock: true });
  rig.sample();
  await rig.settle();
  locked.cancel("submitter left");
  assert.equal(rig.running.every(trial => trial.input.signal.aborted), true);
  await rig.pool.reap(rig.clock + 1, new Set());
  assert.equal(rig.factory.created[0]?.stopped, false, "not while its trials still run");
  for (const trial of [...rig.running]) trial.finish("cancelled");
  await locked.finished;
  await rig.pool.reap(rig.clock + 2, new Set());
  assert.equal(rig.factory.created[0]?.stopped, true);
});

test("a hold batch queued behind a plain batch starts after it; a plain batch submitted during the hold waits for it", async () => {
  const rig = new SchedulerRig();
  const before = rig.submit(lanes("before-1", "before-2"));
  rig.sample();
  await rig.settle();
  const hold = rig.submit(lanes("load-1", "load-2"), { hold: true });
  const during = rig.submit(lanes("during"));
  rig.sample();
  await rig.settle();
  assert.deepEqual(rig.runningNames().sort(), ["before-1", "before-2"], "the hold waits for the queue ahead of it to empty; later submissions wait for the hold");
  assert.match(rig.scheduler.waitReport(during.id) ?? "", /hold batch/u);
  for (const trial of [...rig.running]) trial.finish();
  await rig.settle();
  assert.deepEqual(rig.runningNames().sort(), ["load-1", "load-2"]);
  const lateComer = rig.submit(lanes("late"));
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.deepEqual(rig.runningNames().sort(), ["load-1", "load-2"], "still alone");
  for (const trial of [...rig.running]) trial.finish();
  await hold.finished;
  await rig.settle();
  assert.deepEqual(rig.runningNames().sort(), ["during", "late"]);
  await rig.drain();
  await Promise.all([before.finished, during.finished, lateComer.finished]);
});

test("a hold batch is not a timing batch: its own load does not keep it from starting", async () => {
  const rig = new SchedulerRig();
  const hold = rig.submit(lanes("load-1"), { hold: true });
  rig.sample({ cpuBusy: 0.83 });
  await rig.settle();
  assert.deepEqual(rig.runningNames(), ["load-1"]);
  await rig.drain();
  await hold.finished;
});

test("a timing trial waiting for a calm machine holds the plain trials to CPU_CALM too, so the load drains and it starts", async () => {
  const rig = new SchedulerRig();
  const plain = rig.submit(lanes("p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"), { maxLanes: 2 });
  rig.sample({ cpuBusy: 0.3 });
  await rig.settle();
  const locked = rig.submit(lanes("timed"), { lock: true });
  const BUSY = rig.config.cpuCalm + 0.1;
  rig.clock += 5_000;
  rig.sample({ cpuBusy: BUSY });
  await rig.settle();
  assert.match(rig.scheduler.waitReport(locked.id) ?? "", /cpu/u);
  rig.finishNamed(rig.runningNames()[0]!);
  await rig.settle();
  assert.equal(rig.running.length, 1, "between CPU_CALM and CPU_ADMIT no plain trial refills the slot the timing trial is waiting for");
  assert.match(rig.scheduler.waitReport(plain.id) ?? "", /timing trial/u);
  rig.clock += 5_000;
  rig.sample({ cpuBusy: rig.config.cpuCalm - 0.1 });
  await rig.settle();
  assert.ok(rig.runningNames().includes("timed"));
  await rig.drain();
  await Promise.all([plain.finished, locked.finished]);
});

test("a hold batch tells its submitter when it starts running alone, so a load can start then and not before", async () => {
  const rig = new SchedulerRig();
  const before = rig.submit(lanes("before"));
  rig.sample();
  await rig.settle();
  const infos: string[] = [];
  const hold = rig.submit(lanes("load"), { hold: true, emit: event => { if (event.type === "info") infos.push(event.text); } });
  rig.sample();
  await rig.settle();
  assert.deepEqual(infos, [], "still waiting for the batch ahead");
  rig.finishNamed("before");
  await rig.settle();
  assert.deepEqual(infos, ["hold: this batch runs alone now"]);
  await rig.drain();
  await Promise.all([before.finished, hold.finished]);
});

test("a timing batch cancelled while it waits for a calm machine stops holding the plain trials to CPU_CALM", async () => {
  const rig = new SchedulerRig();
  const plain = rig.submit(lanes("p1", "p2"), { maxLanes: 1 });
  rig.sample({ cpuBusy: 0.3 });
  await rig.settle();
  const locked = rig.submit(lanes("timed"), { lock: true });
  const BUSY = rig.config.cpuCalm + 0.1;
  rig.clock += 5_000;
  rig.sample({ cpuBusy: BUSY });
  await rig.settle();
  rig.finishNamed("p1");
  await rig.settle();
  assert.deepEqual(rig.runningNames(), [], "held while the timing batch waits");
  locked.cancel("submitter left");
  await locked.finished;
  rig.clock += 5_000;
  rig.sample({ cpuBusy: BUSY });
  await rig.settle();
  assert.deepEqual(rig.runningNames(), ["p2"], "no timing trial waits any more: the plain bound (CPU_ADMIT) is back");
  await rig.drain();
  await plain.finished;
});
