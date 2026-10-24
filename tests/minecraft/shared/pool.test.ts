import test from "node:test";
import assert from "node:assert/strict";
import { LAST_BODY } from "../arena/lanes.ts";
import { loadScenarioServerConfig } from "./config.ts";
import { FakeFactory } from "./fake-servers.ts";
import { ServerPool, type ServerSpec } from "./pool.ts";
import type { TrialEnd } from "./trial.ts";
import { fixtureScenario } from "./scenario-fixture.ts";

const config = loadScenarioServerConfig({ MINE_AI_SCENARIO_SERVER_IDLE_MS: "1000", MINE_AI_SCENARIO_MAX_PLAYERS: "6" });

function spec(overrides: Partial<ServerSpec> = {}): ServerSpec {
  return { kind: "shared", key: "k1", heapMb: 3_072, setup: ["difficulty normal", "gamerule commandModificationBlockLimit 25165824"], scenario: fixtureScenario(10), ...overrides };
}

function end(overrides: Partial<TrialEnd> = {}): TrialEnd {
  return { result: { scenario: "x", outcome: "pass", elapsedMs: 1, goal: { state: "passed", detail: "" }, goalText: "" }, lane: "free",
    serverSick: false, hitWallBound: false, restored: true, mutexWaitMs: 0, ...overrides };
}

function setup() {
  const factory = new FakeFactory();
  return { factory, pool: new ServerPool(factory, config, () => {}) };
}

test("a new shared server of a key is listed as starting, then runs the key's setup commands once and is ready", async () => {
  const { factory, pool } = setup();
  const managed = pool.startServer(spec(), 0);
  assert.equal(pool.readings()[0]?.status, "starting");
  await managed.ready;
  assert.equal(pool.readings()[0]?.status, "ready");
  assert.deepEqual(factory.created[0]?.commands, ["difficulty normal", "gamerule commandModificationBlockLimit 25165824"]);
});

test("server ids are unique and several servers may hold one key", async () => {
  const { pool } = setup();
  const [a, b] = [pool.startServer(spec(), 0), pool.startServer(spec(), 0)];
  await Promise.all([a.ready, b.ready]);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(pool.sharedCandidates("k1"), [a.id, b.id]);
  assert.deepEqual(pool.sharedCandidates("other"), []);
});

test("lanes are leased lowest first on the server and come back when the trial ends free", async () => {
  const { pool } = setup();
  const managed = pool.startServer(spec(), 0);
  await managed.ready;
  const first = pool.leaseLane(managed.id)!;
  const second = pool.leaseLane(managed.id)!;
  assert.deepEqual([first.index, second.index], [1, 2]);
  pool.finishTrial(managed.id, first, end(), 10);
  assert.equal(pool.leaseLane(managed.id)?.index, 1);
});

test("a server with every lane leased is no candidate (max-players leaves two for the operator)", async () => {
  const { pool } = setup();
  const managed = pool.startServer(spec(), 0);
  await managed.ready;
  for (let lane = 0; lane < 4; lane++) assert.ok(pool.leaseLane(managed.id));
  assert.equal(pool.leaseLane(managed.id), null);
  assert.deepEqual(pool.sharedCandidates("k1"), []);
});

test("a server that is idle past SERVER_IDLE with none of its key queued is stopped; with its key queued it stays", async () => {
  const { factory, pool } = setup();
  const managed = pool.startServer(spec(), 0);
  await managed.ready;
  const lane = pool.leaseLane(managed.id)!;
  pool.finishTrial(managed.id, lane, end(), 500);
  await pool.reap(1_400, new Set(["k1"]));
  assert.equal(factory.created[0]?.stopped, false, "its key is still queued");
  await pool.reap(1_400, new Set());
  assert.equal(factory.created[0]?.stopped, false, "idle only 900 ms");
  await pool.reap(1_600, new Set());
  assert.equal(factory.created[0]?.stopped, true);
  assert.equal(pool.readings().length, 0);
});

test("a server with a trial still running is never reaped", async () => {
  const { factory, pool } = setup();
  const managed = pool.startServer(spec(), 0);
  await managed.ready;
  pool.leaseLane(managed.id);
  await pool.reap(1_000_000, new Set());
  assert.equal(factory.created[0]?.stopped, false);
});

