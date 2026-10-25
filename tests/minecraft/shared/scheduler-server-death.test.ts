// A server whose java process died or never started: its trials end red or go back to the queue once, and the next trial runs on another server.
import test from "node:test";
import assert from "node:assert/strict";
import type { Scenario } from "mine-labs";
import { renameBodyOnOwnServer } from "../arena/own-body.ts";
import { fixtureScenario } from "./scenario-fixture.ts";
import { ScriptedClients } from "./scripted-clients.ts";
import { lanePlacement, ownPlacement, SchedulerRig } from "./scheduler-rig.ts";

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

// R20: a trial on a server of its own has no arrangement queue; `TrialEnd.arranged` says whether anything of it ran.

const OPTIONS = { timeout: 30_000 };
const BACK = /its server died before its arrangement, back in the queue/u;
const backCount = (rig: SchedulerRig) => rig.logs.filter(line => BACK.test(line)).length;

/**
 * Holds every trial before its arrangement; the returned function ends the held run as a runner does whose RCON died ("rcon closed").
 * It clears the gate first, so a run started after it (the trial sent back) is not failed too.
 */
function failingArrangement(rig: SchedulerRig): () => void {
  let fail!: (error: Error) => void;
  const gate = new Promise<void>((_, reject) => { fail = reject; });
  gate.catch(() => {});
  rig.arrangeGate = gate;
  return () => {
    rig.arrangeGate = null;
    fail(new Error("rcon closed"));
  };
}

const resultError = (rig: SchedulerRig, name: string) => {
  const event = resultOf(rig, name);
  return event?.type === "result" ? event.error ?? "" : null;
};

for (const [label, reusable] of [["reusable", true], ["non-reusable", false]] as const) {
  test(`an own ${label} trial whose java died before its arrangement goes back to the queue once, runs on a new server, and its result is the second run's`, OPTIONS, async () => {
    const rig = new SchedulerRig();
    const failArrangement = failingArrangement(rig);
    const handle = rig.submit([{ name: "a", placement: ownPlacement("own:a", reusable) }]);
    rig.sample();
    await rig.settle();
    await rig.killJavaOf(0);
    failArrangement();
    await rig.settle();
    assert.equal(backCount(rig), 1);
    assert.equal(resultOf(rig, "a"), undefined, "its server's death is not its result");
    await rig.until(() => rig.running.length === 1, "a running again");
    assert.equal(rig.serverOf("a"), "s2");
    rig.finishNamed("a");
    const summary = await handle.finished;
    assert.deepEqual([summary.passed, summary.failed], [1, 0]);
    assert.equal(backCount(rig), 1, "back in the queue once");
  });
}

test("an own trial whose java dies after it was prepared ends red naming the death and is not sent back", OPTIONS, async () => {
  const rig = new SchedulerRig();
  rig.submit([{ name: "a", placement: ownPlacement("own:a") }]);
  rig.sample();
  await rig.settle();
  const running = rig.running[0]!;
  await rig.killJavaOf(0);
  running.finish("cancelled");
  await rig.settle();
  assert.match(resultError(rig, "a") ?? "", /server s1 died/u);
  assert.equal(backCount(rig), 0);
  assert.equal(rig.factory.created.length, 1);
});

test("an own trial whose servers die twice before its arrangement ends red with the second death", OPTIONS, async () => {
  const rig = new SchedulerRig();
  const failFirst = failingArrangement(rig);
  rig.submit([{ name: "a", placement: ownPlacement("own:a") }]);
  rig.sample();
  await rig.settle();
  await rig.killJavaOf(0);
  failFirst();
  const failSecond = failingArrangement(rig);
  await rig.settle();
  assert.equal(backCount(rig), 1);
  await rig.killJavaOf(1);
  failSecond();
  await rig.settle();
  assert.match(resultError(rig, "a") ?? "", /server s2 died/u, "the second death is its error");
  assert.equal(backCount(rig), 1, "sent back once");
  assert.equal(rig.scheduler.queuedCount, 0);
});

test("a submission cancelled while its own trial's server is dead is not re-queued", OPTIONS, async () => {
  const rig = new SchedulerRig();
  const failArrangement = failingArrangement(rig);
  const handle = rig.submit([{ name: "a", placement: ownPlacement("own:a") }]);
  rig.sample();
  await rig.settle();
  await rig.killJavaOf(0);
  handle.cancel("the owner cancelled");
  failArrangement();
  const summary = await handle.finished;
  assert.equal(summary.runs, 1);
  assert.equal(backCount(rig), 0);
  assert.equal(rig.scheduler.queuedCount, 0);
  assert.equal(rig.factory.created.length, 1, "no server for it");
});

