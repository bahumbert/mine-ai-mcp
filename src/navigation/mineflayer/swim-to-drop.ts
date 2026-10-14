import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Swims or walks in a straight line to a dropped item the bot wants back, a few blocks off (a boat's item that drifted
 * from the bank, spec 2026-10-04 deep-water-and-boats), until `done` or `timeoutMs`. No route: only for a short way
 * over open water, where nothing stands in it.
 */
export async function swimToDrop(bot: Bot, wanted: (item: { readonly name: string }) => boolean, reach: number, done: () => boolean, timeoutMs: number): Promise<void> {
  const drop = () => Object.values(bot.entities).find((entity) => {
    if (entity.name !== "item" || entity.position.distanceTo(bot.entity.position) > reach) return false;
    const item = (entity as Entity & { getDroppedItem?: () => { readonly name: string } | null }).getDroppedItem?.();
    return item !== null && item !== undefined && wanted(item);
  });
  const deadline = Date.now() + timeoutMs;
  try {
    for (let item = drop(); item !== undefined && !done() && Date.now() < deadline; item = drop()) {
      await bot.lookAt(item.position, true);
      bot.setControlState("forward", true);
      bot.setControlState("jump", (bot.entity as Entity & { readonly isInWater?: boolean }).isInWater === true || item.position.y > bot.entity.position.y + 0.5);
      await sleep(100);
    }
  } finally {
    bot.clearControlStates();
  }
}
