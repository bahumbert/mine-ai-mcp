import { isHeadPassable, isSafeSupport } from "./block-geometry.js";
import type { BlockPosition, Position3, WorldView } from "./world.js";

// Measured on our pinned 1.21.4 physics: sink .025, rise .175 blocks/tick.
// Include acceleration and centring, rather than pricing terminal speed alone.
export const SWIM_DOWN_TICKS = 44;
export const SWIM_UP_TICKS = 10;
export const SWIM_HORIZONTAL_TICKS = 14;
export const DIVE_RESERVE_TICKS = 65;
export const DIVE_BACKSTOP_TICKS = 25;

/** How far above a swimmer the column is read for a way up. */
export const OPEN_COLUMN_REACH = 32;

/** A loaded ascent column. Its bottom may be one newly excavated pickup cell. */
export function openWaterSurface(read: WorldView["blockAt"], feet: BlockPosition): BlockPosition | null {
  for (let y = feet.y; y <= feet.y + OPEN_COLUMN_REACH; y++) {
    const body = read(feet.x, y, feet.z);
    const head = read(feet.x, y + 1, feet.z);
    if (body.kind !== "loaded" || head.kind !== "loaded") return null;
    if (body.traits.waterlogged || head.traits.waterlogged) return null;
    const pickupHole = y === feet.y && isSafeSupport(read(feet.x, y - 1, feet.z)) &&
      head.traits.liquid === "water" && head.traits.liquidSource;
    // A mined floor is briefly air before its source-water neighbour flows in.
    // Both observations leave the same one-cell, supported escape corridor.
    if ((!pickupHole && (body.traits.liquid !== "water" || !body.traits.liquidSource)) ||
      (pickupHole && body.traits.liquid !== "water" && (body.traits.liquid !== null || !isHeadPassable(body))) || body.collisionShapes.length > 0) return null;
    if (head.traits.liquid === null && isHeadPassable(head)) return { x: feet.x, y, z: feet.z };
    if (head.traits.liquid !== "water" || !head.traits.liquidSource || head.collisionShapes.length > 0) return null;
  }
  return null;
}

/** What a swimmer meets in a cell. Lava, damaging blocks and anything with a collision shape count as solid. */
export type SwimCell = "water" | "air" | "solid" | "unknown";
export type SwimCellReader = (x: number, y: number, z: number) => SwimCell;

/** How far around the swimmer, in every direction, an exit is looked for. */
export const SWIM_EXIT_RADIUS = 12;

/** The cell as a swimmer meets it, from the observed world. */
export function swimCellsOf(read: WorldView["blockAt"]): SwimCellReader {
  return (x, y, z) => {
    const block = read(x, y, z);
    if (block.kind !== "loaded") return "unknown";
    if (block.traits.liquid === "lava" || block.traits.damaging || block.collisionShapes.length > 0) return "solid";
    return block.traits.liquid === "water" || block.traits.waterlogged ? "water" : "air";
  };
}

const passable = (cell: SwimCell) => cell === "water" || cell === "air";

/** Whether water and air alone, with no roof, lead from this cell up to open sky as far as the column is known. */
function columnOpen(read: SwimCellReader, x: number, y: number, z: number): boolean {
  let airSeen = false;
  for (let above = y; above <= y + OPEN_COLUMN_REACH; above++) {
    const cell = read(x, above, z);
    if (cell === "unknown") return airSeen;
    if (cell === "solid") return false;
    if (cell === "air") airSeen = true;
  }
  return true;
}

const STEPS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
  [0, 1, 0],
  [0, -1, 0],
] as const;

/**
 * The nearest cell, by breadth-first swim through the water and air a body fits in (two cells high), that `goal`
 * accepts: the cells run from the first stroke to it; empty when the start is itself accepted; null when none lies
 * within the radius.
 */
function swimPath(
  read: SwimCellReader,
  start: BlockPosition,
  goal: (cell: BlockPosition) => boolean,
  radius: number,
): BlockPosition[] | null {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const fits = (x: number, y: number, z: number) => passable(read(x, y, z)) && passable(read(x, y + 1, z));
  const parents = new Map<string, string | null>([[key(start.x, start.y, start.z), null]]);
  const cells = new Map<string, BlockPosition>([[key(start.x, start.y, start.z), start]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head]!;
    if (goal(cell)) {
      const path: BlockPosition[] = [];
      for (let at: string | null | undefined = key(cell.x, cell.y, cell.z); at; at = parents.get(at))
        if (parents.get(at) !== null) path.unshift(cells.get(at)!);
      return path;
    }
    for (const [dx, dy, dz] of STEPS) {
      const next = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz };
      if (Math.max(Math.abs(next.x - start.x), Math.abs(next.y - start.y), Math.abs(next.z - start.z)) > radius) continue;
      const id = key(next.x, next.y, next.z);
      if (parents.has(id) || !fits(next.x, next.y, next.z)) continue;
      parents.set(id, key(cell.x, cell.y, cell.z));
      cells.set(id, next);
      queue.push(next);
    }
  }
  return null;
}

