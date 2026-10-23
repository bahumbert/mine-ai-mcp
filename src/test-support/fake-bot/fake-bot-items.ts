/**
 * The fake bot's hands: the held stack, equip, toss (the count lowered at once, the drop one server answer later,
 * `inventory.js:643-650`), the use released (`deactivateItem`) and a block placement the server answers (`place_block.js`).
 */
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { FakeBot } from "./fake-bot.js";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import type { MineflayerBlock } from "../../navigation/mineflayer/world.js";
import { EQUIPMENT_SLOTS, type FakeInventory, type TossedStack, itemOf } from "./fake-inventory.js";
import type { FakeClock } from "./fake-clock.js";
import type { FakeServer } from "./fake-server.js";
import { type FakeWorld, blockUpdateEventOf } from "./fake-world.js";

/** Mineflayer's one sequence of prediction acknowledgements per connection (`interaction_sequence.js`). */
const { nextInteractionSequence } = createRequire(import.meta.url)("mineflayer/lib/interaction_sequence") as { nextInteractionSequence(bot: Bot): number | undefined };
/** `block_dig` status 5: the held item's use released (`inventory.js` `deactivateItem`). */
const RELEASE_USE_ITEM = 5;

/** Mineflayer's wait for a placement's block update, counted from the packet (`place_block.js`). */
const PLACEMENT_TIMEOUT_MS = 5_000;
/** Prismarine's face numbers (`vectorToDirection`): bottom, top, north, south, west, east. */
const FACE_VECTORS = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)];
/** `block_place`'s hand: 0 the main hand, 1 the off hand. */
const OFF_HAND = 1;
/** Where a tossed stack appears: the player's toss starts at the eye, 0.3 below it. */
const DROP_HEIGHT = 1.32;

export interface FakeEntities {
  /** A new entity id the bot has not seen. */
  nextId(): number;
  /** A Prismarine entity of `name` at `position`, its size from the version's data; not added to the bot. */
  make(name: string, position: Vec3, id?: number): Entity;
}

/** Give `bot` its hand, `equip`, `toss`, `tossStack` and `placeBlock`. */
export function attachFakeItems(bot: FakeBot, parts: { clock: FakeClock; server: FakeServer; world: FakeWorld; inventory: FakeInventory; entities: FakeEntities }): void {
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
    for (const stack of stacks) server.answer(() => spawnDrop(bot, parts.entities, stack));
  };
  bot.toss = async (itemType, _metadata, count) => dropAll(inventory.toss(itemType, count));
  bot.tossStack = async (item) => {
    if (!item) throw new Error("tossStack needs a stack");
    dropAll(inventory.tossStack(item));
  };
  bot.deactivateItem = () => releaseUseItem(bot);
  bot.placeBlock = (referenceBlock, faceVector) => placeHeldBlock(bot, parts, referenceBlock, faceVector);
  server.onPacket("block_place", (data) => {
    const { location, direction, hand } = data as { location: Vec3; direction: number; hand: number };
    const face = FACE_VECTORS[direction];
    if (face !== undefined) server.answer(() => answerPlacement(bot, parts, location.plus(face), hand));
  });
}

/** `deactivateItem` as `inventory.js:157-172` has it: the release told to the server, then `usingHeldItem` cleared. */
function releaseUseItem(bot: FakeBot): void {
  const ownPacket = bot.supportFeature("useItemWithOwnPacket");
  const body = { status: RELEASE_USE_ITEM, location: new Vec3(0, 0, 0), face: ownPacket ? 0 : 5, ...(ownPacket && { sequence: nextInteractionSequence(bot) }) };
  bot._client.write("block_dig", body);
  bot.usingHeldItem = false;
}

/** The tossed stack as an item entity beside the bot, announced with `entitySpawn`. */
function spawnDrop(bot: FakeBot, entities: FakeEntities, stack: TossedStack): void {
  const drop = entities.make("item", bot.entity.position.offset(0, DROP_HEIGHT, 0));
  const item = itemOf(bot.registry, bot.registry.items[stack.type]!.name, stack.count);
  drop.getDroppedItem = () => item;
  bot.entities[drop.id] = drop;
  bot.emit("entitySpawn", drop);
}

/** The server's side of a placement: the used hand's block put in an empty cell, one taken from it outside creative. */
function answerPlacement(bot: FakeBot, parts: { world: FakeWorld; inventory: FakeInventory }, location: Vec3, hand: number): void {
  const held = hand === OFF_HAND ? (parts.inventory.slots[EQUIPMENT_SLOTS["off-hand"]] ?? null) : parts.inventory.heldItem;
  const block = held === null ? undefined : bot.registry.blocksByName[held.name];
  const cell = parts.world.blockAt(location);
  if (block === undefined || cell === null || cell.shapes.length > 0) return;
  parts.world.setCell(location, block.name);
  if (bot.game.gameMode === "creative") return;
  parts.inventory.updateSlot(held!.slot, held!.count > 1 ? itemOf(bot.registry, held!.name, held!.count - 1) : (null as never));
}

/** `bot.placeBlock` as Mineflayer runs it: the look at the face, the packet, then the cell's update or 5 s of nothing. */
async function placeHeldBlock(
  bot: Bot,
  parts: { clock: FakeClock },
  referenceBlock: MineflayerBlock,
  faceVector: Vec3,
): Promise<void> {
  if (!bot.heldItem) throw new Error("must be holding an item to place");
  const destination = referenceBlock.position.plus(faceVector);
  const eventName = blockUpdateEventOf(destination);
  let cancelTimeout = () => undefined as void;
  let onUpdate: (before: MineflayerBlock | null, after: MineflayerBlock | null) => void = () => undefined;
  try {
    await bot.lookAt(referenceBlock.position.offset(0.5 + faceVector.x * 0.5, 0.5 + faceVector.y * 0.5, 0.5 + faceVector.z * 0.5));
    await new Promise<void>((resolve, reject) => {
      onUpdate = (before, after) => {
        if (!before || !after || before.type !== after.type) resolve();
      };
      bot.on(eventName, onUpdate);
      const direction = FACE_VECTORS.findIndex((face) => face.equals(faceVector));
      bot._client.write("block_place", { location: referenceBlock.position.clone(), direction, hand: 0 });
      cancelTimeout = parts.clock.after(PLACEMENT_TIMEOUT_MS, () =>
        reject(new Error(`Event ${eventName} did not fire within timeout of ${PLACEMENT_TIMEOUT_MS}ms`)),
      );
    });
  } finally {
    cancelTimeout();
    bot.removeListener(eventName, onUpdate);
  }
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
        displayName: known?.displayName ?? name,
        height: known?.height ?? 0,
        width: known?.width ?? 0,
        position: position.clone(),
      });
      return entity;
    },
  };
}

