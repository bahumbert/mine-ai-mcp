// T7c: the arrangement queue as a placement bound, the daemon's trial line, own-server bodies, growth under demand, the sample report.
import test from "node:test";
import assert from "node:assert/strict";
import { lanePlacement, ownPlacement, SchedulerRig } from "./scheduler-rig.ts";
import { fixtureScenario } from "./scenario-fixture.ts";

const lanes = (count: number, key = "k") => Array.from({ length: count }, (_, index) => ({ name: `t${index}`, placement: lanePlacement(key) }));
const queued = (rig: SchedulerRig) => Object.fromEntries([...rig.pool.queues(rig.pool.list().map(server => server.id))].map(([id, queue]) => [id, queue.queued]));

function closedGate(rig: SchedulerRig): () => void {
  let open!: () => void;
  rig.arrangeGate = new Promise<void>(resolve => { open = resolve; });
  return open;
}

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
  closedGate(rig);
  rig.submit(lanes(9));
  await rig.settle();
  assert.equal(rig.scheduler.runningCount, 9);
  assert.deepEqual(queued(rig), { s1: 6, s2: 3 }, "6 arrangements queued at 800 ms fit 5 s, the 7th would not");
  assert.match(rig.logs.find(line => line.includes("server s2 (shared")) ?? "", /starting: key's servers refused it \(arrangement queue/u);
});

test("the first server of a key starts once per sample like any server: the trials it cannot take in time wait on the shortest queue, not outside the target", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_MAX_PLAYERS: "30" });
  closedGate(rig);
  rig.submit(lanes(9));
  rig.sample();
  await rig.settle();
  assert.equal(rig.scheduler.runningCount, 9);
  assert.deepEqual(queued(rig), { s1: 9 });
  assert.equal(rig.factory.created.length, 1);
});

test("the queue empties as trials are arranged and restored", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_MAX_PLAYERS: "30" });
  const open = closedGate(rig);
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
  // 1000 MB of ledger are left when the 7th trial is asked: a client fits (250), a new server (4346) does not.
  await warmServer(rig, { memAvailableMb: 3_584 + 250 + 6 * 250 + 1_000 });
  closedGate(rig);
  rig.submit(lanes(9));
  await rig.settle();
  assert.equal(rig.factory.created.length, 1);
  assert.equal(rig.scheduler.runningCount, 9);
  assert.deepEqual(queued(rig), { s1: 9 });
});

test("a server of its own is not a candidate for the queue bound: any number of reusable scenarios queue on their own servers as before", async () => {
  const rig = new SchedulerRig();
  closedGate(rig);
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
      lane: "free", serverSick: false, hitWallBound: false, restored: true, mutexWaitMs: 0,
      phases: { mutexWaitMs: 0, arrangeMs: 1_500, joinMs: 0, trialMs: 0, restoreWaitMs: 0, restoreMs: 500 } }, rig.clock);
  }
  assert.equal(rig.pool.queues([server.id]).get(server.id)?.holdMs, 2_000);
});

const TRIAL_LINE = /^trial (\S+) lane (\S+) server (s\d+) queue=(\d+) serverWait=(\d+) mutexWait=(\d+) arrange=(\d+) join=(\d+) trial=(\d+) restoreWait=(\d+) restore=(\d+) hold=(\d+)$/u;

test("each settled lane trial writes one line: where it ran, its wait before admission and for the server, the six phases and its hold", async () => {
  const rig = new SchedulerRig();
  const handle = rig.submit([{ name: "a", placement: lanePlacement("k") }]);
  rig.clock += 7_000;
  rig.sample();
  await rig.settle();
  rig.clock += 2_500;
  rig.running[0]!.finish();
  await handle.finished;
  const line = rig.logs.find(candidate => candidate.startsWith("trial "));
  assert.ok(line, `no trial line in ${rig.logs.join(" | ")}`);
  const match = TRIAL_LINE.exec(line);
  assert.ok(match, line);
  assert.deepEqual([match[1], match[2], match[3], match[4], match[12]], ["a", "1", "s1", "7000", "2500"], "queue is admission minus submission, hold is settle minus admission");
});

