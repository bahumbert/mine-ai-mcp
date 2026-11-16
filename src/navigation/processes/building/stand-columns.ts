/**
 * Where to stand for the cells the ground cannot serve: a roof is worked from the top of a few pillars of scaffold, each
 * chosen to serve many cells, not from one block under each cell in turn (the roof call of 2026-11-12 laid its dirt in a
 * patch at ground level, each route spending its blocks on the nearest cell, never standing higher; spike 2026-11-16,
 * facts `houses.md` "Roof scaffold spike"). The reach is `build-reach.ts`'s; this file finds the columns the world allows
 * and hands them to its pure cover.
 */
import type { BlockPosition } from "../../index.js";
import {
  coverWithColumns,
  eyeOver,
  withinBlockReach,
  type ChosenColumn,
  type StandColumn,
} from "./build-reach.js";

export interface StandColumns {
  /** The columns to stand on, each with the blocks it takes above the ground. */
  readonly columns: readonly ChosenColumn[];
  /** The cells to place now (packed keys) that are out of reach from the ground and served by a chosen column's top. */
  readonly served: ReadonlySet<number>;
}

export interface StandColumnsQuery {
  /** Every cell the structure still owes (to place now, or waiting for a support or a block), with its packed key. */
  readonly cells: readonly (BlockPosition & { readonly key: number; readonly placeable: boolean })[];
  /** The feet level the bot walks on to the structure: a column of height h puts the feet at `ground + h`. */
  readonly ground: number;
  readonly range: number;
  /** The bot's feet cell: of equal columns the nearest one is taken. */
  readonly near: { readonly x: number; readonly z: number };
  /** Whether a route may stand in or pillar through this cell: passable in the world, and no block of the structure's own. */
  readonly isFree: (x: number, y: number, z: number) => boolean;
}

/**
 * How many blocks the column at x, z may be pillared above the ground, up to the level `top`: feet at `ground + height` need
 * that cell and the one above it free, and the cells under them are passed through on the way up. -1 when not even the
 * ground cell is free.
 */
function freeHeight(x: number, z: number, top: number, query: StandColumnsQuery): number {
  let height = 0;
  while (query.ground + height <= top && query.isFree(x, query.ground + height, z) && query.isFree(x, query.ground + height + 1, z)) {
    height += 1;
  }
  return height - 1;
}

/** The columns beside the cells that stand free from the ground up as high as any of them reaches. */
function candidateColumns(cells: readonly BlockPosition[], query: StandColumnsQuery): readonly StandColumn[] {
  const slack = Math.ceil(query.range);
  const top = Math.max(...cells.map((cell) => cell.y));
  const low = (axis: "x" | "z") => Math.min(...cells.map((cell) => cell[axis])) - slack;
  const high = (axis: "x" | "z") => Math.max(...cells.map((cell) => cell[axis])) + slack;
  const columns: StandColumn[] = [];
  for (let x = low("x"); x <= high("x"); x += 1) {
    for (let z = low("z"); z <= high("z"); z += 1) {
      const maxHeight = freeHeight(x, z, top, query);
      if (maxHeight >= 0) columns.push({ x, z, maxHeight });
    }
  }
  return columns;
}

/**
 * The stand columns for the cells still owed, none when the ground serves them all or no column the world allows does. The
 * cover is over every owed cell, the layers of a roof still to come included, so the layers share their pillars (planned a
 * layer at a time the same 15 x 12 roof took 78 blocks against 43: task review 2026-11-16); the goal takes only the columns
 * that serve a cell to place now, the others wait for their layer.
 */
export function planStandColumns(query: StandColumnsQuery): StandColumns {
  // A cell out of the eye's reach even from the ground straight under it is out of reach from every other column too: one
  // cheap cut, no world reads.
  const high = query.cells.filter(
    (cell) => !withinBlockReach(eyeOver({ x: cell.x, y: query.ground, z: cell.z }), cell, query.range),
  );
  if (!high.some((cell) => cell.placeable)) return { columns: [], served: new Set() };
  const covering = coverWithColumns(high, candidateColumns(high, query), query.ground, query.range, query.near);
  const reaches = (column: ChosenColumn, cell: BlockPosition) =>
    withinBlockReach(eyeOver({ x: column.x, y: query.ground + column.height, z: column.z }), cell, query.range);
  const placeable = high.filter((cell) => cell.placeable);
  const columns = covering.filter((column) => placeable.some((cell) => reaches(column, cell)));
  const served = new Set(placeable.filter((cell) => columns.some((column) => reaches(column, cell))).map((cell) => cell.key));
  return { columns, served };
}
