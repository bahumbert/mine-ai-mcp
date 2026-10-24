import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { holdsWater } from "../navigation/world/deep-water.js";
import type { WorldView } from "../navigation/world/world.js";

/** Prismarine state properties may be numeric strings (including falling level "8"). */
export function lavaLevel(block: NonNullable<ReturnType<Bot["blockAt"]>>): number {
  return Number(block.getProperties().level);
}

/**
 * Could lava of this `level` (0 source .. 7 flowing, 8 falling) flow into a dry cell on its next update? Lava above a cell
 * falls into it; a falling column and flowing lava pour on down where nothing holds them up and spread sideways only once a
 * floor stops them (contract check `lava-over-hole`: a level 2 over a hole filled no cell beside it); a source spreads
 * either way. Beside it, overworld lava loses two levels per step and the Nether's one, so it spreads while a level is left.
 * The one rule behind the fire reflex and the route planner.
 * `floorBelow`: whether the lava cell rests on a floor (false: the cell under it is open), when the caller knows (the planner
 * does; the reflex assumes a floor, and so does the planner for a cell under it that is not loaded).
 */
export function lavaSpreadsFrom(level: number, above: boolean, dimension: string, floorBelow?: boolean): boolean {
  if (above) return true;
  if (floorBelow === false && level !== 0) return false;
  if (level >= 8) return true;
  return level + (dimension === "the_nether" ? 1 : 2) < 8;
}

const SPREAD_NEIGHBOURS: readonly (readonly [number, number, number])[] = [[-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0]];

/**
 * Whether the cell under (x, y, z) holds lava up: a block with collision, water (lava meeting it sets stone, which is a
 * floor next), or a block with none that lava cannot enter (a ladder, a door, a sign, a bubble column, and every block that
 * takes water in: a rail, glow lichen, a coral fan; a vine or a button counts too, which keeps the sideways spread).
 * Lava or air under it, or a block lava replaces, lets lava pour on: false. Sugar cane and portals hold lava up too and
 * show no trait: they read as open.
 * A cell not loaded is not known: undefined, which `lavaSpreadsFrom` reads as a floor.
 */
function restsOnFloor(world: Pick<WorldView, "blockAt">, x: number, y: number, z: number): boolean | undefined {
  const below = world.blockAt(x, y - 1, z);
  if (below.kind !== "loaded") return undefined;
  if (below.collisionShapes.length > 0 || below.traits.liquid === "water") return true;
  const { climbable, openable, interactive, current, waterloggable } = below.traits;
  return climbable || openable || interactive || waterloggable || current === true;
}

/**
 * Could lava beside or above the feet cell (x, y, z) or the head cell over it flow into one of them on its next update?
 * The route planner's reading of `advancingLavaAt`, on its world view: a solid cell or one holding water takes no lava.
 * Flowing lava over a cell that lets it pour on (`restsOnFloor`) does not spread sideways, so the cell beside it stays open.
 */
export function lavaSpreadsIntoBody(world: Pick<WorldView, "blockAt">, x: number, y: number, z: number, dimension: string): boolean {
  for (let rise = 0; rise <= 1; rise += 1) {
    const body = world.blockAt(x, y + rise, z);
    if (body.kind !== "loaded" || body.collisionShapes.length > 0 || body.traits.liquid === "water") continue;
    for (const [dx, dy, dz] of SPREAD_NEIGHBOURS) {
      const neighbour = world.blockAt(x + dx, y + rise + dy, z + dz);
      if (neighbour.kind !== "loaded" || neighbour.traits.liquid !== "lava") continue;
      const level = neighbour.traits.liquidLevel ?? 0;
      // Flowing or source lava beside the head cell alone is the state a settled stream leaves (step-up-turn-beside-lava-stream):
      // it reaches the body through the feet row. A falling column that lands beside the head still pours in.
      if (rise === 1 && dy === 0 && level < 8) continue;
      if (lavaSpreadsFrom(level, dy === 1, dimension, restsOnFloor(world, x + dx, y + rise + dy, z + dz))) return true;
    }
  }
  return false;
}

/** Could an adjacent lava cell spread into the body's currently dry cells on its next update? */
export function advancingLavaAt(bot: Bot, position = bot.entity.position, source?: Vec3): boolean {
  const radius = (bot.entity.width ?? 0.6) / 2;
  for (let x = Math.floor(position.x - radius + 0.001); x <= Math.floor(position.x + radius - 0.001); x++)
    for (let z = Math.floor(position.z - radius + 0.001); z <= Math.floor(position.z + radius - 0.001); z++)
      for (let y = Math.floor(position.y); y <= Math.floor(position.y + (bot.entity.height ?? 1.8) - 0.001); y++) {
        const cell = new Vec3(x, y, z);
        const body = bot.blockAt(cell);
        if (!body || body.boundingBox === "block" || holdsWater(body.name, body.getProperties?.() ?? {})) continue;
        for (const [dx, dy, dz] of [
          [-1, 0, 0],
          [1, 0, 0],
          [0, 0, -1],
          [0, 0, 1],
          [0, 1, 0],
        ] as const) {
          const from = cell.offset(dx, dy, dz);
          if (source && !source.equals(from)) continue;
          const neighbor = bot.blockAt(from);
          if (neighbor?.name !== "lava") continue;
          const level = lavaLevel(neighbor);
          if (lavaSpreadsFrom(level, dy === 1, bot.game.dimension)) return true;
        }
      }
  return false;
}

/** World-age ticks between two steps of lava spreading: the Nether's lava flows 3 times as fast as the Overworld's. */
export function lavaFlowDelayTicks(bot: Bot): number {
  return bot.game.dimension === "the_nether" ? 10 : 30;
}

/**
 * Did a block update change lava (it was lava, or became lava, with another state) within `radius` cells of the body
 * horizontally and two cells above or below it? The volume is the one the fire reflex scans.
 */
export function lavaChangedNear(
  bot: Bot,
  before: ReturnType<Bot["blockAt"]>,
  after: ReturnType<Bot["blockAt"]>,
  radius: number,
): boolean {
  const cell = (after ?? before)?.position;
  if (!cell || before?.stateId === after?.stateId) return false;
  if (before?.name !== "lava" && after?.name !== "lava") return false;
  const origin = bot.entity.position.floored();
  return Math.abs(cell.x - origin.x) <= radius && Math.abs(cell.z - origin.z) <= radius && Math.abs(cell.y - origin.y) <= 2;
}
