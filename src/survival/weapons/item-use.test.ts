import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { CombatItemUse } from "./item-use.js";

test("drawing a bow releases server shield use even after local posture was invalidated", async () => {
  // The server ignores a use request while another hand is active, and ends a main-hand use when the held slot changes.
  const { bot, clock } = createFakeBot({ carried: { bow: 1, arrow: 4 }, slots: { 45: { name: "shield", count: 1 } } });
  const arrowsFlying = () => Object.values(bot.entities).filter((entity) => entity.name === "arrow").length;
  const handInUse = () => (Number(bot.entity.metadata[bot.registry.entitiesByName.player!.metadataKeys!.indexOf("living_entity_flags")]) & 1) === 1;
  const use = new CombatItemUse(bot, async () => {});
  await use.raiseShield();
  await clock.advance(100);
  assert.equal(handInUse(), true, "the server holds the shield up");
  use.invalidateShield(); // Refused construction did not release the native use.
  using draw = use.drawBow();
  await clock.advance(200);
  draw.release();
  await clock.advance(100);
  assert.equal(arrowsFlying(), 1, "release must fire a bow, not merely lower the still-active shield");
  assert.equal(bot.inventory.count(bot.registry.itemsByName.arrow!.id, null), 3);
  assert.equal(handInUse(), false);
});

/** The shared fake bot with its item release and control clearing written to `order`. */
function recordedBot(order: string[]) {
  const harness = createFakeBot();
  const release = harness.bot.deactivateItem.bind(harness.bot);
  harness.bot.deactivateItem = () => {
    order.push("release use");
    release();
  };
  const clear = harness.bot.clearControlStates.bind(harness.bot);
  harness.bot.clearControlStates = () => {
    order.push("clear movement");
    clear();
  };
  return harness;
}

test("cleanup settles the body after the final item-release tick can deliver knockback", async () => {
  let grounded = true;
  let settledAirborne = false;
  const order: string[] = [];
  const { bot, clock } = recordedBot(order);
  const cleanup = new CombatItemUse(bot, async () => {}).neutralise(async () => {
    settledAirborne = !grounded;
    grounded = true;
    order.push("land");
  }, new AbortController().signal);
  grounded = false;
  order.push("knockback arrives");
  await clock.advance(50);
  await cleanup;
  assert.equal(settledAirborne, true, "the health cancellation precedes the velocity packet");
  assert.equal(grounded, true, "no awaited cleanup remains after the physical handoff");
  assert.ok(order.indexOf("land") > order.indexOf("knockback arrives"));
  assert.ok(order.lastIndexOf("clear movement") > order.indexOf("land"));
});

test("body cancellation settles item release even when physics has stopped", async () => {
  const { bot } = createFakeBot();
  const owner = new AbortController();
  let settled = false;
  const cleanup = new CombatItemUse(bot, async () => {}).neutralise(async () => {
    settled = true;
  }, owner.signal);
  owner.abort(new Error("body released"));
  await cleanup;
  assert.equal(settled, true);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});
