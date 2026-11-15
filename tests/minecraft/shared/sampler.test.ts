import test from "node:test";
import assert from "node:assert/strict";
import { createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { loadScenarioServerConfig } from "./config.ts";
import { FakeFactory } from "./fake-servers.ts";
import { ServerPool } from "./pool.ts";
import { sampleOnce, type SamplerDeps } from "./sampler.ts";
import { lanePlacement, SchedulerRig } from "./scheduler-rig.ts";
import { serverSpecFor } from "./server-spec.ts";
import { settlesWithin } from "./settles-within.ts";
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

test("a sample reads each server's tick time and resident size into the pool, and the scheduler's report names the tick time by server id", async () => {
  const rig = new SchedulerRig();
  const { managed, fake } = await readyServer(rig.pool, rig.factory);
  fake.replies.set("tick query", TICK_QUERY);
  await sampleOnce(depsOf(rig.pool, rig));
  assert.deepEqual(rig.pool.readings().find(reading => reading.id === managed.id), {
    id: managed.id, key: "k", status: "ready", shared: true, busy: false, lanes: 0, msptP95: 9.5, heapMb: 3_072, residentMb: 1_234,
  });
  assert.deepEqual(rig.scheduler.sampleReport()?.serverTicks, [{ id: managed.id, msptP95: 9.5 }]);
});

test("a tick query that fails at once marks the server late and drops its old percentile until the next answer", async () => {
  const rig = new SchedulerRig();
  const { managed, fake } = await readyServer(rig.pool, rig.factory);
  fake.replies.set("tick query", TICK_QUERY);
  await sampleOnce(depsOf(rig.pool, rig));
  assert.equal(rig.pool.readings().find(each => each.id === managed.id)?.msptP95, 9.5);
  fake.replies.set("tick query", new Error("RCON timed out"));
  await sampleOnce(depsOf(rig.pool, rig));
  let reading = rig.pool.readings().find(each => each.id === managed.id);
  assert.equal(reading?.late, true);
  assert.equal(reading?.msptP95, null);
  fake.replies.set("tick query", TICK_QUERY);
  await sampleOnce(depsOf(rig.pool, rig));
  reading = rig.pool.readings().find(each => each.id === managed.id);
  assert.equal(reading?.late, undefined);
  assert.equal(reading?.msptP95, 9.5);
});

test("a server whose tick query fails is not stalled until STALL_STOP has passed since its first failed query, then it is stopped", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_STALL_STOP_MS: "1000" });
  const { managed, fake } = await readyServer(rig.pool, rig.factory);
  rig.pool.leaseLane(managed.id);
  fake.replies.set("tick query", new Error("RCON timed out"));
  let now = 500;
  await sampleOnce(depsOf(rig.pool, rig, { now: () => now }));
  assert.equal(fake.stopped, false);
  now = 1_499;
  await sampleOnce(depsOf(rig.pool, rig, { now: () => now }));
  assert.equal(fake.stopped, false, "the window starts at the first query (500), not at the server's start (0)");
  now = 1_500;
  await sampleOnce(depsOf(rig.pool, rig, { now: () => now }));
  assert.equal(fake.stopped, true);
  assert.equal(rig.pool.get(managed.id), undefined);
});

