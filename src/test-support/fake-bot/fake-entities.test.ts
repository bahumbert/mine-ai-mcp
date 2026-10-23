import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeBotOptions, createFakeBot } from "./fake-bot.js";

/** Thirty-five different items of one each: with a cobblestone stack they fill the 36 slots a pickup can use. */
const FILLER = [
  "dirt", "sand", "gravel", "stick", "coal", "iron_ingot", "gold_ingot", "diamond", "emerald", "redstone", "glass", "clay_ball",
  "brick", "paper", "book", "string", "feather", "flint", "bone", "leather", "apple", "bread", "carrot", "potato", "wheat",
  "sugar", "egg", "snowball", "arrow", "torch", "ladder", "oak_planks", "oak_log", "stone", "granite",
];
const ALL_BUT = (room: number) => ({ cobblestone: 64 - room, ...Object.fromEntries(FILLER.map((name) => [name, 1])) });
const AT_FEET = new Vec3(0.5, 64, 1.5);

/** What the client hears of a pickup, by event name, in order. */
function hearing(harness: ReturnType<typeof createFakeBot>) {
  const heard: string[] = [];
  harness.bot.on("playerCollect", () => void heard.push("playerCollect"));
  harness.bot.inventory.on("updateSlot", () => void heard.push("updateSlot"));
  harness.bot.on("entityGone", () => void heard.push("entityGone"));
  return heard;
}

function cobblestone(harness: ReturnType<typeof createFakeBot>): number {
  return harness.bot.inventory.count(harness.bot.registry.itemsByName.cobblestone!.id, null);
}

function pickupHarness(options: FakeBotOptions = {}) {
  return createFakeBot({ carried: { cobblestone: 10 }, ...options });
}

// Mineflayer's entity_metadata handler (`entities.js:471-481`): an item's metadata packet emits entityUpdate, then itemDrop.
test("an entity the server spawns is on the bot, announced as the server's packets are, an item reads as a dropped item, an id named is kept", () => {
  const harness = pickupHarness();
  const events: string[] = [];
  for (const event of ["entitySpawn", "entityUpdate", "itemDrop"] as const) harness.bot.on(event, () => void events.push(event));
  const drop = harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "cobblestone", count: 3 } });
  assert.equal(harness.bot.entities[drop.id], drop);
  assert.deepEqual(events, ["entitySpawn", "entityUpdate", "itemDrop"]);
  assert.deepEqual([drop.name, drop.getDroppedItem()?.name, drop.getDroppedItem()?.count], ["item", "cobblestone", 3]);
  assert.ok(drop.id >= 1_000, "an id above the ones a test names");
  const zombie = harness.entities.spawn({ name: "zombie", position: AT_FEET });
  assert.equal(zombie.kind, "Hostile mobs");
  assert.deepEqual(events.slice(3), ["entitySpawn"], "no item metadata for a zombie");

  const named = harness.entities.spawn({ id: 77, name: "item", position: AT_FEET, item: { name: "cobblestone", count: 1 } });
  assert.equal(harness.bot.entities[77], named);
  assert.throws(() => harness.entities.spawn({ id: 77, name: "item", position: AT_FEET, item: { name: "cobblestone", count: 1 } }), /entity 77 is already/);
});

test("an item entity without a stack is refused, and an item the registry lacks names itself", () => {
  const harness = pickupHarness();
  assert.throws(() => harness.entities.spawn({ name: "item", position: AT_FEET }), /item entity needs a stack/);
  assert.throws(() => harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "no_such_item", count: 1 } }), /unknown item no_such_item/);
});

test("removing an entity tells the client with entityGone, marks it invalid, and an unknown id throws", () => {
  const harness = pickupHarness();
  const gone: number[] = [];
  harness.bot.on("entityGone", (entity) => void gone.push(entity.id));
  const drop = harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "cobblestone", count: 1 } });
  harness.entities.remove(drop.id);
  assert.deepEqual(gone, [drop.id]);
  assert.equal(harness.bot.entities[drop.id], undefined);
  assert.equal(drop.isValid, false);
  assert.throws(() => harness.entities.remove(drop.id), /no entity/);
});

