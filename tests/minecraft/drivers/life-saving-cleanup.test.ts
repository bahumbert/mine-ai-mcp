// Cleanup confirmation returns on the server answer and reports a stopped clock.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { loadScenario } from "mine-labs";
import { Vec3 } from "vec3";
import { createViewStatusAction } from "../../../src/actions/view-status/view-status.ts";
import { temporaryBotData } from "../../../src/test-support/bot-data.ts";
import { protectedRegion } from "../../../src/test-support/protected-region.ts";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { removeLifeSavingPlacements } from "../../../src/world/life-saving-placements.ts";
import { setProtectedRegionsProvider } from "../../../src/world/protected-regions.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import type { ScenarioCall } from "../scenario.ts";
import { run } from "./life-saving-cleanup.ts";

const scenario = await loadScenario(new URL("../scenarios/survival/life-saving-cleanup.yaml", import.meta.url).pathname);

interface CleanupSchedule {
  readonly fireTicks?: number | null;
  readonly cleanupTicks?: number;
  readonly stop?: "fire" | "cleanup";
}

// Measured loop spans: 220 ticks at 20 tps, 200-212 at 10; the driver budget is twice the worst (T2d).
const OBSERVE_TICKS = 440;

/** Script only the measured cleanup/fire stages, not the runtime reflex; the real scenario covers that handover. */
function cleanupRun(t: TestContext, stopped: boolean, ticksPerSecond: number, schedule: CleanupSchedule = {}) {
  const clock = createFakeClock({ mode: "mocked" });
  const world = createFakeBot({ clock, server: { ticksPerSecond }, cells: { "7,-60,0": "cobblestone" }, position: new Vec3(0.5, -60, 0.5) });
  const { bot, server } = world;
  setProtectedRegionsProvider(bot, () => [protectedRegion({ regionId: 1, dimension: "overworld", owner: "Builder", label: "test",
    min: { x: 7, y: -60, z: 0 }, max: { x: 7, y: -60, z: 0 } })]);
  const status = createViewStatusAction(bot, temporaryBotData({ botId: "CleanupTest", closeAfter: t }), () => ({ owner: "idle", activeAction: null }));
  let owner: string | null = "remove_life_saving_placements";
  let queryAge = 0;
  let navigated = false;
  let calls = 0;
  let receipts = 0;
  let paused = 0;
  let resumed = 0;
  let fireSentAge = 0;
  let fireAnswerAge = 0;
  let fireAnswerMs = 0;
  const began = clock.now();
  const atTick = (ticks: number, answer: () => void) => clock.after(ticks * 1_000 / ticksPerSecond, answer);
  atTick(1, () => { bot.entity.position.x += 1; });
  const cleanupTicks = schedule.cleanupTicks ?? (schedule.fireTicks ?? 0) + 4;
  atTick(cleanupTicks, () => {
    if (schedule.stop !== undefined) return;
    world.world.setCell(new Vec3(7, -60, 0), "air");
    owner = null;
    // The real removal observes the already confirmed air and clears the recorded obligation.
    void removeLifeSavingPlacements(bot, new AbortController().signal);
  });
  // Arrange the driver's command answers; the fake has no command interpreter.
  bot.chat = (command) => {
    if (command.startsWith("/setblock")) {
      if (fireSentAge === 0) fireSentAge = bot.time.age;
      if (schedule.stop === "fire") server.stop();
      else if (schedule.fireTicks !== null) atTick(schedule.fireTicks ?? 0, () => {
        world.world.setCell(bot.entity.position.floored(), "fire");
        fireAnswerAge = bot.time.age;
        fireAnswerMs = clock.now() - began;
        // The reflex takes the body and puts the fire out at once (it is scripted, not run): the fake lights a body in a fire block, so the block and the burn go with it.
        atTick(1, () => {
          owner = "fire_reflex";
          world.world.setCell(bot.entity.position.floored(), "air");
          world.combat.burn.extinguish();
        });
        if (schedule.stop === "cleanup") atTick(42, () => { server.stop(); });
      });
    }
    if (command.startsWith("/execute")) {
      receipts += 1;
      queryAge = bot.time.age;
      if (stopped) server.stop();
      else atTick(1, () => bot.emit("messagestr", "cleanup-server-air", "chat", {} as never));
    }
  };
  const context = scenarioTestContext({ bot, scenario, call: async (action) => {
    calls += 1;
    if (action === "view_status") {
      const result = await status.execute({}, {});
      return { action, durationMs: 0, summary: "status", result,
        survival: { owner: { current: owner } } } as unknown as ScenarioCall;
    }
    if (action === "navigate") navigated = true;
    return { action, durationMs: 0, summary: "done", result: { status: "succeeded" } };
  } });
  context.physics.pause = () => { paused += 1; };
  context.physics.resume = () => { resumed += 1; };
  return { clock, bot, server, status, pending: () => run(context, clock.sleep), queryAge: () => queryAge,
    navigated: () => navigated, calls: () => calls, receipts: () => receipts, physics: () => ({ paused, resumed }),
    fireAnswer: () => ({ ticks: fireAnswerAge - fireSentAge, ms: fireAnswerMs }), began };
}

