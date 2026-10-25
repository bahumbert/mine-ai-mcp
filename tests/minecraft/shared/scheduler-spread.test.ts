// T7c3: SERVERS_PER_KEY spreads a key over several servers.
import test from "node:test";
import assert from "node:assert/strict";
import { SchedulerRig } from "./scheduler-rig.ts";
import { lanes, queued } from "./scheduler-queue-fixtures.ts";

// T7c3. MAX_PLAYERS 22 gives 20 lanes a server: SERVERS_PER_KEY 2 spreads a key from 2 x 20 / 2 = 20 trials queued, 3 from 30.
const SPREAD_ENV = { MINE_AI_SCENARIO_MAX_PLAYERS: "22" };
/** The target is out of the way (60): these tests are about where trials go, not how many run. */
const spreadOver = (servers: number) => ({ ...SPREAD_ENV, MINE_AI_SCENARIO_SERVERS_PER_KEY: String(servers), MINE_AI_SCENARIO_TARGET_START: "60" });
const serverIdsOf = (rig: SchedulerRig) => rig.pool.list().map(server => server.id);

test("SERVERS_PER_KEY 1, the default: 20 trials queued start one server, all on it", async () => {
  const rig = new SchedulerRig(SPREAD_ENV);
  assert.equal(rig.config.serversPerKey, 1);
  rig.holdArrangements();
  rig.submit(lanes(20));
  rig.sample();
  await rig.settle();
  assert.deepEqual(queued(rig), { s1: 20 });
});

test("SERVERS_PER_KEY 2 with 20 trials queued: both servers start in the first pass and the trials alternate by arrangement queue", async () => {
  const rig = new SchedulerRig(spreadOver(2));
  rig.holdArrangements();
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
  spread.holdArrangements();
  spread.submit(lanes(30));
  spread.sample();
  await spread.settle();
  assert.deepEqual(queued(spread), { s1: 10, s2: 10, s3: 10 });
  const mixed = new SchedulerRig(spreadOver(3));
  mixed.holdArrangements();
  mixed.submit([...lanes(29), ...lanes(5, "other")]);
  mixed.sample();
  await mixed.settle();
  assert.deepEqual(mixed.pool.list().filter(server => server.key === "k").length, 1, "29 trials of the key, under 30: one server");
});

test("SERVERS_PER_KEY 2 and the ledger cannot pay a second server: none starts and the first takes the trials", async () => {
  const rig = new SchedulerRig(spreadOver(2));
  rig.holdArrangements();
  // A new server with its client needs 250 + 3072 + 1024 = 4346 MB; once the first trial is in, the server's growth (3584) and its client (250) are out of the ledger: 1 MB short of a second.
  rig.submit(lanes(20));
  rig.sample({ memAvailableMb: 3_584 + 250 + 4_346 - 1 });
  await rig.settle();
  assert.deepEqual(serverIdsOf(rig), ["s1"]);
  assert.ok((queued(rig).s1 ?? 0) > 1, "the trials that fit the ledger are on s1");
});

test("SERVERS_PER_KEY 2: trials placed while the servers still start take the shorter queue of the two, ready or not", async () => {
  const rig = new SchedulerRig(spreadOver(2));
  rig.holdArrangements();
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
  rig.holdArrangements();
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
  rig.holdArrangements();
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
  rig.holdArrangements();
  rig.submit(lanes(20), { maxLanes: 2 });
  rig.sample();
  await rig.settle();
  assert.deepEqual(serverIdsOf(rig), ["s1"]);
});

test("SERVERS_PER_KEY 2: a batch submitted between two samples spreads in its own pass, before the next sample", async () => {
  const rig = new SchedulerRig(spreadOver(2));
  rig.holdArrangements();
  rig.sample();
  rig.submit(lanes(20));
  await rig.settle();
  assert.deepEqual(queued(rig), { s1: 10, s2: 10 });
});

test("SERVERS_PER_KEY 2: a server replaces a lost one at a sample, not at the settle of any trial", async () => {
  const rig = new SchedulerRig({ ...spreadOver(2), MINE_AI_SCENARIO_TARGET_START: "20" });
  const open = rig.holdArrangements();
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