// Contract check item-pickup-after-delay (Mine Labs 2026-10-23, 1.21.4): collect, set_slot and remove_entities in one tick.
test("an item in reach is picked up once its delay is over: playerCollect, the slot, entityGone, in one tick", async () => {
  const harness = pickupHarness();
  const heard = hearing(harness);
  const pairs: unknown[] = [];
  harness.bot.on("playerCollect", (collector, collected) => void pairs.push([collector.id, collected.id]));
  await harness.clock.advance(1_234); // the delay counts from the spawn, not from the clock's start
  const drop = harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "cobblestone", count: 3 }, pickupDelayTicks: 20 });
  await harness.clock.advance(950);
  assert.deepEqual(heard, [], "not before the delay");
  assert.equal(cobblestone(harness), 10);
  await harness.clock.advance(100);
  assert.deepEqual(heard, ["playerCollect", "updateSlot", "entityGone"]);
  assert.deepEqual(pairs, [[harness.bot.entity.id, drop.id]]);
  assert.equal(cobblestone(harness), 13);
  assert.equal(harness.bot.entities[drop.id], undefined);
  assert.equal(drop.getDroppedItem(), null, "Mineflayer's collect handler emptied the dropped item's metadata");
});

test("a pickup fills a partial stack first, then the first empty slot, hotbar before main", async () => {
  const harness = createFakeBot({ slots: { 36: { name: "cobblestone", count: 62 }, 9: { name: "dirt", count: 1 } } });
  harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "cobblestone", count: 5 }, pickupDelayTicks: 0 });
  await harness.clock.advance(200);
  assert.equal(harness.inventory.slots[36]!.count, 64);
  assert.equal(harness.inventory.slots[37]!.name, "cobblestone", "the rest goes to the first empty slot, in the hotbar");
  assert.equal(harness.inventory.slots[37]!.count, 3);
});

// Contract check item-pickup-after-delay: a pickup that fits in part sends the slot alone; the client's entity keeps its count.
test("a pickup that fits only in part fills the room, sends the slot alone, and the client is never told the new count", async () => {
  const harness = pickupHarness({ carried: ALL_BUT(2) });
  const heard = hearing(harness);
  const drop = harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "cobblestone", count: 8 }, pickupDelayTicks: 0 });
  await harness.clock.advance(500);
  assert.equal(cobblestone(harness), 64);
  assert.deepEqual(heard, ["updateSlot"]);
  assert.equal(harness.bot.entities[drop.id], drop);
  assert.equal(drop.getDroppedItem()?.count, 8, "the entity on the client keeps the count it was spawned with");
  assert.equal(harness.entities.countOnServer(drop.id), 6, "the server's own record is lowered");
});

test("a full inventory picks nothing up, and the item goes once the room is made", async () => {
  const harness = pickupHarness({ carried: ALL_BUT(0) });
  const heard = hearing(harness);
  const drop = harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "cobblestone", count: 2 }, pickupDelayTicks: 0 });
  await harness.clock.advance(1_000);
  assert.equal(heard.length, 0);
  assert.equal(harness.bot.entities[drop.id], drop);
  harness.inventory.updateSlot(harness.inventory.findInventoryItem(harness.bot.registry.itemsByName.dirt!.id, null, false)!.slot, null as never);
  await harness.clock.advance(100);
  assert.ok(heard.includes("entityGone"), "picked up as soon as a slot is free");
});

