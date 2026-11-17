// Where a bot stands to build the cells the ground cannot serve: the brain's copy of the runtime's reach and stand-column
// cover (`src/navigation/processes/building/build-reach.ts` `withinBlockReach`, `coverWithColumns`; `stand-columns.ts`
// `planStandColumns`), written once here because `brain/` does not import `src/`. `scaffoldNeed` (`stage-progress.ts`)
// counts the blocks of the columns it gives. `stand-columns.test.ts` holds the two equal on shared cells (expected columns
// written out from the runtime's functions); a change to the runtime's rule changes both files and that test.

/** The block interaction range the runtime falls back to when the bot has no attribute (the brain has none): vanilla 1.21.4's survival range; the server took a placement 4.517 from the eye and refused 4.866 (facts houses.md "Roof scaffold spike"). */
export const BLOCK_REACH = 4.5;

/** The height of a standing bot's eye above its feet (`STANDING_EYE_HEIGHT`, `src/world/block-visibility.ts`; Mineflayer's 1.62). */
export const STANDING_EYE_HEIGHT = 1.62;

/** A point in space, as the eye is. */
export interface Point {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A cell of the world, by its lower corner. */
export interface Cell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A column the bot could stand on top of: the cell column, and the most blocks it may be pillared up before it is blocked. */
export interface StandColumn {
  readonly x: number;
  readonly z: number;
  readonly maxHeight: number;
}

/** A column chosen to stand on, with the blocks it takes: its top is the feet level `ground + height`. */
export interface ChosenColumn {
  readonly x: number;
  readonly z: number;
  readonly height: number;
}

/** The eye of a bot whose feet are in `feet`'s cell: over the middle of the cell, one standing eye height up. */
export function eyeOver(feet: Cell): Point {
  return { x: feet.x + 0.5, y: feet.y + STANDING_EYE_HEIGHT, z: feet.z + 0.5 };
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** The distance from `eye` to the nearest point of the cell's box (the square root of the summed squares, as the runtime's, so a cell exactly at the range is judged the same). */
function boxDistance(eye: Point, cell: Cell): number {
  const offsetX = clamp(eye.x, cell.x, cell.x + 1) - eye.x;
  const offsetY = clamp(eye.y, cell.y, cell.y + 1) - eye.y;
  const offsetZ = clamp(eye.z, cell.z, cell.z + 1) - eye.z;
  return Math.sqrt(offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ);
}

/** Whether the server would take a placement at this cell from this eye: the nearest point of its box within `range`. */
export function withinBlockReach(eye: Point, cell: Cell, range: number): boolean {
  return boxDistance(eye, cell) <= range;
}

/** The lowest number of blocks above `ground` a column must be pillared to for the eye to reach `cell`, or null when even `maxHeight` does not. */
function heightToReach(column: StandColumn, cell: Cell, ground: number, range: number): number | null {
  // Beside the cell farther than the range, no height reaches it: skip the climb.
  const beside = Math.hypot(clamp(column.x + 0.5, cell.x, cell.x + 1) - (column.x + 0.5), clamp(column.z + 0.5, cell.z, cell.z + 1) - (column.z + 0.5));
  if (beside > range) return null;
  for (let height = 0; height <= column.maxHeight; height += 1) {
    if (withinBlockReach(eyeOver({ x: column.x, y: ground + height, z: column.z }), cell, range)) return height;
  }
  return null;
}

interface ColumnChoice {
  readonly index: number;
  readonly height: number;
  readonly covers: number;
  readonly score: number;
  readonly distance: number;
}

const beats = (choice: ColumnChoice, best: ColumnChoice | null): boolean =>
  best === null ||
  choice.score > best.score ||
  (choice.score === best.score &&
    (choice.covers > best.covers || (choice.covers === best.covers && (choice.height < best.height || (choice.height === best.height && choice.distance < best.distance)))));

type Reaches = (index: number, height: number, cell: number) => boolean;

/** The column and height serving the most uncovered cells per block (ties: more cells, fewer blocks, nearest `near`), or null. */
function bestColumn(columns: readonly StandColumn[], needs: readonly (readonly number[])[], uncovered: readonly number[], near: { readonly x: number; readonly z: number }, reachesAt: Reaches): ColumnChoice | null {
  let best: ColumnChoice | null = null;
  for (const [index, column] of columns.entries()) {
    const distance = Math.hypot(column.x - near.x, column.z - near.z);
    // Heights worth trying: each one that some uncovered cell first becomes reachable at (a ground cell needs no column).
    const heights = new Set(uncovered.map((cell) => needs[index]![cell]!).filter((need) => need > 0 && need < Infinity));
    for (const height of heights) {
      const covers = uncovered.filter((cell) => reachesAt(index, height, cell)).length;
      const choice = { index, height, distance, covers, score: covers / height };
      best = beats(choice, best) ? choice : best;
    }
  }
  return best;
}

/**
 * The columns to stand on for `cells` (the ones out of reach from the ground): greedy, the most cells per block first, then
 * the column serving more cells, then the one with fewer blocks, then the one nearest `near`. A column's height is a feet
 * level above `ground` from which each cell it serves is in reach, tested at the chosen height (a taller column reaches less
 * of what lies far below its eye). A cell no offered column reaches is left out. The runtime's `coverWithColumns`, as is.
 */
export function coverWithColumns(cells: readonly Cell[], columns: readonly StandColumn[], ground: number, range: number, near: { readonly x: number; readonly z: number }): readonly ChosenColumn[] {
  const needs = columns.map((column) => cells.map((cell) => heightToReach(column, cell, ground, range) ?? Infinity));
  const reachesAt: Reaches = (index, height, cell) => withinBlockReach(eyeOver({ x: columns[index]!.x, y: ground + height, z: columns[index]!.z }), cells[cell]!, range);
  const chosen: ChosenColumn[] = [];
  let uncovered = cells.map((_cell, index) => index);
  for (;;) {
    const best = bestColumn(columns, needs, uncovered, near, reachesAt);
    if (best === null) return chosen;
    chosen.push({ x: columns[best.index]!.x, z: columns[best.index]!.z, height: best.height });
    uncovered = uncovered.filter((cell) => !reachesAt(best.index, best.height, cell));
  }
}

const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;

/**
 * The columns beside `cells` that are free from `ground` up as high as any of them reaches: a column's feet and head cells
 * hold none of the cells `closed` (the structure's own cells still to place and the house's built ones: `planStandColumns`'s
 * `freeHeight` over `isFree`). The terrain is not known here, so it is taken as free.
 */
function candidateColumns(high: readonly Cell[], closed: ReadonlySet<string>, ground: number, range: number): StandColumn[] {
  const slack = Math.ceil(range);
  const top = Math.max(...high.map((cell) => cell.y));
  const free = (x: number, y: number, z: number) => !closed.has(keyOf(x, y, z));
  const span = (axis: "x" | "z") => [Math.min(...high.map((cell) => cell[axis])) - slack, Math.max(...high.map((cell) => cell[axis])) + slack] as const;
  const [lowX, highX] = span("x");
  const [lowZ, highZ] = span("z");
  const columns: StandColumn[] = [];
  for (let x = lowX; x <= highX; x += 1) {
    for (let z = lowZ; z <= highZ; z += 1) {
      let height = 0;
      while (ground + height <= top && free(x, ground + height, z) && free(x, ground + height + 1, z)) height += 1;
      if (height > 0) columns.push({ x, z, maxHeight: height - 1 });
    }
  }
  return columns;
}

/** Whether the eye of a bot standing on the ground straight under `cell` (feet level `ground`) cannot reach it: a cell a stand column serves. */
export const outOfReachFromGround = (cell: Cell, ground: number): boolean => !withinBlockReach(eyeOver({ x: cell.x, y: ground, z: cell.z }), cell, BLOCK_REACH);

/**
 * The stand columns for `cells`, the blocks still to place (air left out by the caller), from a bot walking on feet level
 * `ground`: none when the eye reaches every cell from the ground straight under it, else the runtime's cover of the cells it
 * does not reach. `built`: the house's cells standing when they are placed (the earlier calls', air left out by the caller): no
 * column passes through one, as the runtime's `isFree` refuses its `keep` cells. `near` breaks ties (the runtime takes the
 * bot's feet; the brain has the bot's place only roughly).
 */
export function columnsForCells(cells: readonly Cell[], ground: number, near: { readonly x: number; readonly z: number }, built: readonly Cell[]): readonly ChosenColumn[] {
  const high = cells.filter((cell) => outOfReachFromGround(cell, ground));
  if (high.length === 0) return [];
  const closed = new Set([...cells, ...built].map((cell) => keyOf(cell.x, cell.y, cell.z)));
  return coverWithColumns(high, candidateColumns(high, closed, ground, BLOCK_REACH), ground, BLOCK_REACH, near);
}
