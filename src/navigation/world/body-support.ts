// Whether removing a block removes the body's sole footprint support.
import { footprintStandsOnCell } from "../../world/player-physics.js";
import { isSafeSupport } from "./block-geometry.js";
import type { BlockPosition, Position3, WorldView } from "./world.js";

/** Whether the body's footprint depends on this block rather than another floor. */
export function bodyDependsOnBlock(position: Position3, floating: boolean, target: BlockPosition, read: WorldView["blockAt"]): boolean {
  if (floating || target.y !== Math.ceil(position.y) - 1) return false;
  return footprintStandsOnCell(position, target, (x, y, z) => isSafeSupport(read(x, y, z)));
}
