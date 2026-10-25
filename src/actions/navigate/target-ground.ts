/** What navigate reads of a destination's cells: standable ground, a column's surface, the shore near a watery target. */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { canOccupyWater, isSafeSupport, liveBlockReader, standsOnDryGround, type MineflayerBlock } from "../../navigation/index.js";
import { tagsOf } from "../../world/block-tags.js";

/** How far below a target to look for ground when refusing it, so the refusal can name the height instead. */
const GROUND_SEARCH_DEPTH = 64;

function supported(bot: Bot, feet: Vec3): boolean {
  return isSafeSupport(liveBlockReader(bot)(feet.x, feet.y - 1, feet.z));
}

/** Feet and head clear and dry, and something solid to stand on, as routes judge it. Unloaded cells are not standable. */
export function standable(bot: Bot, feet: Vec3): boolean {
  return standsOnDryGround(liveBlockReader(bot), feet);
}

/**
 * Reject unsupported mid-air destinations unless building was requested.
 * Existing footing is enough: movement policy owns whether feet and head
 * cells can be excavated. Unloaded targets must be judged during the route.
 */
export function targetSupported(bot: Bot, target: { x: number; y: number; z: number }, range: number): boolean {
  const centre = new Vec3(target.x, target.y, target.z);
  if (bot.blockAt(centre) === null) return true;
  return cellsWithin(centre, range).some((feet) => supported(bot, feet) || canOccupyWater(bot, feet));
}

/** The cells within `range` of `centre` (straight-line distance), x outermost, then y, then z. */
function cellsWithin(centre: Vec3, range: number): Vec3[] {
  const reach = Math.ceil(range);
  const cells: Vec3[] = [];
  for (let dx = -reach; dx <= reach; dx += 1)
    for (let dy = -reach; dy <= reach; dy += 1)
      for (let dz = -reach; dz <= reach; dz += 1) cells.push(centre.offset(dx, dy, dz));
  return cells.filter((cell) => cell.distanceTo(centre) <= range);
}

/** How far around a watery target the existing shore search looks. */
export const SHORE_SEARCH_RADIUS = 8;

type SurfaceObservation =
  | { readonly kind: "surface"; readonly y: number; readonly name: string; readonly solid: boolean }
  | { readonly kind: "ambiguous"; readonly observation: string; readonly floors: readonly number[] };

/** Omitted height may resolve only an unambiguous outdoor column, never choose among floors. */
export function surfaceAt(bot: Bot, x: number, z: number): SurfaceObservation | null {
  // The game plugin supplies these dimension bounds; Mineflayer's type omits them.
  const dimension = bot.game as typeof bot.game & { minY: number; height: number };
  const bottom = dimension.minY;
  const top = bottom + dimension.height - 1;
  const read = liveBlockReader(bot);
  let highest: Extract<SurfaceObservation, { kind: "surface" }> | null = null;
  let canopyOrRoof = false;
  const floors: number[] = [];
  for (let y = top; y >= bottom; y--) {
    const cell = read(x, y, z);
    if (cell.kind !== "loaded") return null;
    // The surface is the highest solid block or liquid, a water plant included: a kelp column is the sea, not air
    // over the sea floor (run 16, Yuki).
    if (cell.traits.empty && cell.traits.liquid === null) continue;
    if (highest === null) {
      const block = bot.blockAt(new Vec3(x, y, z))!;
      highest = { kind: "surface", y, name: block.name, solid: !cell.traits.empty };
      canopyOrRoof = isCanopyOrRoof(block, bot.version);
    }
    if (y + 2 <= top && standsOnDryGround(read, { x, y: y + 1, z })) floors.push(y + 1);
  }
  if (highest && (canopyOrRoof || floors.length > 1)) {
    return {
      kind: "ambiguous",
      observation: `[NAVIGATION_HEIGHT_REQUIRED] Column ${x}, ${z} has highest block ${highest.name} at y=${highest.y}; observed standable feet heights: ${floors.join(", ") || "none"}. Supply y (or near_y) to choose a floor.`,
      floors,
    };
  }
  return highest;
}

/** A top that is a canopy (the game's leaves tag) or a roof nothing breaks (the Nether's): never the ground itself. */
function isCanopyOrRoof(block: MineflayerBlock, version: string): boolean {
  return tagsOf(block.name, version).includes("leaves") || block.diggable === false;
}

/**
 * Where a ground target on water is really going: the nearest column within
 * a few blocks whose surface is solid ground the bot can stand on. Both
 * bucket deaths in the playthroughs began with a walk to "the water at x,z",
 * which the ground goal resolved to the lake bed.
 */
export function shoreNear(bot: Bot, target: { x: number; z: number }, reach = SHORE_SEARCH_RADIUS): { x: number; z: number } | null {
  const surface = surfaceAt(bot, target.x, target.z);
  if (!surface || surface.kind === "ambiguous" || surface.solid) return target;
  for (let radius = 1; radius <= reach; radius += 1) {
    const nearest = nearestShoreOnRing(bot, target, radius);
    if (nearest !== null) return nearest;
  }
  return null;
}

/** The standable solid column nearest `target` on the square ring `radius` blocks out from it, if any. */
function nearestShoreOnRing(bot: Bot, target: { x: number; z: number }, radius: number): { x: number; z: number } | null {
  let nearest: { x: number; z: number } | null = null;
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
      const x = target.x + dx;
      const z = target.z + dz;
      const candidate = surfaceAt(bot, x, z);
      if (candidate?.kind === "surface" && candidate.solid && standable(bot, new Vec3(x, candidate.y + 1, z)) &&
        (nearest === null || Math.hypot(dx, dz) < Math.hypot(nearest.x - target.x, nearest.z - target.z))) nearest = { x, z };
    }
  }
  return nearest;
}

/** The highest standable feet cell at or below the target in its column, if one is loaded. */
export function groundBelow(bot: Bot, target: { x: number; y: number; z: number }): number | null {
  for (let y = target.y; y >= target.y - GROUND_SEARCH_DEPTH; y -= 1) {
    if (standable(bot, new Vec3(target.x, y, target.z))) return y;
  }
  return null;
}

/** The feet height of the highest place to stand in a column (its surface, above any caves); null when not loaded. */
export function highestFloor(bot: Bot, x: number, z: number): number | null {
  const dimension = bot.game as typeof bot.game & { minY: number; height: number };
  for (let y = dimension.minY + dimension.height - 3; y >= dimension.minY; y--) {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) return null;
    if (block.boundingBox === "block" && standable(bot, new Vec3(x, y + 1, z))) return y + 1;
  }
  return null;
}
