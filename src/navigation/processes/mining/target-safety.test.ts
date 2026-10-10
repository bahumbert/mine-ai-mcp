import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { flatWorld } from "../../../test-support/navigation.js";
import { blockClass } from "../../mineflayer/world.js";
import { createMovementPolicy } from "../../movements/policy.js";
import { evaluateMineTarget, lavaClosuresOf } from "./target-safety.js";
import { BREAK_UNDER_WATER, createMineflayerMovementPolicy } from "../../mineflayer/movement-policy.js";
import { observeMineflayerBlock } from "../../mineflayer/world.js";
import { setProtectedRegionsProvider } from "../../../world/protected-regions.js";

test("lava preparation counts permitted building material, not reserved inventory", () => {
  const bot = botFixture({ items: [{ type: 1, name: "oak_log", count: 64 }] });
  const blocks = blockClass(bot);
  const target = blocks.fromStateId(bot.registry.blocksByName.oak_log!.defaultState, 0);
  target.position = new Vec3(0, 64, 0);
  bot.blockAt = (position) => {
    const name = position.equals(new Vec3(1, 64, 0)) ? "lava" : "air";
    const block = blocks.fromStateId(bot.registry.blocksByName[name]!.defaultState, 0);
    block.position = position;
    return block;
  };
  const policy = createMovementPolicy();
  const world = flatWorld();
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 0), {
    kind: "prohibited",
    reason: "1 lava face, 0 blocks available for placement",
  });
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 1), {
    kind: "mineable",
    routeMayBreak: false,
  });
});

test("missing isolation material rejects a dry water barrier but retains a swimmer's approach", () => {
  const bot = botFixture();
  const blocks = blockClass(bot);
  let submergedTarget = false;
  bot.blockAt = (position) => {
    const name = position.equals(new Vec3(2, 64, 0)) || (submergedTarget && position.equals(new Vec3(1, 65, 0)))
      ? "water" : position.equals(new Vec3(1, 64, 0)) ? "stone" : position.y < 63 ? "stone" : "air";
    const block = blocks.fromStateId(bot.registry.blocksByName[name]!.minStateId, 0);
    block.position = position;
    return block;
  };
  const world = {
    blockAt: (x: number, y: number, z: number) => observeMineflayerBlock(bot.blockAt(new Vec3(x, y, z))!),
    revision: 0, subscribe: () => () => {},
  };
  const policy = createMineflayerMovementPolicy(bot);
  const target = bot.blockAt(new Vec3(1, 64, 0))!;
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 0), {
    kind: "prohibited", reason: "liquid isolation needs a permitted building block or an empty bucket",
  });
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 1), { kind: "mineable", routeMayBreak: false });
  Reflect.set(bot.entity, "isInWater", true);
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 0), { kind: "mineable", routeMayBreak: false });
  Reflect.set(bot.entity, "isInWater", false);
  submergedTarget = true;
  // Owner, 2026-10-02: never mine under water, whatever the occasion; a submerged block is reached from the land below.
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 0), { kind: "prohibited", reason: BREAK_UNDER_WATER },
    "a submerged target is never mined, not even from the shore");
});

test("lava below an open drop column needs a floor under the target", () => {
  const bot = botFixture({ items: [{ type: 1, name: "cobblestone", count: 1 }] });
  const blocks = blockClass(bot);
  let lavaDepth = 3;
  bot.blockAt = (position) => {
    const name = position.equals(new Vec3(0, 64, 0)) ? "stone"
      : position.equals(new Vec3(0, 64 - lavaDepth, 0)) ? "lava" : "air";
    const block = blocks.fromStateId(bot.registry.blocksByName[name]!.minStateId, 0);
    block.position = position;
    return block;
  };
  const target = bot.blockAt(new Vec3(0, 64, 0))!;
  const policy = createMovementPolicy();
  const world = flatWorld();
  assert.deepEqual(lavaClosuresOf(bot, target.position), [{ x: 0, y: 63, z: 0 }]);
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 0), {
    kind: "prohibited",
    reason: "a floor over lava, 0 blocks available for placement",
  });
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 1), { kind: "mineable", routeMayBreak: false });

  lavaDepth = 1;
  assert.deepEqual(lavaClosuresOf(bot, target.position), [{ x: 0, y: 63, z: 0 }],
    "lava directly below is a face, counted once");
});

test("a drop column that ends on a solid block or in water needs no floor", () => {
  const bot = botFixture();
  const blocks = blockClass(bot);
  let stop = "stone";
  bot.blockAt = (position) => {
    const name = position.equals(new Vec3(0, 64, 0)) ? "stone"
      : position.equals(new Vec3(0, 61, 0)) ? stop
      : position.equals(new Vec3(0, 60, 0)) ? "lava" : "air";
    const block = blocks.fromStateId(bot.registry.blocksByName[name]!.minStateId, 0);
    block.position = position;
    return block;
  };
  assert.deepEqual(lavaClosuresOf(bot, { x: 0, y: 64, z: 0 }), []);
  // Items float in water, so a pool between the target and the lava catches the drop.
  stop = "water";
  assert.deepEqual(lavaClosuresOf(bot, { x: 0, y: 64, z: 0 }), []);
});

