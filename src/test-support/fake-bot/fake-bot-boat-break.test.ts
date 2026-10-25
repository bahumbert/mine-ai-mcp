/**
 * The fake bot's boat hit, mounted and left as the 1.21.4 server does it (contract checks `boat-broken-by-attack`,
 * `boat-shift-within-one-tick`, `boat-mount-refused`, Mine Labs 2026-10-23): a boat breaks on damage, drops its item,
 * frees its rider and tells her nothing; a shift read at a server tick; a mount refused with silence.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { writeShiftKey } from "../../navigation/mineflayer/sneak.js";
import { type FakeBotOptions, type FakeHarness, createFakeBot } from "./fake-bot.js";
import { createFakeClock } from "./fake-clock.js";

const BOAT_ID = 7;
const FEET = new Vec3(0.5, -60, 0.5);
const BOAT_SPOT = new Vec3(0.5, -60, 2.5);

function boatBeside(options: FakeBotOptions = {}, boatAt: Vec3 = BOAT_SPOT): FakeHarness {
  return createFakeBot({ position: FEET, entities: { [BOAT_ID]: { name: "oak_boat", position: boatAt } }, ...options });
}

/** Hit boat 7 every `gapMs` until the client no longer has it; the hits made (at most 40). */
async function hitUntilGone({ bot, clock }: FakeHarness, gapMs: number): Promise<number> {
  let hits = 0;
  while (bot.entities[BOAT_ID] !== undefined && hits < 40) {
    bot.attack(bot.entities[BOAT_ID]!);
    hits += 1;
    await clock.advance(gapMs);
  }
  return hits;
}

async function seat({ bot, clock }: FakeHarness): Promise<void> {
  bot.mount(bot.entities[BOAT_ID]!);
  await clock.advance(100);
}

const itemEntities = ({ bot }: FakeHarness) => Object.values(bot.entities).filter((entity) => entity.name === "item");

test("attack writes the use_entity attack Mineflayer writes for a 1.21.4 server", async () => {
  const harness = boatBeside();
  harness.bot.attack(harness.bot.entities[BOAT_ID]!);
  assert.deepEqual(harness.server.packets.map(({ name, data }) => ({ name, data })), [
    { name: "use_entity", data: { target: BOAT_ID, mouse: 1, sneaking: false, location: new Vec3(0, 0, 0) } },
    // `entities.js:870`: the swing follows the attack on a 1.21.4 server.
    { name: "arm_animation", data: { hand: 0 } },
  ]);
});

test("a boat breaks on the hit that takes its damage past 40: 10 a hit, 1 lost a tick (8 hits 250 ms apart, 9 at 300, 17 at 400)", async () => {
  for (const [gapMs, expected] of [[250, 8], [300, 9], [400, 17], [1_000, 40]] as const) {
    const harness = boatBeside();
    assert.equal(await hitUntilGone(harness, gapMs), expected, `hits ${gapMs} ms apart (40: the boat is still there, its damage drained faster than a hit added)`);
  }
});

test("the broken boat leaves the client as the server removes it, and its item lies where it stood", async () => {
  const harness = boatBeside();
  const gone: number[] = [];
  harness.bot.on("entityGone", (entity) => void gone.push(entity.id));
  await hitUntilGone(harness, 250);
  assert.deepEqual(gone, [BOAT_ID]);
  const [drop, ...others] = itemEntities(harness);
  assert.deepEqual(others, []);
  assert.deepEqual(drop!.position.toArray(), BOAT_SPOT.toArray());
  assert.deepEqual([drop!.getDroppedItem()!.name, drop!.getDroppedItem()!.count], ["oak_boat", 1]);
  assert.equal(harness.server.packets.filter(({ name }) => name === "use_entity").length, 8);
});

test("the item of a boat broken within reach is picked up after the 10 ticks the server measured, not before", async () => {
  const harness = boatBeside({}, new Vec3(0.5, -60, 1.5));
  await hitUntilGone(harness, 250);
  const boats = () => harness.inventory.items().filter((item) => item.name === "oak_boat").length;
  await harness.clock.advance(150);
  assert.equal(boats(), 0, "the delay is not over: 400 ms after the break");
  await harness.clock.advance(200);
  assert.equal(boats(), 1);
  assert.deepEqual(itemEntities(harness), []);
});

test("the item of a boat out of reach stays where the boat stood", async () => {
  const harness = boatBeside({}, new Vec3(0.5, -60, 3.5));
  harness.bot.entities[BOAT_ID]!.position.z = 3.5;
  await hitUntilGone(harness, 250);
  await harness.clock.advance(2_000);
  assert.equal(harness.inventory.items().length, 0);
  assert.equal(itemEntities(harness).length, 1);
});

