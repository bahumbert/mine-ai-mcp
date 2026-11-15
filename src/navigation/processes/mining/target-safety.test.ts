import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, type FakeCell } from "../../../test-support/fake-bot/index.js";
import { flatWorld } from "../../../test-support/navigation.js";
import { createMovementPolicy } from "../../movements/policy.js";
import { evaluateMineTarget, isWalkwayOverDrop, lavaClosuresOf, standsOnBlock } from "./target-safety.js";
import { BREAK_UNDER_WATER, createMineflayerMovementPolicy } from "../../mineflayer/movement-policy.js";
import { observeMineflayerBlock } from "../../mineflayer/world.js";
import { setProtectedRegionsProvider } from "../../../world/protected-regions.js";
import { rememberSealedPit } from "../../../world/sealed-pits.js";

/** The cells of a box named by `nameAt`, for a world the test writes as a rule on x, y and z. */
function cellsOf(box: { x: [number, number]; y: [number, number]; z: [number, number] }, nameAt: (x: number, y: number, z: number) => FakeCell): Record<string, FakeCell> {
  const cells: Record<string, FakeCell> = {};
  for (let x = box.x[0]; x <= box.x[1]; x++)
    for (let y = box.y[0]; y <= box.y[1]; y++)
      for (let z = box.z[0]; z <= box.z[1]; z++) cells[`${x},${y},${z}`] = nameAt(x, y, z);
  return cells;
}

/** The world view the mining rule reads, over the bot's own world. */
const viewOf = (bot: ReturnType<typeof createFakeBot>["bot"]) => ({
  blockAt: (x: number, y: number, z: number) => observeMineflayerBlock(bot.blockAt(new Vec3(x, y, z))!),
  revision: 0, subscribe: () => () => {},
});

test("a pond-edge log is mineable only drained, and a refused in-water target is marked underWater", () => {
  const { bot } = createFakeBot({ groundY: 63, cells: { "0,64,0": "oak_log", "-1,64,0": "water" } });
  const target = bot.blockAt(new Vec3(0, 64, 0))!;
  const world = viewOf(bot);
  const policy = createMineflayerMovementPolicy(bot);
  const accepted = evaluateMineTarget(bot, policy, target, world, 1);
  assert.equal(accepted.kind, "mineable");
  if (accepted.kind !== "mineable") throw new Error("expected a drainable log");
  assert.equal(accepted.routeMayBreak, false);
  assert.ok(accepted.drained?.wetStances.some((cell) => cell.x === -1 && cell.y === 64 && cell.z === 0));
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 0), {
    kind: "prohibited", underWater: true, reason: "in water: draining it takes 1 block to place, 0 carried",
  });
});

test("stone under a seabed with no wet face decides as today, and lava over a block is no underWater", () => {
  const { bot, world } = createFakeBot({ groundY: 63, cells: { "0,64,0": "stone", "0,65,0": "stone", "0,66,0": "water" } });
  const policy = createMineflayerMovementPolicy(bot);
  const target = bot.blockAt(new Vec3(0, 64, 0))!;
  assert.deepEqual(evaluateMineTarget(bot, policy, target, viewOf(bot), 0), { kind: "mineable", routeMayBreak: true });
  world.setCell(new Vec3(0, 65, 0), "lava");
  assert.deepEqual(evaluateMineTarget(bot, policy, target, viewOf(bot), 16), { kind: "prohibited", reason: BREAK_UNDER_WATER });
  world.setCell(new Vec3(0, 65, 0), "water");
  assert.deepEqual(evaluateMineTarget(bot, policy, target, viewOf(bot), 16), { kind: "prohibited", reason: BREAK_UNDER_WATER, underWater: true });
});