test("a server not asked while the sampler was held 40 s is not stopped as stalled at the next sample", async () => {
  const rig = new SchedulerRig();
  const { fake, managed } = await readyServer(rig.pool, rig.factory);
  rig.pool.leaseLane(managed.id);
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  let queries = 0;
  // The first query answers at once; the one after the hold answers 5 s later, past the sample's own wait.
  fake.command = () => new Promise<string>(resolve => { setTimeout(() => resolve(TICK_QUERY), queries++ === 0 ? 0 : 5_000); });
  const deps = depsOf(rig.pool, rig, { now: clock.now });
  const first = sampleOnce(deps);
  await clock.advance(50);
  await first;
  await clock.advance(40_000);
  const second = sampleOnce(deps);
  await clock.advance(config.sampleEveryMs / 2);
  await second;
  assert.equal(fake.stopped, false, "its 40 s of silence were the sampler's");
  assert.equal(rig.logs.some(line => line.includes("answered nothing")), false);
  await clock.advance(5_000);
  assert.equal(rig.pool.readings().find(reading => reading.id === managed.id)?.msptP95, 9.5, "its answer, late, still counts");
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

test("a hanging tick query stays late across samples without a duplicate query, until its answer clears the mark", async () => {
  const rig = new SchedulerRig();
  const { managed, fake } = await readyServer(rig.pool, rig.factory);
  rig.pool.leaseLane(managed.id);
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  let answerLate!: (text: string) => void;
  let asked = 0;
  fake.command = () => { asked += 1; return new Promise<string>(resolve => { answerLate = resolve; }); };
  const deps = depsOf(rig.pool, rig, { now: clock.now });
  const first = sampleOnce(deps);
  await sampleOnce(deps);
  assert.equal(asked, 1, "no duplicate while the first sample still waits for its bound");
  await clock.advance(config.sampleEveryMs / 2);
  await first;
  let reading = rig.pool.readings().find(each => each.id === managed.id);
  assert.equal(reading?.late, true);
  assert.equal(reading?.msptP95, null);
  await sampleOnce(deps);
  reading = rig.pool.readings().find(each => each.id === managed.id);
  assert.equal(reading?.late, true);
  assert.equal(reading?.msptP95, null);
  assert.equal(asked, 1, "no second tick query on top of the unanswered one");
  answerLate(TICK_QUERY);
  await clock.advance(0);
  reading = rig.pool.readings().find(each => each.id === managed.id);
  assert.equal(reading?.late, undefined);
  assert.equal(reading?.msptP95, 9.5);
});

// A stop or a slow answer never holds the sample (spec 2026-11-15 sections 1 and F2).

test("a server stop that takes 20 s does not hold the sample: the next sample runs and asks every other server", async () => {
  const rig = new SchedulerRig();
  const { managed: reaped, fake: slowStop } = await readyServer(rig.pool, rig.factory);
  const { managed: kept, fake: other } = await readyServer(rig.pool, rig.factory);
  rig.pool.leaseLane(kept.id);
  let endStop!: () => void;
  slowStop.stop = () => new Promise<void>(resolve => { endStop = resolve; });
  other.replies.set("tick query", TICK_QUERY);
  const idleNow = rig.config.serverIdleMs + 10;
  assert.equal(await settlesWithin(sampleOnce(depsOf(rig.pool, rig, { now: () => idleNow }))), true, "the sample does not wait for the stop");
  assert.equal(rig.pool.get(reaped.id), undefined);
  const asked = () => other.commands.filter(command => command === "tick query").length;
  const askedBefore = asked();
  assert.equal(await settlesWithin(sampleOnce(depsOf(rig.pool, rig, { now: () => idleNow + 5_000 }))), true);
  assert.equal(asked(), askedBefore + 1, "the second sample asked the other server while the stop still ran");
  endStop();
});

test("a tick query unanswered after sampleEveryMs / 2 does not hold the sample; its later answer still marks the server answered", async () => {
  const rig = new SchedulerRig();
  const { managed, fake } = await readyServer(rig.pool, rig.factory);
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  fake.command = () => new Promise<string>(resolve => { setTimeout(() => resolve(TICK_QUERY), 8_000); });
  const answeredAt: number[] = [];
  const answered = rig.pool.answered.bind(rig.pool);
  rig.pool.answered = (id, at) => { answeredAt.push(at); answered(id, at); };
  let done = false;
  // A trial runs on it, so the 1 s idle bound of the rig does not reap it at 2.5 s (the pool's STALL_STOP is the default 30 s).
  rig.pool.leaseLane(managed.id);
  void sampleOnce(depsOf(rig.pool, rig, { now: clock.now })).then(() => { done = true; });
  await clock.advance(config.sampleEveryMs / 2 - 100);
  assert.equal(done, false, "held until the bound");
  await clock.advance(100);
  assert.equal(done, true, "released at sampleEveryMs / 2");
  const late = rig.pool.readings().find(reading => reading.id === managed.id);
  assert.equal(late?.late, true, "no new trial on its old P95 in this sample");
  assert.equal(late?.msptP95, null);
  await clock.advance(8_000 - config.sampleEveryMs / 2);
  assert.deepEqual(answeredAt, [8_000]);
  const restored = rig.pool.readings().find(reading => reading.id === managed.id);
  assert.equal(restored?.late, undefined, "its late answer clears the flag");
  assert.equal(restored?.msptP95, 9.5);
});

test("a tick query answered after the bound but before a slow machine read ends is not marked late", async () => {
  const rig = new SchedulerRig();
  const { managed, fake } = await readyServer(rig.pool, rig.factory);
  rig.pool.leaseLane(managed.id);
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  fake.command = () => new Promise<string>(resolve => { setTimeout(() => resolve(TICK_QUERY), 3_000); });
  const machine = { read: () => new Promise<{ cpuBusy: number; memAvailableMb: number; threads: number }>(resolve => { setTimeout(() => resolve({ cpuBusy: 0.4, memAvailableMb: 20_000, threads: 24 }), 4_000); }) };
  let done = false;
  void sampleOnce(depsOf(rig.pool, rig, { now: clock.now, machine })).then(() => { done = true; });
  await clock.advance(4_000);
  assert.equal(done, true);
  const reading = rig.pool.readings().find(each => each.id === managed.id);
  assert.equal(reading?.msptP95, 9.5, "its answer at 3 s came after the 2.5 s bound but before the sample ended");
  assert.equal(reading?.late, undefined);
});

test("a sample whose reads all win leaves no timer pending", async () => {
  const rig = new SchedulerRig();
  const { fake } = await readyServer(rig.pool, rig.factory);
  fake.replies.set("tick query", TICK_QUERY);
  const pending = new Set<unknown>();
  const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = globalThis;
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    const handle = realSetTimeout(() => { pending.delete(handle); handler(); }, ms);
    pending.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => { pending.delete(handle); realClearTimeout(handle); }) as typeof clearTimeout;
  try {
    await sampleOnce(depsOf(rig.pool, rig));
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  assert.equal(pending.size, 0);
});

test("the machine reading's own cpu and load average reach the scheduler's sample report", async () => {
  const rig = new SchedulerRig();
  await sampleOnce(depsOf(rig.pool, rig, { machine: { read: async () => ({ cpuBusy: 0.5, ownCpu: 0.4, load1: 6.5, memAvailableMb: 20_000, threads: 24 }) } }));
  const report = rig.scheduler.sampleReport();
  assert.equal(report?.ownCpu, 0.4);
  assert.equal(report?.load1, 6.5);
});

// A server whose java process is gone (the OOM killer, a crash) is stopped at once, not after STALL_STOP.

test("a server whose java process is gone for two samples is stopped at once, well before STALL_STOP", async () => {
  const rig = new SchedulerRig();
  const { managed, fake } = await readyServer(rig.pool, rig.factory);
  fake.replies.set("tick query", new Error("connection reset"));
  const logged: string[] = [];
  const deps = depsOf(rig.pool, rig, { residentMbOf: async () => 0, log: message => logged.push(message), now: () => 100 });
  await sampleOnce(deps);
  assert.equal(fake.stopped, false, "one reading of 0 MB could be a /proc read that failed");
  await sampleOnce(deps);
  assert.equal(fake.stopped, true);
  assert.equal(rig.pool.get(managed.id), undefined);
  assert.equal(managed.died.aborted, true, "the trials on it are told it died");
});

test("a /proc reading that fails once is not a death: a reading that finds the process again starts the count over", async () => {
  const rig = new SchedulerRig();
  const { managed, fake } = await readyServer(rig.pool, rig.factory);
  fake.replies.set("tick query", new Error("RCON timed out"));
  const readings = [0, 1_234, 0, 1_234];
  const deps = depsOf(rig.pool, rig, { residentMbOf: async () => readings.shift() ?? 1_234, now: () => 100 });
  for (let sample = 0; sample < 4; sample++) await sampleOnce(deps);
  assert.equal(fake.stopped, false);
  assert.equal(managed.died.aborted, false);
});

test("a server whose tick query is still unanswered is checked for its java process all the same", async () => {
  const rig = new SchedulerRig();
  const { managed, fake } = await readyServer(rig.pool, rig.factory);
  fake.command = () => new Promise<string>(() => {});
  const deps = depsOf(rig.pool, rig, { residentMbOf: async () => 0, now: () => 100 });
  void sampleOnce(deps);
  await sampleOnce(deps);
  await sampleOnce(deps);
  assert.equal(managed.died.aborted, true, "the first query never answers; the second and third samples still read the process");
});

test("a server whose java pid is unknown has no liveness reading: only STALL_STOP, counted from its first query, stops it", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_STALL_STOP_MS: "1000" });
  const { managed, fake } = await readyServer(rig.pool, rig.factory);
  rig.pool.leaseLane(managed.id);
  fake.javaPid = () => null;
  fake.replies.set("tick query", new Error("RCON timed out"));
  let now = 500;
  const deps = depsOf(rig.pool, rig, { residentMbOf: async () => 0, now: () => now });
  await sampleOnce(deps);
  await sampleOnce(deps);
  assert.equal(fake.stopped, false);
  assert.equal(managed.died.aborted, false);
  now = 1_500;
  await sampleOnce(deps);
  assert.equal(fake.stopped, true, "1000 ms after its first query (500)");
  assert.equal(managed.died.aborted, true, "stopping a stalled server aborts its unfinished trials");
  assert.equal(managed.died.reason, `it answered nothing for ${rig.config.stallStopMs} ms`);
});

test("a server the pool stops itself (idle) is not counted as a death", async () => {
  const rig = new SchedulerRig();
  const { managed, fake } = await readyServer(rig.pool, rig.factory);
  await sampleOnce(depsOf(rig.pool, rig, { now: () => rig.config.serverIdleMs + 10 }));
  assert.equal(fake.stopped, true);
  assert.equal(managed.died.aborted, false);
});
