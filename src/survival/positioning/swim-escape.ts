import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { type SwimCellReader, swimExitPath } from "../../navigation/index.js";

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

/** A short lateral swim needs a clear body corridor and water or footing at its end. */
function clearSwim(bot: Bot, target: Vec3): boolean {
  const start = bot.entity.position;
  const steps = Math.ceil(start.distanceTo(target) / 0.2);
  for (let step = 1; step <= steps; step++) {
    const p = start.plus(target.minus(start).scaled(step / steps));
    if (obstruction(bot, p)) return false;
    for (const dx of [-0.3, 0.3])
      for (const dz of [-0.3, 0.3])
        for (const dy of [0, 1, 1.8]) {
          const block = bot.blockAt(p.offset(dx, dy, dz));
          if (!block || ["lava", "fire", "soul_fire"].includes(block.name)) return false;
        }
  }
  const feet = bot.blockAt(target);
  const floor = bot.blockAt(target.offset(0, -1, 0));
  return feet?.name === "water" || (floor?.boundingBox === "block" && floor.name !== "magma_block");
}

function swimCellOf(bot: Bot): SwimCellReader {
  return (x, y, z) => {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) return "unknown";
    if (["lava", "fire", "soul_fire", "magma_block"].includes(block.name)) return "solid";
    if (block.name === "water" || block.name === "bubble_column") return "water";
    return block.shapes.length > 0 ? "solid" : block.boundingBox === "empty" ? "air" : "solid";
  };
}

/**
 * The next swim toward the nearest open column, or the own column when it is open (the old recentre). A stroke is the
 * farthest cell of the exit path a straight swim reaches; a path that first goes up or down gives its first sideways
 * cell, and the loop asks again from where the stroke ended. Null when no open column lies in `SWIM_EXIT_RADIUS`.
 */
export function nearbySwimEscape(bot: Bot, blocked: readonly Vec3[] = []): Vec3 | null {
  const origin = bot.entity.position.floored();
  const path = swimExitPath(swimCellOf(bot), origin, blocked.map((point) => ({ x: Math.floor(point.x), z: Math.floor(point.z) })));
  if (path === null) return null;
  const strokes = (path.length === 0 ? [origin] : path).map(
    (cell) => new Vec3(cell.x + 0.5, bot.entity.position.y, cell.z + 0.5),
  );
  const clear = [...strokes].reverse().find((target) => !obstruction(bot, target.offset(0, 0.5, 0)) && clearSwim(bot, target));
  return clear ?? strokes.find((target) => target.x !== origin.x + 0.5 || target.z !== origin.z + 0.5) ?? strokes[0]!;
}
