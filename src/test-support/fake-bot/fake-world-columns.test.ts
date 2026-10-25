import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "./fake-bot.js";
import { DEFAULT_LOADED_CHUNK_RADIUS, type FakeColumn, type ListedColumn } from "./fake-world-columns.js";
import { createFakeWorld } from "./fake-world.js";

const VERSION = "1.21.4";
const at = (x: number, y: number, z: number) => new Vec3(x, y, z);

/** `bot.world.getColumn`, which Prismarine's typings declare as the async world's. */
function columnOf(world: { getColumn: unknown }, chunkX: number, chunkZ: number): FakeColumn | undefined {
  return (world.getColumn as (chunkX: number, chunkZ: number) => FakeColumn | undefined)(chunkX, chunkZ);
}

/** `bot.world.getColumns`, whose coordinates Prismarine's `WorldSync` hands over as strings. */
function listedColumns(world: { getColumns: unknown }): ListedColumn[] {
  return (world.getColumns as () => ListedColumn[])();
}

const chunkNames = (world: { getColumns: unknown }) =>
  listedColumns(world)
    .map(({ chunkX, chunkZ }) => `${chunkX},${chunkZ}`)
    .sort();

test("a column's state id at a cell equals blockAt's, for a block set with properties and for ground and air", () => {
  const { bot } = createFakeBot({
    position: at(0.5, 64, 0.5),
    cells: { "2,64,0": { name: "oak_stairs", properties: { facing: "east", half: "top" } }, "3,70,5": "gold_block" },
  });
  const column = columnOf(bot.world, 0, 0)!;
  for (const cell of [at(2, 64, 0), at(3, 70, 5), at(0, 63, 0), at(0, 64, 0), at(15, 100, 15)]) {
    assert.equal(column.getBlockStateId(at(cell.x & 15, cell.y, cell.z & 15)), bot.blockAt(cell)!.stateId, String(cell));
  }
  assert.notEqual(bot.blockAt(at(2, 64, 0))!.stateId, bot.registry.blocksByName.oak_stairs!.defaultState, "the properties are kept");
});

test("a whole column agrees with blockAt cell by cell, on a chunk at negative coordinates with ground under it", () => {
  const { bot } = createFakeBot({ position: at(-8.5, 64, -8.5), cells: { "-16,64,-1": "gold_block", "-1,63,-16": "water", "-9,200,-9": "glass" } });
  const column = columnOf(bot.world, -1, -1)!;
  const disagreeing: string[] = [];
  for (let y = column.minY; y < column.minY + column.worldHeight; y++) {
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        const cell = at(x - 16, y, z - 16);
        if (column.getBlockStateId(at(x, y, z)) !== bot.world.getBlockStateId(cell)) disagreeing.push(String(cell));
      }
    }
  }
  assert.deepEqual(disagreeing, []);
});

test("a column has the dimension's floor and height, and getColumns hands the coordinates over as strings", () => {
  const { bot } = createFakeBot();
  const column = columnOf(bot.world, 0, 0)!;
  assert.equal(column.minY, bot.game.minY);
  assert.equal(column.worldHeight, bot.game.height);
  const entry = listedColumns(bot.world).find(({ chunkX, chunkZ }) => chunkX === "0" && chunkZ === "0");
  assert.ok(entry, "the feet's chunk is listed");
  assert.equal(entry.column, column, "getColumns and getColumn answer the same column");
});

test("cells on both sides of a chunk border, at negative coordinates, belong to the chunks floor division gives", () => {
  const cells = { "-17,64,0": "gold_block", "-16,64,0": "gold_block", "-1,64,-1": "gold_block", "15,64,15": "gold_block", "16,64,16": "gold_block" };
  const { bot } = createFakeBot({ cells });
  const gold = bot.registry.blocksByName.gold_block!.defaultState!;
  // [chunk x, chunk z, x in the chunk, z in the chunk]
  const expected: [number, number, number, number][] = [[-2, 0, 15, 0], [-1, 0, 0, 0], [-1, -1, 15, 15], [0, 0, 15, 15], [1, 1, 0, 0]];
  for (const [chunkX, chunkZ, x, z] of expected) {
    assert.equal(columnOf(bot.world, chunkX, chunkZ)!.getBlockStateId(at(x, 64, z)), gold, `chunk ${chunkX},${chunkZ}`);
  }
  assert.notEqual(columnOf(bot.world, -1, 0)!.getBlockStateId(at(15, 64, 0)), gold, "-17 is not in chunk -1");
});

