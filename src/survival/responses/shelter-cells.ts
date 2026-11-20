// The cells around a bot that is hiding: where it stands, whether the box is closed, who is inside it.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { MineflayerWorldView } from "../../navigation/mineflayer/world.js";
import { navigationFeet, safeSupportingCell } from "../../navigation/world/block-geometry.js";
import type { WorldView } from "../../navigation/world/world.js";
import { cellIntersectsBody } from "../../utils/geometry.js";
import type { WorldBlock } from "../../world/index.js";
import type { ResponseContext } from "../control/combat/context.js";
import { isThreat } from "../perception/combat/threats.js";
import { fullProtectionBlock } from "../positioning/combat/build-protection.js";
import { PROTECTION_SIDES, protectionShell } from "../positioning/combat/planner.js";

export type Entity = Parameters<Bot["attack"]>[0];

export const SIDES = PROTECTION_SIDES;
/** A mob this close is in the shaft with the bot, and the only fight left is the one at arm's length. */
const SHAFT_REACH = 2;

/** One read view per bot, as the runtime keeps one: its listeners live as long as the bot does. */
const liveWorlds = new WeakMap<Bot, WorldView>();

function liveWorldOf(bot: Bot): WorldView {
  let world = liveWorlds.get(bot);
  if (!world) {
    world = new MineflayerWorldView(bot);
    liveWorlds.set(bot, world);
  }
  return world;
}

/**
 * Whether the floor under `feet` holds the cell's centre at the body's height. A bottom slab or a fence top beside the
 * body is another height, so it does not hold the centre (`shelterFeet`, `centerForShelterRing`).
 */
export function floorHoldsCentre(bot: Bot, feet: Vec3): boolean {
  const floor = bot.blockAt(feet.offset(0, -1, 0));
  return (
    floor?.shapes.some(
      ([minX, , minZ, maxX, maxY, maxZ]) =>
        minX <= 0.5 &&
        maxX >= 0.5 &&
        minZ <= 0.5 &&
        maxZ >= 0.5 &&
        Math.abs(feet.y - 1 + maxY - bot.entity.position.y) < 0.001,
    ) ?? false
  );
}

/**
 * Every solid floor under the body's footprint tops out at the body's height, so a bottom slab beside the chosen cell
 * is another height and keeps today's answer (D31). Air under the footprint is no floor (the recorded edge is over air).
 */
function footprintFloorsAtBodyHeight(bot: Bot, feetY: number): boolean {
  const { x, z } = bot.entity.position;
  for (let fx = Math.floor(x - 0.3); fx < x + 0.3; fx++)
    for (let fz = Math.floor(z - 0.3); fz < z + 0.3; fz++) {
      const floor = bot.blockAt(new Vec3(fx, feetY - 1, fz));
      if (!floor || floor.shapes.length === 0) continue;
      const top = (maxY: number) => Math.abs(feetY - 1 + maxY - bot.entity.position.y) < 0.001;
      if (!floor.shapes.some(([, , , , maxY]) => top(maxY))) return false;
    }
  return true;
}

/**
 * The cell a shelter is built on. A grounded body takes the supporting cell under its footprint when that cell's floor
 * holds its centre; otherwise the navigation cell, as before (lava, a damaging or unloaded neighbour, an airborne body
 * and a floor of another height keep today's answers).
 */
export function shelterFeet(bot: Bot): Vec3 {
  if (bot.entity.onGround) {
    const support = safeSupportingCell(liveWorldOf(bot), bot.entity.position);
    if (support) {
      const at = new Vec3(support.x, support.y, support.z);
      if (floorHoldsCentre(bot, at) && footprintFloorsAtBodyHeight(bot, at.y)) return at;
    }
  }
  const cell = navigationFeet(bot.entity.position, bot.entity.onGround);
  return new Vec3(cell.x, cell.y, cell.z);
}

export function solid(block: WorldBlock | null): block is WorldBlock {
  return block?.boundingBox === "block";
}

export function diggable(block: WorldBlock | null): block is WorldBlock {
  return solid(block) && block.name !== "bedrock" && block.hardness !== null && block.hardness >= 0;
}

/** The cells that make a closed box around a bot standing at `feet`: four sides at each level, and the cap. */
function shell(feet: Vec3): readonly Vec3[] {
  return protectionShell(feet, [feet]);
}

export function enclosedInPlace(bot: Bot, blockNames?: readonly string[]): boolean {
  return shell(shelterFeet(bot)).every((cell) => {
    const block = bot.blockAt(cell);
    return fullProtectionBlock(block) && (!blockNames || blockNames.includes(block!.name));
  });
}

/** An authorized threat occupying the body or shelter shell; never chase beyond construction space. */
export function shelterIntruder(bot: Bot, context: ResponseContext): Entity | null {
  return shelterIntruders(bot, context).next().value ?? null;
}

/** Every authorized threat in construction space, so a known occupant cannot mask a new arrival. */
export function* shelterIntruders(bot: Bot, context: ResponseContext): Generator<Entity> {
  for (const id in bot.entities) {
    const entity = bot.entities[id];
    // Multipart dragon contact belongs to the End owner, not shaft melee.
    if (entity?.name === "ender_dragon") continue;
    if (!isThreat(bot, entity, context)) continue;
    const delta = entity.position.minus(bot.entity.position);
    const feet = shelterFeet(bot);
    if (
      delta.y >= -1 &&
      delta.y <= SHAFT_REACH &&
      [feet, feet.offset(0, 1, 0), ...shell(feet)].some((cell) => cellIntersectsBody(cell, entity))
    )
      yield entity;
  }
}

/** The four sides, the one facing the nearest hostile first, so cover goes up where the arrows come from. */
export function sidesByThreat(bot: Bot, context: ResponseContext): readonly Vec3[] {
  let nearest: Entity | null = null;
  for (const id in bot.entities) {
    const entity = bot.entities[id];
    if (!isThreat(bot, entity, context)) continue;
    if (
      !nearest ||
      entity.position.distanceTo(bot.entity.position) < nearest.position.distanceTo(bot.entity.position)
    ) {
      nearest = entity;
    }
  }
  if (!nearest) return SIDES;
  const toward = nearest.position.minus(bot.entity.position);
  return [...SIDES].sort((left, right) => right.dot(toward) - left.dot(toward));
}
