/**
 * The server's answer to a bucket used (`use_item`), as the 1.21.4 server gave it (contract check
 * `bucket-pour-and-fill`, Mine Labs 2026-10-23): a water bucket pours a source into the cell above the face the look
 * meets (in front of a side face), within the block reach, and becomes an empty bucket; an empty bucket facing a water
 * source takes it and becomes a water bucket (in its own slot, or in the first free hotbar slot when the stack holds more
 * than one). The slot is sent before the block change. Nothing else happens for the sky and for ground out of reach.
 * Not measured, and narrower than the game where it differs: a creative bot keeps its stack (the game also adds a filled
 * bucket it lacks), the water is put only in an air or flowing-water cell (the game also pours into snow, grass and other
 * replaceable blocks, and its look clips outline shapes, not collision shapes), an empty bucket takes sources only, a full
 * inventory loses the filled bucket (the game drops it), a pour in the nether does not evaporate, lava buckets and
 * waterlogged blocks are not answered.
 */
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { BLOCK_REACH, FACE_VECTORS, type LookMeeting, lookDirection, lookMeeting } from "./fake-bot-look.js";
import { type FakeInventory, itemOf } from "./fake-inventory.js";
import type { FakeWorld } from "./fake-world.js";

const WATER_BUCKET = "water_bucket";
const EMPTY_BUCKET = "bucket";
/** The blocks a pour replaces without more: the air blocks. */
const AIR_BLOCKS = new Set(["air", "cave_air", "void_air"]);

export interface BucketParts {
  readonly world: FakeWorld;
  readonly inventory: FakeInventory;
}

/** The stack leaves `slot` for `replacement`, as the server's `set_slot` says it. */
function setSlot(inventory: FakeInventory, slot: number, replacement: Item | null): void {
  inventory.updateSlot(slot, replacement as never);
}

/** The cell a pour puts its source in: in front of the solid face the look meets, if that cell takes water. */
function pouredCell(bot: Bot, parts: BucketParts, eye: Vec3, direction: Vec3): Vec3 | null {
  const hit = parts.world.raycast(eye, direction, BLOCK_REACH);
  const face = hit === null ? undefined : FACE_VECTORS[hit.face];
  if (hit === null || face === undefined) return null;
  const cell = hit.position.plus(face);
  const block = parts.world.blockAt(cell);
  if (block === null) return null;
  const flowing = block.name === "water" && Number(block.getProperties().level ?? 0) !== 0;
  return AIR_BLOCKS.has(block.name) || flowing ? cell : null;
}

/** A water bucket used: the bucket empty (outside creative), then the source in the cell. */
function pour(bot: Bot, parts: BucketParts, held: Item, eye: Vec3, direction: Vec3): void {
  const cell = pouredCell(bot, parts, eye, direction);
  if (cell === null) return;
  if (bot.game.gameMode !== "creative") setSlot(parts.inventory, held.slot, itemOf(bot.registry, EMPTY_BUCKET, 1));
  parts.world.setCell(cell, { name: "water", properties: { level: 0 } });
}

/** The first hotbar slot with nothing in it, then the first of the main inventory; null when the inventory is full. */
function firstFreeSlot(inventory: FakeInventory): number | null {
  return inventory.firstEmptyHotbarSlot() ?? inventory.firstEmptyInventorySlot();
}

/** An empty bucket used: the source the look meets is taken, and the bucket (or one of the stack) is a water bucket. */
function fill(bot: Bot, parts: BucketParts, held: Item, meeting: LookMeeting | null): void {
  if (meeting === null || meeting.surface === null) return;
  const cell = new Vec3(Math.floor(meeting.point.x), Math.floor(meeting.point.y), Math.floor(meeting.point.z));
  const filled = itemOf(bot.registry, WATER_BUCKET, 1);
  if (bot.game.gameMode !== "creative") {
    if (held.count === 1) setSlot(parts.inventory, held.slot, filled);
    else {
      setSlot(parts.inventory, held.slot, itemOf(bot.registry, EMPTY_BUCKET, held.count - 1));
      const free = firstFreeSlot(parts.inventory);
      if (free !== null) setSlot(parts.inventory, free, filled);
    }
  }
  parts.world.setCell(cell, "air");
}

/** The server's answer to a bucket in `held` used with the look `rotation` from `eye`: nothing for any other item. */
export function answerBucketUse(bot: Bot, parts: BucketParts, held: Item, eye: Vec3, rotation: { x: number; y: number }): void {
  const direction = lookDirection(rotation);
  if (held.name === WATER_BUCKET) pour(bot, parts, held, eye, direction);
  else if (held.name === EMPTY_BUCKET) fill(bot, parts, held, lookMeeting(bot, eye, direction, true));
}