// Contract check item-pickup-after-delay: reach is the bot's box grown by 1 block sideways and 0.5 up and down.
test("an item out of reach stays, and is picked up once the bot comes within it", async () => {
  const harness = pickupHarness();
  const heard = hearing(harness);
  const drop = harness.entities.spawn({ name: "item", position: new Vec3(0.5 + 1.55, 64, 0.5), item: { name: "cobblestone", count: 1 }, pickupDelayTicks: 0 });
  const near = harness.entities.spawn({ name: "item", position: new Vec3(0.5 + 1.3, 64, 0.5), item: { name: "cobblestone", count: 1 }, pickupDelayTicks: 0 });
  await harness.clock.advance(500);
  assert.equal(harness.bot.entities[drop.id], drop);
  assert.equal(harness.bot.entities[near.id], undefined, "1.3 blocks away is within reach");
  assert.deepEqual(heard, ["playerCollect", "updateSlot", "entityGone"]);
  harness.bot.entity.position.set(2, 64, 0.5);
  await harness.clock.advance(100);
  assert.equal(harness.bot.entities[drop.id], undefined);

  // Above or below: the box grown by half a block (the bot's top is 65.8).
  const spawnAt = (y: number) => harness.entities.spawn({ name: "item", position: new Vec3(2, y, 0.5), item: { name: "cobblestone", count: 1 }, pickupDelayTicks: 0 });
  const [high, low, inside] = [spawnAt(64 + 2.4), spawnAt(64 - 0.8), spawnAt(64 + 2.2)];
  await harness.clock.advance(300);
  assert.deepEqual([harness.bot.entities[high!.id] === high, harness.bot.entities[low!.id] === low, harness.bot.entities[inside!.id]], [true, true, undefined]);
});

test("two items in reach are both picked up, each with its three events", async () => {
  const harness = pickupHarness();
  const heard = hearing(harness);
  harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "cobblestone", count: 1 }, pickupDelayTicks: 0 });
  harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "cobblestone", count: 2 }, pickupDelayTicks: 0 });
  await harness.clock.advance(300);
  assert.equal(cobblestone(harness), 13);
  assert.deepEqual(heard.filter((event) => event === "playerCollect").length, 2);
  assert.deepEqual(heard.filter((event) => event === "entityGone").length, 2);
});

test("an item removed while its delay runs is never picked up", async () => {
  const harness = pickupHarness();
  const heard = hearing(harness);
  const drop = harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "cobblestone", count: 3 }, pickupDelayTicks: 20 });
  await harness.clock.advance(500);
  harness.entities.remove(drop.id);
  await harness.clock.advance(2_000);
  assert.deepEqual(heard, ["entityGone"]);
  assert.equal(cobblestone(harness), 10);
});

test("a stopped server picks nothing up until it resumes", async () => {
  const harness = pickupHarness();
  const drop = harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "cobblestone", count: 3 }, pickupDelayTicks: 0 });
  harness.server.stop();
  await harness.clock.advance(2_000);
  assert.equal(harness.bot.entities[drop.id], drop);
  harness.server.resume();
  await harness.clock.advance(100);
  assert.equal(harness.bot.entities[drop.id], undefined);
  assert.equal(cobblestone(harness), 13);
});

test("with lagMs the pickup reaches the client lagMs after the server took the item", async () => {
  const harness = pickupHarness({ lagMs: 300 });
  const drop = harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "cobblestone", count: 3 }, pickupDelayTicks: 0 });
  await harness.clock.advance(250);
  assert.equal(harness.bot.entities[drop.id], drop, "the answer is still on its way");
  await harness.clock.advance(250);
  assert.equal(harness.bot.entities[drop.id], undefined);
  assert.equal(cobblestone(harness), 13, "taken once, never twice, while the answer was late");
});

