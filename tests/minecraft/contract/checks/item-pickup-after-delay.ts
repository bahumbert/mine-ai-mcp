/**
 * The server picks an item entity up once its pickup delay is over, it is in reach (the bot's box grown by 1 block
 * sideways and half a block up and down) and the inventory has room, and the client hears three things in one tick, in
 * this order: `collect` (`playerCollect`), the stack's `set_slot`, `remove_entities` (`entityGone`). A pickup that only
 * fits in part (Mine Labs 2026-10-23, 1.21.4) sends the slot alone: no `collect`, no `remove_entities`, no new count for
 * the entity, which stays on the client with the count it was spawned with. A full inventory picks nothing up.
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { holdsWithin, type ContractSubject } from "../subject.ts";

/** Thirty-five different items of one each, so they fill 35 of the 36 slots and the cobblestone stack has the last. */
const FILLER = [
  "dirt", "sand", "gravel", "stick", "coal", "iron_ingot", "gold_ingot", "diamond", "emerald", "redstone", "glass", "clay_ball",
  "brick", "paper", "book", "string", "feather", "flint", "bone", "leather", "apple", "bread", "carrot", "potato", "wheat",
  "sugar", "egg", "snowball", "arrow", "torch", "ladder", "oak_planks", "oak_log", "stone", "granite",
];
/** Cobblestone the last slot can still take: the three pickups below take 1, 3 and (of 8) the 1 left. */
const ROOM = 5;
const PICKUP_DELAY_TICKS = 20;
const MS_PER_TICK = 50;
/** Measured over 6 runs (Mine Labs 2026-10-23): 961-1011 ms from the client seeing the spawn to the collect for 20 ticks (1000 ms), the three events within 0.3 ms; the bounds leave 150 ms under and 250 ms over for a slower server. */
const PICKUP_BOUNDS_MS = { min: PICKUP_DELAY_TICKS * MS_PER_TICK - 150, max: PICKUP_DELAY_TICKS * MS_PER_TICK + 250 } as const;
/** Longest an item with no delay waits to be picked up (the server's next tick and the trip back). */
const NO_DELAY_PICKUP_MS = 600;
/** Long enough for any pickup that is going to happen (delay 20 ticks plus bounds). */
const QUIET_MS = 2_000;
/** The bot's half width, the pickup reach sideways (the box grown by 1 block) and an item's half width: a bit past 1.425 is out of reach. */
const INSIDE_REACH = 1.3;
const OUTSIDE_REACH = 1.55;
const FEET = new Vec3(0.5, -60, 0.5);

type Heard = { readonly kind: "playerCollect" | "updateSlot" | "entityGone"; readonly entityId?: number; readonly atMs: number };

/** What the client hears of cobblestone and of item entities, in order. */
function listen(subject: ContractSubject): { readonly heard: Heard[]; stop(): void } {
  const { bot } = subject;
  const cobblestone = bot.registry.itemsByName.cobblestone!.id;
  const heard: Heard[] = [];
  const onCollect = (_collector: Entity, collected: Entity) => void heard.push({ kind: "playerCollect", entityId: collected.id, atMs: subject.now() });
  const onSlot = (_slot: number, _old: unknown, next: { type: number } | null) => {
    if (next?.type === cobblestone) heard.push({ kind: "updateSlot", atMs: subject.now() });
  };
  const onGone = (entity: Entity) => void heard.push({ kind: "entityGone", entityId: entity.id, atMs: subject.now() });
  bot.on("playerCollect", onCollect);
  bot.inventory.on("updateSlot", onSlot);
  bot.on("entityGone", onGone);
  return {
    heard,
    stop() {
      bot.off("playerCollect", onCollect);
      bot.inventory.off("updateSlot", onSlot);
      bot.off("entityGone", onGone);
    },
  };
}

/** Summon cobblestone `count` at `position` and let `ms` pass; the entity and the clock reading when the client got it. */
async function summonAndWait(subject: ContractSubject, count: number, position: Vec3, delayTicks: number, ms: number): Promise<{ entity: Entity; spawnedAtMs: number }> {
  const entity = await subject.summonItem({ name: "cobblestone", count }, position, delayTicks);
  const spawnedAtMs = subject.now();
  await holdsWithin(subject, () => false, ms);
  return { entity, spawnedAtMs };
}

export const itemPickupAfterDelay: ContractCheck = {
  name: "item-pickup-after-delay",
  // Bare bot: our runtime must not walk to items lying near it while the check measures the server (review of T3b-C).
  withoutRuntime: true,
  fixture: { cells: {}, carried: { cobblestone: 64 - ROOM, ...Object.fromEntries(FILLER.map((name) => [name, 1])) }, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    const cobblestone = bot.registry.itemsByName.cobblestone!.id;
    const carried = () => bot.inventory.count(cobblestone, null);
    const { heard, stop } = listen(subject);
    try {
      const outside = await summonAndWait(subject, 1, FEET.offset(OUTSIDE_REACH, 0, 0), 0, QUIET_MS);
      assert.equal(bot.entities[outside.entity.id], outside.entity, `an item ${OUTSIDE_REACH} blocks away was picked up`);
      assert.equal(heard.length, 0, `heard ${JSON.stringify(heard)} for an item out of reach`);

      const inside = await summonAndWait(subject, 1, FEET.offset(INSIDE_REACH, 0, 0), 0, NO_DELAY_PICKUP_MS);
      assert.equal(carried(), 64 - ROOM + 1, `the item ${INSIDE_REACH} blocks away (delay 0) was not picked up within ${NO_DELAY_PICKUP_MS} ms`);
      assert.equal(bot.entities[inside.entity.id], undefined, "the picked-up item is still an entity on the client");
      heard.length = 0;

      const whole = await summonAndWait(subject, 3, FEET.offset(0, 0, 1), PICKUP_DELAY_TICKS, QUIET_MS);
      assert.deepEqual(heard.map(({ kind }) => kind), ["playerCollect", "updateSlot", "entityGone"], "what the client heard of a pickup that fits");
      assert.ok(heard.every(({ entityId }) => entityId === undefined || entityId === whole.entity.id));
      const afterMs = heard[0]!.atMs - whole.spawnedAtMs;
      assert.ok(afterMs >= PICKUP_BOUNDS_MS.min && afterMs <= PICKUP_BOUNDS_MS.max, `the pickup came ${afterMs} ms after the spawn, delay ${PICKUP_DELAY_TICKS} ticks: not within ${JSON.stringify(PICKUP_BOUNDS_MS)}`);
      assert.ok(heard[2]!.atMs - heard[0]!.atMs <= 100, "collect, slot and removal came in one tick");
      assert.equal(carried(), 64 - ROOM + 1 + 3);
      heard.length = 0;

      const partial = await summonAndWait(subject, 8, FEET.offset(0, 0, 1), PICKUP_DELAY_TICKS, QUIET_MS);
      assert.deepEqual(heard.map(({ kind }) => kind), ["updateSlot"], "what the client heard of a pickup that fits in part");
      assert.equal(carried(), 64, "the stack filled up");
      assert.equal(bot.entities[partial.entity.id], partial.entity, "the partly picked-up entity is gone on the client");
      assert.equal(partial.entity.getDroppedItem()?.count, 8, "the client was told a new count for the partly picked-up entity");
      heard.length = 0;

      const full = await summonAndWait(subject, 2, FEET.offset(0, 0, 0), 0, QUIET_MS);
      assert.deepEqual(heard, [], "something was picked up with a full inventory");
      assert.equal(bot.entities[full.entity.id], full.entity);
    } finally {
      stop();
    }
  },
};