test("a sick server takes no lane, and stops once its last trial has settled", async () => {
  const { factory, pool } = setup();
  const managed = pool.startServer(spec(), 0);
  await managed.ready;
  const lane = pool.leaseLane(managed.id)!;
  pool.finishTrial(managed.id, lane, end({ serverSick: true, lane: "held" }), 10);
  assert.equal(pool.readings()[0]?.status, "sick");
  assert.deepEqual(pool.sharedCandidates("k1"), []);
  await pool.reap(20, new Set(["k1"]));
  assert.equal(factory.created[0]?.stopped, true, "drained: nothing runs on it");
});

test("a sick server with another trial still running waits for it", async () => {
  const { factory, pool } = setup();
  const managed = pool.startServer(spec(), 0);
  await managed.ready;
  const [sickLane] = [pool.leaseLane(managed.id)!, pool.leaseLane(managed.id)!];
  pool.finishTrial(managed.id, sickLane, end({ serverSick: true, lane: "held" }), 10);
  await pool.reap(20, new Set());
  assert.equal(factory.created[0]?.stopped, false);
});

test("half the lanes quarantined restarts the server once it drains", async () => {
  const { factory, pool } = setup();
  const managed = pool.startServer(spec(), 0);
  await managed.ready;
  const [one, two] = [pool.leaseLane(managed.id)!, pool.leaseLane(managed.id)!];
  pool.finishTrial(managed.id, one, end({ lane: "quarantined" }), 10);
  pool.finishTrial(managed.id, two, end({ lane: "quarantined" }), 10);
  await pool.reap(20, new Set(["k1"]));
  assert.equal(factory.created[0]?.stopped, true);
  assert.deepEqual(pool.sharedCandidates("k1"), [], "the next trial of the key starts a new server");
});

test("a server that fails to start leaves the pool and rejects its ready promise", async () => {
  const { factory, pool } = setup();
  factory.failNextStart = true;
  const managed = pool.startServer(spec(), 0);
  await assert.rejects(managed.ready, /no port/u);
  assert.equal(pool.readings().length, 0);
});

test("a server of its own is a candidate for the next scenario of its key only when it was left reusable", async () => {
  const { factory, pool } = setup();
  const reusable = pool.startServer(spec({ kind: "single", key: "own:a", heapMb: 2_048, setup: [] }), 0);
  const throwaway = pool.startServer(spec({ kind: "single", key: "own:b", heapMb: 2_048, setup: [] }), 0);
  await Promise.all([reusable.ready, throwaway.ready]);
  pool.finishTrial(reusable.id, null, end(), 10, { reusable: true });
  pool.finishTrial(throwaway.id, null, end({ restored: false }), 10, { reusable: false });
  assert.deepEqual(pool.reusableSingles("own:a"), [reusable.id]);
  assert.deepEqual(pool.reusableSingles("own:b"), []);
  await pool.reap(11, new Set());
  assert.equal(factory.created[1]?.stopped, true, "a scenario that changes the world is stopped after its trial, never reused");
});

test("a busy single server is no candidate", async () => {
  const { pool } = setup();
  const managed = pool.startServer(spec({ kind: "single", key: "own:a", heapMb: 2_048, setup: [] }), 0);
  await managed.ready;
  pool.noteSingleTrialStarted(managed.id);
  assert.deepEqual(pool.reusableSingles("own:a"), []);
});

test("health readings reach the admission sample", async () => {
  const { pool } = setup();
  const managed = pool.startServer(spec(), 0);
  await managed.ready;
  pool.setHealth(managed.id, { msptP95: 7.5, residentMb: 1_200 });
  assert.deepEqual(pool.readings()[0], { id: managed.id, key: "k1", status: "ready", shared: true, msptP95: 7.5, heapMb: 3_072, residentMb: 1_200 });
});

test("stopAll stops servers that are ready and those still starting", async () => {
  const { factory, pool } = setup();
  const ready = pool.startServer(spec(), 0);
  await ready.ready;
  pool.startServer(spec({ key: "k2" }), 0);
  await pool.stopAll();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(factory.created.map(server => server.stopped), [true, true]);
});