for (const ticksPerSecond of [20, 10]) test(`the cleanup server answer ends the wait early at ${ticksPerSecond} tps`, async (t) => {
  const fixture = cleanupRun(t, false, ticksPerSecond);
  using _timers = fixture.clock.install();
  const added = listenersAddedSince(fixture.bot);
  let settlements = 0;
  const result = await fixture.clock.settle(fixture.pending().then((answer) => { settlements += 1; return answer; }), 1_000);
  assert.equal(result.status, "succeeded", result.detail ?? "no detail");
  assert.equal(fixture.bot.time.age, fixture.queryAge());
  assert.equal(fixture.navigated(), true);
  assert.equal(JSON.parse(result.detail!).retainedDuringFire, true);
  const calls = fixture.calls();
  await fixture.clock.advance(31_000);
  assert.equal(settlements, 1);
  assert.equal(fixture.calls(), calls);
  assert.equal(added("messagestr"), 0);
});

for (const rate of [20, 10]) {
  test(`a fire answer 30 server ticks after the send permits cleanup at ${rate} tps`, async (t) => {
    const fixture = cleanupRun(t, false, rate, { fireTicks: 30 });
    using _timers = fixture.clock.install();
    const added = listenersAddedSince(fixture.bot);
    let settlements = 0;
    const result = await fixture.clock.settle(fixture.pending().then((answer) => { settlements += 1; return answer; }), 5_000);
    assert.equal(result.status, "succeeded", result.detail ?? "no detail");
    assert.deepEqual(fixture.fireAnswer(), { ticks: 20, ms: 31 * 1_000 / rate });
    assert.equal(fixture.navigated(), true);
    assert.equal(JSON.parse(result.detail!).retainedDuringFire, true);
    assert.deepEqual(fixture.physics(), { paused: 1, resumed: 1 });
    const calls = fixture.calls();
    await fixture.clock.advance(51_000);
    assert.equal(settlements, 1);
    assert.equal(fixture.calls(), calls);
    assert.equal(added("messagestr"), 0);
  });

  for (const [name, schedule, detail, maxMs] of [
    ["missing fire answer", { fireTicks: null }, /fire block/, 31_000],
    ["stopped fire clock", { stop: "fire" }, /clock stood still.*fire block/, 31_000],
    ["cleanup beyond its tick budget", { cleanupTicks: OBSERVE_TICKS + 20 }, /440.*tick.*budget/, 50_000],
    ["stopped cleanup clock", { stop: "cleanup" }, /clock stood still.*cleanup/, 31_000],
  ] as const) test(`${name} fails without receipts or navigation at ${rate} tps`, async (t) => {
    const fixture = cleanupRun(t, false, rate, schedule);
    using _timers = fixture.clock.install();
    const added = listenersAddedSince(fixture.bot);
    let settlements = 0;
    const result = await fixture.clock.settle(fixture.pending().then((answer) => { settlements += 1; return answer; }), maxMs);
    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", detail);
    assert.equal(fixture.receipts(), 0);
    assert.equal(fixture.navigated(), false);
    const physics = fixture.physics();
    assert.ok(physics.paused > 0);
    assert.equal(physics.resumed, physics.paused);
    if (name === "cleanup beyond its tick budget") {
      assert.equal(fixture.bot.time.age, 24_440);
      assert.equal(fixture.clock.now() - fixture.began, OBSERVE_TICKS * 1_000 / rate);
    } else if (name === "missing fire answer") {
      assert.equal(fixture.bot.time.age, 24_060);
      assert.equal(fixture.clock.now() - fixture.began, 60 * 1_000 / rate);
    } else if (name === "stopped cleanup clock") {
      assert.equal(fixture.bot.time.age, 24_040);
      assert.equal(fixture.clock.now() - fixture.began, 40 * 1_000 / rate + 20_000);
    } else assert.equal(fixture.bot.time.age, 24_000);
    const calls = fixture.calls();
    fixture.server.resume();
    await fixture.clock.advance(51_000);
    assert.equal(settlements, 1);
    assert.equal(fixture.calls(), calls);
    assert.equal(added("messagestr"), 0);
  });

  test(`cleanup finishing 20 ticks before its budget succeeds at ${rate} tps`, async (t) => {
    const fixture = cleanupRun(t, false, rate, { cleanupTicks: OBSERVE_TICKS - 20 });
    using _timers = fixture.clock.install();
    const added = listenersAddedSince(fixture.bot);
    let settlements = 0;
    const result = await fixture.clock.settle(fixture.pending().then((answer) => { settlements += 1; return answer; }), 45_000);
    assert.equal(result.status, "succeeded", result.detail ?? "no detail");
    assert.equal(fixture.queryAge(), 24_420);
    assert.equal(fixture.clock.now() - fixture.began, 421 * 1_000 / rate);
    assert.equal(fixture.navigated(), true);
    assert.equal(JSON.parse(result.detail!).retainedDuringFire, true);
    assert.deepEqual(fixture.physics(), { paused: 1, resumed: 1 });
    const calls = fixture.calls();
    await fixture.clock.advance(51_000);
    assert.equal(settlements, 1);
    assert.equal(fixture.calls(), calls);
    assert.equal(added("messagestr"), 0);
  });
}

for (const rate of [20, 10]) test(`a stopped clock during the cleanup server answer is named and does not navigate at ${rate} tps`, async (t) => {
  const fixture = cleanupRun(t, true, rate);
  using _timers = fixture.clock.install();
  const added = listenersAddedSince(fixture.bot);
  let settlements = 0;
  const result = await fixture.clock.settle(fixture.pending().then((answer) => { settlements += 1; return answer; }), 31_000);
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /clock stood still/);
  assert.equal(fixture.navigated(), false);
  fixture.server.resume();
  const next = await fixture.clock.settle(fixture.status.execute({}, {}), 500);
  assert.equal(next.status, "succeeded");
  const calls = fixture.calls();
  await fixture.clock.advance(31_000);
  assert.equal(settlements, 1);
  assert.equal(fixture.calls(), calls);
  assert.equal(added("messagestr"), 0);
});
