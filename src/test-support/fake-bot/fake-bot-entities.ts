/**
 * The fake server's entities after the start: what it spawns and removes on a made harness, and the pickup of item
 * entities by the bot. Contract checks `item-pickup-after-delay` and `tossed-item-kept-before-delay` (Mine Labs
 * 2026-10-23, 1.21.4) measured the server's pickup; the client side is Mineflayer's `collect` handler
 * (`entities.js:159-172`) and `entity_destroy` handler (`entities.js:310-320`).
 */
import { createRequire } from "node:module";
import type minecraftData from "minecraft-data";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import type { FakeBot, FakeEntitySpec } from "./fake-bot.js";
import type { FakeClock } from "./fake-clock.js";
import type { FakeEntities } from "./fake-bot-items.js";
import { EQUIPMENT_SLOTS, type FakeInventory, itemOf } from "./fake-inventory.js";
import type { FakeServer } from "./fake-server.js";

type Registry = ReturnType<typeof minecraftData>;
type ItemClass = typeof Item & { toNotch(item: Item | null): unknown };
const require = createRequire(import.meta.url);

const MS_PER_TICK = 50;
/** The delay of a block's drop (`ItemEntity.setDefaultPickUpDelay`): unmeasured, only the delay a spec gives is. */
const DEFAULT_PICKUP_DELAY_TICKS = 10;
/** An item in reach touches the bot's box grown by this much sideways and up and down (measured: 1.3 blocks in, 1.55 out). */
const REACH_SIDEWAYS = 1;
const REACH_VERTICAL = 0.5;
/** Hotbar before main: the slots a pickup fills (the order of `Inventory.add`). */
const HOTBAR_START = 36;
const MAIN_START = 9;
const PICKUP_SLOT_ORDER = [...Array.from({ length: 9 }, (_, index) => HOTBAR_START + index), ...Array.from({ length: HOTBAR_START - MAIN_START }, (_, index) => MAIN_START + index)];

export interface ServerEntitySpec extends FakeEntitySpec {
  /** An item entity's stack. */
  readonly item?: { readonly name: string; readonly count: number };
  /** The entity's id; a new one above any a test names otherwise. */
  readonly id?: number;
  /** Ticks before the bot can pick an item entity up; a toss is 40. */
  readonly pickupDelayTicks?: number;
}

export interface ServerEntities {
  /** The server spawns an entity: it is on the bot and announced with `entitySpawn`. */
  spawn(spec: ServerEntitySpec): Entity;
  /** The server removes an entity: `entityGone`, then gone from the bot. Throws for an id the bot does not know. */
  remove(id: number): void;
  /** The server merged drops into this item entity: its stack is `count` now and the client gets it as metadata (`entityUpdate`, `itemDrop`). */
  restack(id: number, count: number): void;
  /** What the server holds of an item entity's stack, which a partial pickup lowers without telling the client; null when it is gone. */
  countOnServer(id: number): number | null;
}

/** An item entity waiting to be picked up, as the server knows it. */
interface LyingItem {
  readonly entity: Entity;
  readonly name: string;
  count: number;
  readonly pickableAtMs: number;
  /** A pickup decided and still on its way to the client (a lagging server). */
  inFlight: boolean;
}

interface EntityParts {
  readonly clock: FakeClock;
  readonly server: FakeServer;
  readonly inventory: FakeInventory;
  readonly entities: FakeEntities;
}

/** Whether `item` touches the bot's box grown for a pickup. */
function inReach(bot: FakeBot, item: Entity): boolean {
  const body = bot.entity;
  const sideways = body.width / 2 + REACH_SIDEWAYS + item.width / 2;
  const touchesSideways = Math.abs(item.position.x - body.position.x) < sideways && Math.abs(item.position.z - body.position.z) < sideways;
  const touchesVertically = item.position.y < body.position.y + body.height + REACH_VERTICAL && item.position.y + item.height > body.position.y - REACH_VERTICAL;
  return touchesSideways && touchesVertically;
}

/** `Player.aiStep` touches entities only for a living player who is not a spectator. */
function canPickUp(bot: FakeBot): boolean {
  return bot.health > 0 && bot.game.gameMode !== "spectator";
}

/** The slots a pickup tops up, in the order `Inventory.add` tries them (`getSlotWithRemainingSpace`): the selected slot, the off hand, then 0 to 35. */
function stackSlotOrder(inventory: FakeInventory): number[] {
  return [...new Set([HOTBAR_START + inventory.quickBarSlot, EQUIPMENT_SLOTS["off-hand"], ...PICKUP_SLOT_ORDER])];
}

/** How much of `name` the slots a pickup fills can take: room in its stacks (off hand too), then the empty slots (`getFreeSlot`: never the off hand). */
function roomFor(inventory: FakeInventory, registry: Registry, name: string): number {
  const stackSize = itemOf(registry, name).stackSize;
  const stacks = stackSlotOrder(inventory).reduce((room, slot) => {
    const held = inventory.slots[slot];
    return held != null && held.name === name ? room + stackSize - held.count : room;
  }, 0);
  return stacks + PICKUP_SLOT_ORDER.filter((slot) => inventory.slots[slot] == null).length * stackSize;
}