// Contract check tossed-item-kept-before-delay: a toss is kept 40 ticks.
test("a tossed stack is not picked up for 40 ticks, then comes back; it lands where the bot tossed it, however late the server answers", async () => {
  const harness = pickupHarness({ lagMs: 100 });
  await harness.bot.toss(harness.bot.registry.itemsByName.cobblestone!.id, null, 4);
  harness.bot.entity.position.set(20.5, 64, 0.5);
  await harness.clock.advance(300);
  const drops = Object.values(harness.bot.entities).filter((entity) => entity.name === "item");
  assert.equal(drops.length, 4, "one entity per right click of a part of a stack");
  assert.ok(drops.every((drop) => Math.abs(drop.position.x - 0.5) < 0.01), `drops at ${drops.map((drop) => drop.position)}`);
  harness.bot.entity.position.set(0.5, 64, 0.5);
  await harness.clock.advance(1_600);
  assert.equal(cobblestone(harness), 6, "kept while the delay runs");
  await harness.clock.advance(300);
  assert.equal(cobblestone(harness), 10);
});

test("restack: the server merged drops into one, the client gets the new count as metadata and the entity is picked up whole", async () => {
  const harness = pickupHarness();
  const events: string[] = [];
  const drop = harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "cobblestone", count: 1 }, pickupDelayTicks: 5 });
  for (const event of ["entityUpdate", "itemDrop"] as const) harness.bot.on(event, () => void events.push(event));
  harness.entities.restack(drop.id, 4);
  assert.deepEqual(events, ["entityUpdate", "itemDrop"]);
  assert.equal(drop.getDroppedItem()?.count, 4);
  assert.equal(harness.entities.countOnServer(drop.id), 4);
  await harness.clock.advance(500);
  assert.equal(cobblestone(harness), 14);
  assert.throws(() => harness.entities.restack(drop.id, 2), /no item entity/);
});

// Review of T3b-C: `Inventory.add` tries the selected slot, then the off hand, then the slots in order.
test("a pickup tops up the stack in the off hand before an empty slot, the selected hotbar slot first", async () => {
  const harness = createFakeBot({ slots: { 45: { name: "cobblestone", count: 60 }, 37: { name: "cobblestone", count: 60 } } });
  harness.bot.setQuickBarSlot(1);
  harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "cobblestone", count: 6 }, pickupDelayTicks: 0 });
  await harness.clock.advance(300);
  assert.deepEqual([harness.inventory.slots[37]!.count, harness.inventory.slots[45]!.count, harness.inventory.slots[36]?.count], [64, 62, undefined]);
});

test("a dead bot and a spectator pick nothing up", async () => {
  for (const options of [{ health: 0 }, { gameMode: "spectator" }]) {
    const harness = pickupHarness(options);
    const drop = harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "cobblestone", count: 3 }, pickupDelayTicks: 0 });
    await harness.clock.advance(500);
    assert.equal(harness.bot.entities[drop.id], drop, JSON.stringify(options));
    assert.equal(cobblestone(harness), 10);
  }
});

test("a pickup on its way never takes another entity that got the removed one's id", async () => {
  const harness = pickupHarness({ lagMs: 300 });
  harness.entities.spawn({ id: 77, name: "item", position: AT_FEET, item: { name: "cobblestone", count: 3 }, pickupDelayTicks: 0 });
  await harness.clock.advance(100);
  harness.entities.remove(77);
  const far = harness.entities.spawn({ id: 77, name: "item", position: new Vec3(30.5, 64, 0.5), item: { name: "cobblestone", count: 3 }, pickupDelayTicks: 0 });
  await harness.clock.advance(600);
  assert.equal(harness.bot.entities[77], far);
  assert.equal(cobblestone(harness), 10);
});

test("an id a test named is never handed out again to a spawn that names none", () => {
  const harness = pickupHarness();
  const first = harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "cobblestone", count: 1 } });
  const named = harness.entities.spawn({ id: first.id + 1, name: "item", position: AT_FEET, item: { name: "cobblestone", count: 1 } });
  const second = harness.entities.spawn({ name: "item", position: AT_FEET, item: { name: "cobblestone", count: 1 } });
  assert.notEqual(second.id, named.id);
  assert.equal(harness.bot.entities[named.id], named);
});
