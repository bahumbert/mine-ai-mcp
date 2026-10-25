import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { liveBlockReader } from "../../navigation/index.js";
import { holdSwimDepth, swimBreathPath, swimCellsOf } from "../../navigation/world/swimming.js";

/** Collision shapes touched by the whole body, excluding faces merely touching. */
function obstruction(bot: Bot, position: Vec3): ReturnType<Bot["blockAt"]> {
  const radius = (bot.entity.width ?? 0.6) / 2;
  const height = bot.entity.height ?? 1.8;
  const low = position.offset(-radius + 0.001, 0.001, -radius + 0.001);
  const high = position.offset(radius - 0.001, height - 0.001, radius - 0.001);
  for (let x = Math.floor(low.x); x <= Math.floor(high.x); x++)
    for (let y = Math.floor(low.y); y <= Math.floor(high.y); y++)
      for (let z = Math.floor(low.z); z <= Math.floor(high.z); z++) {
        const block = bot.blockAt(new Vec3(x, y, z));
        if (!block) continue;
        if (
          block.shapes.some(
            ([x0, y0, z0, x1, y1, z1]) =>
              low.x < x + x1 &&
              high.x > x + x0 &&
              low.y < y + y1 &&
              high.y > y + y0 &&
              low.z < z + z1 &&
              high.z > z + z0,
          )
        )
          return block;
      }
  return null;
}

/** The next swim stroke can hit an adjacent rock even when the center is water. */
export function swimmingRoof(bot: Bot): ReturnType<Bot["blockAt"]> {
  return obstruction(bot, bot.entity.position.offset(0, 0.5, 0));
}

/** The key of a swim cell, as `swimBreathRoute` skips it once a stroke into it stalled. */
export const swimCellKey = (cell: { x: number; y: number; z: number }) => `${cell.x},${cell.y},${cell.z}`;

/**
 * The swim to the nearest breathable cell (an air pocket, or an open column's surface) as the cells' feet centres from
 * the first stroke to the last, up and down included. Empty when the head is already in air; null when none lies in
 * reach. `closed` names cells a stroke stalled in: they read as rock, so the next ask finds another way. Cells not loaded
 * are never passable.
 */
export function swimBreathRoute(bot: Bot, closed: ReadonlySet<string>): Vec3[] | null {
  const read = swimCellsOf(liveBlockReader(bot));
  const path = swimBreathPath((x, y, z) => (closed.has(swimCellKey({ x, y, z })) ? "solid" : read(x, y, z)), bot.entity.position.floored());
  return path && path.map((cell) => new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5));
}

/** Whether the cell over the one the feet are in is air: the head breathes there (the cell test of `swimBreathRoute`). */
export function headInAir(bot: Bot): boolean {
  const feet = bot.entity.position.floored();
  return swimCellsOf(liveBlockReader(bot))(feet.x, feet.y + 1, feet.z) === "air";
}

/** Within this of a cell's centre sideways, and this of its feet height, the cell is closed. */
const CELL_REACHED_SIDEWAYS = 0.25;
const CELL_REACHED_VERTICALLY = 0.7;
/** Feet ride this far above a cell's floor while the swim holds that depth. */
const SWIM_DEPTH_ABOVE_FLOOR = 0.1;

export function routeCellReached(position: Vec3, cell: Vec3): boolean {
  return Math.hypot(position.x - cell.x, position.z - cell.z) < CELL_REACHED_SIDEWAYS && Math.abs(position.y - cell.y) < CELL_REACHED_VERTICALLY;
}

/** Vertical control toward a route cell: jump to rise, shift to sink, else hold the depth (the last cell always rises). */
export function routeVerticalControls(bot: Bot, cell: Vec3, last: boolean): { jump: boolean; sneak: boolean } {
  const { position, velocity } = bot.entity;
  const depth = cell.y + SWIM_DEPTH_ABOVE_FLOOR;
  if (last) return { jump: true, sneak: false };
  if (position.y > depth + 0.4) return { jump: false, sneak: true };
  return { jump: holdSwimDepth(position.y, velocity?.y ?? 0, depth), sneak: false };
}
