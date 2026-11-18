// Recorded loadout commands wait for authoritative slot answers on the server clock.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createFakeBot, createFakeClock, itemOf, listenersAddedSince } from "../../src/test-support/fake-bot/index.ts";
import { watch } from "../../src/test-support/pending.ts";
import { restoreRecordedLoadout } from "./recorded-loadout.ts";

/** Slot updates use Prismarine's window, as Mineflayer inventory.js's set_slot handler does. */
function loadoutHarness(rate: number) {
  const clock = createFakeClock({ mode: "mocked" });
  const sent: string[] = [];
  const harness = createFakeBot({ clock, server: { startAge: 1_000, ticksPerSecond: rate },
    overrides: { chat: message => { sent.push(message); } } });
  const loadout: Array<[number, string, number, number]> = Array.from({ length: 41 }, (_, i) => [i + 5, "stone", 2, 0]);
  loadout[31] = [36, "iron_pickaxe", 1, 7];
  const controller = new AbortController();
  const added = listenersAddedSince(harness.bot);
  return { ...harness, sent, loadout, controller, acknowledge() {
    for (const [slot, name, count, damage] of loadout) {
      const item = itemOf(harness.bot.registry, name, count);
      if (damage) item.nbt = { type: "compound", value: { Damage: { type: "int", value: damage } } };
      harness.inventory.updateSlot(slot, item);
    }
  }, async assertClean() {
    assert.equal(clock.pendingTimers(), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    for (const event of harness.bot.eventNames()) assert.equal(added(String(event)), 0);
    await clock.advance(30_000);
    assert.equal(clock.pendingGlobalTimers(), 0);
    assert.equal(sent.length, 41);
  } };
}

for (const rate of [20, 10]) {
  test(`all 41 loadout commands precede the budget-10 (+30) server-tick slot answers at ${rate} tps`, async () => {
    const h = loadoutHarness(rate);
    using _timers = h.clock.install();
    const pending = restoreRecordedLoadout(h.bot, h.loadout, h.controller.signal);
    const state = watch(pending);
    assert.equal(h.sent.length, 41, "do not spend client ticks between commands");
    assert.equal(h.sent[0], "/item replace entity @s armor.head with minecraft:stone 2");
    assert.equal(h.sent[31], "/item replace entity @s hotbar.0 with minecraft:iron_pickaxe[minecraft:damage=7] 1");
    assert.equal(h.sent[40], "/item replace entity @s weapon.offhand with minecraft:stone 2");
    await h.clock.advance(30 * 1_000 / rate);
    assert.equal(h.server.gameTime, 1_030);
    assert.equal(h.bot.time.age, 1_020, "the cached time packet precedes the slot answer");
    assert.equal(state.over, false);
    h.acknowledge();
    await h.clock.settle(pending, 50);
    assert.equal(h.clock.now(), 30 * 1_000 / rate + 50);
    await h.assertClean();
  });

  for (const mismatch of ["missing", "name", "count", "damage"] as const) {
    test(`a ${mismatch} loadout answer fails at the first look after budget+20 (+60) at ${rate} tps`, async () => {
      const h = loadoutHarness(rate);
      using _timers = h.clock.install();
      const pending = restoreRecordedLoadout(h.bot, h.loadout, h.controller.signal);
      const rejected = assert.rejects(pending, /Recorded inventory slots\/counts\/durability were not acknowledged.*ticks/u);
      const state = watch(pending);
      if (mismatch !== "missing") {
        h.acknowledge();
        const item = h.inventory.slots[36]!;
        if (mismatch === "name") h.inventory.updateSlot(36, itemOf(h.bot.registry, "stone"));
        if (mismatch === "count") item.count = 2;
        if (mismatch === "damage") item.nbt = null;
      }
      await h.clock.advance(60 * 1_000 / rate);
      assert.equal(h.bot.time.age, 1_060);
      assert.equal(state.over, false, "the first look follows the packet");
      await h.clock.settle(rejected, 50);
      assert.equal(h.clock.now(), 60 * 1_000 / rate + 50);
      await h.assertClean();
    });
  }
}

for (const end of ["stopped", "cancelled"] as const) {
  test(`a ${end} loadout wait settles and releases its observers`, async () => {
    const h = loadoutHarness(10);
    using _timers = h.clock.install();
    if (end === "stopped") h.server.stop();
    const pending = restoreRecordedLoadout(h.bot, h.loadout, h.controller.signal);
    const reason = new Error("scenario cancelled");
    const rejected = assert.rejects(pending, end === "stopped" ? /not acknowledged.*wall/u : error => error === reason);
    if (end === "cancelled") h.controller.abort(reason);
    await h.clock.settle(rejected, end === "stopped" ? 9_000 : 0);
    assert.equal(h.clock.now(), end === "stopped" ? 9_000 : 0);
    assert.equal(h.bot.time.age, 1_000);
    await h.assertClean();
  });
}
