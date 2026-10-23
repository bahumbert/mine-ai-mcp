import test from "node:test";
import assert from "node:assert/strict";
import { loadScenarioServerConfig } from "./config.ts";
import { FakeFactory } from "./fake-servers.ts";
import { ServerPool } from "./pool.ts";
import { sampleOnce, type SamplerDeps } from "./sampler.ts";
import { lanePlacement, SchedulerRig } from "./scheduler-rig.ts";
import { serverSpecFor } from "./server-spec.ts";
import { fixtureScenario } from "./scenario-fixture.ts";

const TICK_QUERY = "Average time per tick: 3.0ms (Target: 50.0ms)\nPercentiles: P50: 2.0ms P95: 9.5ms P99: 12.0ms, sample: 100";
const config = loadScenarioServerConfig({ MINE_AI_SCENARIO_STALL_STOP_MS: "1000" });

async function readyServer(pool: ServerPool, factory: FakeFactory) {
  const managed = pool.startServer(serverSpecFor(lanePlacement("k"), fixtureScenario(10), config), 0);
  await managed.ready;
  return { managed, fake: factory.created[factory.created.length - 1]! };
}

function depsOf(pool: ServerPool, rig: SchedulerRig, overrides: Partial<SamplerDeps> = {}): SamplerDeps {
  return {
    pool, scheduler: rig.scheduler, config, now: () => 500, log: () => {},
    machine: { read: async () => ({ cpuBusy: 0.4, memAvailableMb: 20_000, threads: 24 }) },
    residentMbOf: async () => 1_234, ...overrides,
  };
}

test("a sample reads each server's tick time and resident size into the pool", async () => {
  const rig = new SchedulerRig();
  const { managed, fake } = await readyServer(rig.pool, rig.factory);
  fake.replies.set("tick query", TICK_QUERY);
  await sampleOnce(depsOf(rig.pool, rig));
  assert.deepEqual(rig.pool.readings().find(reading => reading.id === managed.id), {
    id: managed.id, key: "k", status: "ready", shared: true, msptP95: 9.5, heapMb: 3_072, residentMb: 1_234,
  });
});

test("a server whose tick query fails is not stalled until STALL_STOP has passed, then it is stopped", async () => {
  const rig = new SchedulerRig();
  const { managed, fake } = await readyServer(rig.pool, rig.factory);
  fake.replies.set("tick query", new Error("RCON timed out"));
  let now = 500;
  await sampleOnce(depsOf(rig.pool, rig, { now: () => now }));
  assert.equal(fake.stopped, false);
  now = 1_000;
  await sampleOnce(depsOf(rig.pool, rig, { now: () => now }));
  assert.equal(fake.stopped, true);
  assert.equal(rig.pool.get(managed.id), undefined);
});

test("an answer that parses to no percentile keeps the server in service (unknown tick time) and logs the answer once", async () => {
  const rig = new SchedulerRig();
  const { fake } = await readyServer(rig.pool, rig.factory);
  fake.replies.set("tick query", "something this version prints differently");
  const logged: string[] = [];
  await sampleOnce(depsOf(rig.pool, rig, { log: message => logged.push(message) }));
  await sampleOnce(depsOf(rig.pool, rig, { log: message => logged.push(message), now: () => 600 }));
  assert.equal(rig.pool.readings()[0]?.msptP95, null);
  assert.equal(fake.stopped, false);
  assert.equal(logged.filter(line => line.includes("tick query")).length, 1);
});

test("the sample reaches the scheduler, which then admits the waiting trial", async () => {
  const rig = new SchedulerRig();
  rig.submit([{ name: "a", placement: lanePlacement("k") }]);
  await sampleOnce(depsOf(rig.pool, rig));
  await rig.settle();
  assert.equal(rig.running.length, 1);
});

test("an idle server is reaped by the sample when its key is no longer queued", async () => {
  const rig = new SchedulerRig();
  const { managed, fake } = await readyServer(rig.pool, rig.factory);
  await sampleOnce(depsOf(rig.pool, rig, { now: () => rig.config.serverIdleMs + 10 }));
  assert.equal(fake.stopped, true);
  assert.equal(rig.pool.get(managed.id), undefined);
});

test("a slow tick query is neither abandoned nor repeated: it is still outstanding at the next sample, and its late answer counts", async () => {
  const rig = new SchedulerRig();
  const { managed, fake } = await readyServer(rig.pool, rig.factory);
  let answerLate!: (text: string) => void;
  let asked = 0;
  fake.command = () => { asked += 1; return new Promise<string>(resolve => { answerLate = resolve; }); };
  const first = sampleOnce(depsOf(rig.pool, rig, { now: () => 500 }));
  await sampleOnce(depsOf(rig.pool, rig, { now: () => 600 }));
  assert.equal(asked, 1, "no second tick query on top of the unanswered one");
  answerLate(TICK_QUERY);
  await first;
  assert.equal(rig.pool.readings().find(reading => reading.id === managed.id)?.msptP95, 9.5);
});
