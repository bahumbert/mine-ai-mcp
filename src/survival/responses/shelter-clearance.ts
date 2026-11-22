// Safe excavation of an obstructed wall within the hide's remaining construction budget.
import type { Vec3 } from "vec3";
import { createMovements, nativeDigTicks, selectHarvestTool } from "../../navigation/index.js";
import { monotonicNow } from "../../utils/index.js";
import { MS_PER_ON_TIME_TICK } from "../../world/world-age.js";
import type { ShelterBuild } from "./shelter-build.js";

/** Refuse unsafe or slow removal before borrowing navigation's confirmed in-place break. */
export async function clearShelterCell(build: ShelterBuild, cell: Vec3, signal: AbortSignal): Promise<string> {
  const { bot, options } = build;
  const navigation = options.navigation!;
  signal.throwIfAborted();
  const above = navigation.world.blockAt(cell.x, cell.y + 1, cell.z);
  if (above.kind !== "loaded") return "The cell above is not loaded. Choose another shelter cell.";
  if (above.traits.falling) return "A falling block above would enter the wall opening. Choose another shelter cell.";
  const block = bot.blockAt(cell);
  if (!block) return "The wall cell is not loaded. Choose another shelter cell.";
  const tool = selectHarvestTool(bot, block);
  if (tool && bot.heldItem !== tool) await bot.equip(tool, "hand");
  signal.throwIfAborted();
  const diggingMs = nativeDigTicks(bot.digTime(block)) * MS_PER_ON_TIME_TICK;
  const leftMs = Math.max(0, build.constructionDeadline - monotonicNow());
  if (diggingMs > leftMs)
    return `wall cell ${block.name} digs in ${(bot.digTime(block) / 1000).toFixed(1)} s, ${(leftMs / 1000).toFixed(1)} s left; ` +
      `${(diggingMs / 1000).toFixed(1)} s including the server answer. ` +
      "Use a faster tool or another shelter cell.";
  const result = await navigation.breakBlockInPlace({
    position: cell, movements: createMovements(bot, { allowDigging: true, scaffolding: false }), signal,
  });
  signal.throwIfAborted();
  return result.status === "broken" ? "cleared" : result.reason;
}
