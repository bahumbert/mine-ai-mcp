/** The cells a movement that carries past its destination may end on. */
import { hasUnstableFallingSupport, isHeadPassable, isPassable, isSafeSupport } from "../world/block-geometry.js";
import type { BlockPosition } from "../world/world.js";
import type { MovementGenerationContext } from "./catalogue.js";

/**
 * Where a movement that carries past its destination may end up.
 *
 * A drop or a sprint jump lands with momentum. Observed: a four-block parkour
 * span landed at x 13.19 on ground when the plan named 12.5, and the run
 * reported a movement failure for what was a clean landing one block along.
 * The cell one further in the direction of travel is a valid arrival when the
 * bot could stand there.
 */
export function arrivals(
  context: MovementGenerationContext,
  destination: BlockPosition,
  dx: number,
  dz: number,
): readonly BlockPosition[] {
  const x = destination.x + dx;
  const z = destination.z + dz;
  const y = destination.y;
  const cells = context.cells;
  const clear =
    isPassable(cells.look(x, y, z)) &&
    isHeadPassable(cells.look(x, y + 1, z)) &&
    isSafeSupport(cells.look(x, y - 1, z)) &&
    !hasUnstableFallingSupport(context.view.blockAt, x, y - 1, z);
  return clear ? [destination, { x, y, z }] : [destination];
}