/**
 * The swim from `start` to the nearest cell whose column is open all the way up, so an overhang is swum round, never
 * judged by a straight line. Empty when the start is itself under open sky; null when no exit lies within the radius.
 * `blocked` names columns already tried in vain: they are crossed but never chosen.
 */
export function swimExitPath(
  read: SwimCellReader,
  start: BlockPosition,
  blocked: readonly { x: number; z: number }[] = [],
  radius = SWIM_EXIT_RADIUS,
): BlockPosition[] | null {
  const isBlocked = (x: number, z: number) => blocked.some((column) => column.x === x && column.z === z);
  return swimPath(read, start, (cell) => !isBlocked(cell.x, cell.z) && columnOpen(read, cell.x, cell.y + 1, cell.z), radius);
}

/**
 * The swim from `start` to the nearest cell where the body fits and the head is in air, an air pocket included
 * (`swimExitPath` wants a column open to the sky, which a roofed stream or pocket never has). Empty when the head is
 * already in air; null when no such cell lies within the radius.
 */
export function swimBreathPath(read: SwimCellReader, start: BlockPosition, radius = SWIM_EXIT_RADIUS): BlockPosition[] | null {
  const bodyFits = (cell: BlockPosition) => passable(read(cell.x, cell.y, cell.z)) && read(cell.x, cell.y + 1, cell.z) === "air";
  return swimPath(read, start, bodyFits, radius);
}


export function swimTravelTicks(from: Position3, to: Position3): number {
  return Math.hypot(to.x - from.x, to.z - from.z) * SWIM_HORIZONTAL_TICKS +
    Math.max(0, from.y - to.y) * SWIM_DOWN_TICKS + Math.max(0, to.y - from.y) * SWIM_UP_TICKS + 8;
}

/** Apply jump early enough to arrest sinking; release early enough to arrest lift. */
export function holdSwimDepth(y: number, velocityY: number, targetY: number): boolean {
  return y + velocityY * 4 < targetY;
}

export interface DiveAdmission {
  readonly origin: Position3;
  readonly airTicks: number;
}

/** Ticks to swim the exit path from its first stroke, each stroke priced by its direction as `swimTravelTicks` does. */
function exitTravelTicks(from: BlockPosition, path: readonly BlockPosition[]): number {
  let ticks = 8;
  let at = from;
  for (const next of path) {
    ticks += next.y < at.y ? SWIM_DOWN_TICKS : next.y > at.y ? SWIM_UP_TICKS : SWIM_HORIZONTAL_TICKS;
    at = next;
  }
  return ticks;
}

/** Ticks of held breath on a swim to a breathing cell: a stroke costs only while the head is under water at either end. */
function breathTravelTicks(read: SwimCellReader, from: BlockPosition, path: readonly BlockPosition[]): number {
  let ticks = 0;
  let at = from;
  for (const next of path) {
    if (read(at.x, at.y + 1, at.z) === "water" || read(next.x, next.y + 1, next.z) === "water")
      ticks += (ticks === 0 ? 8 : 0) + (next.y < at.y ? SWIM_DOWN_TICKS : next.y > at.y ? SWIM_UP_TICKS : SWIM_HORIZONTAL_TICKS);
    at = next;
  }
  return ticks;
}

/** The way up to air from a submerged cell: the cell where the head breaks the surface, and the ticks the swim takes. */
export interface SwimAscent {
  readonly surface: BlockPosition;
  readonly ticks: number;
}

/**
 * The way up from `feet`: straight up an open column, else the nearest cell with the head in air (an air pocket or a
 * stream with air round the head counts), else, under a roof, the swim to the nearest open column
 * (`swimExitPath`) and the rise there. Null when neither leads to air (live 2026-10-10: a bot on the sea floor under
 * an overhang had no ascent for the planner, so no route out).
 */
export function swimAscent(read: WorldView["blockAt"], feet: BlockPosition): SwimAscent | null {
  const direct = openWaterSurface(read, feet);
  if (direct !== null) return { surface: direct, ticks: swimTravelTicks(feet, direct) };
  const cells = swimCellsOf(read);
  const breath = swimBreathPath(cells, feet);
  if (breath !== null) return { surface: breath.at(-1) ?? feet, ticks: breathTravelTicks(cells, feet, breath) };
  const path = swimExitPath(cells, feet);
  if (path === null) return null;
  const exit = path.at(-1) ?? feet;
  let top = exit.y;
  while (cells(exit.x, top + 1, exit.z) === "water") top++;
  const surface = { x: exit.x, y: top, z: exit.z };
  return { surface, ticks: exitTravelTicks(feet, path) + swimTravelTicks(exit, surface) };
}

export function admitsDive(read: WorldView["blockAt"], feet: BlockPosition, budget: DiveAdmission, workTicks = 0): boolean {
  const ascent = swimAscent(read, feet);
  return ascent !== null && swimTravelTicks(budget.origin, feet) + workTicks + ascent.ticks + DIVE_RESERVE_TICKS <=
    budget.airTicks;
}
