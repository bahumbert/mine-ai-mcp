/**
 * A cell holds water when the game's fluid state there is water, which is more than the `water` block: kelp and
 * seagrass are always water-filled and a waterlogged block holds a source in its own cell. `view_blocks cells` says
 * `holds_water` for each of them (`cellHoldsWater` over the observed cell), and for neither stone nor air.
 * Measured 2026-11-08 on the 1.21.4 server: each of these three is a water source that spreads over open floor (an
 * unwalled fixture put flowing water at the air cell 4 blocks away), so each stands in a pocket of stone.
 */
import assert from "node:assert/strict";
import { viewBlocks } from "../../../../src/actions/view-blocks/view-blocks.ts";
import type { FakeCell } from "../../../../src/test-support/fake-bot/index.ts";
import type { ContractCheck } from "../checks.ts";

type Cell = readonly [number, number, number];

/** The three water holders on the floor row z 2, two blocks apart; the stone between and beside them walls each in. */
const HOLDERS: readonly { readonly cell: Cell; readonly block: FakeCell }[] = [
  { cell: [-4, -60, 2], block: "kelp" },
  { cell: [-2, -60, 2], block: "seagrass" },
  { cell: [0, -60, 2], block: { name: "oak_stairs", properties: { waterlogged: true } } },
];
/** Stone around the holders (x -5 to 1, rows z 1 and 3, and between them on z 2); the one at x 1 is also the stone that holds no water. */
const WALLS: readonly Cell[] = [-5, -4, -3, -2, -1, 0, 1].flatMap((x): Cell[] => [[x, -60, 1], [x, -60, 3], ...(x % 2 === 0 ? [] : [[x, -60, 2] as Cell])]);
const STONE_CELL: Cell = [1, -60, 2];
/** Far from any water the holders send out. */
const AIR_CELL: Cell = [5, -60, -3];

/** Each cell read, the name it must read and whether the game's fluid state there is water. */
const READS: readonly { readonly cell: Cell; readonly name: string; readonly holdsWater: boolean }[] = [
  ...HOLDERS.map(({ cell, block }) => ({ cell, name: typeof block === "string" ? block : (block as { name: string }).name, holdsWater: true })),
  { cell: STONE_CELL, name: "stone", holdsWater: false },
  { cell: AIR_CELL, name: "air", holdsWater: false },
];

export const waterHeldCells: ContractCheck = {
  name: "water-held-cells",
  fixture: {
    cells: Object.fromEntries([
      ...WALLS.map((cell) => [cell.join(","), "stone"] as const),
      ...HOLDERS.map(({ cell, block }) => [cell.join(","), block] as const),
    ]),
    carried: {},
    position: [0.5, -60, 0.5],
  },
  async run({ bot, world }) {
    const cells = READS.map(({ cell }) => {
      const position = world(cell);
      return { x: position.x, y: position.y, z: position.z };
    });
    const result = viewBlocks(bot, { find: null, box: null, cells });
    assert.equal(result.status, "succeeded", "the cells read");
    result.blocks.cells.forEach((read, index) => {
      const { cell, name, holdsWater } = READS[index]!;
      assert.equal(read.name, name, `${cell}: ${read.name}, not ${name}`);
      assert.equal(read.holds_water === true, holdsWater, `${name} at ${cell}: holds_water ${String(read.holds_water)}, the game's fluid there is ${holdsWater ? "water" : "none"}`);
      // The key is absent, never false, when the cell holds none.
      assert.equal("holds_water" in read, holdsWater, `${name} at ${cell}: key present ${"holds_water" in read}`);
    });
  },
};
