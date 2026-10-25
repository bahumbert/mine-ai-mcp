import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "./fake-bot.js";

const at = (x: number, y: number, z: number) => new Vec3(x, y, z);

// Nearest first, `count`, `maxDistance` and `point` are measured by contract check find-blocks-matching (on the fake and on the server).
test("findBlocks matches by id, by a list of ids and by a predicate, and finds nothing for a block that is not there", () => {
  const { bot } = createFakeBot({ cells: { "6,64,0": "gold_block", "0,64,3": "gold_block", "9,64,9": "iron_block" } });
  const gold = bot.registry.blocksByName.gold_block!.id;
  const iron = bot.registry.blocksByName.iron_block!.id;
  assert.equal(bot.findBlocks({ matching: [gold, iron], count: 10, maxDistance: 20 }).length, 3);
  assert.deepEqual(bot.findBlocks({ matching: (block) => block !== null && block.name === "iron_block", count: 5 }).map(String), [String(at(9, 64, 9))]);
  assert.deepEqual(bot.findBlocks({ matching: bot.registry.blocksByName.diamond_block!.id, count: 3 }), []);
});

test("findBlocks stops at the end of the section ring that held enough blocks, so a nearer block in the next chunk can be missed", () => {
  // blocks.js:178: "if we started a layer, we have to finish it" - the ring, not the whole distance. Mineflayer's own answer.
  const { bot } = createFakeBot({ cells: { "6,64,0": "gold_block", "0,64,3": "gold_block", "-2,64,0": "gold_block" } });
  const found = bot.findBlocks({ matching: bot.registry.blocksByName.gold_block!.id, count: 2 });
  assert.deepEqual(found.map(String), [at(0, 64, 3), at(6, 64, 0)].map(String));
});

test("findBlock after a setCell finds the new block and no longer the replaced one", () => {
  const { bot, world } = createFakeBot({ cells: { "3,64,0": "gold_block" } });
  assert.equal(bot.findBlock({ matching: bot.registry.blocksByName.gold_block!.id })?.position.x, 3);
  world.setCell(at(3, 64, 0), "air");
  world.setCell(at(0, 64, 4), "gold_block");
  assert.deepEqual(bot.findBlock({ matching: bot.registry.blocksByName.gold_block!.id })?.position, at(0, 64, 4));
});

test("findBlocks never reports a void cell or a cell of an unlisted chunk", () => {
  const { bot } = createFakeBot({ cells: { "2,64,0": "void", "3,64,0": "gold_block" }, loadedColumns: [[0, 0]] });
  const air = bot.registry.blocksByName.air!.id;
  assert.equal(bot.findBlocks({ matching: air, count: 500, maxDistance: 40 }).some((found) => found.x === 2 && found.y === 64 && found.z === 0), false);
  assert.equal(bot.findBlocks({ matching: air, count: 20_000, maxDistance: 40 }).some((found) => found.x >= 16), false);
});

test("a search reads the world and game the bot has when it runs, not when it was made", () => {
  const { bot, world } = createFakeBot({ cells: { "3,64,0": "gold_block" } });
  const gold = bot.registry.blocksByName.gold_block!.id;
  assert.equal(bot.findBlocks({ matching: gold }).length, 1);
  Object.assign(bot, { world: { ...bot.world, getColumn: () => undefined, getColumns: () => [] } });
  assert.equal(bot.findBlocks({ matching: gold }).length, 0, "no column in the world it now has");
  assert.ok(world.blockAt(at(3, 64, 0)), "the harness world itself is unchanged");
});

test("over 2000 named cells, a search of maxDistance 32 ends within the time a test can spend", () => {
  const cells: Record<string, string> = {};
  for (let index = 0; index < 2_000; index++) cells[`${(index % 40) - 20},${64 + (index % 7)},${Math.floor(index / 40) - 25}`] = "gold_block";
  const { bot } = createFakeBot({ cells });
  const gold = bot.registry.blocksByName.gold_block!.id;
  const start = performance.now();
  const found = bot.findBlocks({ matching: gold, count: 50, maxDistance: 32 });
  const ms = performance.now() - start;
  assert.equal(found.length, 50);
  // Measured 2026-10-23 at 3-97 ms (facts, runtime-pitfalls "World columns"; a search for nothing, 58-64 ms, is the slowest); mine-process runs 61 tests under bun's 5 s each.
  assert.ok(ms < FIND_BLOCKS_BOUND_MS, `findBlocks ${ms.toFixed(0)} ms`);
});

const FIND_BLOCKS_BOUND_MS = 2_000;
