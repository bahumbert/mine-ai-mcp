// The cells around a bot that is hiding: where it stands, whether the box is closed, who is inside it.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { liveBlockReader } from "../../navigation/mineflayer/world.js";
import { navigationFeet, safeSupportingCell } from "../../navigation/world/block-geometry.js";
import { cellIntersectsBody } from "../../utils/geometry.js";
import { entityDimensions } from "../../world/entity-dimensions.js";
import type { WorldBlock } from "../../world/index.js";
import type { ResponseContext } from "../control/combat/context.js";
import { isThreat } from "../perception/combat/threats.js";
import { fullProtectionBlock } from "../positioning/combat/build-protection.js";
import { PROJECTILE_HIT_MARGIN } from "../positioning/combat/exposure.js";
import { PROTECTION_SIDES, protectionShell } from "../positioning/combat/planner.js";

export type Entity = Parameters<Bot["attack"]>[0];

export const SIDES = PROTECTION_SIDES;
/** A mob this close is in the shaft with the bot, and the only fight left is the one at arm's length. */
const SHAFT_REACH = 2;

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
    const support = safeSupportingCell({ blockAt: liveBlockReader(bot) }, bot.entity.position);
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

/** The vector from the bot to the nearest threat, or null when there is none. */
export function nearestThreatDirection(bot: Bot, context: ResponseContext): Vec3 | null {
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
  return nearest ? nearest.position.minus(bot.entity.position) : null;
}

/** The four sides, the one facing the nearest hostile first, so cover goes up where the arrows come from. */
export function sidesByThreat(bot: Bot, context: ResponseContext): readonly Vec3[] {
  const toward = nearestThreatDirection(bot, context);
  if (!toward) return SIDES;
  return [...SIDES].sort((left, right) => right.dot(toward) - left.dot(toward));
}

/** The cells' coordinates a span from `min` to `max` touches: `floor(min)` up to `ceil(max) - 1`. */
function wholeNumbersAcross(min: number, max: number): number[] {
  const first = Math.floor(min);
  return Array.from({ length: Math.max(0, Math.ceil(max) - first) }, (_, offset) => first + offset);
}

/** The body's own layers first, the layers above ascending, then the layers below descending. */
function marginLayerRank(feet: Vec3, cell: Vec3): number {
  const above = cell.y - feet.y;
  return above >= 0 ? above : 1000 - above;
}

/** Horizontal Manhattan distance from the feet column: an eave comes before the corner it supports. */
function marginColumnDistance(feet: Vec3, cell: Vec3): number {
  return Math.abs(cell.x - feet.x) + Math.abs(cell.z - feet.z);
}

/**
 * Every cell the body box, expanded by `margin` on every face, overlaps with positive volume, minus the feet and head
 * cells and the shell. A projectile's terrain ray stops at the entry point of that expanded box (`projectileContact`), so
 * these are the cells a shell of `protectionShell` leaves between a shot and the body. No table of cells: the set follows
 * the body's position and dimensions. The order is D9b's: layers (feet, head, above ascending, below descending), then
 * the distance from the feet column, then x, then z.
 */
export function marginBoxCells(bot: Bot, feet: Vec3, margin = PROJECTILE_HIT_MARGIN): Vec3[] {
  const { position } = bot.entity;
  const { width, height } = entityDimensions(bot, bot.entity);
  const box = { position: position.offset(0, -margin, 0), width: width + 2 * margin, height: height + 2 * margin };
  const half = box.width / 2;
  const excluded = new Set([feet, feet.offset(0, 1, 0), ...shell(feet)].map((cell) => cell.toString()));
  const xs = wholeNumbersAcross(position.x - half, position.x + half);
  const ys = wholeNumbersAcross(box.position.y, box.position.y + box.height);
  const zs = wholeNumbersAcross(position.z - half, position.z + half);
  const cells = xs.flatMap((x) => ys.flatMap((y) => zs.map((z) => new Vec3(x, y, z))))
    .filter((cell) => cellIntersectsBody(cell, box) && !excluded.has(cell.toString()));
  return cells.sort((left, right) =>
    marginLayerRank(feet, left) - marginLayerRank(feet, right) ||
    marginColumnDistance(feet, left) - marginColumnDistance(feet, right) ||
    left.x - right.x || left.z - right.z);
}

/**
 * The margin cells a shelter pass can still fill: loaded and not a full block. Inside a layer and distance group the
 * cells on the `toward` side (the nearest threat) come first.
 */
export function marginCells(bot: Bot, feet: Vec3, toward: Vec3 | null, margin = PROJECTILE_HIT_MARGIN): Vec3[] {
  const open = marginBoxCells(bot, feet, margin).filter((cell) => {
    const block = bot.blockAt(cell);
    return block !== null && !fullProtectionBlock(block);
  });
  if (!toward) return open;
  const { position } = bot.entity;
  const side = (cell: Vec3) => cell.offset(0.5, 0.5, 0.5).minus(position).dot(toward);
  return open.sort((left, right) =>
    marginLayerRank(feet, left) - marginLayerRank(feet, right) ||
    marginColumnDistance(feet, left) - marginColumnDistance(feet, right) ||
    side(right) - side(left) || left.x - right.x || left.z - right.z);
}
