import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { listenersAddedSince } from "../../test-support/fake-bot/listener-counts.js";
import { burnLeft, recordFireContact } from "./burn.js";
import { readFireDanger } from "./fire-danger.js";

/** The server's burn after a fire block, read in tick counts by contract check `fire-block-burn`: the longest of 5 runs at 20 and at 10 tps (2026-11-21: 177 for a soul fire block at 20 tps). */
const FIRE_BURN = 177;
const LAVA_BURN = 300;
/** The health of the `s278` body: a burn of `ceil(ticks / 20)` hp or less left is not lethal to it. */
const S278_HEALTH = 14.18;
/** The fake's burn lit for longer than any test here runs: the body burns throughout, until a test puts it out. */
const BURNS_THROUGHOUT_TICKS = 100_000;

/** A burning body on dry footing at world age 1000, the age the contacts of a test are recorded at; `burning(false)` puts the fire out, `burning(true)` lights it again. */
function burningBody() {
  const harness = createFakeBot({ server: { startAge: 1000 } });
  const burning = (on: boolean) => (on ? harness.combat.burn.igniteFor(BURNS_THROUGHOUT_TICKS) : harness.combat.burn.extinguish());
  burning(true);
  return { ...harness, burning };
}

test("the burn estimate follows the latest contact, caps clock jumps, and clears on death", async () => {
  const { bot, clock, server, burning } = burningBody();
  burning(false);
  assert.deepEqual(burnLeft(bot), { ticks: 0, hp: 0 });
  burning(true);
  recordFireContact(bot, "lava", 1000);
  await clock.advance(5_000);
  assert.deepEqual(burnLeft(bot), { ticks: 200, hp: 10 });
  await clock.advance(500);
  server.resendTime();
  assert.deepEqual(burnLeft(bot), { ticks: 190, hp: 10 });
  recordFireContact(bot, "fire", 1105);
  assert.deepEqual(burnLeft(bot), { ticks: 190, hp: 10 }, "a fire contact never shortens what lava still owes");
  recordFireContact(bot, "lava", 2000);
  assert.deepEqual(burnLeft(bot), { ticks: LAVA_BURN, hp: 15 });
  bot.emit("death");
  assert.deepEqual(burnLeft(bot), { ticks: 0, hp: 0 });
});

test("a fire block contact owes its own burn, not lava's: lethal only at or under ceil(burn / 20) hp", () => {
  const { bot } = burningBody();
  recordFireContact(bot, "fire", 1000);
  assert.deepEqual(burnLeft(bot), { ticks: FIRE_BURN, hp: 9 });
  bot.health = S278_HEALTH;
  assert.equal(readFireDanger(bot).lethalBurn, false, "14.18 hp outlives the 9 hp of a fire block's burn (a lava burn's 15 hp would be lethal)");
  bot.health = 9;
  assert.equal(readFireDanger(bot).lethalBurn, true, "9 hp is the burn left");
  bot.health = 9.01;
  assert.equal(readFireDanger(bot).lethalBurn, false, "one step above it");
});

test("a fire block contact read 20 ticks later on dry footing owes 20 ticks less, and a lava contact stays lethal at the same health", async () => {
  const fire = burningBody();
  recordFireContact(fire.bot, "fire", 1000);
  await fire.clock.advance(1_000);
  assert.equal(fire.bot.time.age, 1020);
  assert.deepEqual(burnLeft(fire.bot), { ticks: FIRE_BURN - 20, hp: 8 });
  fire.bot.health = S278_HEALTH;
  assert.equal(readFireDanger(fire.bot).lethalBurn, false);

  const lava = burningBody();
  recordFireContact(lava.bot, "lava", 1000);
  lava.bot.health = S278_HEALTH;
  assert.equal(readFireDanger(lava.bot).lethalBurn, true, "300 ticks are 15 hp: 14.18 hp does not outlive them");
  await lava.clock.advance(1_000);
  assert.deepEqual(burnLeft(lava.bot), { ticks: LAVA_BURN - 20, hp: 14 });
});

test("lava then fire 40 ticks later keeps lava's end; fire then lava takes lava's end", async () => {
  const lavaFirst = burningBody();
  recordFireContact(lavaFirst.bot, "lava", 1000);
  await lavaFirst.clock.advance(2_000);
  recordFireContact(lavaFirst.bot, "fire", 1040);
  assert.deepEqual(burnLeft(lavaFirst.bot), { ticks: LAVA_BURN - 40, hp: 13 }, "lava's end at 1300, kept");
  recordFireContact(lavaFirst.bot, "fire", 990);
  assert.deepEqual(burnLeft(lavaFirst.bot), { ticks: LAVA_BURN - 40, hp: 13 }, "an older fire contact (the ages arrive out of order) adds nothing either");

  const fireFirst = burningBody();
  recordFireContact(fireFirst.bot, "fire", 1000);
  await fireFirst.clock.advance(2_000);
  recordFireContact(fireFirst.bot, "lava", 1040);
  assert.deepEqual(burnLeft(fireFirst.bot), { ticks: LAVA_BURN, hp: 15 }, "lava's end at 1340, read at 1040");
  await fireFirst.clock.advance(1_000);
  assert.deepEqual(burnLeft(fireFirst.bot), { ticks: LAVA_BURN - 20, hp: 14 });
});