test("the listed columns are the 329 chunks Mine Labs' server sent around the feet, plus the chunks of named cells", () => {
  // Measured by contract check columns-hold-cells, 2026-10-23: view-distance=8 gives radius 9 with the corners cut.
  const radius = DEFAULT_LOADED_CHUNK_RADIUS;
  const far = (radius + 4) * 16;
  const { bot } = createFakeBot({ position: at(40.5, 64, -20.5), cells: { [`${far},64,0`]: "stone" } });
  const names = chunkNames(bot.world);
  assert.equal(names.length, 329 + 1);
  assert.ok(names.includes("2,-2") && names.includes(`${2 + radius},-2`) && names.includes(`${2 - radius},-2`) && names.includes(`2,${-2 + radius}`));
  assert.ok(!names.includes(`${2 + radius},${-2 + radius}`), "the corner of the square is cut");
  const fromFeet = (dx: number, dz: number) => `${2 + dx},${-2 + dz}`;
  assert.ok(names.includes(fromFeet(9, 5)) && names.includes(fromFeet(8, 7)), "the last chunks of each edge the server sent");
  assert.ok(!names.includes(fromFeet(9, 6)) && !names.includes(fromFeet(8, 8)), "the first it did not");
  assert.ok(!names.includes(`${3 + radius},-2`), "one chunk past the square");
  assert.ok(names.includes(`${radius + 4},0`), "the named cell's chunk");
  assert.equal(columnOf(bot.world, 3 + radius, -2), undefined);
  assert.equal(bot.blockAt(at((3 + radius) * 16, 64, -32)), null, "blockAt answers where the columns are, null elsewhere");
  assert.ok(bot.blockAt(at(far, 64, 0)), "inside the named cell's chunk");
  assert.equal(bot.world.getBlockStateId(at((3 + radius) * 16, 64, -32)), 0, "an unloaded column reads as id 0, as Prismarine does");
});

test("loadedColumns names the chunks, [] lists none and every read of an unlisted chunk is null", () => {
  const some = createFakeBot({ loadedColumns: [[2, 3], [-1, 0]], cells: { "0,64,0": "stone" } });
  assert.deepEqual(chunkNames(some.bot.world), ["-1,0", "2,3"]);
  assert.equal(some.bot.blockAt(at(0, 64, 0)), null, "chunk 0,0 is not listed, even with a named cell");
  assert.ok(some.bot.blockAt(at(2 * 16 + 1, 64, 3 * 16 + 1)));
  const none = createFakeBot({ loadedColumns: [] });
  assert.deepEqual(listedColumns(none.bot.world), []);
  assert.equal(none.bot.blockAt(at(0, 63, 0)), null);
  assert.equal(columnOf(none.bot.world, 0, 0), undefined);
});

test("a void cell reads null inside a listed column; a chunk of void cells alone, outside the square, is not listed", () => {
  const radius = DEFAULT_LOADED_CHUNK_RADIUS;
  const outside = (radius + 3) * 16;
  const { bot } = createFakeBot({ cells: { "3,64,3": "void", [`${outside},64,0`]: "void" } });
  assert.equal(bot.blockAt(at(3, 64, 3)), null);
  assert.ok(chunkNames(bot.world).includes("0,0"), "the column holding the void cell is listed");
  assert.equal(columnOf(bot.world, 0, 0)!.getBlockStateId(at(3, 64, 3)), 0, "its cell is air in the column");
  assert.ok(!chunkNames(bot.world).includes(`${radius + 3},0`));
  assert.equal(bot.blockAt(at(outside, 64, 0)), null);
});

test("a setCell into an unlisted chunk lists it; a void setCell there does not", () => {
  const { bot, world } = createFakeBot({ loadedColumns: [[0, 0]] });
  world.setCell(at(48, 64, 0), "gold_block");
  assert.deepEqual(chunkNames(bot.world), ["0,0", "3,0"]);
  assert.equal(bot.blockAt(at(48, 64, 0))!.name, "gold_block");
  world.setCell(at(80, 64, 0), "void");
  assert.deepEqual(chunkNames(bot.world), ["0,0", "3,0"]);
});

test("a setCell that lists a chunk announces it as the server's chunk packet does: chunkColumnLoad at the column's corner, before the block update", () => {
  // worldsync.js setColumn emits chunkColumnLoad(columnCorner); Mineflayer forwards it to the bot.
  const { bot, world } = createFakeBot({ loadedColumns: [[0, 0]] });
  const seen: string[] = [];
  bot.on("chunkColumnLoad", (corner: Vec3) => void seen.push(`load ${corner}`));
  bot.on("blockUpdate", () => void seen.push("update"));
  world.setCell(at(48, 64, -20), "gold_block");
  world.setCell(at(49, 64, -20), "gold_block");
  world.setCell(at(5, 64, 5), "gold_block");
  assert.deepEqual(seen, [`load ${at(48, 0, -32)}`, "update", "update", "update"]);
});

