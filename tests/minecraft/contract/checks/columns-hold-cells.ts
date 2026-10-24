/**
 * `world.getColumns` lists the chunks the server sent (329 around a bot standing still on Mine Labs' server, whose
 * `view-distance` is 8), its coordinates as strings; each column holds what `blockAt` reads, and a block the server
 * changes later changes the column already handed out (`worldsync.js:78-82`, `blocks.js` `updateBlockState`).
 */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { type FakeColumn, type ListedColumn, createLoadedChunks } from "../../../../src/test-support/fake-bot/fake-world-columns.ts";
import type { ContractCheck } from "../checks.ts";
import { serverQuiet } from "../server-answer.ts";
import { type LocalPoint, holdsWithin } from "../subject.ts";

const STAIRS_CELL = [2, -60, 0] as const;
const STAIRS = { name: "oak_stairs", properties: { facing: "east", half: "top" } } as const;
const GOLD_CELL = [-3, -60, -4] as const;
const FEET = [0.5, -60, 0.5] as const;
/** The server sends its chunks over the first seconds after the login. */
const CHUNKS_ARRIVE_WITHIN_MS = 20_000;

/** The synchronous world of `WorldSync`, whose columns Prismarine's typings leave out. */
interface SyncWorld {
  getColumn(chunkX: number, chunkZ: number): FakeColumn | undefined;
  getColumns(): ListedColumn[];
}

/** The cell's state in its column: x and z local to the chunk, y absolute. */
function stateInColumn(world: SyncWorld, cell: Vec3): number {
  const column = world.getColumn(cell.x >> 4, cell.z >> 4);
  assert.ok(column, `${cell}: no column for chunk ${cell.x >> 4},${cell.z >> 4}`);
  return column.getBlockStateId(new Vec3(cell.x & 15, cell.y, cell.z & 15));
}

export const columnsHoldCells: ContractCheck = {
  name: "columns-hold-cells",
  fixture: { cells: { "2,-60,0": STAIRS, "-3,-60,-4": "gold_block" }, carried: {}, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    const world = bot.world as unknown as SyncWorld;
    const feet = subject.world(FEET);
    const stairsCell = subject.world(STAIRS_CELL);
    const expected = createLoadedChunks({ feet, namedChunks: [] }).list();
    const arrived = await holdsWithin(subject, () => world.getColumns().length >= expected.length, CHUNKS_ARRIVE_WITHIN_MS);
    assert.ok(arrived, `${world.getColumns().length} of ${expected.length} chunks listed`);
    // A chunk still on its way (one the list should not hold) shows up within the server's ticks: the list is compared after them.
    await serverQuiet(subject, "after the expected chunks were listed");
    const listed = world.getColumns();
    assert.deepEqual(
      listed.map(({ chunkX, chunkZ }) => `${chunkX},${chunkZ}`).sort(),
      expected.map(([chunkX, chunkZ]) => `${chunkX},${chunkZ}`).sort(),
      "the chunks listed around the feet",
    );
    assert.equal(typeof listed[0]!.chunkX, "string", "getColumns hands the coordinates over as strings");
    const { minY, height } = bot.game as typeof bot.game & { minY: number; height: number };
    assert.equal(listed[0]!.column.minY, minY);
    assert.equal(listed[0]!.column.worldHeight, height);

    for (const cell of [STAIRS_CELL, GOLD_CELL, [0, -61, 0], [0, -60, 0], [5, -57, -5]].map((local) => subject.world(local as LocalPoint))) {
      assert.equal(stateInColumn(world, cell), bot.blockAt(cell)?.stateId, `${cell}: the column and blockAt differ`);
      assert.equal(bot.world.getBlockStateId(cell), bot.blockAt(cell)?.stateId, `${cell}: getBlockStateId and blockAt differ`);
    }
    assert.notEqual(stateInColumn(world, stairsCell), bot.registry.blocksByName[STAIRS.name]!.defaultState, "the stairs kept their properties");

    const held = world.getColumn(stairsCell.x >> 4, stairsCell.z >> 4)!;
    await subject.setBlock(stairsCell, "gold_block");
    assert.equal(world.getColumn(stairsCell.x >> 4, stairsCell.z >> 4), held, "a block update keeps the stored column");
    assert.equal(held.getBlockStateId(new Vec3(stairsCell.x & 15, stairsCell.y, stairsCell.z & 15)), bot.registry.blocksByName.gold_block!.defaultState, "the held column holds the new block");
  },
};