test("a read that finds the body not burning ends the episode: a later fire contact owes only the fire block's burn", async () => {
  const { bot, clock, burning } = burningBody();
  recordFireContact(bot, "lava", 1000);
  await clock.advance(1_000);
  burning(false);
  assert.deepEqual(burnLeft(bot), { ticks: 0, hp: 0 }, "extinguished: nothing is owed");
  burning(true);
  recordFireContact(bot, "fire", 1020);
  assert.deepEqual(burnLeft(bot), { ticks: FIRE_BURN, hp: 9 }, "lava's old end does not leak into the new ignition");
});

test("a contact is not cleared by a read at its own world age, before the burning flag has reached the client", () => {
  const { bot, burning } = burningBody();
  burning(false);
  recordFireContact(bot, "lava", 1000);
  assert.deepEqual(burnLeft(bot), { ticks: LAVA_BURN, hp: 15 }, "the flag is one packet behind the contact");
});

test("a world age behind the contact's (the clock went back) never gives more than the contact's own burn", () => {
  const { bot, burning } = burningBody();
  recordFireContact(bot, "fire", 1500);
  assert.deepEqual(burnLeft(bot), { ticks: FIRE_BURN, hp: 9 }, "age 1000 is 500 ticks before the fire contact");
  recordFireContact(bot, "lava", 2000);
  assert.deepEqual(burnLeft(bot), { ticks: LAVA_BURN, hp: 15 });
  burning(false);
  assert.deepEqual(burnLeft(bot), { ticks: LAVA_BURN, hp: 15 }, "not burning, but the contact is in the future of this age: the episode stays");
});

test("an episode lasts to the end of its burn: one tick before it 1 tick is owed, at it and after it nothing", async () => {
  const { bot, clock } = burningBody();
  // The world age moves in jumps of 20: contacts at 1004 and 1003 end at 1181 and 1180, read at 1180.
  recordFireContact(bot, "fire", 1004);
  await clock.advance(9_000);
  assert.equal(bot.time.age, 1180);
  assert.deepEqual(burnLeft(bot), { ticks: 1, hp: 1 }, "the end is at 1181");
  await clock.advance(1_000);
  assert.deepEqual(burnLeft(bot), { ticks: 0, hp: 0 }, "age 1200 is past the end");
  const next = burningBody();
  recordFireContact(next.bot, "fire", 1003);
  await next.clock.advance(9_000);
  assert.deepEqual(burnLeft(next.bot), { ticks: 0, hp: 0 }, "the end is at 1180: nothing owed at it");
});

test("a contact of a kind outside the type (a caller that forgot the kinds) keeps today's 300 ticks", () => {
  const { bot } = burningBody();
  recordFireContact(bot, "magma" as never, 1000);
  assert.deepEqual(burnLeft(bot), { ticks: LAVA_BURN, hp: 15 });
});

test("burning episodes of one life add one death listener, and a death still clears the episode that follows", async () => {
  const { bot, clock, burning } = burningBody();
  const added = listenersAddedSince(bot);
  const EPISODES = 12; // one more than Node's warning limit of 10 listeners per event
  for (let episode = 0; episode < EPISODES; episode++) {
    burning(true);
    recordFireContact(bot, "fire", bot.time.age);
    await clock.advance(1_000);
    burning(false);
    assert.deepEqual(burnLeft(bot), { ticks: 0, hp: 0 }, `episode ${episode} ends at the first read of a body that no longer burns`);
  }
  assert.equal(added("death"), 1, "one listener for the life, not one per episode");
  burning(true);
  recordFireContact(bot, "lava", bot.time.age);
  bot.emit("death");
  assert.deepEqual(burnLeft(bot), { ticks: 0, hp: 0 });
  // The same bot object lives the next life (Mineflayer emits `death` on it each time): the listener is armed again.
  burning(true);
  recordFireContact(bot, "lava", bot.time.age);
  assert.ok(burnLeft(bot).ticks > 0, "the second life burns");
  bot.emit("death");
  assert.deepEqual(burnLeft(bot), { ticks: 0, hp: 0 }, "the second death clears the episode too");
});