test("a hit on a boat with no rider and on another entity changes nothing about a seat", async () => {
  const harness = boatBeside({ entities: { [BOAT_ID]: { name: "oak_boat", position: BOAT_SPOT }, 8: { name: "zombie", position: new Vec3(2.5, -60, 0.5) } } });
  harness.bot.attack(harness.bot.entities[8]!);
  await harness.clock.advance(500);
  assert.notEqual(harness.bot.entities[8], undefined, "only a boat takes damage from a hit");
  assert.equal(harness.server.riderOf(BOAT_ID), null);
});

test("a hit on a boat past the server's reach does nothing", async () => {
  const harness = boatBeside({}, new Vec3(0.5, -60, 7.5));
  harness.bot.entities[BOAT_ID]!.position.z = 7.5;
  assert.equal(await hitUntilGone(harness, 250), 40);
  assert.notEqual(harness.bot.entities[BOAT_ID], undefined);
});

test("a stopped server breaks nothing and prices the hits it queued at the resume tick, one swing between them (18.3 after 1.25 s of wall time); a lagging one breaks the boat a lag later", async () => {
  const stopped = boatBeside();
  stopped.server.stop();
  for (let hit = 0; hit < 5; hit += 1) {
    stopped.bot.attack(stopped.bot.entities[BOAT_ID]!);
    await stopped.clock.advance(250);
  }
  assert.notEqual(stopped.bot.entities[BOAT_ID], undefined, "a stopped server breaks nothing");
  stopped.server.resume();
  await stopped.clock.advance(50);
  assert.notEqual(stopped.bot.entities[BOAT_ID], undefined, "five hits read at the resume tick weigh 10 + 4 x 2.08 = 18.3, whatever wall time passed while stopped");
  const lagging = boatBeside({ lagMs: 200 });
  for (let hit = 0; hit < 8; hit += 1) {
    lagging.bot.attack(lagging.bot.entities[BOAT_ID]!);
    await lagging.clock.advance(hit < 7 ? 250 : 150);
  }
  assert.notEqual(lagging.bot.entities[BOAT_ID], undefined, "the eighth hit is still on its way");
  await lagging.clock.advance(100);
  assert.equal(lagging.bot.entities[BOAT_ID], undefined);
});

/** Whether the boat is gone after the server reads `hits` hits in one tick (the bot has stood about: the first is a full swing). */
async function brokenByHitsInOneTick(hits: number, options: FakeBotOptions = {}): Promise<boolean> {
  const harness = boatBeside(options);
  harness.server.stop();
  for (let hit = 0; hit < hits; hit += 1) harness.bot.attack(harness.bot.entities[BOAT_ID]!);
  harness.server.resume();
  await harness.clock.advance(100);
  return harness.bot.entities[BOAT_ID] === undefined;
}

test("hits read in one tick share one swing counter: the first weighs 10, each next 2.08, so 15 do not break the boat and 16 do", async () => {
  assert.equal(await brokenByHitsInOneTick(15), false);
  assert.equal(await brokenByHitsInOneTick(16), true);
});

const ZOMBIE_ID = 8;
const STACKS = { 36: { name: "oak_boat" }, 37: { name: "stick" } };

/** A boat 2 blocks ahead and a zombie 2 blocks to the side; a boat stack in the hand, a stick beside it. */
const boatAndZombie = (): FakeHarness => boatBeside({ slots: STACKS, entities: { [BOAT_ID]: { name: "oak_boat", position: BOAT_SPOT }, [ZOMBIE_ID]: { name: "zombie", position: new Vec3(2.5, -60, 0.5) } } });
const zombieHealth = ({ bot }: FakeHarness) => Number(bot.entities[ZOMBIE_ID]!.metadata[bot.registry.entitiesByName.zombie!.metadataKeys!.indexOf("health")]);

test("a boat hit starts the swing over: a mob hit in the same tick is weak (1 x 0.208 by hand, the boat stack in hand priced as the hand)", async () => {
  const harness = boatAndZombie();
  harness.server.stop();
  harness.bot.attack(harness.bot.entities[BOAT_ID]!);
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  harness.server.resume();
  await harness.clock.advance(100);
  assert.ok(Math.abs(zombieHealth(harness) - (20 - 0.208)) < 0.001, `the zombie has ${zombieHealth(harness)}`);
});

