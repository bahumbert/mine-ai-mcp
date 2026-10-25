// The scheduler boots a submission's scenario clients ahead of their trials (T7h-b): when, how many, what the ledger holds for them, and what becomes of them.
import test from "node:test";
import assert from "node:assert/strict";
import { loadScenarioServerConfig } from "./config.ts";
import { fixtureScenario } from "./scenario-fixture.ts";
import { lanePlacement, ownPlacement, SchedulerRig } from "./scheduler-rig.ts";
import { ScriptedClients, type ClientScript } from "./scripted-clients.ts";

const OPTIONS = { timeout: 30_000 };
const SERVER_MARGIN_MB = loadScenarioServerConfig({}).serverMemMarginMb;
const WARM_RESIDENT_MB = 3_000;
const lanes = (...names: string[]) => names.map(name => ({ name, placement: lanePlacement("k") }));
const OUR_HOST_ENTRY = fixtureScenario(60).client.args[0]!;

/** A rig with scripted clients; whatever a test leaves alive is killed at its end, so no process outlives it. */
async function withAhead(env: Record<string, string>, plan: readonly ClientScript[], body: (rig: SchedulerRig, clients: ScriptedClients) => Promise<void>): Promise<void> {
  const clients = new ScriptedClients(plan);
  const rig = new SchedulerRig(env, { clients });
  try {
    await body(rig, clients);
  } finally {
    rig.scheduler.cancelAll("test over");
    await clients.stopAll();
  }
}

async function booted(rig: SchedulerRig, submission: number, count: number): Promise<void> {
  await rig.until(() => rig.ahead!.counts(submission).booted >= count, `${count} clients booted`);
}

test("the trials a pass admits boot their clients in that pass, and each takes its own, with its settle and join apart in the trial line", OPTIONS, () => withAhead({}, [], async (rig, clients) => {
  rig.submit(lanes("a", "b", "c"));
  rig.sample();
  assert.equal(clients.spawned.length, 3, "spawned in the admission pass, before the trials' servers are even ready");
  await rig.settle();
  await rig.until(() => rig.running.length === 3, "three trials running");
  for (const trial of rig.running) assert.ok(clients.spawned.some(({ ahead }) => ahead === trial.clients[0]), "a trial's client is one that was booted ahead");
  assert.equal(new Set(rig.running.map(trial => trial.clients[0])).size, 3, "no client is given twice");
  await rig.drain();
  const line = rig.logs.find(text => text.startsWith("trial a lane "))!;
  assert.match(line, /arrange=\d+ settle=\d+ join=\d+ trial=\d+/u);
  assert.equal(rig.ahead!.waitingCount(), 0);
}));

test("the next trial a --lanes cap lets start gets its client booted too, and a trial admitted later takes it instead of booting its own", OPTIONS, () => withAhead({}, [], async (rig, clients) => {
  const openGate = rig.holdArrangements();
  rig.submit(lanes("a", "b", "c", "d"), { maxLanes: 1 });
  rig.sample();
  assert.equal(clients.spawned.length, 2, "a's own and b's, the next one the cap of 1 lets start: c and d wait");
  await booted(rig, 1, 2);
  openGate();
  await rig.until(() => rig.running.length === 1, "a running");
  assert.equal(rig.running[0]!.clients[0], clients.spawned[0]!.ahead, "a took the client booted for it");
  rig.finishNamed("a");
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.deepEqual(rig.runningNames(), ["b"]);
  assert.equal(clients.spawned.length, 3, "b took the client already booted for it; c's boots now");
  assert.equal(rig.running[0]!.clients[0], clients.spawned[1]!.ahead);
  await rig.drain();
}));

test("a submission never has more than clientsAhead clients waiting, and all submissions never more than clientsAheadMax", OPTIONS, async () => {
  await withAhead({ MINE_AI_SCENARIO_CLIENTS_AHEAD: "2" }, [], async (rig, clients) => {
    rig.submit(lanes("a", "b", "c", "d", "e"), { maxLanes: 1 });
    rig.sample();
    assert.equal(clients.spawned.length, 2, "a's own and one more, then the cap");
    assert.ok(rig.ahead!.waitingCount(1) <= 2);
    await rig.settle();
    rig.finishNamed("a");
    rig.clock += 5_000;
    rig.sample();
    await rig.settle();
    assert.ok(rig.ahead!.waitingCount(1) <= 2, "the cap holds as clients are taken and others boot");
    await rig.drain();
  });
  await withAhead({ MINE_AI_SCENARIO_CLIENTS_AHEAD: "5", MINE_AI_SCENARIO_CLIENTS_AHEAD_MAX: "3" }, [], async (rig, clients) => {
    rig.submit(lanes("a1", "b1", "c1", "d1"), { maxLanes: 1 });
    rig.submit(lanes("a2", "b2", "c2", "d2"), { maxLanes: 1 });
    rig.sample();
    assert.equal(clients.spawned.length, 3, "two submissions together stop at the total cap");
    await rig.drain();
  });
});

