// The brain's stand-column cover: the runtime's rule imported through `#src/` (`stand-cover.ts`, re-exported by
// `stand-columns.ts`; `build-reach.ts` re-exports it for the runtime). The expected columns below are written out from the runtime's own
// functions on the same input (plan 2026-11-14-house-build-fixes-2 Task 2c), so a change to either side fails here.
import assert from "node:assert/strict";
import test from "node:test";
import { planTemplate } from "./plan.ts";
import { BLOCK_REACH, columnsForCells, coverWithColumns, eyeOver, withinBlockReach, type StandColumn } from "./stand-columns.ts";
import { callWorks, stageCells } from "./stage-progress.ts";
import { templateFor } from "./templates.ts";

const EYE = eyeOver({ x: 0, y: 64, z: 0 });
const NEAR = { x: 0, z: 0 };

/** Candidate columns in a row at z 0: x from `from` to `to`, any height up to `maxHeight`. */
const row = (from: number, to: number, maxHeight = 8): StandColumn[] => Array.from({ length: to - from + 1 }, (_unused, index) => ({ x: from + index, z: 0, maxHeight }));
const cover = (cells: { x: number; y: number; z: number }[], columns: StandColumn[], near = NEAR) => coverWithColumns(cells, columns, 64, BLOCK_REACH, near);

test("the range is the vanilla 4.5 the runtime falls back to (the brain has no bot attribute: facts houses.md 'Roof scaffold spike')", () => {
  assert.equal(BLOCK_REACH, 4.5);
});

test("a cell is in reach when the nearest point of its box is within the range of the eye (the runtime's rows)", () => {
  for (const { cell, reached, range = BLOCK_REACH, name } of [
    { cell: { x: 0, y: 70, z: 0 }, reached: true, name: "6 above the feet, straight up: 4.38" },
    { cell: { x: 0, y: 70, z: 0 }, reached: false, range: 4, name: "at range 4 the same cell is out" },
    { cell: { x: 0, y: 71, z: 0 }, reached: false, name: "7 above: 5.38" },
    { cell: { x: 4, y: 64, z: 0 }, reached: true, name: "4 away on the floor level" },
    { cell: { x: 5, y: 65, z: 0 }, reached: true, name: "4.5 away on the eye's level: the range is inclusive" },
    { cell: { x: 6, y: 65, z: 0 }, reached: false, name: "5.5 away" },
    { cell: { x: 0, y: 61, z: 0 }, reached: true, name: "below, the upper face: 3.62" },
    { cell: { x: 0, y: 60, z: 0 }, reached: false, name: "4.62 below" },
  ]) {
    assert.equal(withinBlockReach(EYE, cell, range), reached, name);
  }
});

test("the cover gives the columns and heights the runtime gives on the same cells (expected values written out from the runtime)", () => {
  const eave = (length: number) => Array.from({ length }, (_unused, x) => ({ x, y: 72, z: 0 }));
  assert.deepEqual(cover([{ x: 0, y: 72, z: 0 }], row(0, 0)), [{ x: 0, z: 0, height: 2 }], "8 above, straight over the column");
  assert.deepEqual(cover([{ x: 2, y: 72, z: 0 }], row(0, 0)), [{ x: 0, z: 0, height: 3 }], "2 away horizontally");
  assert.deepEqual(cover(eave(7), row(-2, 9)), [{ x: 3, z: 0, height: 3 }], "a 7-wide eave: one column in its middle");
  assert.deepEqual(cover(eave(15), row(-2, 17)), [{ x: 3, z: 0, height: 3 }, { x: 10, z: 0, height: 3 }, { x: 13, z: 0, height: 2 }], "a 15-wide eave");
  assert.deepEqual(cover([{ x: 0, y: 72, z: 0 }], row(-1, 1), { x: 1, z: 0 }), [{ x: 1, z: 0, height: 2 }], "of equal columns the nearest");
  assert.deepEqual(cover([{ x: 0, y: 72, z: 0 }, { x: 0, y: 74, z: 0 }], row(0, 0)), [{ x: 0, z: 0, height: 4 }], "one column of 4 serves both layers: fewer pillars");
  assert.deepEqual(cover([{ x: 0, y: 72, z: 0 }], row(0, 0, 1)), [], "a column too short to reach serves nothing");
  assert.deepEqual(cover([{ x: 0, y: 72, z: 0 }, { x: 40, y: 72, z: 0 }], row(0, 0)), [{ x: 0, z: 0, height: 2 }], "a cell no column serves is left out");
  const mixed = [
    { x: 2, y: 82, z: 0 }, { x: -4, y: 76, z: 0 }, { x: 3, y: 80, z: 0 }, { x: -7, y: 80, z: 0 }, { x: 0, y: 83, z: 0 },
    { x: 5, y: 72, z: 0 }, { x: 1, y: 83, z: 0 }, { x: 6, y: 76, z: 0 },
  ];
  assert.deepEqual(cover(mixed, row(-10, 10, 24)), [{ x: 4, z: 0, height: 2 }, { x: -2, z: 0, height: 15 }, { x: 5, z: 0, height: 6 }], "coverage is tested at the chosen height");
  const patch = Array.from({ length: 81 }, (_unused, index) => ({ x: index % 9, y: 74, z: Math.floor(index / 9) }));
  const plane = Array.from({ length: 17 * 17 }, (_unused, index) => ({ x: -4 + (index % 17), z: -4 + Math.floor(index / 17), maxHeight: 12 }));
  const chosen = [{ x: 4, z: 4, height: 6 }, { x: 4, z: 4, height: 8 }];
  assert.deepEqual(cover(patch, plane), [...chosen, { x: 4, z: 0, height: 6 }, { x: 4, z: 6, height: 6 }], "a 9 x 9 patch, the bot at its corner");
  assert.deepEqual(cover(patch, plane, { x: 8, z: 8 }), [...chosen, { x: 8, z: 4, height: 6 }, { x: 2, z: 4, height: 6 }], "the same patch, the bot at the far corner: the ties go to the nearest");
});