/** `Inventory.add`: fill the partial stacks of `name`, then the empty slots, up to `count`; returns how many went in. */
function addToInventory(inventory: FakeInventory, registry: Registry, name: string, count: number): number {
  const stackSize = itemOf(registry, name).stackSize;
  let left = count;
  for (const slots of [stackSlotOrder(inventory), PICKUP_SLOT_ORDER]) {
    for (const slot of slots) {
      const held = inventory.slots[slot];
      const fits = slots === PICKUP_SLOT_ORDER ? held == null : held != null && held.name === name && held.count < stackSize;
      if (!fits || left === 0) continue;
      const total = Math.min(stackSize, (held?.count ?? 0) + left);
      left -= total - (held?.count ?? 0);
      inventory.updateSlot(slot, itemOf(registry, name, total));
    }
  }
  return count - left;
}

/** Give the server its spawn, removal and the pickup of item entities; returns the controls of the harness. */
export function attachFakeEntities(bot: FakeBot, parts: EntityParts): ServerEntities {
  const { clock, server, inventory, entities } = parts;
  const lying = new Map<number, LyingItem>();
  const Items = require("prismarine-item")(bot.registry) as ItemClass;
  const itemSlot = bot.registry.supportFeature("metadataIxOfItem") as number;

  const remove = (id: number) => {
    const entity = bot.entities[id];
    if (entity === undefined) throw new Error(`no entity ${id} on the bot to remove`);
    lying.delete(id);
    bot.emit("entityGone", entity);
    entity.isValid = false;
    delete bot.entities[id];
  };

  const spawn = (spec: ServerEntitySpec) => {
    const { id, name, position, item, pickupDelayTicks, ...extra } = spec;
    if (name === "item" && item === undefined) throw new Error("an item entity needs a stack");
    if (id !== undefined && bot.entities[id] !== undefined) throw new Error(`entity ${id} is already on the bot`);
    let newId = id ?? entities.nextId();
    while (id === undefined && bot.entities[newId] !== undefined) newId = entities.nextId();
    const entity = Object.assign(entities.make(name, new Vec3(position.x, position.y, position.z), newId), extra);
    if (item !== undefined) {
      entity.metadata[itemSlot] = Items.toNotch(itemOf(bot.registry, item.name, item.count));
      lying.set(entity.id, { entity, name: item.name, count: item.count, pickableAtMs: clock.now() + (pickupDelayTicks ?? DEFAULT_PICKUP_DELAY_TICKS) * MS_PER_TICK, inFlight: false });
    }
    bot.entities[entity.id] = entity;
    bot.emit("entitySpawn", entity);
    if (item !== undefined) announceItemMetadata(entity);
    return entity;
  };

  /** Mineflayer's `entity_metadata` handler for an item's stack (`entities.js:471-481`): `entityUpdate`, then `itemDrop`. */
  const announceItemMetadata = (entity: Entity) => {
    bot.emit("entityUpdate", entity);
    bot.emit("itemDrop", entity);
  };

  const restack = (id: number, count: number) => {
    const stack = lying.get(id);
    if (stack === undefined) throw new Error(`no item entity ${id} on the server to restack`);
    stack.count = count;
    stack.entity.metadata[itemSlot] = Items.toNotch(itemOf(bot.registry, stack.name, count));
    announceItemMetadata(stack.entity);
  };

  /** The server takes what fits of a lying item; the client hears `collect`, the slots and the removal only for all of it. */
  const pickUp = (lyingItem: LyingItem) => {
    lyingItem.inFlight = false;
    const { entity, name } = lyingItem;
    const room = roomFor(inventory, bot.registry, name);
    if (lying.get(entity.id) !== lyingItem || room === 0 || !canPickUp(bot)) return;
    const all = room >= lyingItem.count;
    if (all) collect(entity, lyingItem.count);
    lyingItem.count -= addToInventory(inventory, bot.registry, name, lyingItem.count);
    if (all) remove(entity.id);
  };

  /** Mineflayer's `collect` handler: `playerCollect`, then the dropped item's metadata lowered by the packet's count. */
  const collect = (entity: Entity, pickupItemCount: number) => {
    bot.emit("playerCollect", bot.entity, entity);
    const dropped = entity.getDroppedItem();
    if (dropped === null) return;
    dropped.count = Math.max(0, dropped.count - pickupItemCount);
    entity.metadata[itemSlot] = Items.toNotch(dropped.count > 0 ? dropped : null);
  };

  clock.onSlice("server", () => {
    if (!server.isRunning || !canPickUp(bot)) return;
    for (const lyingItem of [...lying.values()]) {
      const waiting = lyingItem.inFlight || clock.now() < lyingItem.pickableAtMs;
      if (waiting || !inReach(bot, lyingItem.entity) || roomFor(inventory, bot.registry, lyingItem.name) === 0) continue;
      lyingItem.inFlight = true;
      server.answer(() => pickUp(lyingItem));
    }
  });

  return { spawn, remove, restack, countOnServer: (id) => lying.get(id)?.count ?? null };
}