test("clients are never shared between submissions: each trial takes the one booted for its own submission", OPTIONS, () => withAhead({}, [], async (rig, clients) => {
  rig.submit(lanes("a1", "b1"), { maxLanes: 1 });
  rig.submit(lanes("a2", "b2"), { maxLanes: 1 });
  rig.sample();
  await rig.settle();
  await rig.until(() => rig.running.length === 2, "both submissions' first trials");
  const first = rig.running.find(trial => trial.input.scenario.name === "a1")!;
  const second = rig.running.find(trial => trial.input.scenario.name === "a2")!;
  assert.equal(first.clients[0], clients.spawned[0]!.ahead, "submission 1 booted its own first");
  assert.equal(second.clients[0], clients.spawned[1]!.ahead);
  assert.equal(rig.ahead!.waitingCount(1), 1, "each keeps the one it booted for its queued trial");
  assert.equal(rig.ahead!.waitingCount(2), 1);
  await rig.drain();
}));

test("a scenario whose client is not our client host gets no client ahead: it would never say it booted", OPTIONS, () => withAhead({}, [], async (rig, clients) => {
  rig.submit([{ name: "foreign", placement: ownPlacement("own:x"), client: { command: "node" } }, { name: "host", placement: lanePlacement("k"), client: { args: [OUR_HOST_ENTRY, "drivers/other.ts"] } }]);
  rig.sample();
  assert.equal(clients.spawned.length, 1, "one for the lane trial and, since the own placement's command is node, none for it");
  assert.equal(clients.spawned.filter(({ spec }) => spec.command === "node").length, 0);
  await rig.drain();
}));

test("a locked batch boots no clients ahead", OPTIONS, () => withAhead({}, [], async (rig, clients) => {
  rig.submit(lanes("t1", "t2", "t3"), { lock: true, maxLanes: 1 });
  rig.sample();
  await rig.settle();
  rig.clock += 5_000;
  rig.sample();
  assert.equal(clients.spawned.length, 0, "a timing trial's machine stays calm: no boot beside it, and none for it");
  await rig.drain();
}));

test("no client boots while a timing trial runs, and boots resume when it ends", OPTIONS, () => withAhead({}, [], async (rig, clients) => {
  rig.submit(lanes("timed"), { lock: true });
  rig.sample();
  await rig.settle();
  rig.submit(lanes("p1", "p2", "p3"), { maxLanes: 1 });
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.deepEqual(rig.runningNames().sort(), ["p1", "timed"]);
  assert.equal(clients.spawned.length, 0, "the timing trial runs: no client boots for p1 or for the queued p2 and p3");
  rig.finishNamed("timed");
  await rig.settle();
  assert.ok(clients.spawned.length >= 1, "the timing trial ended: the next queued trial's client boots");
  await rig.drain();
}));

test("no client boots while a timing trial waits for a calm machine, nor after it starts", OPTIONS, () => withAhead({}, [], async (rig, clients) => {
  rig.submit([{ name: "exclusive", placement: ownPlacement("own:t", true, true) }]);
  rig.submit(lanes("p1", "p2", "p3"), { maxLanes: 1 });
  rig.sample({ cpuBusy: 0.7 });
  rig.clock += 5_000;
  rig.sample({ cpuBusy: 0.7 });
  await rig.settle();
  assert.equal(rig.runningNames().length, 0, "everything waits for calm, the timing trial first");
  assert.equal(clients.spawned.length, 0, "the machine must calm down: a boot would be load on it");
  rig.clock += 5_000;
  rig.sample({ cpuBusy: 0.2 });
  await rig.settle();
  assert.ok(rig.runningNames().includes("exclusive"));
  assert.equal(clients.spawned.length, 0, "the timing trial runs now: still none");
  await rig.drain();
}));

