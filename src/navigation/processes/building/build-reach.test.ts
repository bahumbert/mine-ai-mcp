import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { HORIZONTAL_TICKS_PER_BLOCK } from "../../index.js";
import { observation } from "../../../test-support/navigation.js";
import {
  DEFAULT_BLOCK_RANGE,
  blockRangeOf,
  coverWithColumns,
  eyeOver,
  reachGoal,
  withinBlockReach,
  type StandColumn,
} from "./build-reach.js";

/** The eye of a bot whose feet cell is (0, 64, 0): the centre of the cell, 1.62 up (`STANDING_EYE_HEIGHT`). */
const EYE = eyeOver({ x: 0, y: 64, z: 0 });

test("a cell is in reach when the nearest point of its box is within the range of the eye, not its corner of the feet cell", () => {
  for (const row of [
    // Straight up: the cell's lower face is its nearest point, 70 - 65.62 = 4.38 away.
    { cell: { x: 0, y: 70, z: 0 }, reached: true, name: "6 above the feet, straight up, is reached from the eye (the feet rule said 4)" },
    { cell: { x: 0, y: 70, z: 0 }, reached: false, range: 4, name: "the range is a parameter: at 4 the same cell is out of reach" },
    { cell: { x: 0, y: 71, z: 0 }, reached: false, name: "7 above is 5.38 from the eye" },
    // Beside the eye: the box's near face, 3.5 away in x, 0.62 above in y.
    { cell: { x: 4, y: 64, z: 0 }, reached: true, name: "4 away on the floor level" },
    { cell: { x: 5, y: 65, z: 0 }, reached: true, name: "a face 4.5 away on the eye's level is reached exactly (the range is inclusive)" },
    { cell: { x: 6, y: 65, z: 0 }, reached: false, name: "5.5 away on the eye's level is not" },
    // Under the eye the box's upper face is the nearest point.
    { cell: { x: 0, y: 61, z: 0 }, reached: true, name: "below, the cell's upper face counts: 3.62" },
    { cell: { x: 0, y: 60, z: 0 }, reached: false, name: "one lower is 4.62 from the eye" },
  ]) {
    assert.equal(withinBlockReach(EYE, row.cell, row.range ?? DEFAULT_BLOCK_RANGE), row.reached, row.name);
  }
});

test("the range is the bot's block interaction range attribute when it has one, else the vanilla 4.5", () => {
  const { bot } = createFakeBot();
  assert.equal(blockRangeOf(bot), DEFAULT_BLOCK_RANGE, "no attribute: the default");
  Reflect.set(bot.entity, "attributes", { "player.block_interaction_range": { value: 3, modifiers: [] } });
  assert.equal(blockRangeOf(bot), 3);
  Reflect.set(bot.entity, "attributes", { "player.block_interaction_range": { value: Number.NaN } });
  assert.equal(blockRangeOf(bot), DEFAULT_BLOCK_RANGE, "an attribute that is no number is no answer");
});

test("the reach goal is satisfied from the feet cells the eye test accepts, and its estimate falls to zero there", () => {
  const goal = reachGoal({ x: 0, y: 70, z: 0 }, DEFAULT_BLOCK_RANGE);
  const resolved = goal.resolve(observation(0, 64, 0));
  assert.equal(resolved.kind, "active");
  if (resolved.kind !== "active") return;
  assert.match(resolved.revision, /^reach:0,70,0:4\.5$/, "the revision names the cell first (the route fake reads it)");
  const at = (y: number, x = 0) => ({ feet: { x, y, z: 0 } }) as never;
  const world = {} as never;
  assert.equal(resolved.isSatisfied(at(64), world), true, "feet at 64: the eye at 65.62 is 4.38 from the cell");
  assert.equal(resolved.isSatisfied(at(63), world), false, "one lower: 5.38");
  assert.equal(resolved.isSatisfied(at(63, 2), world), false);
  assert.equal(resolved.heuristic(at(64)), 0);
  assert.ok(resolved.heuristic(at(60)) > 0);
  assert.ok(resolved.heuristic(at(60, 8)) > resolved.heuristic(at(60)), "farther away looks dearer");
  assert.ok(resolved.heuristic(at(60, 8)) >= 7 * HORIZONTAL_TICKS_PER_BLOCK, "the horizontal shortfall is priced");
});

/** Candidate columns in a row at z 0: x from `from` to `to`, any height up to 8. */
function row(from: number, to: number, maxHeight = 8): StandColumn[] {
  return Array.from({ length: to - from + 1 }, (_unused, index) => ({ x: from + index, z: 0, maxHeight }));
}