test("lava preparation counts permitted building material, not reserved inventory", () => {
  const { bot } = createFakeBot({ carried: { oak_log: 64 }, groundY: null, cells: { "0,64,0": "oak_log", "1,64,0": "lava" } });
  const target = bot.blockAt(new Vec3(0, 64, 0))!;
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

test("water-face isolation needs building material even when the miner is already swimming", () => {
  const { bot, world: gameWorld } = createFakeBot({ groundY: 62, cells: { "2,64,0": "water", "1,64,0": "stone" } });
  const world = viewOf(bot);
  const policy = createMineflayerMovementPolicy(bot);
  const target = bot.blockAt(new Vec3(1, 64, 0))!;
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 0), {
    kind: "prohibited", reason: "in water: draining it takes 1 block to place, 0 carried", underWater: true,
  });
  const prepared = evaluateMineTarget(bot, policy, target, world, 1);
  assert.equal(prepared.kind === "mineable" && prepared.drained !== undefined && !prepared.routeMayBreak, true);
  Reflect.set(bot.entity, "isInWater", true);
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 0), {
    kind: "prohibited", reason: "in water: draining it takes 1 block to place, 0 carried", underWater: true,
  });
  Reflect.set(bot.entity, "isInWater", false);
  gameWorld.setCell(new Vec3(1, 65, 0), "water");
  // Owner, 2026-10-02: never mine under water, whatever the occasion; a submerged block is reached from the land below.
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 0), { kind: "prohibited", reason: BREAK_UNDER_WATER, underWater: true },
    "a submerged target is never mined, not even from the shore");
});

test("lava below an open drop column needs a floor under the target", () => {
  const { bot, world: gameWorld } = createFakeBot({ carried: { cobblestone: 1 }, groundY: null, cells: { "0,64,0": "stone", "0,61,0": "lava" } });
  const target = bot.blockAt(new Vec3(0, 64, 0))!;
  const policy = createMovementPolicy();
  const world = flatWorld();
  assert.deepEqual(lavaClosuresOf(bot, target.position), [{ x: 0, y: 63, z: 0 }]);
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 0), {
    kind: "prohibited",
    reason: "a floor over lava, 0 blocks available for placement",
  });
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 1), { kind: "mineable", routeMayBreak: false });

  gameWorld.setCell(new Vec3(0, 61, 0), "air");
  gameWorld.setCell(new Vec3(0, 63, 0), "lava");
  assert.deepEqual(lavaClosuresOf(bot, target.position), [{ x: 0, y: 63, z: 0 }],
    "lava directly below is a face, counted once");
});

test("a drop column that ends on a solid block or in water needs no floor", () => {
  const { bot, world: gameWorld } = createFakeBot({ groundY: null, cells: { "0,64,0": "stone", "0,61,0": "stone", "0,60,0": "lava" } });
  assert.deepEqual(lavaClosuresOf(bot, { x: 0, y: 64, z: 0 }), []);
  // Items float in water, so a pool between the target and the lava catches the drop.
  gameWorld.setCell(new Vec3(0, 61, 0), "water");
  assert.deepEqual(lavaClosuresOf(bot, { x: 0, y: 64, z: 0 }), []);
});