test("a machine over the cpu bound boots no client ahead, and a trial still starts", OPTIONS, () => withAhead({}, [], async (rig, clients) => {
  rig.submit(lanes("a", "b"), { maxLanes: 1 });
  rig.sample({ cpuBusy: 0.9, ownCpu: 0.01 });
  await rig.settle();
  assert.equal(clients.spawned.length, 0);
  assert.deepEqual(rig.runningNames(), ["a"], "foreign load does not starve us: the trial runs and boots its client itself");
  await rig.drain();
}));

test("a tuple that failed to boot twice fails its submission's queued and admitted trials with the boot's stderr, and nothing is respawned", OPTIONS, () => withAhead({}, ["crashes", "crashes", "crashes"], async (rig, clients) => {
  const openGate = rig.holdArrangements();
  const handle = rig.submit(lanes("a", "b", "c"), { maxLanes: 1 });
  rig.sample();
  const client = fixtureScenario(60).client;
  await rig.until(() => rig.ahead!.brokenReason(1, client) !== null, "two failed boots");
  const spawnedAtGiveUp = clients.spawned.length;
  openGate();
  const summary = await handle.finished;
  assert.deepEqual({ runs: summary.runs, failed: summary.failed, passed: summary.passed }, { runs: 3, failed: 3, passed: 0 });
  const errors = rig.events.flatMap(event => (event.type === "result" ? [event.error ?? ""] : []));
  assert.equal(errors.length, 3);
  for (const error of errors) assert.match(error, /failed to boot \d times in a row.*Cannot find module '\.\/missing-driver\.ts'.*submit again/su);
  assert.equal(clients.spawned.length, spawnedAtGiveUp, "nothing respawned once the tuple was given up");
  assert.equal(rig.ahead!.waitingCount(), 0, "and no client of the tuple is left booting");
  assert.ok(rig.logs.some(text => /gave up booting clients ahead/u.test(text)));
}));

test("one failed boot does not fail a trial: it takes another client its submission booted, and the next trial gets one booted for it in turn", OPTIONS, () => withAhead({}, ["crashes"], async (rig, clients) => {
  const openGate = rig.holdArrangements();
  const handle = rig.submit(lanes("a", "b"), { maxLanes: 1 });
  rig.sample();
  await rig.until(() => rig.logs.some(text => text.startsWith("client boot failed")), "a's client lost");
  openGate();
  await rig.until(() => rig.running.length === 1, "a running");
  assert.equal(rig.running[0]!.clients[0], clients.spawned[1]!.ahead, "a took the client booted for b: a trial takes whatever its submission has booted, and b gets another");
  rig.finishNamed("a");
  rig.clock += 5_000;
  rig.sample();
  await rig.until(() => rig.running.length === 1, "b running");
  assert.equal(rig.running[0]!.clients[0], clients.spawned[2]!.ahead, "b boots its own client when it is admitted: nothing was left for it");
  rig.finishNamed("b");
  const summary = await handle.finished;
  assert.deepEqual({ runs: summary.runs, passed: summary.passed }, { runs: 2, passed: 2 });
}));

test("a cancelled submission kills the clients it booted and had not handed over, and the next submission runs from there", OPTIONS, () => withAhead({}, [], async (rig, clients) => {
  const openGate = rig.holdArrangements();
  const handle = rig.submit(lanes("a", "b", "c", "d"), { maxLanes: 1 });
  rig.sample();
  await booted(rig, 1, 2);
  handle.cancel("owner stopped it");
  await Promise.all(clients.spawned.map(({ ahead }) => ahead.closed));
  assert.deepEqual(clients.spawned.map(({ ahead }) => ahead.child.signalCode), ["SIGKILL", "SIGKILL"], "claimed or not, every client not handed over is killed");
  assert.equal(rig.ahead!.waitingCount(), 0);
  // The next action from here: the cancelled trial ends, and a new submission boots and runs with nothing of the cancelled one left.
  openGate();
  await rig.until(() => rig.running.length === 1, "the cancelled submission's running trial");
  assert.equal(rig.running[0]!.clients[0], undefined, "its client was killed with the submission: nothing to take");
  rig.finishNamed("a", "cancelled");
  const summary = await handle.finished;
  assert.deepEqual({ runs: summary.runs, cancelled: summary.cancelled }, { runs: 4, cancelled: 4 });
  const next = rig.submit(lanes("z"));
  rig.clock += 5_000;
  rig.sample();
  await rig.until(() => rig.running.some(trial => trial.input.scenario.name === "z"), "z running");
  const own = rig.running.find(trial => trial.input.scenario.name === "z")!.clients[0]!;
  assert.ok(own === clients.spawned[2]!.ahead && own.child.exitCode === null && own.child.signalCode === null, "z took its own client, alive");
  rig.finishNamed("z");
  await next.finished;
}));

