import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BLOCK_RANGE } from "./build-reach.js";
import { planStandColumns, type StandColumnsQuery } from "./stand-columns.js";

const cell = (x: number, y: number, z: number, placeable: boolean) => ({ x, y, z, key: (y * 1000 + x) * 1000 + z, placeable });

function query(cells: StandColumnsQuery["cells"], isFree: StandColumnsQuery["isFree"] = () => true): StandColumnsQuery {
  return { cells, ground: 64, range: DEFAULT_BLOCK_RANGE, near: { x: 0, z: 0 }, isFree };
}

test("the plan covers every cell still owed, so the layers of a roof share their pillars: a column for the layer above also serves the one placeable now", () => {
  const now = cell(0, 72, 0, true);
  const later = cell(0, 74, 0, false);
  // The cell to place now alone takes a column 2 high; with the layer above owed, one column 4 high serves both.
  assert.deepEqual(planStandColumns(query([now])).columns, [{ x: 0, z: 0, height: 2 }]);
  const plan = planStandColumns(query([now, later]));
  assert.deepEqual(plan.columns, [{ x: 0, z: 0, height: 4 }]);
  assert.deepEqual([...plan.served], [now.key], "only a cell to place is served: the later one is not a target yet");
});

test("a column that serves no cell to place now is not a goal yet", () => {
  const now = cell(0, 72, 0, true);
  const farLater = cell(30, 72, 0, false);
  const plan = planStandColumns(query([now, farLater]));
  assert.deepEqual(plan.columns, [{ x: 0, z: 0, height: 2 }], "the column for the far cell waits until that cell is placeable");
});

test("no cell to place, or all within reach from the ground: no column", () => {
  assert.deepEqual(planStandColumns(query([cell(0, 72, 0, false)])).columns, []);
  assert.deepEqual(planStandColumns(query([cell(0, 69, 0, true)])).columns, []);
});

test("a column is as high as its cells stay free, and none stands in a cell that is not", () => {
  const ceiling = (x: number, y: number) => !(y >= 67 && Math.abs(x) <= 1);
  // Free up to feet 65 (cells 65 and 66) for the columns under the ceiling: too low for a cell 8 up, so a column beside serves it.
  const plan = planStandColumns(query([cell(0, 72, 0, true)], (x, y) => ceiling(x, y)));
  assert.equal(plan.columns.length, 1);
  assert.ok(Math.abs(plan.columns[0]!.x) >= 2, `a column clear of the ceiling: ${JSON.stringify(plan.columns)}`);
});
