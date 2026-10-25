import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { CHUNK_WIDTH, chunkCoordinate, chunkPosition, loadedColumns } from "./chunks.js";

test("maps block coordinates to their containing chunks across zero and exact boundaries", () => {
  assert.equal(CHUNK_WIDTH, 16);
  assert.deepEqual([15.999, 16, -0.001, -16, -16.001].map(chunkCoordinate), [0, 1, -1, -1, -2]);
});

test("maps one structural horizontal position to chunk coordinates", () => {
  assert.deepEqual(chunkPosition({ x: -0.001, z: 31.999 }), { chunkX: -1, chunkZ: 1 });
});

test("loadedColumns lists the shared fake's columns with their coordinates as numbers, negative and zero ones included", () => {
  const { bot } = createFakeBot({ loadedColumns: [[-1, -1], [0, 0]] });
  // The fake lists strings as the game does (fake-world-columns.test.ts holds it); `loadedColumns` gives numbers.
  const listed = loadedColumns(bot.world);
  assert.deepEqual(listed.map(({ chunkX, chunkZ }) => [chunkX, chunkZ]), [[-1, -1], [0, 0]]);
  assert.equal(listed[0]!.column, bot.world.getColumn(-1, -1));
});

test("loadedColumns of a world with no column is an empty list", () => {
  assert.deepEqual(loadedColumns(createFakeBot({ loadedColumns: [] }).bot.world), []);
});

test("loadedColumns refuses a coordinate that is not an integer, naming the entry", () => {
  const column = {};
  for (const bad of ["1.5", "x", "", undefined, null, Number.NaN, "1e400", "9007199254740993"]) {
    assert.throws(
      () => loadedColumns({ getColumns: () => [{ chunkX: 2, chunkZ: bad, column }] }),
      (error: Error) => error.message.includes("chunkZ") && error.message.includes(JSON.stringify(bad) ?? String(bad)),
      `chunkZ ${String(bad)}`,
    );
  }
  assert.throws(() => loadedColumns({ getColumns: () => [{ chunkX: "1.5", chunkZ: "0", column }] }), /chunkX.*"1\.5"/);
});