/** What starts the swing over, run on the stopped server before the boat hits. */
const SWING_STARTERS: Readonly<Record<string, (harness: FakeHarness) => void>> = {
  "a mob hit": ({ bot }) => bot.attack(bot.entities[ZOMBIE_ID]!),
  "a deflected fireball": ({ bot, combat }) => {
    bot.entity.yaw = -Math.PI / 2;
    bot.entity.pitch = 0;
    bot.attack(combat.launchFireball(new Vec3(2.5, -59.1, 0.5), new Vec3(-0.2, 0, 0)));
  },
  "a new item type in the hand": ({ bot }) => bot.setQuickBarSlot(1),
};

test("a mob hit, a deflected fireball and a new item type in the hand start the swing over: a boat hit in the same tick is weak, so 19 hits after it do not break the boat and 20 do", async () => {
  for (const [starter, start] of Object.entries(SWING_STARTERS)) {
    for (const [hits, broken] of [[19, false], [20, true]] as const) {
      const harness = boatAndZombie();
      harness.server.stop();
      start(harness);
      for (let hit = 0; hit < hits; hit += 1) harness.bot.attack(harness.bot.entities[BOAT_ID]!);
      harness.server.resume();
      await harness.clock.advance(100);
      assert.equal(harness.bot.entities[BOAT_ID] === undefined, broken, `${hits} boat hits after ${starter} (2.08 each: 39.5, then 41.6)`);
    }
  }
});

test("a hit on a boat with a weapon or tool in hand throws: its scaling is unmeasured", async () => {
  for (const tool of ["iron_sword", "trident"]) {
    const harness = boatBeside({ slots: { 36: { name: tool } } });
    harness.bot.attack(harness.bot.entities[BOAT_ID]!);
    await assert.rejects(harness.clock.advance(100), new RegExp(`boat hit with ${tool}: not modelled, unmeasured`, "u"));
  }
});

test("two harnesses on one clock break their own boats and drop their own items", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const first = boatBeside({ clock });
  const second = boatBeside({ clock });
  for (let hit = 0; hit < 8; hit += 1) {
    first.bot.attack(first.bot.entities[BOAT_ID]!);
    await clock.advance(250);
  }
  assert.equal(first.bot.entities[BOAT_ID], undefined);
  assert.notEqual(second.bot.entities[BOAT_ID], undefined);
  assert.equal(itemEntities(second).length, 0);
});

test("a stopped server reads the press and the release in one tick when it resumes: the seat is kept", async () => {
  const harness = boatBeside();
  const { bot, clock, server } = harness;
  await seat(harness);
  server.stop();
  writeShiftKey(bot, true);
  await clock.advance(400);
  writeShiftKey(bot, false);
  await clock.advance(400);
  server.resume();
  await clock.advance(500);
  assert.equal(server.riderOf(BOAT_ID), bot.entity.id, "run 14b: a server behind by seconds keeps her riding");
});

test("a boat with one passenger takes her as the second rider and the client has both on the boat", async () => {
  const harness = boatBeside({ entities: { [BOAT_ID]: { name: "oak_boat", position: BOAT_SPOT, passengers: ["armor_stand"] } } });
  const { bot, server } = harness;
  const passenger = bot.entities[BOAT_ID]!.passengers[0]!;
  assert.equal(passenger.name, "armor_stand");
  assert.deepEqual(server.ridersOf(BOAT_ID), [passenger.id]);
  await seat(harness);
  assert.deepEqual(server.ridersOf(BOAT_ID), [passenger.id, bot.entity.id]);
  assert.deepEqual(bot.entities[BOAT_ID]!.passengers.map((rider) => rider.id), [passenger.id, bot.entity.id]);
  writeShiftKey(bot, true);
  await harness.clock.advance(200);
  assert.deepEqual(server.ridersOf(BOAT_ID), [passenger.id], "the shift frees her and only her");
});

test("a seat the server keeps after her client forgot the boat: the boat is hit from the seat, not from where her client walked, and a held shift frees her", async () => {
  const harness = boatBeside({}, new Vec3(0.5, -60, 1.5));
  const { bot, clock, server } = harness;
  await seat(harness);
  bot.vehicle = null;
  bot.entity.position = new Vec3(0.5, -60, 70.5);
  const boat = bot.entities[BOAT_ID]!;
  bot.attack(boat);
  writeShiftKey(bot, true);
  await clock.advance(150);
  assert.deepEqual(server.ridersOf(BOAT_ID), [], "the server let her off the boat her client no longer knew");
  assert.equal(server.sentPositions.length, 1);
  writeShiftKey(bot, false);
  // The first hit counted (10 damage, 3 ticks drained); the next comes 3 ticks after it and weighs 5.92 (strength 0.7), then 250 ms apart: 7 more hits break it (8 in all).
  assert.equal(await hitUntilGone(harness, 250), 7, "the hit before the get-off counted: the boat was in reach of the seat");
});
