// A server whose java process died or never started: its trials end red or go back to the queue once, and the next trial runs on another server.
import test from "node:test";
import assert from "node:assert/strict";
import { lanePlacement, SchedulerRig } from "./scheduler-rig.ts";

const resultOf = (rig: SchedulerRig, name: string) => rig.events.find(event => event.type === "result" && event.name === name);

test("a trial running on a server whose java died is told, and ends red naming the death; the next trial of the key runs on another server in its submission's pass", async () => {
  const rig = new SchedulerRig();
  rig.submit([{ name: "a", placement: lanePlacement("k") }]);
  rig.sample();
  await rig.settle();
  const running = rig.running[0]!;
  await rig.killJavaOf(0);
  assert.equal(running.input.signal.aborted, true, "the trial running on it is aborted, not left to the RCON timeouts");
  running.finish("cancelled");
  await rig.settle();
  const event = resultOf(rig, "a");
  assert.equal(event?.type === "result" ? event.outcome : null, "error");
  assert.match(event?.type === "result" ? event.error ?? "" : "", /server s1 died/u);
  rig.submit([{ name: "b", placement: lanePlacement("k") }]);
  await rig.settle();
  assert.equal(rig.serverOf("b"), "s2", "b is not admitted to the dead server");
});

test("a trial still waiting for the arrangement turn of a server whose java died goes back to the queue once and runs on another server; the one arranging ends red", async () => {
  const rig = new SchedulerRig();
  let open!: () => void;
  rig.arrangeGate = new Promise<void>(resolve => { open = resolve; });
  rig.submit([{ name: "a", placement: lanePlacement("k") }, { name: "b", placement: lanePlacement("k") }]);
  rig.sample();
  await rig.settle();
  await rig.killJavaOf(0);
  assert.equal(resultOf(rig, "b"), undefined, "b has not arranged anything: it is not a result");
  open();
  await rig.settle();
  assert.equal(rig.serverOf("b"), "s2");
  rig.finishNamed("a", "cancelled");
  rig.finishNamed("b");
  await rig.settle();
  const arranging = resultOf(rig, "a");
  assert.match(arranging?.type === "result" ? arranging.error ?? "" : "", /server s1 died/u);
  const waiting = resultOf(rig, "b");
  assert.equal(waiting?.type === "result" ? waiting.outcome : null, "pass");
});

test("a server that fails to start sends its trials back to the queue once: they run on the next server", async () => {
  const rig = new SchedulerRig();
  let release!: () => void;
  rig.factory.startGate = new Promise<void>(resolve => { release = resolve; });
  rig.factory.failNextStart = true;
  const handle = rig.submit([{ name: "a", placement: lanePlacement("k") }, { name: "b", placement: lanePlacement("k") }]);
  rig.sample();
  await rig.settle();
  rig.factory.startGate = null;
  release();
  await rig.settle();
  assert.equal(rig.events.filter(event => event.type === "result").length, 0, "neither trial ended: both wait for another server");
  assert.equal(rig.scheduler.queuedCount, 2);
  assert.equal(rig.scheduler.runningCount, 0, "nothing of the failed admission is left running or in the pool");
  assert.equal(rig.pool.list().length, 0);
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.deepEqual(rig.runningNames().sort(), ["a", "b"]);
  assert.equal(rig.serverOf("a"), "s2");
  await rig.drain();
  const summary = await handle.finished;
  assert.deepEqual([summary.passed, summary.failed], [2, 0]);
});

test("a trial sent back from a failed start leaves nothing in the memory ledger: it is what a machine with no trial reads", async () => {
  const tight = { memAvailableMb: 3_000 };
  const idle = new SchedulerRig();
  idle.sample();
  idle.sample(tight);
  const sentBack = new SchedulerRig();
  sentBack.factory.failNextStart = true;
  sentBack.submit([{ name: "a", placement: lanePlacement("k") }]);
  sentBack.sample();
  await sentBack.settle();
  sentBack.sample(tight);
  assert.equal(sentBack.scheduler.sampleReport()!.ledgerMb, idle.scheduler.sampleReport()!.ledgerMb, "the failed admission's client is not still growing in the ledger");
});