test("a ready server that answered nothing for STALL_STOP is stopped and leaves the pool; one that answered is kept", async () => {
  const { factory, pool } = setup();
  const silent = pool.startServer(spec({ key: "silent" }), 0);
  const talking = pool.startServer(spec({ key: "talking" }), 0);
  await Promise.all([silent.ready, talking.ready]);
  pool.answered(talking.id, config.stallStopMs - 1);
  const stopped = await pool.stopStalled(config.stallStopMs);
  assert.deepEqual(stopped, [silent.id]);
  assert.deepEqual(factory.created.map(server => server.stopped), [true, false]);
  assert.deepEqual(pool.readings().map(reading => reading.id), [talking.id]);
});

test("a server still starting is never called stalled", async () => {
  const { factory, pool } = setup();
  factory.startGate = new Promise(() => {});
  pool.startServer(spec(), 0);
  assert.deepEqual(await pool.stopStalled(10 * config.stallStopMs), []);
});

test("the health targets are the servers that are up, not those starting", async () => {
  const { factory, pool } = setup();
  const up = pool.startServer(spec(), 0);
  await up.ready;
  factory.startGate = new Promise(() => {});
  pool.startServer(spec({ key: "k2" }), 0);
  assert.deepEqual(pool.healthTargets().map(target => target.id), [up.id]);
});

test("releasing a batch's reservation retires its servers at once, a server still starting stops once ready, and other servers stay", async () => {
  const { factory, pool } = setup();
  const reserved = pool.startServer(spec({ key: "k1#batch7", reservedFor: 7 }), 0);
  const other = pool.startServer(spec({ key: "k1#batch8", reservedFor: 8 }), 0);
  const plain = pool.startServer(spec(), 0);
  await Promise.all([reserved.ready, other.ready, plain.ready]);
  const late = pool.startServer(spec({ key: "k1#batch7", reservedFor: 7 }), 0);
  pool.releaseReservation(7);
  await pool.reap(1, new Set(["k1", "k1#batch7"]));
  await late.ready;
  await pool.reap(2, new Set());
  assert.deepEqual(factory.created.map(server => server.stopped), [true, false, false, true], "batch 7's two servers stopped, batch 8's and the plain one kept");
});

function withPhases(arrangeMs: number, restoreMs: number, overrides: Partial<TrialEnd> = {}): TrialEnd {
  return end({ phases: { mutexWaitMs: 50, arrangeMs, joinMs: 9_000, trialMs: 5_000, restoreWaitMs: 40, restoreMs }, ...overrides });
}

async function readyShared(pool: ServerPool, overrides: Partial<ServerSpec> = {}) {
  const managed = pool.startServer(spec(overrides), 0);
  await managed.ready;
  return managed;
}

const queueOf = (pool: ServerPool, id: string) => pool.queues([id]).get(id)!;

test("a trial counts in its server's mutex queue from admission until its arrangement is done, and a restore from queued until done", async () => {
  const { pool } = setup();
  const managed = await readyShared(pool);
  const lane = pool.leaseLane(managed.id)!;
  const marks = pool.joinMutexQueue(managed.id)!;
  assert.equal(queueOf(pool, managed.id).queued, 1, "admitted, not arranged");
  marks.arranged();
  assert.equal(queueOf(pool, managed.id).queued, 0);
  marks.restoreQueued();
  assert.equal(queueOf(pool, managed.id).queued, 1);
  marks.restoreDone();
  assert.equal(queueOf(pool, managed.id).queued, 0);
  pool.finishTrial(managed.id, lane, end(), 10);
});

test("each mark counts once however often it is called", async () => {
  const { pool } = setup();
  const managed = await readyShared(pool);
  pool.leaseLane(managed.id);
  const marks = pool.joinMutexQueue(managed.id)!;
  const other = pool.joinMutexQueue(managed.id)!;
  assert.equal(queueOf(pool, managed.id).queued, 2);
  marks.arranged();
  marks.arranged();
  marks.restoreDone();
  assert.equal(queueOf(pool, managed.id).queued, 1, "a second arranged() or a restoreDone() with no restore queued takes nothing off another trial");
  other.leave();
  other.leave();
  assert.equal(queueOf(pool, managed.id).queued, 0);
});