test("a block inside a protected region is never a mining target, and the refusal names the region", () => {
  const { bot } = createFakeBot({ groundY: 62, cells: { "1,64,0": "dirt" } });
  const world = viewOf(bot);
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

test("a plug block of a sealed pit is not a mine target, the same block elsewhere is", () => {
  // Cobblestone along y 64 from x 1 east (loaded to x 12).
  const { bot } = createFakeBot({ groundY: 62, cells: cellsOf({ x: [-3, 12], y: [63, 66], z: [-3, 3] }, (x, y) => (y === 64 && x >= 1 ? "cobblestone" : "air")) });
  const world = viewOf(bot);
  const policy = createMineflayerMovementPolicy(bot);
  const plug = bot.blockAt(new Vec3(1, 64, 0))!;
  const elsewhere = bot.blockAt(new Vec3(5, 64, 0))!;
  assert.equal(evaluateMineTarget(bot, policy, plug, world, 0).kind, "mineable");
  rememberSealedPit(bot, { x: 1, y: 62, z: 0 });
  assert.deepEqual(evaluateMineTarget(bot, policy, plug, world, 0), {
    kind: "prohibited", reason: "it would open the pit of items buried at 1 62 0",
  });
  assert.equal(evaluateMineTarget(bot, policy, elsewhere, world, 0).kind, "mineable");
});

test("a bridge over a deep drop is never a mining target, the same block on the ground is", () => {
  // A cobblestone bridge at y 64 along z 0, x 0..4: ground at y 63 under x 0..1, a 10-deep gap under x 2..4.
  const cell = (x: number, y: number, z: number) =>
    y === 64 && z === 0 && x >= 0 && x <= 4 ? "cobblestone" : y === 63 && x <= 1 ? "stone" : "air";
  const { bot } = createFakeBot({ position: new Vec3(9.5, 64, 9.5), groundY: 52, cells: cellsOf({ x: [-3, 6], y: [53, 66], z: [-3, 3] }, cell) });
  const world = viewOf(bot);
  const policy = createMineflayerMovementPolicy(bot);
  const reasonFor = (x: number) => evaluateMineTarget(bot, policy, bot.blockAt(new Vec3(x, 64, 0))!, world, 0);
  assert.equal(reasonFor(3).kind, "prohibited", "over the gap");
  assert.match((reasonFor(3) as { reason: string }).reason, /walkway over a drop/);
  assert.equal(reasonFor(1).kind, "mineable", "on the ground");
  assert.deepEqual(reasonFor(0), { kind: "mineable", routeMayBreak: true }, "the ground end of the bridge");
  // Standing on the ground end is a stance problem the scan answers, not a property of the block.
  bot.entity.position = new Vec3(1.5, 65, 0.5);
  assert.equal(reasonFor(1).kind, "mineable");
  // Standing over the gap, the block is still the walkway that strands the bot.
  bot.entity.position = new Vec3(3.5, 65, 0.5);
  assert.match((reasonFor(3) as { reason: string }).reason, /walkway over a drop/);
});

test("a bridge over a long drop is a walkway unless the drop ends in two cells of source water (06b T4: a long fall needs source water)", () => {
  // A cobblestone bridge at y 64 along z 0, x 0..4: ground at y 63 under x 0..1, a 10-deep gap under x 2..4 with two water cells at its foot (landing y 53, below y 52).
  const bridge = (x: number, y: number, z: number): FakeCell =>
    y === 64 && z === 0 && x >= 0 && x <= 4 ? "cobblestone" : y === 63 && x <= 1 ? "stone" : "air";
  const flowing: FakeCell = { name: "water", properties: { level: 1 } };
  const verdictOver = (landing: FakeCell, below: FakeCell) => {
    const { bot } = createFakeBot({
      position: new Vec3(9.5, 64, 9.5),
      groundY: 40,
      cells: { ...cellsOf({ x: [-3, 6], y: [54, 66], z: [-3, 3] }, bridge), ...cellsOf({ x: [2, 4], y: [53, 53], z: [0, 0] }, () => landing), ...cellsOf({ x: [2, 4], y: [52, 52], z: [0, 0] }, () => below) },
    });
    return evaluateMineTarget(bot, createMineflayerMovementPolicy(bot), bot.blockAt(new Vec3(3, 64, 0))!, viewOf(bot), 0).kind;
  };
  assert.equal(verdictOver("water", "water"), "mineable", "source water two deep is a landing");
  assert.equal(verdictOver(flowing, flowing), "prohibited", "flowing water is no landing");
  assert.equal(verdictOver("water", flowing), "prohibited", "a source landing over flowing water is not two deep");
  assert.equal(verdictOver(flowing, "water"), "prohibited", "flowing water over a source is not a source landing");
});

test("a carpet landing ends a mining walkway's empty column at the existing drop limit", () => {
  const { bot } = createFakeBot({ groundY: 59, cells: {
    "0,64,0": "cobblestone", "0,63,0": "air", "0,62,0": "air", "0,61,0": "air", "0,60,0": "white_carpet",
  } });
  assert.equal(isWalkwayOverDrop(createMovementPolicy({ maximumDrop: 3 }), viewOf(bot), { x: 0, y: 64, z: 0 }), false);
});

test("standsOnBlock: on the block, not beside it or lower in its column; a swimmer afloat over it does not", () => {
  const { bot } = createFakeBot({ position: new Vec3(1.5, 65, 0.5), groundY: 64 });
  const block = { x: 1, y: 64, z: 0 };
  assert.equal(standsOnBlock(bot, block), true);
  assert.equal(standsOnBlock(bot, { x: 2, y: 64, z: 0 }), false, "the next column");
  assert.equal(standsOnBlock(bot, { x: 1, y: 63, z: 0 }), false, "a block lower in the column");
  Object.assign(bot.entity, { isInWater: true, onGround: true });
  assert.equal(standsOnBlock(bot, block), true, "wading on the block: breaking it in place would let the water in");
  Object.assign(bot.entity, { onGround: false });
  assert.equal(standsOnBlock(bot, block), false, "a swimmer afloat works from the top stance");
});

test("standsOnBlock: a target under the footprint's edge with the centre over a drop is the body's floor; a solid neighbour is the floor instead", () => {
  const target = { x: 1, y: 64, z: 0 };
  const edge = new Vec3(0.85, 65, 0.5);
  const over = createFakeBot({ position: edge, groundY: 50, cells: { "1,64,0": "stone" } });
  assert.equal(standsOnBlock(over.bot, target), true, "the 0.6-wide body is on the step's edge, the other column is air");
  const held = createFakeBot({ position: edge, groundY: 50, cells: { "1,64,0": "stone", "0,64,0": "stone" } });
  assert.equal(standsOnBlock(held.bot, target), false, "the neighbouring column carries the body, the target may be mined from here");
  const centred = createFakeBot({ position: new Vec3(1.1, 65, 0.5), groundY: 50, cells: { "1,64,0": "stone", "0,64,0": "stone" } });
  assert.equal(standsOnBlock(centred.bot, target), false, "a centre over the target with a solid neighbour under the footprint: the neighbour carries it too");
  const beside = createFakeBot({ position: new Vec3(0.7, 65, 0.5), groundY: 50, cells: { "1,64,0": "stone" } });
  assert.equal(standsOnBlock(beside.bot, target), false, "a footprint that only touches the boundary is not on it");
});

test("standing mid-bridge over a 20-deep gap, no bridge block is a target; cobblestone on the ground still is", () => {
  // Bridge at y 64, x 0..9 along z 0, over a gap down to y 44; ground at y 63 for x <= -1 and x >= 10, and cobblestone 15 away.
  const cell = (x: number, y: number, z: number) =>
    y === 64 && z === 0 && x >= 0 && x <= 9 ? "cobblestone"
      : y === 64 && z === 0 && x === 25 ? "cobblestone"
        : (x <= -1 || x >= 10) && y <= 63 ? "stone" : "air";
  const { bot } = createFakeBot({ position: new Vec3(5.5, 65, 0.5), groundY: 43, cells: cellsOf({ x: [-3, 27], y: [44, 66], z: [-3, 3] }, cell) });
  const world = viewOf(bot);
  const policy = createMineflayerMovementPolicy(bot);
  const verdict = (x: number) => evaluateMineTarget(bot, policy, bot.blockAt(new Vec3(x, 64, 0))!, world, 0).kind;
  for (let x = 0; x <= 9; x += 1) assert.equal(verdict(x), "prohibited", `bridge block ${x}`);
  assert.equal(verdict(25), "mineable", "the cobblestone on the ground");
});
