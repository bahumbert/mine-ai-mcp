import assert from "node:assert/strict";
import test from "node:test";
import { liveBlockReader } from "../navigation/index.js";
import { createFakeBot, type FakeBotOptions } from "../test-support/fake-bot/index.js";
import { targetSituation, situationOf } from "./target-situation.js";

type Cells = NonNullable<FakeBotOptions["cells"]>;

/** A column of cells at x 0, z 0 from `y`, `names` bottom to top, as fake bot cells. */
function column(y: number, ...names: readonly (string | { name: string; properties: Record<string, string | number | boolean> })[]): Cells {
  return Object.fromEntries(names.map((name, index) => [`0,${y + index},0`, name]));
}

function situation(cells: Cells, target = "oak_log", y = 64) {
  const { bot } = createFakeBot({ cells, groundY: null });
  const block = bot.registry.blocksByName[target]!;
  const ids = new Set<number>();
  for (let stateId = block.minStateId; stateId <= block.maxStateId; stateId += 1) ids.add(stateId);
  return situationOf(bot, { x: 0, y, z: 0 }, ids);
}

const WATERLOGGED = { name: "oak_stairs", properties: { waterlogged: true } } as const;

test("canopy: another tree's log branch and leaves above is open", () => {
  assert.equal(situation(column(64, "oak_log", "air", "birch_log", "birch_leaves", "oak_leaves")), "open");
});

test("snow layer on the leaves is open", () => {
  assert.equal(situation(column(64, "oak_log", "oak_log", "oak_leaves", "snow")), "open");
});

test("water above the trunk is under water", () => {
  assert.equal(situation(column(64, "oak_log", "oak_log", "water", "water", "water", "water", "water")), "under_water");
});

test("water beside, not above, is open", () => {
  const cells: Cells = { ...column(64, "oak_log", "oak_log"), "1,64,0": "water", "0,64,1": "water", "-1,65,0": "water" };
  assert.equal(situation(cells), "open");
});

test("a waterlogged block above is under water", () => {
  assert.equal(situation(column(64, "oak_log", "oak_log", WATERLOGGED)), "under_water");
});

test("a waterlogged target is under water", () => {
  // oak_stairs stands for any waterloggable target block.
  assert.equal(situation(column(64, WATERLOGGED), "oak_stairs"), "under_water");
});

test("stone high above a column of air is roofed", () => {
  assert.equal(situation(column(64, "oak_log", "air", "air", "air", "air", "stone")), "roofed");
});

test("an unloaded cell above is open, whatever lies beyond it", () => {
  assert.equal(situation({ ...column(64, "oak_log"), "0,65,0": "void", "0,66,0": "stone" }), "open");
});

test("open sky ends at topY: a column of air to the world top is open and reads at most topY - y cells", () => {
  const { bot } = createFakeBot({ cells: column(64, "oak_log"), groundY: null });
  const topY = bot.game.minY + bot.game.height;
  const base = liveBlockReader(bot);
  let reads = 0;
  const read: typeof base = (x, y, z) => {
    reads += 1;
    return base(x, y, z);
  };
  const log = bot.registry.blocksByName.oak_log!;
  const isTarget = (block: { stateId: number }) => block.stateId >= log.minStateId && block.stateId <= log.maxStateId;
  assert.equal(targetSituation(read, { x: 0, y: 64, z: 0 }, isTarget, () => false, topY), "open");
  assert.ok(reads <= topY - 64, `${reads} reads for a column of ${topY - 64} cells`);
});
