// Where a bot stands to build the cells the ground cannot serve: the runtime's reach and stand-column cover, imported through `#src/` (`src/navigation/processes/building/stand-cover.ts`, ADR-003, owner O1; no copy here except `BLOCK_REACH` below, a copy of `DEFAULT_BLOCK_RANGE` in `build-reach.ts`), with the brain's own candidate columns. `scaffoldNeed` (`stage-progress.ts`) counts the blocks of the columns it gives. `stand-columns.test.ts` writes the expected columns out from the runtime's functions.
import { coverWithColumns, eyeOver, withinBlockReach, type ChosenColumn, type StandColumn } from "#src/navigation/processes/building/stand-cover.ts";

export { coverWithColumns, eyeOver, withinBlockReach, type ChosenColumn, type Point, type StandColumn } from "#src/navigation/processes/building/stand-cover.ts";
export { STANDING_EYE_HEIGHT } from "#src/world/block-visibility.ts";

/** The block interaction range the runtime falls back to when the bot has no attribute (the brain has none): vanilla 1.21.4's survival range; the server took a placement 4.517 from the eye and refused 4.866 (facts houses.md "Roof scaffold spike"). */
export const BLOCK_REACH = 4.5;

/** A cell of the world, by its lower corner. */
export interface Cell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
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
