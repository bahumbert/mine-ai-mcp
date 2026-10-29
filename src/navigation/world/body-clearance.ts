/**
 * A body standing inside a blocked cell, beside the box that makes it blocked.
 *
 * A bamboo stalk is 3/16 wide and stands off centre, so a body can stand with its centre in the stalk's cell, flush
 * with the stalk (live 2026-10-19, Ayla at 191.249, 292.64375 beside the stalk at 191,78,292). Search never puts the
 * body in a blocked cell, and the first step from there steers in a straight line to the next cell's centre: two of
 * the four ways out cross the stalk, so the step stalls. These two functions find that state and a side to step out to.
 */
import { isHeadPassable, isPassable, isSafeSupport, navigationFeet } from "./block-geometry.js";
import { type BlockPosition, type CollisionBox, type Position3, type WorldView, collisionBoxesAt } from "./world.js";

const HALF_WIDTH = 0.3;
const BODY_HEIGHT = 1.8;
/** How far the body could reach in one step: a box farther than this from its square is not beside it. */
const REACH = 0.3;
/** A box top this close to the feet is a floor the body rests on, not a wall beside it. */
const RESTING_TOLERANCE = 0.01;
const ABOVE_FEET = 0.001;
/** Boxes overlap only when they share more than this, so flush bodies and boxes do not count. */
const OVERLAP_EPSILON = 1e-7;
const SWEEP_STEP = 0.05;

/** Neighbour offsets of a cell on x and z. */
const SIDES: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/**
 * The feet cell when the body stands inside it beside a box that reaches above the feet and could be touched in one
 * step, else null: a cell the body passes through (carpet, ladder, open door, water), a body resting on its own block
 * (slab, stair step, bed), and an unloaded cell are not partial.
 */
export function partialCellAt(world: WorldView, position: Position3): BlockPosition | null {
  const feet = navigationFeet(position, true);
  const feetBlock = world.blockAt(feet.x, feet.y, feet.z);
  if (feetBlock.kind !== "loaded" || isPassable(feetBlock)) return null;
  const feetBoxes = collisionBoxesAt(feetBlock, feet.x, feet.z);
  if (feetBoxes.some((box) => restsOn(box, feet, position))) return null;
  const headBlock = world.blockAt(feet.x, feet.y + 1, feet.z);
  const headBoxes = headBlock.kind === "loaded" ? collisionBoxesAt(headBlock, feet.x, feet.z) : [];
  const besideTheBody = (box: CollisionBox, cellY: number) =>
    cellY + box.maxY > position.y + ABOVE_FEET &&
    cellY + box.minY < position.y + BODY_HEIGHT &&
    feet.x + box.maxX > position.x - HALF_WIDTH - REACH &&
    feet.x + box.minX < position.x + HALF_WIDTH + REACH &&
    feet.z + box.maxZ > position.z - HALF_WIDTH - REACH &&
    feet.z + box.minZ < position.z + HALF_WIDTH + REACH;
  return feetBoxes.some((box) => besideTheBody(box, feet.y)) || headBoxes.some((box) => besideTheBody(box, feet.y + 1))
    ? feet
    : null;
}

function restsOn(box: CollisionBox, cell: BlockPosition, position: Position3): boolean {
  return (
    Math.abs(cell.y + box.maxY - position.y) <= RESTING_TOLERANCE &&
    cell.x + box.maxX > position.x - HALF_WIDTH &&
    cell.x + box.minX < position.x + HALF_WIDTH &&
    cell.z + box.maxZ > position.z - HALF_WIDTH &&
    cell.z + box.minZ < position.z + HALF_WIDTH
  );
}

/**
 * The nearest side neighbour of the feet cell the body can walk out to in a straight line, or null. The neighbour must
 * be free for a body (feet, head, safe support under it) and the straight sweep to its centre must touch no placed box
 * the body does not already overlap at the start: vanilla lets a body move out of a box it is in, never into one.
 */
export function partialCellExit(world: WorldView, position: Position3): BlockPosition | null {
  const feet = navigationFeet(position, true);
  const centreDistance = (at: BlockPosition) => Math.hypot(at.x + 0.5 - position.x, at.z + 0.5 - position.z);
  const candidates = SIDES.map(([dx, dz]) => ({ x: feet.x + dx, y: feet.y, z: feet.z + dz })).sort(
    (a, b) => centreDistance(a) - centreDistance(b),
  );
  for (const at of candidates) {
    if (
      isPassable(world.blockAt(at.x, at.y, at.z)) &&
      isHeadPassable(world.blockAt(at.x, at.y + 1, at.z)) &&
      isSafeSupport(world.blockAt(at.x, at.y - 1, at.z)) &&
      sweepIsClear(world, position, { x: at.x + 0.5, z: at.z + 0.5 })
    )
      return at;
  }
  return null;
}

function sweepIsClear(world: WorldView, from: Position3, to: { readonly x: number; readonly z: number }): boolean {
  const alreadyInside = boxesOverlapping(world, from.x, from.y, from.z);
  if (alreadyInside === null) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / SWEEP_STEP));
  for (let step = 1; step <= steps; step += 1) {
    const x = from.x + ((to.x - from.x) * step) / steps;
    const z = from.z + ((to.z - from.z) * step) / steps;
    const overlapping = boxesOverlapping(world, x, from.y, z);
    if (overlapping === null) return false;
    for (const key of overlapping) if (!alreadyInside.has(key)) return false;
  }
  return true;
}

/** The boxes the body at x, y, z overlaps, by cell and index, or null when a cell it covers is unloaded. */
function boxesOverlapping(world: WorldView, x: number, y: number, z: number): Set<string> | null {
  const overlapping = new Set<string>();
  for (let cellY = Math.floor(y); cellY <= Math.floor(y + BODY_HEIGHT - OVERLAP_EPSILON); cellY += 1)
    for (let cellX = Math.floor(x - HALF_WIDTH); cellX <= Math.floor(x + HALF_WIDTH); cellX += 1)
      for (let cellZ = Math.floor(z - HALF_WIDTH); cellZ <= Math.floor(z + HALF_WIDTH); cellZ += 1) {
        const block = world.blockAt(cellX, cellY, cellZ);
        if (block.kind !== "loaded") return null;
        collisionBoxesAt(block, cellX, cellZ).forEach((box, index) => {
          const shares =
            cellX + box.maxX - (x - HALF_WIDTH) > OVERLAP_EPSILON &&
            x + HALF_WIDTH - (cellX + box.minX) > OVERLAP_EPSILON &&
            cellZ + box.maxZ - (z - HALF_WIDTH) > OVERLAP_EPSILON &&
            z + HALF_WIDTH - (cellZ + box.minZ) > OVERLAP_EPSILON &&
            cellY + box.maxY - y > OVERLAP_EPSILON &&
            y + BODY_HEIGHT - (cellY + box.minY) > OVERLAP_EPSILON;
          if (shares) overlapping.add(`${cellX},${cellY},${cellZ}#${index}`);
        });
      }
  return overlapping;
}