test("a trial whose server never started returns its booted client to the submission's spares, and what is left when the submission ends is killed", OPTIONS, () => withAhead({}, [], async (rig, clients) => {
  // Two starts fail: the first sends a back to the queue with its client, the second is its error.
  rig.factory.failNextStart = true;
  const handle = rig.submit(lanes("a", "b"), { maxLanes: 1 });
  rig.sample();
  await booted(rig, 1, 2);
  await rig.settle();
  rig.factory.failNextStart = true;
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  await rig.until(() => rig.running.some(trial => trial.input.scenario.name === "b"), "b running after a's server failed");
  const taken = rig.running.find(trial => trial.input.scenario.name === "b")!.clients[0];
  assert.ok(clients.spawned.some(({ ahead }) => ahead === taken), "b took one of the booted clients");
  rig.finishNamed("b");
  const summary = await handle.finished;
  assert.equal(summary.failed, 1, "a failed on its server");
  const left = clients.spawned.filter(({ ahead }) => ahead !== taken);
  await Promise.all(left.map(({ ahead }) => ahead.closed));
  assert.deepEqual(left.map(({ ahead }) => ahead.child.signalCode), ["SIGKILL"], "the client nobody took died with the submission");
  assert.equal(rig.ahead!.waitingCount(), 0);
}));

// The ledger: a client booted ahead is memory already taken (`clientBootedMemMb`), its trial reserves the rest.

/** A rig where trial `a` of its own submission was admitted, then a machine reading that leaves the ledger exactly `ledgerMb` MB. */
async function rigWithLedger(ledgerMb: number, withClients: boolean): Promise<{ rig: SchedulerRig; clients: ScriptedClients }> {
  const clients = new ScriptedClients();
  const rig = new SchedulerRig({}, withClients ? { clients } : {});
  rig.submit(lanes("a"), { maxLanes: 1 });
  rig.sample();
  await rig.settle();
  const taken = 28_000 - rig.scheduler.sampleReport()!.ledgerMb;
  rig.sample({ memAvailableMb: taken + ledgerMb });
  return { rig, clients };
}

test("a trial that takes a client booted ahead reserves only the difference to a logged-in client: it starts where a whole client would not fit", OPTIONS, async () => {
  const started: Record<string, string[]> = {};
  for (const withClients of [true, false]) {
    // The next trial queues behind `a`'s lane cap in a submission of its own pass: it is tried when `a` settles.
    const clients = new ScriptedClients();
    const rig = new SchedulerRig({}, withClients ? { clients } : {});
    try {
      const handle = rig.submit(lanes("a", "b"), { maxLanes: 1 });
      rig.sample();
      await rig.settle();
      // `a`'s server is a warm one (3000 MB resident): when `a` settles it goes idle, its growth leaves the ledger and `b` reserves it again with
      // its client and the margin. The live ledger sits half way between that line for the difference and for a whole client.
      rig.pool.setHealth(rig.serverOf("a"), { msptP95: 5, residentMb: WARM_RESIDENT_MB });
      rig.sample();
      const taken = 28_000 - rig.scheduler.sampleReport()!.ledgerMb;
      const { serverMemMarginMb, clientMemMb, clientBootedMemMb } = rig.config;
      const difference = clientMemMb - clientBootedMemMb;
      const room = difference + serverMemMarginMb + (clientMemMb - difference) / 2;
      rig.sample({ memAvailableMb: taken + room });
      rig.finishNamed("a");
      await rig.settle();
      started[withClients ? "ahead" : "plain"] = rig.runningNames();
      if (!withClients) assert.match(rig.scheduler.waitReport(handle.id) ?? "", /memory ledger/u);
    } finally {
      rig.scheduler.cancelAll("test over");
      await clients.stopAll();
    }
  }
  assert.deepEqual(started, { ahead: ["b"], plain: [] });
});

