/**
 * The fake bot's burning, as contract check `fire-block-burn` measured it on the 1.21.4 server (Mine Labs, 2026-11-21, 5 runs at 20 and at 10 tps):
 * the flag goes out 300 ticks after the last lava tick (301-303 read) and 164-176 after the last fire or soul fire block tick; a hurt of
 * `on_fire` comes each 20 ticks before that, 14 after lava and 8-9 after a fire block; a second contact never shortens the burn;
 * water puts it out.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeHarness, createFakeBot } from "./fake-bot.js";
import { BURN_AFTER_FIRE_BLOCK_TICKS, BURN_AFTER_LAVA_TICKS, FIRE_BLOCK_LIGHTS_AFTER_TICKS } from "./fake-bot-fire.js";
import type { FakeCell } from "./fake-world.js";

const TICK_MS = 50;
const FEET = new Vec3(0, 63, 0);
const FLOOR_Y = 62;
/** The check's read of the clear is the tick after the count's (it hears the packet of the tick that changed the flag). */
const READ_LATE = 1;

/** Run `count` server ticks, at whatever rate the harness's server has (the clock in slices of one 20 tps tick until the game time has moved that far). */
async function ticks(harness: FakeHarness, count: number): Promise<void> {
  const target = harness.server.gameTime + count;
  while (harness.server.gameTime < target) await harness.clock.advance(TICK_MS);
}
const burning = ({ bot }: FakeHarness) => (Number(bot.entity.metadata[bot.registry.entitiesByName.player!.metadataKeys!.indexOf("shared_flags")] ?? 0) & 1) === 1;

function scene(rate = 20) {
  return createFakeBot({ position: new Vec3(0.5, 63, 0.5), groundY: FLOOR_Y, server: { ticksPerSecond: rate } });
}

/** The body stands in `contact` for `stay` ticks, then in air: the ticks from the last contact tick to the flag's clear (null: it never went out within `limit`). */
async function burnAfter(harness: FakeHarness, contact: FakeCell, stay: number, limit = 400): Promise<number | null> {
  harness.world.setCell(FEET, contact);
  await ticks(harness, stay);
  harness.world.setCell(FEET, "air");
  assert.equal(burning(harness), true, "lit by the contact");
  for (let after = 1; after <= limit; after += 1) {
    await ticks(harness, 1);
    if (!burning(harness)) return after;
  }
  return null;
}

test("a body leaving lava burns on for 300 ticks and takes 14 hurts of on_fire, one each 20 ticks", async () => {
  const harness = scene();
  const out = await burnAfter(harness, { name: "lava", properties: { level: 0 } }, 1);
  assert.equal(out, BURN_AFTER_LAVA_TICKS + READ_LATE, "read as the contract check reads it: 301");
  assert.equal(harness.bot.health, 20 - 14);
});

test("a body leaving a fire block or a soul fire block burns on for its 176 ticks and takes 8 hurts, at 20 tps and at 10 tps", async () => {
  for (const rate of [20, 10]) for (const name of ["fire", "soul_fire"]) {
    const harness = scene(rate);
    const out = await burnAfter(harness, name, 40);
    assert.equal(out, BURN_AFTER_FIRE_BLOCK_TICKS + READ_LATE, `${name} at ${rate} tps: 176 as read`);
    assert.equal(harness.bot.health, 20 - 8, `${name} at ${rate} tps`);
  }
});

test("a fire block lights a body only after 20 ticks in it, as the server did (contacts of 0, 5, 10 lit nothing, 20 lit)", async () => {
  for (const [stay, lit] of [[0, false], [5, false], [10, false], [FIRE_BLOCK_LIGHTS_AFTER_TICKS - 1, false], [FIRE_BLOCK_LIGHTS_AFTER_TICKS, true]] as const) {
    const harness = scene();
    harness.world.setCell(FEET, "fire");
    await ticks(harness, stay);
    harness.world.setCell(FEET, "air");
    await ticks(harness, 1);
    assert.equal(burning(harness), lit, `a stay of ${stay} ticks`);
  }
});

test("lava burns at 10 tps as at 20: 300 ticks and 14 hurts", async () => {
  const harness = scene(10);
  assert.equal(await burnAfter(harness, { name: "lava", properties: { level: 0 } }, 1), BURN_AFTER_LAVA_TICKS + READ_LATE);
  assert.equal(harness.bot.health, 20 - 14);
});

test("a second contact never shortens the burn: lava then fire keeps lava's end, fire then lava takes lava's", async () => {
  const lavaThenFire = scene();
  lavaThenFire.world.setCell(FEET, { name: "lava", properties: { level: 0 } });
  await ticks(lavaThenFire, 1);
  lavaThenFire.world.setCell(FEET, "air");
  await ticks(lavaThenFire, 40);
  const outAfterFire = await burnAfter(lavaThenFire, "fire", 40);
  assert.equal(outAfterFire, BURN_AFTER_LAVA_TICKS + READ_LATE - 80, "lit by the fire block 40 ticks after the lava, 40 ticks in it: its 175 are under the 220 lava still owes (221 as read)");

  const fireThenLava = scene();
  fireThenLava.world.setCell(FEET, "fire");
  await ticks(fireThenLava, 40);
  fireThenLava.world.setCell(FEET, "air");
  await ticks(fireThenLava, 40);
  assert.equal(await burnAfter(fireThenLava, { name: "lava", properties: { level: 0 } }, 1), BURN_AFTER_LAVA_TICKS + READ_LATE);
});

test("water at the feet puts the burn out and nothing is owed afterwards", async () => {
  const harness = scene();
  harness.world.setCell(FEET, { name: "lava", properties: { level: 0 } });
  await ticks(harness, 5);
  harness.world.setCell(FEET, { name: "water", properties: { level: 0 } });
  await ticks(harness, 2);
  assert.equal(burning(harness), false);
  const health = harness.bot.health;
  harness.world.setCell(FEET, "air");
  await ticks(harness, 400);
  assert.equal(burning(harness), false);
  assert.equal(harness.bot.health, health, "no on_fire hurt after the water");
});

test("a death puts the burn out: the new life is not on fire and takes no hurt from the old one", async () => {
  const harness = scene();
  harness.world.setCell(FEET, { name: "lava", properties: { level: 0 } });
  await ticks(harness, 2);
  harness.world.setCell(FEET, "air");
  harness.combat.setHealth(0);
  await ticks(harness, 5);
  assert.equal(burning(harness), false);
  await ticks(harness, 400);
  assert.equal(harness.bot.health, 20, "the respawned body kept full health");
});

test("the instant heal command gives full health one tick after it is sent", async () => {
  const harness = scene();
  harness.combat.hurtBot(12, null);
  await ticks(harness, 2);
  const hurt = harness.bot.health;
  assert.ok(hurt < 20);
  harness.bot.chat("/effect give @s minecraft:instant_health 1 10 true");
  assert.equal(harness.bot.health, hurt, "not at once");
  await ticks(harness, 3);
  assert.equal(harness.bot.health, 20);
});
