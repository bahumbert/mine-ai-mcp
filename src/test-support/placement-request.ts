import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { BlockPlacement, InventoryItem, WorldBlock } from "../world/placement.js";

/**
 * A placement request of `item` into `target` against the floor block under it; `extra` adds or overrides the request's
 * fields (a look direction, a signal, `lifeSaving`).
 */
export function placementAt(bot: Bot, item: InventoryItem, target: Vec3, extra: Partial<BlockPlacement> = {}): BlockPlacement {
  return {
    item,
    support: bot.blockAt(target.offset(0, -1, 0))!,
    face: new Vec3(0, 1, 0),
    expectedCells: [target] as [Vec3],
    matches: (block: WorldBlock) => block.name === item.name,
    ...extra,
  };
}
