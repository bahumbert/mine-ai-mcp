import test from "node:test";
import assert from "node:assert/strict";
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
