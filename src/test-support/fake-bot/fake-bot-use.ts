/**
 * The fake bot's item use: `activateItem` as Mineflayer writes it (`inventory.js:127`, a `use_item` packet), and the
 * server's answer to a boat used, as the 1.21.4 server gave it (contract check `boat-placed-by-use`, Mine Labs
 * 2026-10-23): the boat appears where the look meets water or ground within the block reach, facing the look, and the
 * stack loses its one boat; on water it sinks to its rest level. Nothing is put (stack kept) for a look at the sky or at
 * something out of reach, where the boat would stand in a block, or on a spot another boat holds.
 * Vanilla's rules, not measured: a creative bot keeps its stack, the off hand's use, a vehicle of any kind blocks a spot,
 * a water plant or a waterlogged block counts as water, the rest of the bobbing between spawn and rest.
 */
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { boxMeetsBlocks, boxMeetsEntity } from "./fake-bot-boxes.js";
import type { FakeEntities } from "./fake-bot-items.js";
import { holdsWater } from "../../navigation/world/deep-water.js";
import { eyeHeightOf } from "./fake-bot-physics.js";
import type { FakeBot } from "./fake-bot.js";
import type { FakeClock } from "./fake-clock.js";
import { EQUIPMENT_SLOTS, type FakeInventory, itemOf } from "./fake-inventory.js";
import type { FakeServer } from "./fake-server.js";
import type { FakeWorld } from "./fake-world.js";

const require = createRequire(import.meta.url);
const { nextInteractionSequence } = require("mineflayer/lib/interaction_sequence") as { nextInteractionSequence(bot: Bot): number | undefined };
const { toNotchianYaw, toNotchianPitch, fromNotchianYaw } = require("mineflayer/lib/conversions") as {
  toNotchianYaw(yaw: number): number;
  toNotchianPitch(pitch: number): number;
  fromNotchianYaw(yaw: number): number;
};

const MAIN_HAND = 0;
const OFF_HAND = 1;
/** The block reach: a boat was put at 4.40 blocks and not at 4.70 (contract check `boat-placed-by-use`). */
const BLOCK_REACH = 4.5;
/** The look is walked in steps of this length to meet a fluid, then the meeting is narrowed by halving. */
const FLUID_STEP = 0.02;
const FLUID_REFINEMENTS = 12;
/** The boats' items are named like their entities (`oak_boat`, `bamboo_raft`): the entity put down is the item's name. */
const BOAT_ITEM_NAME = /_(boat|raft)$/;
/** A boat on water sinks to rest this far below the surface, about 1.5 s after it is put (-60.111 to -60.477 measured). */
const REST_BELOW_SURFACE = 0.366;
const REST_AFTER_MS = 1_500;

/** The fluids a source or flowing block of `level` fills up to, as a fraction of its cell: a source is 8/9. */
function fluidHeight(level: number): number {
  return level >= 8 ? 1 : (8 - level) / 9;
}

/** The look as a direction (a notchian yaw and pitch in degrees, `Entity.getViewVector`). */
function lookDirection({ x: yaw, y: pitch }: { x: number; y: number }): Vec3 {
  const yawRad = (yaw * Math.PI) / 180;
  const pitchRad = (pitch * Math.PI) / 180;
  return new Vec3(-Math.sin(yawRad) * Math.cos(pitchRad), -Math.sin(pitchRad), Math.cos(yawRad) * Math.cos(pitchRad));
}

/** Where a look from `eye` first meets the top of a fluid, or null: the fluid cell's surface level comes with the point. */
function fluidMeeting(bot: Bot, eye: Vec3, direction: Vec3, within: number): { point: Vec3; surface: number } | null {
  const surfaceAt = (point: Vec3): number | null => {
    const block = bot.blockAt(point);
    // Water, a water plant or a waterlogged block (`holdsWater`, the runtime's rule; vanilla's `Fluid.ANY`, unmeasured for
    // the plants); lava is not floated on, so a look at it meets nothing here.
    if (block === null || !holdsWater(block.name, block.getProperties())) return null;
    const level = block.name === "water" ? Number(block.getProperties().level ?? 0) : 0;
    return Math.floor(point.y) + fluidHeight(level);
  };
  const inside = (distance: number) => {
    const point = eye.plus(direction.scaled(distance));
    const surface = surfaceAt(point);
    return surface !== null && point.y < surface ? { point, surface } : null;
  };
  for (let distance = 0; distance <= within; distance += FLUID_STEP) {
    if (inside(distance) === null) continue;
    let [near, far] = [Math.max(0, distance - FLUID_STEP), distance];
    for (let step = 0; step < FLUID_REFINEMENTS; step += 1) {
      const middle = (near + far) / 2;
      if (inside(middle) === null) near = middle;
      else far = middle;
    }
    return inside(far);
  }
  return null;
}

