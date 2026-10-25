import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { MovementPolicy } from "../navigation/index.js";
import { createFakeBot, createFakeClock, itemOf } from "../test-support/fake-bot/index.js";
import { armSignal } from "../utils/index.js";
import {
  DROPPED_ITEM_OBSERVATION_EVENTS,
  droppedItemName,
  findNewItemEntity,
  isItemEntity,
  pickupObservedItem,
  snapshotEntityIds,
} from "./item-pickup.js";

const DROP = new Vec3(3, 64, 0);

/**
 * A bot carrying `filledSlots` full stacks, with one observed white wool drop
 * as entity 7. A route can fill the last slot the way tunnel spoil does, with
 * the server's slot update. The clock is a mocked one a test installs when the
 * pickup waits on a timer.
 */
function pickupBot(filledSlots: number) {
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    carried: { cobblestone: 64 * filledSlots },
    entities: { 7: { name: "item", position: DROP } },
  });
  const { bot } = harness;
  bot.entities[7]!.getDroppedItem = () => itemOf(bot.registry, "white_wool");
  return harness;
}

const OBSERVED_ITEM = { entityId: 7, movements: {} as MovementPolicy, hasArrived: () => false } as const;

/**
 * Both readings of a full inventory are the same fact for the caller: a
 * capacity refusal names the item, rather than blaming the route or arrival.
 */
const capacityCases = [
  { name: "an inventory already full before any route starts", carried: 36, fillsDuringRoute: false },
  { name: "a route whose spoil takes the last slot", carried: 35, fillsDuringRoute: true },
] as const;

for (const { name, carried, fillsDuringRoute } of capacityCases) {
  test(`${name} reports capacity rather than walking or blaming arrival`, async () => {
    const { bot, inventory } = pickupBot(carried);
    // The window's own listener (the held item's) stays; the pickup's settle listener is the one that must go.
    const listenersBefore = bot.inventory.listenerCount("updateSlot");

    const result = await pickupObservedItem(bot, {
      ...OBSERVED_ITEM,
      navigate: async () => {
        if (!fillsDuringRoute) throw new Error("No pickup route should start without capacity.");
        inventory.updateSlot(inventory.firstEmptySlotRange(9, 45)!, itemOf(bot.registry, "cobblestone", 64));
        return { status: "completed", elapsedMs: 1 };
      },
    });

    assert.equal(result.kind, "inventory_full");
    if (result.kind === "inventory_full") assert.match(result.reason, /INVENTORY_FULL.*white_wool/);
    assert.equal(bot.inventory.listenerCount("updateSlot"), listenersBefore, "the settle listener is released");
  });
}

test("an item disappearing during a stopped route is gone, not an unreachable pickup", async () => {
  const { bot, clock } = pickupBot(0);
  using _timers = clock.install();
  const listenersBefore = bot.inventory.listenerCount("updateSlot");

  const result = await clock.settle(pickupObservedItem(bot, {
      ...OBSERVED_ITEM,
      navigate: async () => {
        delete bot.entities[7];
        return { status: "stopped", reason: "Entity 7 is not currently observed.", elapsedMs: 0 };
      },
      settleMs: { itemGone: 50 },
    }), 50);

  assert.deepEqual(result, { kind: "item_gone" });
  assert.equal(bot.inventory.listenerCount("updateSlot"), listenersBefore);
});

test("keeps observing until dropped-item metadata can identify the entity", async () => {
  const { bot } = createFakeBot({ entities: { 2: { name: "item", position: DROP } } });
  const entity = bot.entities[2]!;
  let itemName: string | null = null;
  entity.getDroppedItem = () => {
    if (!itemName) throw new Error("metadata not ready");
    return itemOf(bot.registry, itemName);
  };
  const sighting = armSignal(
    bot,
    [...DROPPED_ITEM_OBSERVATION_EVENTS],
    () =>
      findNewItemEntity(bot, {
        baseline: new Set(),
        itemName: "dirt",
        source: new Vec3(2, 64, 0),
        maxDistance: 4,
      }),
    {},
  );

  bot.emit("entitySpawn", entity);
  itemName = "dirt";
  bot.emit("entityUpdate", entity);

  assert.deepEqual(await sighting.promise, { kind: "signalled", value: { id: 2, position: DROP } });
});

test("attributes only a new matching item near the source, and unread metadata is no evidence yet", () => {
  const wool = (x: number) => ({ name: "item", position: new Vec3(x, 64, 0) });
  // The bot's own entity is 1: the drops are 2 (seen before the act), 3 (new, matching) and 4 (new, unread).
  const { bot } = createFakeBot({ entities: { 2: wool(1), 3: wool(3), 4: { name: "item", position: DROP } } });
  const [seen, matching, pending] = [2, 3, 4].map((id) => bot.entities[id]!);
  for (const drop of [seen!, matching!]) drop.getDroppedItem = () => itemOf(bot.registry, "white_wool");
  pending!.getDroppedItem = () => {
    throw new Error("metadata not ready");
  };

  assert.equal(droppedItemName(seen!), "white_wool");
  assert.equal(droppedItemName(pending!), null, "metadata that has not arrived is not a name");

  // The two new drops spawn after the snapshot.
  delete bot.entities[3];
  delete bot.entities[4];
  const baseline = snapshotEntityIds(bot);
  bot.entities[3] = matching!;
  bot.entities[4] = pending!;

  assert.deepEqual(
    findNewItemEntity(bot, { baseline, itemName: "white_wool", source: new Vec3(2, 64, 0), maxDistance: 4 }),
    { id: 3, position: DROP },
  );
});

test("an item entity is one even before its stack metadata arrives; a mob is not", () => {
  const { bot } = createFakeBot({
    entities: {
      2: { name: "item", position: DROP },
      3: { name: "item", position: DROP },
      4: { name: "zombie", position: DROP },
      5: { name: "arrow", position: DROP },
      6: { name: "item", position: DROP },
    },
  });
  const unreadable = () => {
    throw new Error("metadata not arrived");
  };
  bot.entities[2]!.getDroppedItem = unreadable;
  bot.entities[3]!.getDroppedItem = () => itemOf(bot.registry, "dirt");
  assert.equal(isItemEntity(bot.entities[2]!), true);
  assert.equal(isItemEntity(bot.entities[3]!), true);
  assert.equal(isItemEntity(bot.entities[4]!), false);
  assert.equal(isItemEntity(bot.entities[5]!), false);
  // An entity the server has told nothing about yet has no name.
  assert.equal(isItemEntity(Object.assign(bot.entities[6]!, { name: undefined })), false);
});
