// The shared hunter waits for its quarry on the server clock.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { spyOn } from "bun:test";
import { COLLECT_MOB_DROP } from "@aibengineering/mine-ai-mcp";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../src/test-support/fake-bot/index.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "../../tests/minecraft/drivers/server-ticks.ts";
import { awaitQuarry, quarryBudgetTicks, run } from "./hunter.ts";
import * as scenarioRuntime from "./runtime.ts";
import type { MineAiScenarioContext } from "./scenario-client.ts";

const START_AGE = 1_000;
const RATES = [20, 10];
/** Fake milliseconds the server takes for `ticks` server ticks at `rate`. */
const msFor = (ticks: number, rate: number) => (ticks * 1_000) / rate;

function fixture(rate: number, goalTimeout = 180, timePacketYet = true) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, server: { startAge: START_AGE, ticksPerSecond: rate, timePacketYet } });
  // Stopgap until the shared fake answers `bot.nearestEntity` (the fight watcher reads it each second of physics).
  Object.assign(harness.bot, {
    nearestEntity: (match: (entity: (typeof harness.bot.entities)[number]) => boolean = () => true) =>
      Object.values(harness.bot.entities).find(match) ?? null,
  });
  const controller = new AbortController();
  const logs: string[] = [];
  const context = { bot: harness.bot, signal: controller.signal, log: (line: string) => logs.push(line),
    scenario: { params: { mob_name: "rabbit", drop_name: "rabbit_hide", count: 1 }, goal: { timeout: goalTimeout } },
  } as unknown as MineAiScenarioContext;
  const added = listenersAddedSince(harness.bot);
  const clientAdded = listenersAddedSince(harness.bot._client);
  return { ...harness, clock, controller, context, logs, async assertClean() {
    const check = () => {
      for (const event of harness.bot.eventNames()) assert.equal(added(String(event)), 0, String(event));
      for (const event of harness.bot._client.eventNames()) assert.equal(clientAdded(String(event)), 0, String(event));
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.equal(clock.pendingTimers(), 0);
      assert.equal(clock.pendingGlobalTimers(), 0);
    };
    check();
    await clock.advance(100_000);
    check();
  } };
}

type Fixture = ReturnType<typeof fixture>;

/**
 * The server spawns a rabbit 65 blocks east. Stopgap until the shared fake's `entities.make` files `entityType`: it is the
 * registry id Mineflayer sets on every spawned mob (`entities.js:182,190`), which the hunt's target predicate reads.
 */
function spawnRabbit(f: Fixture) {
  return f.entities.spawn({ name: "rabbit", position: f.bot.entity.position.offset(65, 0, 0), entityType: f.bot.registry.entitiesByName.rabbit!.id });
}

/** The world age and fake time at which a wait rejected, with its message, so a test can keep the clock going past it. */
function rejection(f: Fixture, pending: Promise<unknown>) {
  return pending.then(
    () => { throw new Error("the wait resolved"); },
    (error: Error) => ({ message: error.message, age: f.bot.time.age, atMs: f.clock.now() }),
  );
}

/** The fake runtime of the hunt: it records the world age it was asked at and how often it was closed. */
function huntRuntime(f: Fixture) {
  const state = { askedAt: null as number | null, closed: 0 };
  const attach = spyOn(scenarioRuntime, "openRuntime").mockResolvedValue({
    actions: [{ name: COLLECT_MOB_DROP }],
    run: async () => { state.askedAt = f.bot.time.age; return { result: {} }; },
    close: async () => { state.closed++; },
  } as unknown as Awaited<ReturnType<typeof scenarioRuntime.openRuntime>>);
  return { state, attach };
}