test("a trial aborted between admission and its arrangement leaves the queue when it settles", async () => {
  const { pool } = setup();
  const managed = await readyShared(pool);
  const lane = pool.leaseLane(managed.id)!;
  const marks = pool.joinMutexQueue(managed.id)!;
  assert.equal(queueOf(pool, managed.id).queued, 1);
  marks.leave();
  pool.finishTrial(managed.id, lane, end({ lane: "free" }), 10);
  assert.equal(queueOf(pool, managed.id).queued, 0);
});

test("a restore that never ends leaves the queue with the trial (the restore bound gave up on it)", async () => {
  const { pool } = setup();
  const managed = await readyShared(pool);
  pool.leaseLane(managed.id);
  const marks = pool.joinMutexQueue(managed.id)!;
  marks.arranged();
  marks.restoreQueued();
  assert.equal(queueOf(pool, managed.id).queued, 1);
  marks.leave();
  assert.equal(queueOf(pool, managed.id).queued, 0);
  marks.restoreDone();
  assert.equal(queueOf(pool, managed.id).queued, 0, "the restore finishing later takes nothing off");
});

test("the hold of a server is ARRANGE_HOLD_MS until 3 of its trials settled, then the median of arrange + restore over the last 20", async () => {
  const { pool } = setup();
  const managed = await readyShared(pool);
  assert.equal(queueOf(pool, managed.id).holdMs, config.arrangeHoldMs);
  const settle = (arrange: number, restore: number) => {
    const lane = pool.leaseLane(managed.id)!;
    pool.finishTrial(managed.id, lane, withPhases(arrange, restore), 10);
  };
  settle(300, 100);
  settle(900, 100);
  assert.equal(queueOf(pool, managed.id).holdMs, config.arrangeHoldMs, "two settled: still the default");
  settle(500, 100);
  assert.equal(queueOf(pool, managed.id).holdMs, 600, "median of 400, 1000, 600");
  for (let trial = 0; trial < 20; trial++) settle(100, 50);
  assert.equal(queueOf(pool, managed.id).holdMs, 150, "only the last 20 count");
});

test("the mutex wait and the join are not part of the hold, and an end with no phases adds nothing", async () => {
  const { pool } = setup();
  const managed = await readyShared(pool);
  for (let trial = 0; trial < 3; trial++) pool.finishTrial(managed.id, pool.leaseLane(managed.id)!, withPhases(200, 100), 10);
  pool.finishTrial(managed.id, pool.leaseLane(managed.id)!, end(), 10);
  assert.equal(queueOf(pool, managed.id).holdMs, 300);
});

test("a server of its own has no mutex queue: joining is refused and it has no entry", async () => {
  const { pool } = setup();
  const managed = pool.startServer(spec({ kind: "single", key: "own:a", heapMb: 2_048, setup: [] }), 0);
  await managed.ready;
  assert.equal(pool.joinMutexQueue(managed.id), null);
  assert.equal(pool.queues([managed.id]).size, 0);
});

test("the body counter of a reusable server of its own: 0 for the first scenario, then one more each time", async () => {
  const { pool } = setup();
  const managed = pool.startServer(spec({ kind: "single", key: "own:a", heapMb: 2_048, setup: [] }), 0);
  await managed.ready;
  assert.equal(pool.noteSingleTrialStarted(managed.id), 0);
  pool.finishTrial(managed.id, null, end(), 10, { reusable: true });
  assert.equal(pool.noteSingleTrialStarted(managed.id), 1);
  pool.finishTrial(managed.id, null, end(), 20, { reusable: true });
  assert.equal(pool.noteSingleTrialStarted(managed.id), 2);
});

