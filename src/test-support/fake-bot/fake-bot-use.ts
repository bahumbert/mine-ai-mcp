/**
 * The fake bot's item use: `activateItem` as Mineflayer writes it (`inventory.js:127`, a `use_item` packet), and the
 * server's answer to a boat used, as the 1.21.4 server gave it (contract check `boat-placed-by-use`, Mine Labs
 * 2026-10-23): the boat appears where the look meets water or ground within the block reach, facing the look (its yaw a
 * byte of 256 steps a turn, the look's floored: `yawOfSpawnPacket`), and the stack loses its one boat; on water it sinks to its rest level. Nothing is put (stack kept) for a look at the sky or at
 * something out of reach, where the boat would stand in a block, or on a spot another boat holds.
 * Vanilla's rules, not measured: a creative bot keeps its stack, the off hand's use, a vehicle of any kind blocks a spot,
 * a water plant or a waterlogged block counts as water, the rest of the bobbing between spawn and rest.
 */
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { BOAT_NAME } from "./fake-bot-entity-reach.js";
import { boxMeetsBlocks, boxMeetsEntity } from "./fake-bot-boxes.js";
import type { FakeEntities } from "./fake-bot-items.js";
import { answerBucketUse } from "./fake-bot-bucket.js";
import { lookDirection, lookMeeting } from "./fake-bot-look.js";
import { eyeHeightOf } from "./fake-bot-physics.js";
import { onServerTick } from "./fake-bot-server-ticks.js";
import type { FakeBot } from "./fake-bot.js";
import { EQUIPMENT_SLOTS, type FakeInventory, itemOf } from "./fake-inventory.js";
import type { FakeServer } from "./fake-server.js";
import type { FakeWorld } from "./fake-world.js";

const require = createRequire(import.meta.url);
const { nextInteractionSequence } = require("mineflayer/lib/interaction_sequence") as { nextInteractionSequence(bot: Bot): number | undefined };
const { toNotchianYaw, toNotchianPitch, fromNotchianYawByte } = require("mineflayer/lib/conversions") as {
  toNotchianYaw(yaw: number): number;
  toNotchianPitch(pitch: number): number;
  fromNotchianYawByte(byte: number): number;
};

const MAIN_HAND = 0;
const OFF_HAND = 1;
/** A boat on water sinks to rest this far below the surface, about 1.5 s after it is put (-60.111 to -60.477 measured). */
const REST_BELOW_SURFACE = 0.366;
/** The measured "about 1.5 s" at the server's 20 ticks a second: the server counts ticks, so a slower server takes longer. */
const REST_AFTER_TICKS = 30;
/** An entity's yaw travels as one byte, 256 steps a turn. */
const YAW_STEPS_PER_TURN = 256;
const DEGREES_PER_TURN = 360;

/**
 * The yaw a boat has once the client has decoded the spawn packet: the look's Notchian degrees (a float on the wire) packed
 * into a byte by the server's floor (a look 0.3 of a step either side of east, -64 steps, gave -64 and -65: contract check
 * `boat-placed-by-use`, Mine Labs 2026-10-24; rounding would give -64 twice), then decoded as Mineflayer does. The float32
 * steps of the arithmetic are vanilla's `Mth.packDegrees`, read from its source and not measured.
 */
function yawOfSpawnPacket(degrees: number): number {
  const steps = Math.fround(Math.fround(Math.fround(degrees) * YAW_STEPS_PER_TURN) / DEGREES_PER_TURN);
  // The byte is signed (`(byte)` in Java, an i8 on the wire): 191 steps arrive as -65.
  return fromNotchianYawByte(((Math.floor(steps) + YAW_STEPS_PER_TURN / 2) & (YAW_STEPS_PER_TURN - 1)) - YAW_STEPS_PER_TURN / 2);
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

type UseParts = { server: FakeServer; world: FakeWorld; inventory: FakeInventory; entities: FakeEntities };

/**
 * The server's side of a boat put on water: `REST_AFTER_TICKS` server ticks later it floats at its rest level. One move stands for the bobbing the
 * server sends (-60.25, -60.43, -60.53 ... -60.477); a boat a rider controls is not simulated by the server, so it stays. The move is not lagged (like the fireballs' moves): the lag of `lagMs` delays what the client
 * asks, and the put already waited for it.
 */
function restOnWater(bot: FakeBot, parts: UseParts, boat: Entity, surface: number): void {
  let ticks = 0;
  const stopCounting = onServerTick(parts.server, () => {
    ticks += 1;
    if (ticks < REST_AFTER_TICKS && bot.entities[boat.id] === boat) return;
    stopCounting();
    if (bot.entities[boat.id] !== boat || parts.server.riderOf(boat.id) !== null) return;
    boat.position.y = surface - REST_BELOW_SURFACE;
    parts.server.setServerPosition(boat.id, boat.position);
    bot.emit("entityMoved", boat);
  });
}

/** The server's side of a boat item used: the boat is put where the look meets, one taken from the stack outside creative. */
function answerBoatUse(bot: FakeBot, parts: UseParts, held: Item, eye: Vec3, rotation: { x: number; y: number }): void {
  if (bot.registry.entitiesByName[held.name] === undefined) return;
  const meeting = lookMeeting(bot, eye, lookDirection(rotation));
  const boat = meeting === null ? null : boatAt(bot, parts.entities, held.name, meeting.point, yawOfSpawnPacket(rotation.x));
  if (meeting === null || boat === null) return;
  bot.entities[boat.id] = boat;
  parts.server.setServerPosition(boat.id, boat.position);
  if (bot.game.gameMode !== "creative") parts.inventory.updateSlot(held.slot, held.count > 1 ? itemOf(bot.registry, held.name, held.count - 1) : (null as never));
  bot.emit("entitySpawn", boat);
  if (meeting.surface !== null) restOnWater(bot, parts, boat, meeting.surface);
}

/**
 * The server's side of a `use_item`: a boat or a bucket held is answered, anything else changes nothing; the server
 * acknowledges the use's sequence in every case (contract check `bucket-pour-and-fill`: the sky is only acknowledged).
 */
function answerUse(bot: FakeBot, parts: UseParts, use: { hand: number; sequence: number; rotation: { x: number; y: number } }): void {
  const held = heldIn(parts.inventory, use.hand);
  if (held !== null) {
    const eye = (parts.server.serverPositionOf(bot.entity.id) ?? bot.entity.position).offset(0, eyeHeightOf(bot.entity), 0);
    if (BOAT_NAME.test(held.name)) answerBoatUse(bot, parts, held, eye, use.rotation);
    else answerBucketUse(bot, parts, held, eye, use.rotation);
  }
  bot._client.emit("acknowledge_player_digging", { sequenceId: use.sequence });
}

/** Give `bot` `activateItem` and the server's answer to a `use_item`. */
export function attachFakeUse(bot: FakeBot, parts: UseParts): void {
  // `inventory.js:84-103` `checkActiveItem`: the use ends when the hand's item type or the selected slot changes.
  let active: { offHand: boolean; type: number | undefined; quickBarSlot: number } | null = null;
  const endUseOfChangedItem = () => {
    // A use Mineflayer's own `consume` began is tracked by its plugin (`inventory.js` `checkActiveItem`), not here.
    if (!bot.usingHeldItem || active === null) return;
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
    const use = data as { hand: number; sequence: number; rotation: { x: number; y: number } };
    parts.server.answer(() => answerUse(bot, parts, use));
  });
}