for (const rate of RATES) {
  test(`the hunt waits for the rabbit at +200 server ticks at ${rate} tps`, async () => {
    const f = fixture(rate);
    using _timers = f.clock.install();
    const { state, attach } = huntRuntime(f);
    try {
      const pending = run(f.context);
      await f.clock.advance(msFor(200, rate));
      spawnRabbit(f);
      const result = await f.clock.settle(pending, 100_000);
      assert.equal(state.askedAt, 1_200, "the hunt was asked at world age 1 200");
      assert.equal(JSON.parse(result.detail!).quarryWaitTicks, 200);
      assert.ok(f.logs.includes("quarry rabbit loaded after 200 server ticks"));
      assert.equal(state.closed, 1);
      await f.assertClean();
    } finally { attach.mockRestore(); }
  });

  test(`a death during the wait ends the run as a failed hunt, never asked, at ${rate} tps`, async () => {
    const f = fixture(rate);
    using _timers = f.clock.install();
    const { state, attach } = huntRuntime(f);
    try {
      const pending = run(f.context);
      await f.clock.advance(5_000);
      f.bot.emit("death");
      const result = await f.clock.settle(pending, 100_000);
      assert.deepEqual(result, { status: "failed", detail: "Bot died during the hunt." });
      assert.equal(state.askedAt, null);
      assert.equal(state.closed, 1);
      await f.assertClean();
    } finally { attach.mockRestore(); }
  });

  test(`no rabbit within the goal budget fails the fixture before the hunt is asked at ${rate} tps`, async () => {
    const f = fixture(rate, 10);
    using _timers = f.clock.install();
    const { state, attach } = huntRuntime(f);
    try {
      const pending = run(f.context);
      await assert.rejects(f.clock.settle(pending, 100_000), /Fixture: no loaded rabbit within 100 server ticks/);
      assert.equal(f.bot.time.age, START_AGE + 120, "the wait ends at +120, inside the 200-tick goal");
      assert.equal(f.clock.now(), msFor(120, rate));
      assert.equal(state.askedAt, null);
      assert.equal(state.closed, 1);
      await f.assertClean();
    } finally { attach.mockRestore(); }
  });

  test(`the scenario's own cancel during the wait rejects with its reason at ${rate} tps`, async () => {
    const f = fixture(rate);
    using _timers = f.clock.install();
    const { state, attach } = huntRuntime(f);
    try {
      const pending = run(f.context);
      await f.clock.advance(2_000);
      f.controller.abort(new Error("scenario cancelled"));
      await assert.rejects(f.clock.settle(pending, 100_000), /scenario cancelled/);
      assert.equal(state.askedAt, null);
      assert.equal(state.closed, 1);
      await f.assertClean();
    } finally { attach.mockRestore(); }
  });

  test(`awaitQuarry does not count a cow, nor a rabbit removed again, at ${rate} tps`, async () => {
    const f = fixture(rate);
    using _timers = f.clock.install();
    f.entities.spawn({ name: "cow", position: f.bot.entity.position.offset(5, 0, 0) });
    const failed = rejection(f, awaitQuarry(f.bot, "rabbit", 380));
    f.clock.after(msFor(100, rate), () => f.entities.remove(spawnRabbit(f).id));
    await f.clock.advance(msFor(500, rate));
    const ended = await failed;
    assert.match(ended.message, /Fixture: no loaded rabbit within 380 server ticks/);
    assert.equal(ended.age, START_AGE + 400, "the wait ends at +400");
    assert.equal(ended.atMs, msFor(400, rate));
    await f.assertClean();
  });

  test(`awaitQuarry finds a rabbit spawned at the last look and misses one a look later at ${rate} tps`, async () => {
    // The slice runs its timers before the server moves the age: a rabbit spawned by a timer at +400 is there at the look that reads age 1 400.
    const found = fixture(rate);
    {
      using _timers = found.clock.install();
      const pending = awaitQuarry(found.bot, "rabbit", 380);
      found.clock.after(msFor(400, rate), () => spawnRabbit(found));
      assert.equal(await found.clock.settle(pending, 100_000), 400, "until is read before moved at the look at +400");
      await found.assertClean();
    }
    const missed = fixture(rate);
    using _timers = missed.clock.install();
    const failed = rejection(missed, awaitQuarry(missed.bot, "rabbit", 380));
    missed.clock.after(msFor(420, rate), () => spawnRabbit(missed));
    await missed.clock.advance(msFor(440, rate));
    const ended = await failed;
    assert.match(ended.message, /no loaded rabbit within 380 server ticks/);
    assert.equal(ended.age, START_AGE + 400);
    await missed.assertClean();
  });

  test(`awaitQuarry with a spent budget and no rabbit throws at once at ${rate} tps`, async () => {
    const f = fixture(rate);
    using _timers = f.clock.install();
    await assert.rejects(awaitQuarry(f.bot, "rabbit", 0), /Fixture: no loaded rabbit within 0 server ticks/);
    assert.equal(f.clock.now(), 0);
    await f.assertClean();
  });

  test(`awaitQuarry on a stopped server fails after the stall bound with the age unmoved at ${rate} tps`, async () => {
    const f = fixture(rate);
    using _timers = f.clock.install();
    f.server.stop();
    const pending = awaitQuarry(f.bot, "rabbit", 380);
    const failing = assert.rejects(f.clock.settle(pending, 100_000), /the server clock stood still for 30000 ms/);
    await failing;
    assert.equal(f.clock.now(), DRIVER_CLOCK_STOPPED_MS);
    assert.equal(f.bot.time.age, START_AGE);
    await f.assertClean();
  });

  test(`awaitQuarry aborted at fake 5 s rejects with the abort reason at ${rate} tps`, async () => {
    const f = fixture(rate);
    using _timers = f.clock.install();
    const pending = awaitQuarry(f.bot, "rabbit", 380, { signal: f.controller.signal });
    const failing = assert.rejects(pending, /stop waiting/);
    await f.clock.advance(5_000);
    f.controller.abort(new Error("stop waiting"));
    await failing;
    await f.assertClean();
  });

  test(`awaitQuarry counts from the first age heard when the call came before any time packet at ${rate} tps`, async () => {
    const f = fixture(rate, 180, false);
    using _timers = f.clock.install();
    assert.equal(f.bot.time.age, null, "no age heard at the call");
    const pending = awaitQuarry(f.bot, "rabbit", 380);
    // The first packet comes at +20 ticks (age 1 020); the rabbit appears 60 ticks later, before the look that reads age 1 080.
    f.clock.after(msFor(80, rate), () => spawnRabbit(f));
    assert.equal(await f.clock.settle(pending, 100_000), 60, "age at the matching look 1 080 minus the first age heard 1 020");
    await f.assertClean();
  });

}

