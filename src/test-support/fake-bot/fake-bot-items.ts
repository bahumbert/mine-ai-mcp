/**
 * The fake bot's hands: the held stack, equip, toss (the count lowered at once, the drop one server answer later,
 * `inventory.js:643-650`) and the use released (`deactivateItem`); the block placement is in `fake-bot-placement.ts`.
 */
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { FakeBot } from "./fake-bot.js";
import type { ServerEntities } from "./fake-bot-entities.js";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { EQUIPMENT_SLOTS, type FakeInventory, type TossedStack } from "./fake-inventory.js";
import type { FakeServer } from "./fake-server.js";
import { DEFAULT_MOB_HEALTH, NOT_HURTABLE_TYPES } from "./fake-bot-combat-rules.js";
import type { FakeWorld } from "./fake-world.js";

/** Mineflayer's one sequence of prediction acknowledgements per connection (`interaction_sequence.js`). */
const { nextInteractionSequence } = createRequire(import.meta.url)("mineflayer/lib/interaction_sequence") as { nextInteractionSequence(bot: Bot): number | undefined };
/** `block_dig` status 5: the held item's use released (`inventory.js` `deactivateItem`). */
const RELEASE_USE_ITEM = 5;

/** Where a tossed stack appears: the player's toss starts at the eye, 0.3 below it. */
const DROP_HEIGHT = 1.32;
/** The pickup delay of a tossed stack, measured by contract check `tossed-item-kept-before-delay`. */
const TOSS_PICKUP_DELAY_TICKS = 40;

export interface FakeEntities {
  /** A new entity id the bot has not seen. */
  nextId(): number;
  /** A Prismarine entity of `name` at `position`, its size from the version's data; not added to the bot. */
  make(name: string, position: Vec3, id?: number): Entity;
}

/** Give `bot` its hand, `equip`, `toss` and `tossStack`. */
export function attachFakeItems(
  bot: FakeBot,
  parts: { server: FakeServer; world: FakeWorld; inventory: FakeInventory; spawn: ServerEntities["spawn"] },
): void {
  const { inventory, server } = parts;
  Object.defineProperties(bot, {
    heldItem: { get: () => inventory.heldItem, configurable: true },
    quickBarSlot: { get: () => inventory.quickBarSlot, configurable: true },
  });
  inventory.onHeldItemChanged((item) => bot.emit("heldItemChanged", item as Item));
  inventory.onQuickBarSlotChanged((slot) => bot._client.write("held_item_slot", { slotId: slot }));
  bot.setQuickBarSlot = (slot) => inventory.setQuickBarSlot(slot);
  bot.getEquipmentDestSlot = (destination) =>
    destination === "hand" ? 36 + inventory.quickBarSlot : EQUIPMENT_SLOTS[destination as keyof typeof EQUIPMENT_SLOTS];
  bot.equip = async (item, destination) => inventory.equip(item, destination ?? "hand");
  const dropAll = (stacks: TossedStack[]) => {
    const tossedFrom = bot.entity.position.offset(0, DROP_HEIGHT, 0);
    for (const stack of stacks) server.answer(() => spawnDrop(bot, parts.spawn, stack, tossedFrom));
  };
  bot.toss = async (itemType, _metadata, count) => dropAll(inventory.toss(itemType, count));
  bot.tossStack = async (item) => {
    if (!item) throw new Error("tossStack needs a stack");
    dropAll(inventory.tossStack(item));
  };
  bot.deactivateItem = () => releaseUseItem(bot);
}

/** `deactivateItem` as `inventory.js:157-172` has it: the release told to the server, then `usingHeldItem` cleared. */
function releaseUseItem(bot: FakeBot): void {
  const ownPacket = bot.supportFeature("useItemWithOwnPacket");
  const body = { status: RELEASE_USE_ITEM, location: new Vec3(0, 0, 0), face: ownPacket ? 0 : 5, ...(ownPacket && { sequence: nextInteractionSequence(bot) }) };
  bot._client.write("block_dig", body);
  bot.usingHeldItem = false;
}

/** The tossed stack as an item entity where the bot tossed it, kept for the 40 ticks the server gives a toss (`tossed-item-kept-before-delay`). */
function spawnDrop(bot: FakeBot, spawn: ServerEntities["spawn"], stack: TossedStack, tossedFrom: Vec3): void {
  spawn({
    name: "item",
    position: tossedFrom,
    item: { name: bot.registry.items[stack.type]!.name, count: stack.count },
    pickupDelayTicks: TOSS_PICKUP_DELAY_TICKS,
  });
}

/** The fake bot's entity factory, on Prismarine's own `Entity` class. */
export function createFakeEntities(registry: Bot["registry"], EntityClass: new (id: number) => Entity, firstId: number): FakeEntities {
  let next = firstId;
  return {
    nextId: () => next++,
    make(name, position, id = next++) {
      const entity = new EntityClass(id);
      const known = registry.entitiesByName[name];
      Object.assign(entity, {
        name,
        type: known?.type ?? "other",
        // Mineflayer files every entity under its category, "unknown" when the type has no data (`entities.js:184,193`).
        kind: known?.category ?? "unknown",
        displayName: known?.displayName ?? name,
        height: known?.height ?? 0,
        width: known?.width ?? 0,
        position: position.clone(),
      });
      const healthKey = known?.metadataKeys?.indexOf("health") ?? -1;
      if (healthKey >= 0 && !NOT_HURTABLE_TYPES.has(entity.type)) Reflect.set(entity.metadata, healthKey, DEFAULT_MOB_HEALTH);
      return entity;
    },
  };
}

