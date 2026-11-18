/** Survival and setup require server evidence, including slow, stopped and missing world clocks. */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { spyOn } from "bun:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { watch } from "../../../src/test-support/pending.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import * as arrangedHealth from "./arranged-health.ts";
import { observeSurvival, run } from "./low-health-night-survival.ts";

/** Build a shared-clock trial and count observers and timers left after its exits. */
function fixture(rate = 20, timePacketYet = true) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, server: { startAge: 1_000, ticksPerSecond: rate, timePacketYet } });
  const controller = new AbortController();
  const context = { bot: harness.bot, signal: controller.signal, log: () => {}, scenario: {
    params: { startingHealth: 7 },
    entities: [{ type: "minecraft:zombie" }],
    goal: { kind: "all", goals: [{ kind: "survive", seconds: 20 }] },
  } } as unknown as MineAiScenarioContext;
  const added = listenersAddedSince(harness.bot);
  const clientAdded = listenersAddedSince(harness.bot._client);
  return { ...harness, controller, context, assertClean: async () => {
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

for (const { rate, packetMs } of [{ rate: 20, packetMs: 21_000 }, { rate: 10, packetMs: 42_000 }]) {
  test(`survival waits for the +420 packet and its next look at ${rate} tps`, async () => {
    const { context, bot, clock, assertClean } = fixture(rate);
    using _timers = clock.install();
    const pending = observeSurvival(context, 20);
    const state = watch(pending);
    await clock.advance(packetMs - 50);
    assert.equal(bot.time.age, 1_400);
    assert.equal(state.over, false, "the full survival window needs its packet-origin margin");
    await clock.advance(50);
    assert.equal(bot.time.age, 1_420);
    assert.equal(state.over, false, "the packet follows this look");
    await clock.advance(50);
    assert.equal(await pending, "survived");
    assert.equal(clock.now(), packetMs + 50);
    await assertClean();
  });

  test(`death at +100 ticks ends survival immediately at ${rate} tps`, async () => {
    const { context, bot, clock, combat, assertClean } = fixture(rate);
    using _timers = clock.install();
    const pending = observeSurvival(context, 20);
    await clock.advance(100_000 / rate);
    assert.equal(bot.time.age, 1_100);
    combat.setHealth(0);
    assert.equal(await clock.settle(pending, 0), "died");
    assert.equal(clock.now(), 100_000 / rate);
    await clock.settle(new Promise<void>(resolve => bot.once("physicsTick", () => resolve())), 2_500);
    assert.equal(bot.health, 20, "the real fake-server respawn does not change the verdict");
    await assertClean();
  });

  test(`a death and restored health between looks remain a death at ${rate} tps`, async () => {
    const { context, clock, combat, assertClean } = fixture(rate);
    using _timers = clock.install();
    const pending = observeSurvival(context, 20);
    combat.setHealth(0);
    combat.setHealth(20);
    assert.equal(await clock.settle(pending, 0), "died");
    await assertClean();
  });

  test(`setup accepts threats arriving at +30 server ticks at ${rate} tps`, async () => {
    const { context, bot, clock, server, entities, assertClean } = fixture(rate);
    using _timers = clock.install();
    const reachedRuntime = new Error("setup reached runtime attachment");
    const attach = spyOn(arrangedHealth, "openAtArrangedHealth").mockRejectedValue(reachedRuntime);
    try {
      const pending = run(context);
      const rejected = assert.rejects(pending, error => error === reachedRuntime);
      const state = watch(pending);
      await clock.advance(30_000 / rate);
      assert.equal(server.gameTime, 1_030);
      assert.equal(state.over, false);
      entities.spawn({ name: "zombie", position: bot.entity.position.offset(2, 0, 0) });
      await clock.settle(rejected, 50);
      assert.equal(clock.now(), 30_000 / rate + 50);
      await assertClean();
    } finally {
      attach.mockRestore();
    }
  });

  test(`missing threats fail setup only after the +60 packet at ${rate} tps`, async () => {
    const { context, bot, clock, assertClean } = fixture(rate);
    using _timers = clock.install();
    const pending = run(context);
    const state = watch(pending);
    const packetMs = 60_000 / rate;
    await clock.advance(packetMs - 50);
    assert.equal(bot.time.age, 1_040);
    assert.equal(state.over, false, "setup must not spend client ticks as server ticks");
    await clock.advance(50);
    assert.equal(bot.time.age, 1_060);
    assert.equal(state.over, false);
    await clock.advance(50);
    const result = await pending;
    assert.equal(result.status, "failed");
    assert.match(result.detail!, /Setup failed: the declared threats were not observed \(1 zombie\)/);
    assert.match(result.detail!, /ticks/);
    assert.match(result.detail!, /elapsedMs[":= ]+\d+/);
    assert.match(result.detail!, /elapsedTicks[":= ]+60/);
    await assertClean();
  });
}

for (const { name, rate, observed, stop, finishMs, end, age } of [
  { name: "stopped", rate: 20, observed: true, stop: true, finishMs: 20_000, end: "stalled", age: 1_000 },
  { name: "no age", rate: 20, observed: false, stop: true, finishMs: 20_000, end: "unobserved", age: null },
  { name: "5 tps stress", rate: 5, observed: true, stop: false, finishMs: 63_000, end: "wall", age: 1_300 },
]) {
  test(`${name} cannot pass survival on the ${end} end`, async () => {
    const { context, bot, clock, server, assertClean } = fixture(rate, observed);
    using _timers = clock.install();
    if (stop) server.stop();
    const pending = observeSurvival(context, 20);
    const state = watch(pending);
    await clock.advance(finishMs - 1);
    assert.equal(state.over, false);
    await clock.advance(1);
    assert.equal(await pending, end);
    assert.equal(bot.time.age, age);
    assert.equal(clock.now(), finishMs);
    await assertClean();
  });

  test(`run reports ${end} survival as failed with clock evidence`, async () => {
    const { context, bot, clock, server, entities, assertClean } = fixture(rate, observed);
    using _timers = clock.install();
    if (stop) server.stop();
    entities.spawn({ name: "zombie", position: bot.entity.position.offset(2, 0, 0) });
    let closed = 0;
    const attach = spyOn(arrangedHealth, "openAtArrangedHealth").mockResolvedValue({
      close: async () => { closed++; },
    } as Awaited<ReturnType<typeof arrangedHealth.openAtArrangedHealth>>);
    try {
      const pending = run(context);
      const result = await clock.settle(pending, finishMs + 50);
      assert.equal(result.status, "failed");
      assert.match(result.detail!, new RegExp(end));
      assert.ok(result.detail!.includes(end === "stalled" ? "server clock stood still" : end === "wall" ? "wall backstop" : "no world age heard"));
      assert.match(result.detail!, /elapsedMs/);
      assert.match(result.detail!, /elapsedTicks/);
      assert.equal(closed, 1);
      await assertClean();
    } finally {
      attach.mockRestore();
    }
  });
}

for (const before of [true, false]) {
  test(`cancellation ends survival and setup immediately (already cancelled ${before})`, async () => {
    const { context, clock, controller, assertClean } = fixture();
    using _timers = clock.install();
    const reason = new Error("trial stopped");
    if (before) controller.abort(reason);
    const pending = observeSurvival(context, 20);
    const rejected = assert.rejects(run(context), error => error === reason);
    if (!before) {
      await clock.advance(1_000);
      controller.abort(reason);
    }
    assert.equal(await clock.settle(pending, 0), "cancelled");
    await clock.settle(rejected, 0);
    await assertClean();
  });
}

test("an already dead bot cannot start a survival window", async () => {
  const { context, clock, combat, server, assertClean } = fixture();
  using _timers = clock.install();
  server.stop();
  combat.setHealth(0);
  assert.equal(await observeSurvival(context, 20), "died");
  await assertClean();
});

for (const { observed, finishMs, end, age } of [
  { observed: true, finishMs: 9_000, end: "wall", age: 1_000 },
  { observed: false, finishMs: 2_000, end: "unobserved", age: null },
]) {
  test(`setup with no server progress fails on ${end} and releases observers`, async () => {
    const { context, bot, clock, server, assertClean } = fixture(20, observed);
    using _timers = clock.install();
    server.stop();
    const pending = run(context);
    const state = watch(pending);
    await clock.advance(finishMs - 1);
    assert.equal(state.over, false);
    await clock.advance(1);
    const result = await pending;
    assert.equal(result.status, "failed");
    assert.match(result.detail!, /Setup failed/);
    assert.ok(result.detail!.includes(end));
    assert.ok(result.detail!.includes(`"elapsedMs":${finishMs}`));
    assert.ok(result.detail!.includes(`"elapsedTicks":${observed ? 0 : null}`));
    assert.equal(bot.time.age, age);
    await assertClean();
  });
}