// The server clock never moves in these, so the rate is not an input: one rate each.
const NO_WAIT_CASES: ReadonlyArray<{ name: string; timePacketYet: boolean; mob: string; budget: number; rabbit: boolean }> = [
  { name: "a rabbit loaded before the call", timePacketYet: true, mob: "rabbit", budget: 380, rabbit: true },
  { name: "a rabbit loaded before any time packet", timePacketYet: false, mob: "rabbit", budget: 380, rabbit: true },
  { name: "a spent budget with a rabbit loaded", timePacketYet: true, mob: "rabbit", budget: 0, rabbit: true },
  { name: "a mob the registry does not know", timePacketYet: true, mob: "no_such_mob", budget: 380, rabbit: false },
];
for (const { name, timePacketYet, mob, budget, rabbit } of NO_WAIT_CASES) {
  test(`awaitQuarry returns 0 at once for ${name}`, async () => {
    const f = fixture(20, 180, timePacketYet);
    using _timers = f.clock.install();
    if (rabbit) spawnRabbit(f);
    assert.equal(await f.clock.settle(awaitQuarry(f.bot, mob, budget), 100_000), 0);
    assert.equal(f.clock.now(), 0);
    await f.assertClean();
  });
}

test("quarryBudgetTicks leaves the goal budget less the three reserves", () => {
  assert.equal(quarryBudgetTicks(180, 1_000, 1_085), 3_415);
  assert.equal(quarryBudgetTicks(180, null, 1_085), 3_500);
  assert.equal(quarryBudgetTicks(180, 1_000, null), 3_500);
  assert.equal(quarryBudgetTicks(10, 1_000, 1_000), 100);
  assert.equal(quarryBudgetTicks(5, 1_000, 1_000), 0);
  assert.throws(() => quarryBudgetTicks(undefined, 1_000, 1_085), /needs a goal timeout/);
});