test("a setCell after getColumns changes the column already handed out, in place, as Prismarine's world does", () => {
  // worldsync.js setBlockStateId writes into the stored column: a holder of the column (the frontier scan) sees the block.
  const { bot, world } = createFakeBot({ cells: { "1,64,1": "stone" } });
  const held = columnOf(bot.world, 0, 0)!;
  const neighbour = columnOf(bot.world, 1, 0)!;
  assert.equal(columnOf(bot.world, 0, 0), held, "one column per chunk while nothing changes");
  const [listed] = listedColumns(bot.world).filter(({ chunkX, chunkZ }) => chunkX === "0" && chunkZ === "0");
  assert.equal(listed!.column, held);
  world.setCell(at(1, 64, 1), "gold_block");
  assert.equal(held.getBlockStateId(at(1, 64, 1)), bot.registry.blocksByName.gold_block!.defaultState);
  world.setCell(at(1, 64, 1), "void");
  assert.equal(held.getBlockStateId(at(1, 64, 1)), 0, "a void cell is air in its column");
  assert.equal(columnOf(bot.world, 0, 0), held);
  assert.equal(columnOf(bot.world, 1, 0), neighbour);
  assert.equal(listedColumns(bot.world).find(({ chunkX, chunkZ }) => chunkX === "0" && chunkZ === "0")!.column, held);
});

test("an empty world (groundY null) still lists its columns, all air", () => {
  const { bot } = createFakeBot({ groundY: null });
  const column = columnOf(bot.world, 0, 0)!;
  assert.ok(column);
  assert.equal(column.getBlockStateId(at(0, 63, 0)), 0);
  assert.equal(bot.blockAt(at(0, 63, 0))!.name, "air");
});

test("a cell outside the dimension's height reads air as Prismarine does; naming one throws", () => {
  const { bot, world } = createFakeBot({ groundY: 70 });
  const { minY, height } = bot.game;
  assert.equal(bot.blockAt(at(0, minY - 1, 0))!.name, "air", "below the floor, under the ground");
  assert.equal(bot.blockAt(at(0, minY, 0))!.name, "stone");
  assert.equal(bot.blockAt(at(0, minY + height, 0))!.name, "air");
  assert.throws(() => world.setCell(at(0, minY + height, 0), "stone"), /outside the dimension/);
  assert.throws(() => createFakeWorld(VERSION, { cells: { "0,-65,0": "stone" } }), /outside the dimension/);
  assert.throws(() => createFakeBot({ cells: { "0,-65,0": "stone" } }), /outside the dimension/, "a harness refuses it when made, not at the first read");
  assert.throws(() => createFakeBot({ dimension: "the_nether", cells: { "0,-1,0": "stone" } }), /outside the dimension/, "the nether's floor is 0");
});

test("the feet option moves the square, and a bot's square follows its start position", () => {
  const apart = (DEFAULT_LOADED_CHUNK_RADIUS + 5) * 16;
  const world = createFakeWorld(VERSION, { feet: at(apart + 0.5, 64, 0.5) });
  assert.ok(world.blockAt(at(apart, 64, 0)));
  assert.equal(world.blockAt(at(0, 64, 0)), null, "chunk 0,0 is further than the radius from the feet");
  const { bot } = createFakeBot({ position: at(apart + 0.5, 64, 0.5) });
  assert.ok(bot.blockAt(at(apart, 63, 0)));
  assert.equal(bot.blockAt(at(0, 63, 0)), null);
});

test("a world of 2000 cells lists its 329 columns within the time a test can spend", () => {
  const cells: Record<string, string> = {};
  for (let index = 0; index < 2_000; index++) cells[`${(index % 40) - 20},${64 + (index % 7)},${Math.floor(index / 40) - 25}`] = "gold_block";
  const { bot } = createFakeBot({ cells });
  const listStart = performance.now();
  const listed = listedColumns(bot.world);
  const listMs = performance.now() - listStart;
  assert.equal(listed.length, 329);
  // Measured 2026-10-23 at 25-36 ms for the first call (facts, runtime-pitfalls "World columns"); the bound only catches a build that grows by a factor.
  assert.ok(listMs < GET_COLUMNS_BOUND_MS, `getColumns ${listMs.toFixed(0)} ms`);
});

const GET_COLUMNS_BOUND_MS = 1_000;