test("an exclusive own trial sent back waits for a calm machine again, and nothing starts or boots beside it", OPTIONS, async () => {
  const clients = new ScriptedClients();
  const rig = new SchedulerRig({}, { clients });
  try {
    const failArrangement = failingArrangement(rig);
    rig.submit([{ name: "timed", placement: ownPlacement("own:t", true, true) }]);
    rig.sample();
    await rig.settle();
    await rig.killJavaOf(0);
    rig.sample({ cpuBusy: 0.7 });
    failArrangement();
    await rig.settle();
    assert.equal(backCount(rig), 1);
    const booted = clients.spawned.length;
    const other = rig.submit([{ name: "other", placement: lanePlacement("k") }]);
    await rig.settle();
    assert.deepEqual(rig.runningNames(), [], "neither starts on a machine over the calm bound");
    assert.equal(rig.pool.list().length, 0, "no server was started for the trial or beside it");
    assert.equal(clients.spawned.length, booted, "no client was booted beside it");
    other.cancel("not needed");
    rig.clock += 5_000;
    rig.sample({ cpuBusy: 0.2 });
    await rig.settle();
    assert.deepEqual(rig.runningNames(), ["timed"], "it starts once the machine is calm, on the new server");
    assert.equal(rig.serverOf("timed"), "s2");
    await rig.drain();
  } finally {
    rig.scheduler.cancelAll("test over");
    await clients.stopAll();
  }
});

for (const lane of [false, true]) {
  const kind = lane ? "lane" : "own";
  test(`a ${kind} trial that fails with an RCON error before its java is known dead is sent back when the death is confirmed within the bound`, OPTIONS, async () => {
    const rig = new SchedulerRig();
    const failArrangement = failingArrangement(rig);
    const handle = rig.submit([{ name: "a", placement: lane ? lanePlacement("k") : ownPlacement("own:a") }]);
    rig.sample();
    await rig.settle();
    failArrangement();
    await rig.settle();
    assert.equal(resultOf(rig, "a"), undefined, "the failure is not settled before the death is confirmed or the bound passed");
    assert.equal(rig.scheduler.runningCount, 1);
    assert.ok(rig.logs.some(line => /^a: failed before its arrangement, waiting up to \d+ ms for the death of server s1 to be confirmed$/u.test(line)));
    await rig.killJavaOf(0);
    assert.equal(backCount(rig), 1);
    await rig.until(() => rig.running.length === 1, "a running on the new server");
    assert.equal(rig.serverOf("a"), "s2");
    rig.finishNamed("a");
    const summary = await handle.finished;
    assert.deepEqual([summary.passed, summary.failed], [1, 0]);
  });
}

test("a cancel of the submission ends the wait for the death at once: the trial settles with its own error and is not re-queued", OPTIONS, async () => {
  const rig = new SchedulerRig();
  const failArrangement = failingArrangement(rig);
  const handle = rig.submit([{ name: "a", placement: ownPlacement("own:a") }]);
  rig.sample();
  await rig.settle();
  failArrangement();
  await rig.settle();
  assert.equal(resultOf(rig, "a"), undefined, "waiting for the death");
  handle.cancel("the owner cancelled");
  const summary = await handle.finished;
  assert.equal(summary.runs, 1);
  assert.match(resultError(rig, "a") ?? "", /rcon closed/u);
  assert.equal(backCount(rig), 0);
});

test("a trial that fails with an RCON error on a server whose java stays alive settles red with its own error once the confirmation bound passed", OPTIONS, async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_SAMPLE_EVERY_MS: "50" });
  const failArrangement = failingArrangement(rig);
  rig.submit([{ name: "a", placement: ownPlacement("own:a") }]);
  rig.sample();
  await rig.settle();
  failArrangement();
  await rig.settle();
  assert.equal(resultOf(rig, "a"), undefined, "it waits for the death");
  await rig.until(() => resultOf(rig, "a") !== undefined, "the bound to pass");
  assert.match(resultError(rig, "a") ?? "", /rcon closed/u);
  assert.doesNotMatch(resultError(rig, "a") ?? "", /died/u, "the server did not die");
  assert.equal(backCount(rig), 0);
});

