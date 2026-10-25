import type { Bot } from "mineflayer";
import { liveBlockReader } from "./world.js";
import { isWater } from "../world/block-geometry.js";
import { waterOccupancy } from "../world/water.js";
import type { BlockPosition } from "../world/world.js";
import { admitsDive } from "../world/swimming.js";

/** Public destination admission uses the same water geometry as route search. */
export function canOccupyWater(bot: Bot, feet: BlockPosition): boolean {
  const read = liveBlockReader(bot);
  if (!isWater(read(feet.x, feet.y, feet.z))) return false;
  const occupancy = waterOccupancy(read, feet.x, feet.y, feet.z);
  // Public geometry asks whether a full-air approach could work. Runtime uses live air.
  return occupancy === "submerged" ? admitsDive(read, feet, { origin: feet, airTicks: 300 }) : occupancy !== "unavailable";
}