test("a trial on a server of its own says own, and one that never ran says its phases are none", async () => {
  const rig = new SchedulerRig();
  const own = rig.submit([{ name: "n", placement: ownPlacement("own:w") }]);
  rig.sample();
  await rig.settle();
  rig.running[0]!.finish();
  await own.finished;
  assert.match(rig.logs.find(line => line.startsWith("trial n "))!, /^trial n lane own server s1 queue=0 /u);
  rig.factory.failNextStart = true;
  const failing = rig.submit([{ name: "f", placement: lanePlacement("k") }]);
  rig.clock += 5_000;
  rig.sample();
  await failing.finished;
  assert.match(rig.logs.find(line => line.startsWith("trial f "))!, /^trial f lane 1 server s2 queue=5000 .* phases=none hold=\d+$/u);
});

test("the second scenario on a reusable server of its own logs in under another body: the same server, a name it has not saved", async () => {
  const rig = new SchedulerRig();
  const first = rig.submit([{ name: "n1", placement: ownPlacement("own:w") }]);
  rig.sample();
  await rig.settle();
  assert.deepEqual(rig.running[0]!.input.scenario.players.map(player => player.name), ["Actor"], "the first scenario of a server runs as written");
  rig.running[0]!.finish();
  await first.finished;
  const second = rig.submit([{ name: "n2", placement: ownPlacement("own:w") }]);
  rig.sample();
  await rig.settle();
  assert.equal(rig.factory.created.length, 1, "the same server");
  assert.deepEqual(rig.running[0]!.input.scenario.players.map(player => player.name), ["ActorL0001"]);
  rig.running[0]!.finish();
  await second.finished;
  const third = rig.submit([{ name: "n3", placement: ownPlacement("own:w") }]);
  rig.sample();
  await rig.settle();
  assert.deepEqual(rig.running[0]!.input.scenario.players.map(player => player.name), ["ActorL0002"]);
  rig.running[0]!.finish();
  await third.finished;
});

test("a scenario that cannot be given a fresh body is an error that says why, never run under the old name", async () => {
  const rig = new SchedulerRig();
  const first = rig.submit([{ name: "n1", placement: ownPlacement("own:w") }]);
  rig.sample();
  await rig.settle();
  rig.running[0]!.finish();
  await first.finished;
  const base = fixtureScenario(60, "n2");
  const clashing = { ...base, players: ["ABCDEFGHIJKAAAAA", "ABCDEFGHIJKBBBBB"].map(name => ({ ...base.players[0]!, name })) };
  const second = rig.scheduler.submit({
    entries: [{ name: "n2", scenario: clashing, placement: ownPlacement("own:w") }], repeat: 1, maxLanes: null, lock: false, hold: false,
    outDir: "/tmp/out", emit: event => rig.events.push(event),
  });
  rig.sample();
  await rig.settle();
  assert.equal(rig.running.length, 0, "it never started");
  await second.finished;
  const result = rig.events.find(event => event.type === "result" && event.name === "n2");
  assert.equal(result?.type === "result" ? result.outcome : "", "error");
  assert.match(result?.type === "result" ? result.error ?? "" : "", /fresh body.*ABCDEFGHIJKAAAAA.*ABCDEFGHIJKBBBBB/u);
});

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

