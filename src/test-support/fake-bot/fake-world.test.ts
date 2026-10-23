import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import { createFakeWorld } from "./fake-world.js";

const VERSION = "1.21.4";
const registry = minecraftData(VERSION);

/** The collision boxes the version's data gives a block's state, as Prismarine reads them. */
function registryShapes(name: string, stateId: number): number[][] {
  const entry = registry.blockCollisionShapes.blocks[name];
  const block = registry.blocksByName[name]!;
  const index = Array.isArray(entry) ? entry[stateId - block.minStateId!] : entry;
  return registry.blockCollisionShapes.shapes[index!] ?? [];
}

const at = (x: number, y: number, z: number) => new Vec3(x, y, z);

test("thin blocks have the game's shapes: carpet, single snow layer, fence and slab", () => {
  const world = createFakeWorld(VERSION, {
    cells: {
      "0,64,0": "white_carpet",
      "1,64,0": { name: "snow", properties: { layers: 1 } },
      "2,64,0": "oak_fence",
      "3,64,0": { name: "oak_slab", properties: { type: "bottom" } },
    },
  });
  for (const x of [0, 1, 2, 3]) {
    const block = world.blockAt(at(x, 64, 0))!;
    assert.deepEqual(block.shapes, registryShapes(block.name, block.stateId), block.name);
  }
  const carpet = world.blockAt(at(0, 64, 0))!.shapes[0]!;
  assert.ok(carpet[4]! < 1, "a carpet is not a full cube");
  assert.deepEqual(world.blockAt(at(1, 64, 0))!.shapes, [], "a single snow layer has no collision");
  assert.ok(world.blockAt(at(2, 64, 0))!.shapes.some((box) => box[4]! > 1), "a fence's box is above one block");
  assert.ok(world.blockAt(at(3, 64, 0))!.shapes[0]![4]! < 1, "a bottom slab is not a full cube");
});

test("getBlockStateId equals blockAt().stateId for a block given with properties", () => {
  const cell = at(0, 64, 0);
  const world = createFakeWorld(VERSION, { cells: { "0,64,0": { name: "oak_stairs", properties: { facing: "east" } } } });
  const block = world.blockAt(cell)!;
  assert.equal(block.getProperties().facing, "east");
  assert.notEqual(block.stateId, registry.blocksByName.oak_stairs!.defaultState);
  assert.equal(world.getBlockStateId(cell), block.stateId);
});

test("a cell given as a state id reads that state", () => {
  const stateId = registry.blocksByName.oak_log!.defaultState! + 1;
  const world = createFakeWorld(VERSION, { cells: { "0,64,0": stateId } });
  assert.equal(world.blockAt(at(0, 64, 0))!.stateId, stateId);
  assert.equal(world.blockAt(at(0, 64, 0))!.name, "oak_log");
});

test("blocks carry their position, and unnamed cells are air above groundY and stone at and below it", () => {
  const world = createFakeWorld(VERSION, { groundY: 63 });
  assert.equal(world.blockAt(at(5, 64, 5))!.name, "air");
  assert.equal(world.blockAt(at(5, 63, 5))!.name, "stone");
  assert.deepEqual(world.blockAt(at(5, 63.7, 5.2))!.position, at(5, 63, 5));
  assert.equal(createFakeWorld(VERSION).blockAt(at(0, -10, 0))!.name, "air");
});

test("setCell emits blockUpdate with the old and the new block on every bot the world feeds", () => {
  const world = createFakeWorld(VERSION, { cells: { "0,64,0": "stone" } });
  const bot = new EventEmitter();
  world.forwardTo(bot);
  const seen: string[] = [];
  bot.on("blockUpdate", (before, after) => seen.push(`${before?.name}->${after?.name}`));
  bot.on(`blockUpdate:${at(0, 64, 0)}`, (before, after) => seen.push(`at ${before?.name}->${after?.name}`));
  world.setCell(at(0, 64, 0), "air");
  assert.deepEqual(seen, ["stone->air", "at stone->air"]);
  assert.equal(world.blockAt(at(0, 64, 0))!.name, "air");
  assert.equal(world.getBlockStateId(at(0, 64, 0)), registry.blocksByName.air!.defaultState);
});

test("a void cell answers null to blockAt and air's id to getBlockStateId, as Prismarine's world does unloaded", () => {
  // prismarine-world worldsync.js getBlockStateId: `if (!chunk) return 0`.
  const world = createFakeWorld(VERSION, { cells: { "0,64,0": "void" } });
  assert.equal(world.blockAt(at(0, 64, 0)), null);
  assert.equal(world.getBlockStateId(at(0, 64, 0)), 0);
});

test("onRead sees every cell read", () => {
  const read: string[] = [];
  const world = createFakeWorld(VERSION, { onRead: (cell) => read.push(cell.toString()) });
  world.blockAt(at(1, 2, 3));
  assert.deepEqual(read, [at(1, 2, 3).toString()]);
});

test("an unknown block name throws naming it, so a typo never becomes air", () => {
  assert.throws(() => createFakeWorld(VERSION, { cells: { "0,64,0": "stnoe" } }), /stnoe/);
  const world = createFakeWorld(VERSION);
  assert.throws(() => world.setCell(at(0, 64, 0), "dirtt"), /dirtt/);
});

test("raycast stops at the first block with a collision shape, walking through fluids and a snow layer", () => {
  const world = createFakeWorld(VERSION, {
    cells: { "0,64,1": "water", "0,64,2": { name: "snow", properties: { layers: 1 } }, "0,64,3": "stone" },
  });
  const hit = world.raycast(at(0.5, 64.5, 0.5), new Vec3(0, 0, 1), 10)!;
  assert.equal(hit.name, "stone");
  assert.deepEqual(hit.position, at(0, 64, 3));
  assert.equal(hit.face, 2);
  assert.equal(world.raycast(at(0.5, 64.5, 0.5), new Vec3(0, 0, 1), 2), null);
});

test("raycast meets a block's real shape: a ray over a bottom slab passes, one into it hits its face", () => {
  // prismarine-world `raycast` intersects `block.shapes` (`world.js:67`), so a slab stops only what crosses its half.
  const world = createFakeWorld(VERSION, { cells: { "0,64,2": "stone_slab" } });
  assert.equal(world.raycast(at(0.5, 64.67, 0.5), new Vec3(0, 0, 1), 10), null, "0.17 above the slab's top");
  const hit = world.raycast(at(0.5, 64.25, 0.5), new Vec3(0, 0, 1), 10)!;
  assert.equal(hit.name, "stone_slab");
  assert.deepEqual(hit.position, at(0, 64, 2));
  assert.equal(hit.face, 2);
  assert.ok(Math.abs(hit.intersect.z - 2) < 1e-9 && Math.abs(hit.intersect.y - 64.25) < 1e-9, "met on the slab's north face");
});
