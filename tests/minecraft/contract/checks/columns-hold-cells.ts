/**
 * `world.getColumns` lists the chunks the server sent (329 around a bot standing still on Mine Labs' server, whose
 * `view-distance` is 8), its coordinates as strings; each column holds what `blockAt` reads, and a block the server
 * changes later changes the column already handed out (`worldsync.js:78-82`, `blocks.js` `updateBlockState`).
 */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { type FakeColumn, type ListedColumn, createLoadedChunks } from "../../../../src/test-support/fake-bot/fake-world-columns.ts";
import type { ContractCheck } from "../checks.ts";
import { holdsWithin } from "../subject.ts";

const STAIRS_CELL = new Vec3(2, -60, 0);
const STAIRS = { name: "oak_stairs", properties: { facing: "east", half: "top" } } as const;
const GOLD_CELL = new Vec3(-3, -60, -4);
const FEET = { x: 0.5, z: 0.5 };
/** The server sends its chunks over the first seconds after the login. */
const CHUNKS_ARRIVE_WITHIN_MS = 20_000;
/** Time for a chunk still on its way to show up in the list before it is compared. */
const LATE_CHUNK_GRACE_MS = 1_000;

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
    const expected = createLoadedChunks({ feet: FEET, namedChunks: [] }).list();
    const arrived = await holdsWithin(subject, () => world.getColumns().length >= expected.length, CHUNKS_ARRIVE_WITHIN_MS);
    assert.ok(arrived, `${world.getColumns().length} of ${expected.length} chunks listed`);
    await subject.wait(LATE_CHUNK_GRACE_MS);
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

    for (const cell of [STAIRS_CELL, GOLD_CELL, new Vec3(0, -61, 0), new Vec3(0, -60, 0), new Vec3(5, -57, -5)]) {
      assert.equal(stateInColumn(world, cell), bot.blockAt(cell)?.stateId, `${cell}: the column and blockAt differ`);
      assert.equal(bot.world.getBlockStateId(cell), bot.blockAt(cell)?.stateId, `${cell}: getBlockStateId and blockAt differ`);
    }
    assert.notEqual(stateInColumn(world, STAIRS_CELL), bot.registry.blocksByName[STAIRS.name]!.defaultState, "the stairs kept their properties");

    const held = world.getColumn(0, 0)!;
    await subject.setBlock(STAIRS_CELL, "gold_block");
    assert.equal(world.getColumn(0, 0), held, "a block update keeps the stored column");
    assert.equal(held.getBlockStateId(new Vec3(2, -60, 0)), bot.registry.blocksByName.gold_block!.defaultState, "the held column holds the new block");
  },
};