test("a client is booted for a queued trial only when the ledger holds its booted size and still a whole client for the next trial", OPTIONS, async () => {
  const spawned: Record<string, number> = {};
  for (const [label, ledger] of [["room", 800 + SERVER_MARGIN_MB], ["tight", 600 + SERVER_MARGIN_MB]] as const) {
    const { rig, clients } = await rigWithLedger(ledger, true);
    try {
      const before = clients.spawned.length;
      rig.submit(lanes("b", "c"), { maxLanes: 1 });
      spawned[label] = clients.spawned.length - before;
    } finally {
      rig.scheduler.cancelAll("test over");
      await clients.stopAll();
    }
  }
  assert.deepEqual(spawned, { room: 2, tight: 1 }, "b is admitted and boots its own; c's boots only if 250 + 125 MB and the server margin are left after b's whole client");
});

test("the ledger the daemon logs holds the booted size of a client waiting for a queued trial, and nothing extra for one booted for an admitted trial", OPTIONS, async () => {
  const ledgers: Record<string, number> = {};
  for (const [label, names] of [["one trial", ["a"]], ["with a queued trial", ["a", "b"]]] as const) {
    const clients = new ScriptedClients();
    const rig = new SchedulerRig({}, { clients });
    try {
      rig.submit(lanes(...names), { maxLanes: 1 });
      rig.sample();
      rig.sample();
      ledgers[label] = rig.scheduler.sampleReport()!.ledgerMb;
    } finally {
      rig.scheduler.cancelAll("test over");
      await clients.stopAll();
    }
  }
  assert.equal(ledgers["one trial"]! - ledgers["with a queued trial"]!, new SchedulerRig().config.clientBootedMemMb);
});

test("a trial that cannot start soon gets no client booted: a hold batch waiting its turn, and the trials past a --lanes cap's next wave", OPTIONS, () => withAhead({}, [], async (rig, clients) => {
  rig.submit(lanes("a", "b", "c", "d", "e", "f"), { maxLanes: 2 });
  rig.sample();
  assert.equal(clients.spawned.length, 4, "two admitted trials' own, and the two the cap lets start next; c, d, e, f beyond that wait");
  const before = clients.spawned.length;
  rig.submit(lanes("h1", "h2", "h3", "h4", "h5"), { hold: true });
  rig.clock += 5_000;
  rig.sample();
  assert.equal(clients.spawned.length, before, "the hold batch waits for the submission ahead of it to finish: its clients would idle for minutes");
}));

test("the boots of one pass are counted against the cpu bound: a machine near it takes a boot or two, not a whole cap of them", OPTIONS, () => withAhead({}, [], async (rig, clients) => {
  rig.submit(lanes(...Array.from({ length: 40 }, (_, index) => `t${index}`)));
  rig.sample({ cpuBusy: 0.84 });
  assert.ok(clients.spawned.length >= 1 && clients.spawned.length <= 2, `${clients.spawned.length} clients booted in one pass at 84% cpu with the bound at 85%`);
  assert.ok(rig.scheduler.runningCount >= 1, "foreign load does not hold the trials back");
}));

// A trial whose server died.

test("a trial waiting for the arrangement turn of a server that died, sent back to the queue with no room for a new server, returns the client booted for it to the submission's spares", OPTIONS, () => withAhead({}, [], async (rig, clients) => {
  rig.holdArrangements();
  rig.submit(lanes("a", "b"));
  rig.sample();
  await booted(rig, 1, 2);
  await rig.settle();
  const client = fixtureScenario(60).client;
  assert.equal(rig.ahead!.unclaimedCount(1, client), 0, "a and b each hold their client");
  await rig.killJavaOf(0, 3_000);
  assert.equal(rig.ahead!.unclaimedCount(1, client), 1, "b never arranged and waits for a server: its client is back among the spares; a still holds its own");
  assert.equal(clients.spawned.length, 2);
}));

// T7h-b deviation, owner 2026-10-25 (Q6): a timing trial may take a client booted for another trial of its tuple; none boots for it or beside it.

test("an exclusive entry takes a client already booted for its submission's tuple, and nothing new boots", OPTIONS, () => withAhead({}, [], async (rig, clients) => {
  const spare = rig.ahead!.spawn(1, fixtureScenario(60).client);
  assert.equal(spare, null, "the client starts booting");
  await booted(rig, 1, 1);
  const handle = rig.submit([{ name: "timed", placement: ownPlacement("own:t", true, true) }]);
  assert.equal(handle.id, 1);
  rig.sample();
  await rig.settle();
  await rig.until(() => rig.running.length === 1, "the exclusive entry running");
  assert.equal(rig.running[0]!.clients[0], clients.spawned[0]!.ahead, "it took the client booted before it");
  assert.equal(clients.spawned.length, 1, "no boot for it, none beside it");
  await rig.drain();
}));