test("a cell 8 above the ground on a 1-wide tower is served by a 2-block column beside it (scenario roof-cell-from-a-stand-column)", () => {
  assert.deepEqual(columnsForCells([{ x: 0, y: 72, z: 0 }], 64, NEAR, []).map(({ height }) => height), [2]);
});

test("a column through a built cell is not a stand column: the 3 x 3 columns under the cell are closed, the next ring is farther and taller (3 blocks, not 2)", () => {
  const ring = Array.from({ length: 9 * 7 }, (_unused, index) => ({ x: (index % 3) - 1, y: 64 + Math.floor(index / 9), z: Math.floor((index % 9) / 3) - 1 }));
  assert.deepEqual(columnsForCells([{ x: 0, y: 72, z: 0 }], 64, NEAR, ring).map(({ height }) => height), [3]);
});

test("the cells the ground reaches need no column: the hanok roof (191 cells) and the medieval-small roof (43 cells) need none (runtime: 0 columns for both)", () => {
  for (const [id, cellCount] of [["hanok", 191], ["medieval-small", 43]] as const) {
    const plan = planTemplate(templateFor(id)!, { door: { x: 0, y: 64, z: 2 }, facing: "north" });
    const roof = plan.stages.find((stage) => stage.name === "roof")!;
    const works = callWorks(plan, roof, stageCells(plan, roof));
    assert.equal(works.reduce((sum, work) => sum + work.cells.length, 0), cellCount, `${id}: the roof's cells`);
    for (const { cells, built } of works) assert.deepEqual(columnsForCells(cells, 64, NEAR, built), [], id);
  }
});

/** The summed heights of the columns of the busiest call of stage `stageName` of template `id`, the calls before it built (door at y 64, as the replay script's runtime columns). */
function columnsSum(id: string, stageName: string): number {
  const plan = planTemplate(templateFor(id)!, { door: { x: 0, y: 64, z: 2 }, facing: "north" });
  const stage = plan.stages.find((candidate) => candidate.name === stageName)!;
  const sums = callWorks(plan, stage, stageCells(plan, stage)).map(({ cells, built }) => columnsForCells(cells, 64, { x: 0, z: 2 }, built).reduce((sum, { height }) => sum + height, 0));
  return Math.max(...sums);
}

test("the roofs that do need columns need the runtime's: summed heights written out from planStandColumns on the same cells, the earlier stages standing (adobe-pueblo's upper level 4, not the 2 of a column through a wall: Task 3's replay house-stand-columns-per-call.ts)", () => {
  assert.equal(columnsSum("adobe-pueblo", "upper level"), 4);
  assert.equal(columnsSum("pagoda-house", "roof"), 2, "its calls 9 and 10 take 1 and 2");
  assert.equal(columnsSum("saltbox", "roof"), 11, "its calls 9, 10 and 11 take 6, 10 and 11");
  assert.equal(columnsSum("ndebele-house", "roof"), 1);
});