test("the ledger after a send-back and the new server's start holds one own server and one client, a client still booting included", OPTIONS, async () => {
  const MACHINE_MB = 20_000;
  const ledgers: Record<string, number> = {};
  for (const died of [false, true]) {
    const clients = new ScriptedClients(["hangs"]);
    const rig = new SchedulerRig({}, { clients });
    try {
      const failArrangement = failingArrangement(rig);
      rig.submit([{ name: "a", placement: ownPlacement("own:a") }]);
      rig.sample();
      await rig.settle();
      if (died) {
        await rig.killJavaOf(0);
        failArrangement();
        rig.arrangeGate = new Promise<void>(() => {}); // the new run waits too: a client it took would be in the machine reading, not in the ledger
        await rig.settle();
        await rig.until(() => rig.scheduler.runningCount === 1 && rig.pool.list().length === 1, "a admitted again on its new server");
      }
      rig.sample({ memAvailableMb: MACHINE_MB });
      ledgers[died ? "sent back" : "admitted once"] = rig.scheduler.sampleReport()!.ledgerMb;
      assert.equal(clients.spawned.length, 1, "the client booted for the first admission is the one the re-admission keeps");
    } finally {
      rig.scheduler.cancelAll("test over");
      await clients.stopAll();
    }
  }
  assert.equal(ledgers["sent back"], ledgers["admitted once"], "one client in the ledger, not half of one");
});

test("a client booted ahead for a trial sent back returns to the submission's spares uncovered: it grows into the ledger at its booted size", OPTIONS, async () => {
  const clients = new ScriptedClients(["hangs"]);
  const rig = new SchedulerRig({}, { clients });
  try {
    const failArrangement = failingArrangement(rig);
    rig.submit([{ name: "a", placement: ownPlacement("own:a") }]);
    rig.sample();
    await rig.settle();
    const client = fixtureScenario(60).client;
    assert.equal(rig.ahead!.youngMb(rig.clock), 0, "booted for an admitted trial: its reserve holds the whole client");
    await rig.killJavaOf(0, 3_000);
    failArrangement();
    await rig.settle();
    assert.equal(backCount(rig), 1);
    assert.equal(rig.scheduler.runningCount, 0, "no room for a new server");
    assert.equal(rig.ahead!.unclaimedCount(1, client), 1, "back among the spares");
    assert.equal(rig.ahead!.youngMb(rig.clock), rig.config.clientBootedMemMb, "the trial's young entry is gone: the spare carries its own");
  } finally {
    rig.scheduler.cancelAll("test over");
    await clients.stopAll();
  }
});

test("a locked batch's own trial sent back runs again on a server keyed for its batch, and the timing count is back to 0 between the runs", OPTIONS, async () => {
  const rig = new SchedulerRig();
  const failArrangement = failingArrangement(rig);
  const handle = rig.submit([{ name: "timed", placement: ownPlacement("own:t") }], { lock: true });
  rig.sample();
  await rig.settle();
  const [first] = rig.pool.list();
  assert.match(first!.key, /#batch\d+$/u);
  await rig.killJavaOf(0);
  failArrangement();
  await rig.settle();
  assert.equal(backCount(rig), 1);
  await rig.until(() => rig.running.length === 1, "the batch's trial running again");
  const second = rig.pool.list().find(server => server.id === rig.serverOf("timed"))!;
  assert.equal(second.id, "s2");
  assert.equal(second.key, first!.key, "the batch's key");
  rig.finishNamed("timed");
  await handle.finished;
  // A count left at 1 by the send-back would hold every later trial to the calm bound.
  rig.submit([{ name: "plain", placement: lanePlacement("k") }]);
  rig.clock += 5_000;
  rig.sample({ cpuBusy: 0.7 });
  await rig.settle();
  assert.deepEqual(rig.runningNames(), ["plain"]);
  await rig.drain();
});

test("an own trial sent back from a reused server gets the body its new server gives, never the dead one's", OPTIONS, async () => {
  const rig = new SchedulerRig();
  const first = rig.submit([{ name: "a", placement: ownPlacement("own:r") }]);
  rig.sample();
  await rig.settle();
  rig.finishNamed("a");
  await first.finished;
  const failArrangement = failingArrangement(rig);
  rig.submit([{ name: "b", placement: ownPlacement("own:r") }]);
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.equal(rig.pool.list()[0]!.id, "s1", "b reuses a's server and gets its second body");
  await rig.killJavaOf(0);
  failArrangement();
  await rig.settle();
  await rig.until(() => rig.running.length === 1, "b running again");
  const names = (scenario: Scenario) => scenario.players.map(player => player.name);
  const original = fixtureScenario(60, "b");
  const secondBody = renameBodyOnOwnServer(original, 1);
  assert.ok(secondBody.ok && names(secondBody.scenario).join() !== names(original).join(), "the dead server's body would have been another name");
  assert.deepEqual(names(rig.running[0]!.input.scenario), names(original), "the new server's first body");
  await rig.drain();
});