test("a server of its own whose bodies are used up retires once its trial ends (a name must not come back)", async () => {
  const { factory, pool } = setup();
  const managed = pool.startServer(spec({ kind: "single", key: "own:a", heapMb: 2_048, setup: [] }), 0);
  await managed.ready;
  for (let body = 0; body < LAST_BODY; body++) {
    pool.noteSingleTrialStarted(managed.id);
    pool.finishTrial(managed.id, null, end(), 10, { reusable: true });
  }
  assert.deepEqual(pool.reusableSingles("own:a"), [managed.id], "the last body is still to come");
  pool.noteSingleTrialStarted(managed.id);
  pool.finishTrial(managed.id, null, end(), 10, { reusable: true });
  assert.deepEqual(pool.reusableSingles("own:a"), []);
  await pool.reap(11, new Set());
  assert.equal(factory.created[0]?.stopped, true);
});

test("a server start logs its reason: a new key, a full key, the retired server it replaces, a probe, an own server", async () => {
  const lines: string[] = [];
  const pool = new ServerPool(new FakeFactory(), config, message => lines.push(message));
  const first = pool.startServer(spec(), 0);
  await first.ready;
  const second = pool.startServer(spec(), 0);
  await second.ready;
  pool.markSick(first.id);
  pool.startServer(spec(), 0);
  pool.startServer(spec({ key: "probe:1.21.4" }), 0);
  pool.startServer(spec({ kind: "single", key: "own:a", heapMb: 2_048, setup: [] }), 0, "own, not reusable");
  const starts = lines.filter(line => line.includes(" starting: "));
  assert.deepEqual(starts.map(line => /starting: (.*)$/u.exec(line)?.[1]), [
    "new key", "key's servers refused it (arrangement queue, tick time or size)", `replaces retired ${first.id}`, "probe", "own, not reusable",
  ]);
  assert.match(starts[0]!, /server s1 \(shared, key k1\) starting/u);
});

test("a server stop logs its reason: idle, retired, sick, own after trial", async () => {
  const lines: string[] = [];
  const pool = new ServerPool(new FakeFactory(), config, message => lines.push(message));
  const idle = await readyShared(pool, { key: "idle" });
  const retired = await readyShared(pool, { key: "retired" });
  const sick = await readyShared(pool, { key: "sick" });
  const single = pool.startServer(spec({ kind: "single", key: "own:a", heapMb: 2_048, setup: [] }), 0);
  await single.ready;
  pool.finishTrial(sick.id, pool.leaseLane(sick.id)!, end({ serverSick: true, lane: "held" }), 0);
  pool.noteSingleTrialStarted(single.id);
  pool.finishTrial(single.id, null, end(), 0, { reusable: false });
  const batch = pool.startServer(spec({ key: "k#batch5", reservedFor: 5 }), 0);
  await batch.ready;
  pool.releaseReservation(5);
  await pool.reap(config.serverIdleMs + 1, new Set(["retired"]));
  const reasons = Object.fromEntries(lines.flatMap(line => { const match = /server (s\d+) stopping: (.*)$/u.exec(line); return match ? [[match[1], match[2]]] : []; }));
  assert.deepEqual(reasons, { [idle.id]: "idle", [sick.id]: "sick", [single.id]: "own after trial", [batch.id]: "retired" });
  assert.notEqual(pool.get(retired.id), undefined, "its key is still queued: it stays");
});

test("the number of servers started is counted for the sample line", async () => {
  const { pool } = setup();
  assert.equal(pool.startedCount, 0);
  await readyShared(pool);
  await readyShared(pool, { key: "k2" });
  assert.equal(pool.startedCount, 2);
});

test("a trial that was cancelled or failed (not restored) adds nothing to the hold", async () => {
  const { pool } = setup();
  const managed = await readyShared(pool);
  for (let trial = 0; trial < 3; trial++) pool.finishTrial(managed.id, pool.leaseLane(managed.id)!, withPhases(300, 100), 10);
  for (let trial = 0; trial < 5; trial++) pool.finishTrial(managed.id, pool.leaseLane(managed.id)!, withPhases(0, 0, { restored: false }), 10);
  pool.finishTrial(managed.id, pool.leaseLane(managed.id)!, withPhases(60_000, 0, { restored: false }), 10);
  assert.equal(queueOf(pool, managed.id).holdMs, 400);
});