/** What `getPlayerPOVHitResult` finds with fluids counted: the nearer of the first solid face and the first fluid top in reach. */
function lookMeeting(bot: Bot, eye: Vec3, direction: Vec3): { point: Vec3; surface: number | null } | null {
  const solid = bot.world.raycast(eye, direction, BLOCK_REACH);
  const solidAt = solid === null ? BLOCK_REACH : eye.distanceTo(solid.intersect);
  const fluid = fluidMeeting(bot, eye, direction, solidAt);
  if (fluid !== null) return fluid;
  return solid === null ? null : { point: solid.intersect, surface: null };
}

/** The stack the used hand holds. */
function heldIn(inventory: FakeInventory, hand: number): Item | null {
  return hand === OFF_HAND ? (inventory.slots[EQUIPMENT_SLOTS["off-hand"]] ?? null) : inventory.heldItem;
}

/** The boat entity a boat item puts down at `point`, facing the look; null where it would stand in a block or in another boat. */
function boatAt(bot: FakeBot, entities: FakeEntities, name: string, point: Vec3, yaw: number): Entity | null {
  const boat = entities.make(name, point);
  boat.yaw = yaw;
  const meetsBoat = Object.values(bot.entities).some((other) => other.kind === boat.kind && boxMeetsEntity(point, boat.width, boat.height, other));
  return meetsBoat || boxMeetsBlocks(bot, point, boat.width, boat.height) ? null : boat;
}

type UseParts = { clock: FakeClock; server: FakeServer; world: FakeWorld; inventory: FakeInventory; entities: FakeEntities };

/**
 * The server's side of a boat put on water: after a while it floats at its rest level. One move stands for the bobbing the
 * server sends (-60.25, -60.43, -60.53 ... -60.477); a boat a rider controls is not simulated by the server, so it stays.
 */
function restOnWater(bot: FakeBot, parts: UseParts, boat: Entity, surface: number): void {
  parts.clock.after(REST_AFTER_MS, () =>
    parts.server.answer(() => {
      if (bot.entities[boat.id] !== boat || parts.server.riderOf(boat.id) !== null) return;
      boat.position.y = surface - REST_BELOW_SURFACE;
      parts.server.setServerPosition(boat.id, boat.position);
      bot.emit("entityMoved", boat);
    }),
  );
}

/** The server's side of a `use_item`: a boat item held is put where the look meets, one taken from the stack outside creative. */
function answerUse(bot: FakeBot, parts: UseParts, hand: number, rotation: { x: number; y: number }): void {
  const held = heldIn(parts.inventory, hand);
  const entity = held === null || !BOAT_ITEM_NAME.test(held.name) ? undefined : bot.registry.entitiesByName[held.name];
  if (held === null || entity === undefined) return;
  const eye = (parts.server.serverPositionOf(bot.entity.id) ?? bot.entity.position).offset(0, eyeHeightOf(bot.entity), 0);
  const meeting = lookMeeting(bot, eye, lookDirection(rotation));
  const boat = meeting === null ? null : boatAt(bot, parts.entities, held.name, meeting.point, fromNotchianYaw(rotation.x));
  if (meeting === null || boat === null) return;
  bot.entities[boat.id] = boat;
  parts.server.setServerPosition(boat.id, boat.position);
  if (bot.game.gameMode !== "creative") parts.inventory.updateSlot(held.slot, held.count > 1 ? itemOf(bot.registry, held.name, held.count - 1) : (null as never));
  bot.emit("entitySpawn", boat);
  if (meeting.surface !== null) restOnWater(bot, parts, boat, meeting.surface);
}

/** Give `bot` `activateItem` and the server's answer to a `use_item`. */
export function attachFakeUse(bot: FakeBot, parts: UseParts): void {
  // `inventory.js:84-103` `checkActiveItem`: the use ends when the hand's item type or the selected slot changes.
  let active = { offHand: false, type: undefined as number | undefined, quickBarSlot: 0 };
  const endUseOfChangedItem = () => {
    if (!bot.usingHeldItem) return;
    const item = active.offHand ? parts.inventory.slots[EQUIPMENT_SLOTS["off-hand"]] : bot.heldItem;
    if (item?.type === active.type && (active.offHand || bot.quickBarSlot === active.quickBarSlot)) return;
    bot.usingHeldItem = false;
  };
  parts.inventory.onHeldItemChanged(endUseOfChangedItem);
  parts.inventory.on("updateSlot", endUseOfChangedItem);
  // `inventory.js:105-127`: the use told to the server with the look (`toNotchianYaw` / `toNotchianPitch`).
  bot.activateItem = (offHand = false) => {
    if (!bot.usingHeldItem) active = { offHand, type: (offHand ? parts.inventory.slots[EQUIPMENT_SLOTS["off-hand"]] : bot.heldItem)?.type, quickBarSlot: bot.quickBarSlot };
    bot.usingHeldItem = true;
    bot._client.write("use_item", {
      hand: offHand ? OFF_HAND : MAIN_HAND,
      sequence: nextInteractionSequence(bot),
      rotation: { x: toNotchianYaw(bot.entity.yaw), y: toNotchianPitch(bot.entity.pitch) },
    });
  };
  parts.server.onPacket("use_item", (data) => {
    const { hand, rotation } = data as { hand: number; rotation: { x: number; y: number } };
    parts.server.answer(() => answerUse(bot, parts, hand, rotation));
  });
}
