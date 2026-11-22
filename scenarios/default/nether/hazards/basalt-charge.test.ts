// The charge gate ends on the declared ghast's answer, loss, deadline, or cancellation.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../../src/test-support/fake-bot/index.ts";
import { awaitGhastCharge, watchGhastCharge } from "./basalt-charge.ts";

/** Arrange a ghast with a 2-block height difference and 10-block horizontal separation. */
function chargeFixture(ticksPerSecond = 20) {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, combat, entities, server } = createFakeBot({
    clock,
    position: { x: 0, y: 100, z: 0 },
    server: { ticksPerSecond, startAge: 1_000 },
  });
  const ghast = entities.spawn({ id: 42, name: "ghast", position: { x: 10, y: 102, z: 0 } });
  const controller = new AbortController();
  const added = listenersAddedSince(bot);
  return { clock, bot, combat, entities, ghast, server, controller, added };
}

/** Run the gate and record the first settlement's observed age and clock time. */
function startCharge(fixture: ReturnType<typeof chargeFixture>) {
  const { bot, controller, clock } = fixture;
  const settlements: { age: number | null; ms: number }[] = [];
  const record = () => { settlements.push({ age: bot.time.age, ms: clock.now() }); };
  const result = awaitGhastCharge(bot, watchGhastCharge(bot), bot.time.age, controller.signal, () => {});
  result.then(record, record);
  return { result, settlements };
}

/** Every path must leave the bot, clock and signal as they were before arming. */
async function assertChargeClean(fixture: ReturnType<typeof chargeFixture>, settlements: readonly unknown[]) {
  const { clock, added, controller } = fixture;
  const assertClean = () => {
    for (const event of ["entityUpdate", "time", "entityGone", "entityDead"]) assert.equal(added(event), 0, event);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(clock.pendingTimers(), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
    assert.equal(settlements.length, 1);
  };
  assertClean();
  await clock.advance(60_000);
  assertClean();
}

for (const rate of [20, 10]) {
  const tickMs = 1_000 / rate;

  for (const loss of ["removal", "death"] as const) {
    test(`at ${rate} tps a ${loss} at +100 ends the charge gate with the last observed location`, async () => {
      const f = chargeFixture(rate);
      using _timers = f.clock.install();
      const { result, settlements } = startCharge(f);
      await f.clock.advance(100 * tickMs);
      assert.equal(f.bot.time.age, 1_100);
      // The death packet precedes entity_destroy (attack-hurts-and-kills contract, Mineflayer entities.js:309-320,385-395).
      if (loss === "death") f.combat.kill(f.ghast.id);
      else f.entities.remove(f.ghast.id);
      const detail = await f.clock.settle(result, 550 * tickMs);
      assert.ok("failure" in detail);
      const evidence = JSON.parse(detail.failure);
      assert.match(evidence.error, /ghast lost before charging/);
      assert.equal(evidence.ghastId, 42);
      assert.deepEqual(evidence.lastSeen, { age: 1_100, dy: 2, distance: Math.sqrt(104) });
      assert.equal(settlements[0]?.age, 1_100, "settled before the next time packet");
      assert.ok(settlements[0]!.ms < 120 * tickMs);
      assert.equal(f.bot.entities[f.ghast.id], loss === "death" ? f.ghast : undefined);
      await assertChargeClean(f, settlements);
    });
  }

  test(`at ${rate} tps a charge at +60 wins over removal in the same packet interval`, async () => {
    const f = chargeFixture(rate);
    using _timers = f.clock.install();
    const { result, settlements } = startCharge(f);
    await f.clock.advance(60 * tickMs);
    assert.equal(f.bot.time.age, 1_060);
    // Mineflayer sets metadata before entityUpdate (entities.js:470-475).
    const key = f.bot.registry.entitiesByName.ghast!.metadataKeys!.indexOf("is_charging");
    assert.ok(key >= 0);
    Reflect.set(f.ghast.metadata, key, true);
    f.bot.emit("entityUpdate", f.ghast);
    assert.equal(settlements.length, 0);
    f.entities.remove(f.ghast.id);
    assert.deepEqual(await f.clock.settle(result, 50), { chargeTicks: 60 });
    assert.equal(settlements[0]?.age, 1_060);
    assert.ok(settlements[0]!.ms < 80 * tickMs);
    await assertChargeClean(f, settlements);
  });

  test(`at ${rate} tps an uncharged ghast stays pending through +520 and reports the measured budget`, async () => {
    const f = chargeFixture(rate);
    using _timers = f.clock.install();
    const { result, settlements } = startCharge(f);
    await f.clock.advance(520 * tickMs);
    assert.equal(f.bot.time.age, 1_520);
    assert.equal(settlements.length, 0);
    const detail = await f.clock.settle(result, 20 * tickMs + 50);
    assert.ok("failure" in detail);
    assert.match(detail.failure, /ghast did not charge within 520 server ticks/);
    assert.equal(settlements[0]?.age, 1_540);
    assert.ok(settlements[0]!.ms <= 540 * tickMs + 50);
    await assertChargeClean(f, settlements);
  });

  test(`at ${rate} tps cancellation rejects the charge gate without advancing the clock`, async () => {
    const f = chargeFixture(rate);
    using _timers = f.clock.install();
    const { result, settlements } = startCharge(f);
    await f.clock.advance(40 * tickMs);
    assert.equal(f.bot.time.age, 1_040);
    const reason = new Error("cancel basalt charge");
    f.controller.abort(reason);
    await assert.rejects(result, (error) => error === reason);
    assert.deepEqual(settlements, [{ age: 1_040, ms: 40 * tickMs }]);
    await assertChargeClean(f, settlements);
  });
}

test("a stopped server reports the charge gate stall after 30 seconds", async () => {
  const f = chargeFixture();
  using _timers = f.clock.install();
  f.server.stop();
  const { result, settlements } = startCharge(f);
  const failed = assert.rejects(result, /world age stood still for 30 s after 0 of 520 ticks/);
  await f.clock.advance(29_950);
  assert.equal(settlements.length, 0);
  await f.clock.advance(50);
  await failed;
  assert.deepEqual(settlements, [{ age: 1_000, ms: 30_000 }]);
  await assertChargeClean(f, settlements);
});
