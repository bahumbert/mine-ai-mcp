import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { placeOffsetShapes } from "./offset-shapes.js";

const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.4") as { readonly blocksByName: Record<string, { readonly defaultState: number }> };
const BlockClass = require("prismarine-block")(registry) as {
  fromStateId(stateId: number, biome: number): { position?: Vec3; shapes: number[][]; name: string };
};

interface FakeBlock {
  position?: Vec3;
  shapes: number[][];
  name: string;
}
interface FakeWorld {
  getBlock(position: Vec3): FakeBlock | null;
  raycast(from: Vec3, direction: Vec3): FakeBlock | null;
}
interface FakeBot {
  registry: unknown;
  world: FakeWorld;
  blockAt(position: Vec3): FakeBlock | null;
}

const stateOf = (name: string): number => registry.blocksByName[name]!.defaultState;
const key = (position: Vec3): string => `${position.x},${position.y},${position.z}`;

/** A world like Mineflayer's `WorldSync`: a fresh block each call, its `shapes` the registry's shared array. */
function fakeWorld(cells: Record<string, string>): FakeWorld {
  const world: FakeWorld = {
    getBlock(position) {
      const name = cells[key(position.floored())];
      if (name === undefined) return null;
      const block = BlockClass.fromStateId(stateOf(name), 0);
      block.position = position.floored();
      return block;
    },
    raycast(from) {
      return this.getBlock(from);
    },
  };
  return world;
}

function fakeBot(world: FakeWorld, botRegistry: unknown = registry): FakeBot {
  const bot: FakeBot = { registry: botRegistry, world, blockAt: (position) => bot.world.getBlock(position) };
  return bot;
}

const asBot = (bot: FakeBot): Bot => bot as unknown as Bot;
const BAMBOO_AT_AYLA = [0.622917, 0, 0.55625, 0.810417, 1, 0.74375];
const AYLA = new Vec3(191, 78, 292);

function assertBox(actual: readonly number[] | undefined, expected: readonly number[]): void {
  assert.ok(actual !== undefined);
  expected.forEach((value, index) => assert.ok(Math.abs(actual[index]! - value) < 1e-6, `box[${index}] ${actual[index]} vs ${value}`));
}

test("a bamboo block read from the world has the server's box at its cell", () => {
  const bot = fakeBot(fakeWorld({ [key(AYLA)]: "bamboo" }));
  placeOffsetShapes(asBot(bot));
  const block = bot.world.getBlock(AYLA)!;
  assert.equal(block.shapes.length, 1);
  assertBox(block.shapes[0], BAMBOO_AT_AYLA);
});

test("a block that is not offset keeps the registry's own shapes array", () => {
  const bot = fakeBot(fakeWorld({ [key(AYLA)]: "stone" }));
  const original = BlockClass.fromStateId(stateOf("stone"), 0).shapes;
  placeOffsetShapes(asBot(bot));
  assert.equal(bot.world.getBlock(AYLA)!.shapes, original);
});

test("placing a bamboo box leaves the registry's shared shapes alone", () => {
  const before = structuredClone(BlockClass.fromStateId(stateOf("bamboo"), 0).shapes);
  const bot = fakeBot(fakeWorld({ [key(AYLA)]: "bamboo" }));
  placeOffsetShapes(asBot(bot));
  bot.world.getBlock(AYLA);
  assert.deepEqual(BlockClass.fromStateId(stateOf("bamboo"), 0).shapes, before);
});

test("an unloaded cell is still null", () => {
  const bot = fakeBot(fakeWorld({}));
  placeOffsetShapes(asBot(bot));
  assert.equal(bot.world.getBlock(AYLA), null);
});

test("a new world after a dimension change is placed too, and the old one is not moved twice", () => {
  const first = fakeWorld({ [key(AYLA)]: "bamboo" });
  const bot = fakeBot(first);
  placeOffsetShapes(asBot(bot));
  const second = fakeWorld({ [key(AYLA)]: "bamboo" });
  bot.world = second;
  assertBox(bot.world.getBlock(AYLA)!.shapes[0], BAMBOO_AT_AYLA);
  assert.equal(bot.world, second);
  bot.world = first;
  assertBox(first.getBlock(AYLA)!.shapes[0], BAMBOO_AT_AYLA);
  assertBox(first.getBlock(AYLA)!.shapes[0], BAMBOO_AT_AYLA);
});

test("the disposer gives back the data box, the original method and a plain world property", () => {
  const first = fakeWorld({ [key(AYLA)]: "bamboo" });
  const own = Object.getOwnPropertyDescriptor(first, "getBlock");
  const bot = fakeBot(first);
  const dispose = placeOffsetShapes(asBot(bot));
  const second = fakeWorld({ [key(AYLA)]: "bamboo" });
  bot.world = second;
  dispose();
  assertBox(first.getBlock(AYLA)!.shapes[0], [0.15625, 0, 0.15625, 0.34375, 1, 0.34375]);
  assertBox(second.getBlock(AYLA)!.shapes[0], [0.15625, 0, 0.15625, 0.34375, 1, 0.34375]);
  assert.equal(Object.getOwnPropertyDescriptor(first, "getBlock")?.value, own?.value);
  const descriptor = Object.getOwnPropertyDescriptor(bot, "world")!;
  assert.equal(descriptor.get, undefined);
  assert.equal(descriptor.writable, true);
  assert.equal(descriptor.value, second);
});

test("a registry without collision data installs nothing", () => {
  const world = fakeWorld({ [key(AYLA)]: "bamboo" });
  const bot = fakeBot(world, {});
  const getBlock = world.getBlock;
  const dispose = placeOffsetShapes(asBot(bot));
  assert.equal(world.getBlock, getBlock);
  assert.equal(Object.getOwnPropertyDescriptor(bot, "world")?.get, undefined);
  dispose();
});

test("two bots are wrapped independently", () => {
  const botA = fakeBot(fakeWorld({ [key(AYLA)]: "bamboo" }));
  const botB = fakeBot(fakeWorld({ [key(AYLA)]: "bamboo" }));
  const disposeA = placeOffsetShapes(asBot(botA));
  placeOffsetShapes(asBot(botB));
  disposeA();
  assertBox(botA.world.getBlock(AYLA)!.shapes[0], [0.15625, 0, 0.15625, 0.34375, 1, 0.34375]);
  assertBox(botB.world.getBlock(AYLA)!.shapes[0], BAMBOO_AT_AYLA);
});

test("blockAt and a raycast that calls getBlock on the world see the placed box", () => {
  const bot = fakeBot(fakeWorld({ [key(AYLA)]: "bamboo" }));
  placeOffsetShapes(asBot(bot));
  assertBox(bot.blockAt(AYLA)!.shapes[0], BAMBOO_AT_AYLA);
  assertBox(bot.world.raycast(AYLA, new Vec3(0, 1, 0))!.shapes[0], BAMBOO_AT_AYLA);
});

test("a world that cannot read blocks (a bare fake) is left alone, and a later real world is still placed", () => {
  const bot = fakeBot({} as FakeWorld);
  placeOffsetShapes(asBot(bot));
  const real = fakeWorld({ [key(AYLA)]: "bamboo" });
  bot.world = real;
  assertBox(bot.world.getBlock(AYLA)!.shapes[0], BAMBOO_AT_AYLA);
});