test("a block inside a protected region is never a mining target, and the refusal names the region", () => {
  const bot = botFixture();
  const blocks = blockClass(bot);
  bot.blockAt = (position) => {
    const name = position.equals(new Vec3(1, 64, 0)) ? "dirt" : position.y < 63 ? "stone" : "air";
    const block = blocks.fromStateId(bot.registry.blocksByName[name]!.defaultState, 0);
    block.position = position;
    return block;
  };
  const world = {
    blockAt: (x: number, y: number, z: number) => observeMineflayerBlock(bot.blockAt(new Vec3(x, y, z))!),
    revision: 0, subscribe: () => () => {},
  };
  const target = bot.blockAt(new Vec3(1, 64, 0))!;
  const policy = createMineflayerMovementPolicy(bot);
  setProtectedRegionsProvider(bot, () => []);
  assert.equal(evaluateMineTarget(bot, policy, target, world, 0).kind, "mineable");
  setProtectedRegionsProvider(bot, () => [
    { regionId: 3, dimension: "overworld", min: { x: 0, y: 63, z: -1 }, max: { x: 2, y: 65, z: 1 }, owner: "Tom", label: "Tom's place" },
  ]);
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 0), {
    kind: "prohibited", reason: "inside protected region #3 'Tom's place' (owner Tom)",
  });
});

test("a bridge over a deep drop is never a mining target, the same block on the ground is", () => {
  const bot = botFixture();
  const blocks = blockClass(bot);
  // A cobblestone bridge at y 64 along z 0, x 0..4: ground at y 63 under x 0..1, a 10-deep gap under x 2..4.
  const cell = (x: number, y: number, z: number) =>
    y === 64 && z === 0 && x >= 0 && x <= 4 ? "cobblestone" : y === 63 && x <= 1 ? "stone" : y <= 52 ? "stone" : "air";
  bot.blockAt = (position) => {
    const block = blocks.fromStateId(bot.registry.blocksByName[cell(position.x, position.y, position.z)]!.defaultState, 0);
    block.position = position;
    return block;
  };
  const world = {
    blockAt: (x: number, y: number, z: number) => observeMineflayerBlock(bot.blockAt(new Vec3(x, y, z))!),
    revision: 0, subscribe: () => () => {},
  };
  bot.entity.position = new Vec3(9.5, 64, 9.5);
  const policy = createMineflayerMovementPolicy(bot);
  const reasonFor = (x: number) => evaluateMineTarget(bot, policy, bot.blockAt(new Vec3(x, 64, 0))!, world, 0);
  assert.equal(reasonFor(3).kind, "prohibited", "over the gap");
  assert.match((reasonFor(3) as { reason: string }).reason, /walkway over a drop/);
  assert.equal(reasonFor(1).kind, "mineable", "on the ground");
  assert.deepEqual(reasonFor(0), { kind: "mineable", routeMayBreak: true }, "the ground end of the bridge");
  bot.entity.position = new Vec3(1.5, 65, 0.5);
  assert.deepEqual(reasonFor(1), { kind: "prohibited", reason: "the block the bot stands on" });
});

test("standing mid-bridge over a 20-deep gap, no bridge block is a target; cobblestone on the ground still is", () => {
  const bot = botFixture();
  const blocks = blockClass(bot);
  // Bridge at y 64, x 0..9 along z 0, over a gap down to y 44; ground at y 63 for x <= -1 and x >= 10, and cobblestone 15 away.
  const cell = (x: number, y: number, z: number) =>
    y === 64 && z === 0 && x >= 0 && x <= 9 ? "cobblestone"
      : y === 64 && z === 0 && x === 25 ? "cobblestone"
        : (x <= -1 || x >= 10) && y <= 63 ? "stone" : y <= 43 ? "stone" : "air";
  bot.blockAt = (position) => {
    const block = blocks.fromStateId(bot.registry.blocksByName[cell(position.x, position.y, position.z)]!.defaultState, 0);
    block.position = position;
    return block;
  };
  const world = {
    blockAt: (x: number, y: number, z: number) => observeMineflayerBlock(bot.blockAt(new Vec3(x, y, z))!),
    revision: 0, subscribe: () => () => {},
  };
  bot.entity.position = new Vec3(5.5, 65, 0.5);
  const policy = createMineflayerMovementPolicy(bot);
  const verdict = (x: number) => evaluateMineTarget(bot, policy, bot.blockAt(new Vec3(x, 64, 0))!, world, 0).kind;
  for (let x = 0; x <= 9; x += 1) assert.equal(verdict(x), "prohibited", `bridge block ${x}`);
  assert.equal(verdict(25), "mineable", "the cobblestone on the ground");
});
