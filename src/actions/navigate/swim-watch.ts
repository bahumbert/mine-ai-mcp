/** The deep-water swim budget of a route with no boat, and whether the bot's feet are out at sea. */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { feetAtSea } from "../../navigation/mineflayer/movement-policy.js";
import { holdsWater } from "../../navigation/world/deep-water.js";

/**
 * More than this many blocks swum in a row through deep open water with no boat stops the route (run 10: Ayla swam
 * ~1500 blocks of sea; nothing measured the water during a route, only after it stopped).
 */
const SWIM_BUDGET = 32;

/**
 * Counts the blocks the bot moves in a row with its feet in deep open water; past {@link SWIM_BUDGET} its signal
 * aborts, to stop the route. Reaching shallows or land starts the count over.
 */
export function watchSwim(bot: Bot) {
  const stop = new AbortController();
  let last = bot.entity.position.clone();
  let cell = "";
  let atSea = false;
  let start: Vec3 | null = null;
  let swum = 0;
  const onMove = () => {
    const here = bot.entity.position;
    const moved = Math.hypot(here.x - last.x, here.z - last.z);
    last = here.clone();
    const feet = here.floored();
    const key = `${feet.x},${feet.y},${feet.z}`;
    if (key !== cell) {
      cell = key;
      atSea = standsAtSea(bot);
    }
    if (!atSea) {
      start = null;
      swum = 0;
      return;
    }
    start ??= feet;
    swum += moved;
    if (swum > SWIM_BUDGET && !stop.signal.aborted) stop.abort("[NAVIGATION_DEEP_WATER] swim budget spent");
  };
  bot.on("move", onMove);
  return {
    signal: stop.signal,
    close: () => void bot.off("move", onMove),
    exceeded: () => (stop.signal.aborted && start !== null ? { start, blocks: Math.floor(swum) } : null),
  };
}

/** Whether the bot's feet are in deep open water, by the same test the movement policy's sea exception uses. */
export function standsAtSea(bot: Bot): boolean {
  const water = (x: number, y: number, z: number) => {
    const block = bot.blockAt(new Vec3(x, y, z));
    return block !== null && holdsWater(block.name, block.getProperties?.() ?? {});
  };
  const feet = bot.entity.position.floored();
  return feetAtSea(water, feet, (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.boundingBox === "block");
}