test("a cell 8 above the ground straight over a column is covered from feet 2 above the ground", () => {
  const columns = coverWithColumns([{ x: 0, y: 72, z: 0 }], row(0, 0), 64, DEFAULT_BLOCK_RANGE, { x: 0, z: 0 });
  assert.deepEqual(columns, [{ x: 0, z: 0, height: 2 }]);
});

test("a cell 2 away horizontally needs feet 3 above the ground, not 2", () => {
  const columns = coverWithColumns([{ x: 2, y: 72, z: 0 }], row(0, 0), 64, DEFAULT_BLOCK_RANGE, { x: 0, z: 0 });
  assert.deepEqual(columns, [{ x: 0, z: 0, height: 3 }]);
});

test("a 7-wide eave is covered by one column from its middle, three high", () => {
  const eave = Array.from({ length: 7 }, (_unused, x) => ({ x, y: 72, z: 0 }));
  const columns = coverWithColumns(eave, row(-2, 9), 64, DEFAULT_BLOCK_RANGE, { x: 0, z: 0 });
  assert.deepEqual(columns, [{ x: 3, z: 0, height: 3 }]);
});

test("a wide roof takes several columns, the most cells per block first, the nearest to the bot on a tie", () => {
  const eave = Array.from({ length: 15 }, (_unused, x) => ({ x, y: 72, z: 0 }));
  const columns = coverWithColumns(eave, row(-2, 17), 64, DEFAULT_BLOCK_RANGE, { x: 0, z: 0 });
  assert.ok(columns.length >= 2, `15 cells in a row are no single column's: ${JSON.stringify(columns)}`);
  for (const cell of eave) {
    assert.ok(
      columns.some((column) => withinBlockReach(eyeOver({ x: column.x, y: 64 + column.height, z: column.z }), cell, DEFAULT_BLOCK_RANGE)),
      `cell ${cell.x} is covered`,
    );
  }
  const near = coverWithColumns([{ x: 0, y: 72, z: 0 }], row(-1, 1), 64, DEFAULT_BLOCK_RANGE, { x: 1, z: 0 });
  assert.deepEqual(near.map(({ x, height }) => [x, height]), [[1, 2]], "of equal columns the one nearest the bot");
});

test("a taller column reaches less of what lies far below its eye: every cell some column serves is served by the chosen ones", () => {
  // Found by the task review: the cells below once left (5,72,0) and (6,76,0) out of the cover, because a column chosen for
  // the high cells was counted as serving every lower cell it reached at a lower height.
  const cells = [
    { x: 2, y: 82, z: 0 }, { x: -4, y: 76, z: 0 }, { x: 3, y: 80, z: 0 }, { x: -7, y: 80, z: 0 }, { x: 0, y: 83, z: 0 },
    { x: 5, y: 72, z: 0 }, { x: 1, y: 83, z: 0 }, { x: 6, y: 76, z: 0 },
  ];
  const offered = row(-10, 10, 24);
  const chosen = coverWithColumns(cells, offered, 64, DEFAULT_BLOCK_RANGE, { x: 0, z: 0 });
  const reachedBy = (cell: { x: number; y: number; z: number }, column: { x: number; z: number; height: number }) =>
    withinBlockReach(eyeOver({ x: column.x, y: 64 + column.height, z: column.z }), cell, DEFAULT_BLOCK_RANGE);
  for (const cell of cells) {
    assert.ok(chosen.some((column) => reachedBy(cell, column)), `cell ${JSON.stringify(cell)} is served by ${JSON.stringify(chosen)}`);
  }
});

test("of two columns serving cells at the same price per block, the one serving more cells: fewer pillars", () => {
  // (0,72,0) from height 2, (0,74,0) from height 4: one column of 4 serves both, as 2 + 4 blocks in two columns would.
  const columns = coverWithColumns([{ x: 0, y: 72, z: 0 }, { x: 0, y: 74, z: 0 }], row(0, 0), 64, DEFAULT_BLOCK_RANGE, { x: 0, z: 0 });
  assert.deepEqual(columns, [{ x: 0, z: 0, height: 4 }]);
});

test("only the columns offered are used: a cell none of them can serve is left uncovered", () => {
  const columns = coverWithColumns(
    [{ x: 0, y: 72, z: 0 }, { x: 40, y: 72, z: 0 }],
    row(0, 0),
    64,
    DEFAULT_BLOCK_RANGE,
    { x: 0, z: 0 },
  );
  assert.deepEqual(columns, [{ x: 0, z: 0, height: 2 }]);
  // A column that cannot be pillared high enough serves nothing either.
  assert.deepEqual(coverWithColumns([{ x: 0, y: 72, z: 0 }], row(0, 0, 1), 64, DEFAULT_BLOCK_RANGE, { x: 0, z: 0 }), []);
});

