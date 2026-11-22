/**
 * The cells whose change can turn a route cell unsafe because lava is about to flow into it.
 *
 * A route is planned on cells as they are; lava that was not beside a cell when the route was committed may be, a few
 * ticks later (a falling column landing, a flow reaching it: run 15, `spreading-lava-obstacle-course`). The plan's
 * dependencies are the cells its steps rely on, so a lava change beside a route cell must be one too, or the route
 * walks on as "irrelevant" until the lava is in the body's cell.
 */
import { type BlockPosition, type WorldView, blockKey } from "./world.js";

/** Lava this near the cell (blocks sideways) can reach it within a few flow steps. */
const WATCH_REACH = 2;
/** Falling lava starts above the body: look this far up, and one cell down for a flow under the floor's edge. */
const WATCH_RISE = 4;
const WATCH_DROP = 1;

const SIDES = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;

function lavaNear(world: Pick<WorldView, "blockAt">, cell: BlockPosition): boolean {
  const side = 2 * WATCH_REACH + 1;
  const height = WATCH_RISE + WATCH_DROP + 1;
  for (let index = 0; index < side * side * height; index += 1) {
    const block = world.blockAt(
      cell.x - WATCH_REACH + (index % side),
      cell.y - WATCH_DROP + Math.floor(index / (side * side)),
      cell.z - WATCH_REACH + (Math.floor(index / side) % side),
    );
    if (block.kind === "loaded" && block.traits.liquid === "lava") return true;
  }
  return false;
}

/**
 * The cells lava could flow through into the feet cell `cell` or its head cell, when any lava is near enough to matter:
 * the four sides of both and the cell above the head. Empty when there is no lava near, so a route through ordinary
 * terrain gains no dependency.
 */
export function lavaWatchCells(world: Pick<WorldView, "blockAt">, cell: BlockPosition): BlockPosition[] {
  return lavaNear(world, cell) ? lavaWatchedCells(cell) : [];
}

/**
 * The 9 cells lava could flow through into the feet cell `cell` or its head cell, with no look at what lies near: the
 * route's `lavaDependencies`. A flow that begins farther than the near-lava scan reaches the cell beside the route one
 * flow step before it fills the route cell, and a lava change there (not any change) is what invalidates the route.
 */
export function lavaWatchedCells(cell: BlockPosition): BlockPosition[] {
  const watched: BlockPosition[] = [{ x: cell.x, y: cell.y + 2, z: cell.z }];
  for (const rise of [0, 1]) for (const [dx, dz] of SIDES) watched.push({ x: cell.x + dx, y: cell.y + rise, z: cell.z + dz });
  return watched;
}

/** `RoutePlan.lavaDependencies`: the packed keys of `lavaWatchedCells` for every arrival cell of a route. */
export function routeLavaDependencies(arrivals: readonly BlockPosition[]): Set<number> {
  const keys = new Set<number>();
  for (const arrival of arrivals) for (const cell of lavaWatchedCells(arrival)) keys.add(blockKey(cell));
  return keys;
}