test("a server of its own is not reused after a scenario that could not get a fresh body: the next scenario of the key starts another server", async () => {
  const rig = new SchedulerRig();
  const first = rig.submit([{ name: "n1", placement: ownPlacement("own:w") }]);
  rig.sample();
  await rig.settle();
  rig.running[0]!.finish();
  await first.finished;
  const base = fixtureScenario(60, "n2");
  const clashing = { ...base, players: ["BuilderAlpha1", "BuilderAlpha2"].map(name => ({ ...base.players[0]!, name })) };
  const second = rig.scheduler.submit({
    entries: [{ name: "n2", scenario: clashing, placement: ownPlacement("own:w") }], repeat: 1, maxLanes: null, lock: false, hold: false,
    outDir: "/tmp/out", emit: event => rig.events.push(event),
  });
  rig.sample();
  await rig.settle();
  await second.finished;
  assert.deepEqual(rig.pool.reusableSingles("own:w"), [], "the server that refused is retired, not left idle for the next scenario");
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

// T7c3. MAX_PLAYERS 22 gives 20 lanes a server: SERVERS_PER_KEY 2 spreads a key from 2 x 20 / 2 = 20 trials queued, 3 from 30.
const SPREAD_ENV = { MINE_AI_SCENARIO_MAX_PLAYERS: "22" };
/** The target is out of the way (60): these tests are about where trials go, not how many run. */
const spreadOver = (servers: number) => ({ ...SPREAD_ENV, MINE_AI_SCENARIO_SERVERS_PER_KEY: String(servers), MINE_AI_SCENARIO_TARGET_START: "60" });
const serverIdsOf = (rig: SchedulerRig) => rig.pool.list().map(server => server.id);

test("SERVERS_PER_KEY 1, the default: 20 trials queued start one server, all on it", async () => {
  const rig = new SchedulerRig(SPREAD_ENV);
  assert.equal(rig.config.serversPerKey, 1);
  closedGate(rig);
  rig.submit(lanes(20));
  rig.sample();
  await rig.settle();
  assert.deepEqual(queued(rig), { s1: 20 });
});

test("SERVERS_PER_KEY 2 with 20 trials queued: both servers start in the first pass and the trials alternate by arrangement queue", async () => {
  const rig = new SchedulerRig(spreadOver(2));
  closedGate(rig);
  rig.submit(lanes(20));
  rig.sample();
  await rig.settle();
  assert.equal(rig.scheduler.runningCount, 20);
  assert.deepEqual(serverIdsOf(rig), ["s1", "s2"]);
  assert.deepEqual(queued(rig), { s1: 10, s2: 10 });
  assert.match(rig.logs.find(line => line.includes("server s2 (shared")) ?? "", /starting: spread over 2 servers/u);
});

test("SERVERS_PER_KEY 3 counts only the trials of the key: 30 of it start three servers, 29 of it (under 30) start one, the other key's 5 do not count", async () => {
  const spread = new SchedulerRig(spreadOver(3));
  closedGate(spread);
  spread.submit(lanes(30));
  spread.sample();
  await spread.settle();
  assert.deepEqual(queued(spread), { s1: 10, s2: 10, s3: 10 });
  const mixed = new SchedulerRig(spreadOver(3));
  closedGate(mixed);
  mixed.submit([...lanes(29), ...lanes(5, "other")]);
  mixed.sample();
  await mixed.settle();
  assert.deepEqual(mixed.pool.list().filter(server => server.key === "k").length, 1, "29 trials of the key, under 30: one server");
});

test("SERVERS_PER_KEY 2 and the ledger cannot pay a second server: none starts and the first takes the trials", async () => {
  const rig = new SchedulerRig(spreadOver(2));
  closedGate(rig);
  // A new server with its client needs 250 + 3072 + 1024 = 4346 MB; once the first trial is in, the server's growth (3584) and its client (250) are out of the ledger: 1 MB short of a second.
  rig.submit(lanes(20));
  rig.sample({ memAvailableMb: 3_584 + 250 + 4_346 - 1 });
  await rig.settle();
  assert.deepEqual(serverIdsOf(rig), ["s1"]);
  assert.ok((queued(rig).s1 ?? 0) > 1, "the trials that fit the ledger are on s1");
});

test("SERVERS_PER_KEY 2: trials placed while the servers still start take the shorter queue of the two, ready or not", async () => {
  const rig = new SchedulerRig(spreadOver(2));
  closedGate(rig);
  let startsAt!: () => void;
  rig.factory.startGate = new Promise<void>(resolve => { startsAt = resolve; });
  rig.submit(lanes(20));
  rig.sample();
  await rig.settle();
  assert.deepEqual(rig.pool.readings().map(reading => reading.status), ["starting", "starting"]);
  assert.deepEqual(queued(rig), { s1: 10, s2: 10 });
  startsAt();
  await rig.settle();
});

test("SERVERS_PER_KEY 2: a sick server takes no trial, the key's other server takes them, and a replacement starts only while 20 trials of the key still wait", async () => {
  const rig = new SchedulerRig(spreadOver(2));
  closedGate(rig);
  rig.submit(lanes(20));
  rig.sample();
  await rig.settle();
  rig.pool.markSick("s2");
  rig.submit(lanes(1));
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.deepEqual(serverIdsOf(rig), ["s1", "s2"], "1 trial queued: no replacement");
  assert.equal(queued(rig).s1, 11, "the new trial took s1, never the sick s2");
  rig.submit(lanes(20));
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.ok(serverIdsOf(rig).includes("s3"), serverIdsOf(rig).join());
  assert.match(rig.logs.find(line => line.includes("server s3 (shared")) ?? "", /replaces retired s2/u);
});

test("SERVERS_PER_KEY 2 on a locked batch: its own key spreads over two servers of its own, the plain submission of the same key uses neither", async () => {
  const rig = new SchedulerRig(spreadOver(2));
  closedGate(rig);
  rig.submit(lanes(20), { lock: true });
  rig.sample();
  await rig.settle();
  const keys = rig.pool.list().map(server => server.key);
  assert.equal(keys.length, 2);
  assert.match(keys[0]!, /^k#batch\d+$/u);
  assert.equal(keys[0], keys[1]);
  rig.submit(lanes(1));
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  assert.equal(rig.pool.list().length, 3, "a server for the plain key");
});

test("SERVERS_PER_KEY 2 and --lanes 2: only the 2 trials that can start count toward the threshold, so one server", async () => {
  const rig = new SchedulerRig(spreadOver(2));
  closedGate(rig);
  rig.submit(lanes(20), { maxLanes: 2 });
  rig.sample();
  await rig.settle();
  assert.deepEqual(serverIdsOf(rig), ["s1"]);
});

test("SERVERS_PER_KEY 2: a batch submitted between two samples spreads in its own pass, before the next sample", async () => {
  const rig = new SchedulerRig(spreadOver(2));
  closedGate(rig);
  rig.sample();
  rig.submit(lanes(20));
  await rig.settle();
  assert.deepEqual(queued(rig), { s1: 10, s2: 10 });
});

test("SERVERS_PER_KEY 2: a server replaces a lost one at a sample, not at the settle of any trial", async () => {
  const rig = new SchedulerRig({ ...spreadOver(2), MINE_AI_SCENARIO_TARGET_START: "20" });
  const open = closedGate(rig);
  rig.submit(lanes(20));
  rig.sample();
  await rig.settle();
  rig.pool.markSick("s2");
  rig.submit(lanes(40));
  open();
  await rig.settle();
  for (const trial of [...rig.running].slice(0, 5)) trial.finish();
  await rig.settle();
  assert.equal(rig.scheduler.runningCount, 20, "five slots refilled by the passes of the settles");
  assert.deepEqual(serverIdsOf(rig), ["s1", "s2"], "35 trials of the key waited at those passes and none spread");
  rig.clock += 70_000;
  rig.sample();
  await rig.settle();
  assert.deepEqual(serverIdsOf(rig), ["s1", "s2", "s3"], "the sample (its target grew by one) started the replacement");
});

test("SERVERS_PER_KEY is a whole number from 1", () => {
  assert.throws(() => new SchedulerRig({ MINE_AI_SCENARIO_SERVERS_PER_KEY: "1.5" }), /SERVERS_PER_KEY/u);
  assert.throws(() => new SchedulerRig({ MINE_AI_SCENARIO_SERVERS_PER_KEY: "0" }), /SERVERS_PER_KEY/u);
});
