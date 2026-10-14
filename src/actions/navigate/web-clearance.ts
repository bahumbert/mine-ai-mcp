import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { selectHarvestTool } from "../../navigation/mineflayer/movement-policy.js";

/**
 * Break the cobwebs the body already stands in before a route is walked.
 *
 * A route plans the webs it has to pass as digs, but a body in a web cannot jump or climb (the web scales its motion
 * to a crawl), so the step up the route begins with never lands (live 2026-10-10: Tom, a web in his head cell, five
 * routes in a row ended "No observed settled arrival"). The best carried tool breaks each, as a route's dig does.
 */
export async function clearBodyWebs(bot: Bot, signal?: AbortSignal): Promise<number> {
  let cleared = 0;
  const base = bot.entity.position.floored();
  for (const dy of [0, 1]) {
    const cell = new Vec3(base.x, base.y + dy, base.z);
    const block = bot.blockAt(cell);
    if (block?.name !== "cobweb" || !bot.canDigBlock(block)) continue;
    signal?.throwIfAborted();
    const tool = selectHarvestTool(bot, block);
    if (tool !== null) await bot.equip(tool, "hand").catch(() => undefined);
    try {
      await bot.dig(block, true);
      cleared += 1;
    } catch (cause) {
      signal?.throwIfAborted();
      // A web that stays is left to the route, whose own failure then says why.
      void cause;
    }
  }
  return cleared;
}
