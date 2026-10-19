import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

/** Prismarine state properties may be numeric strings (including falling level "8"). */
export function lavaLevel(block: NonNullable<ReturnType<Bot["blockAt"]>>): number {
  return Number(block.getProperties().level);
}

/** Could an adjacent lava cell spread into the body's currently dry cells on its next update? */
export function advancingLavaAt(bot: Bot, position = bot.entity.position, source?: Vec3): boolean {
  const radius = (bot.entity.width ?? 0.6) / 2;
  for (let x = Math.floor(position.x - radius + 0.001); x <= Math.floor(position.x + radius - 0.001); x++)
    for (let z = Math.floor(position.z - radius + 0.001); z <= Math.floor(position.z + radius - 0.001); z++)
      for (let y = Math.floor(position.y); y <= Math.floor(position.y + (bot.entity.height ?? 1.8) - 0.001); y++) {
        const cell = new Vec3(x, y, z);
        const body = bot.blockAt(cell);
        if (!body || body.boundingBox === "block" || body.name === "water") continue;
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
          // Overworld lava loses two levels per horizontal step; Nether lava
          // loses one. Falling lava can spread again after reaching a floor.
          const decay = bot.game.dimension === "the_nether" ? 1 : 2;
          if (dy === 1 || level >= 8 || level + decay < 8) return true;
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
