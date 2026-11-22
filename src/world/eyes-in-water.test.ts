import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { botEyesInWater, eyesInWater, hasQualifiedEyeWaterSample, standingEyesInWater, type WaterCell } from "./eyes-in-water.js";

/** A column at x 0, z 0 read from cells by y; every other cell is air. */
const column = (cells: Record<number, WaterCell>) => (x: number, y: number, z: number): WaterCell | null =>
  x === 0 && z === 0 ? (cells[y] ?? { name: "air" }) : { name: "air" };
const flowing = (level: number): WaterCell => ({ name: "water", properties: { level: String(level) } });
const source: WaterCell = { name: "water", properties: { level: "0" } };
const EYE = 1.62;

test("the eye crosses the rounded top of a negative-Y source cell before it reaches the next cell", () => {
  for (const y of [-58, -1]) {
    const water = column({ [y]: source });
    const top = Math.fround(y + Math.fround(8 / 9));
    assert.equal(eyesInWater(water, top - 0.000_000_001, 0.5, 0.5), true);
    assert.equal(eyesInWater(water, top, 0.5, 0.5), false);
    assert.equal(eyesInWater(water, top + 0.000_000_001, 0.5, 0.5), false);
    assert.equal(eyesInWater(water, y + 1, 0.5, 0.5), false);
  }
  assert.equal(eyesInWater(column({ [-58]: flowing(8), [-57]: source }), -57, 0.5, 0.5), true);
});

test("the live crouching eye can be wet at a dry standing destination", () => {
  const feet = new Vec3(0.5, -58.644, 0.5);
  const { bot } = createFakeBot({ position: feet, cells: { "0,-58,0": "water" } });
  const pose = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("pose");
  // 1.21.4 Pose.CROUCHING and the resulting Mineflayer entityCrouch eye height.
  Reflect.set(bot.entity.metadata, pose, 5);
  Reflect.set(bot.entity, "eyeHeight", 1.27);
  assert.equal(botEyesInWater(bot), true, "the live crouching eyes are below the top");
  assert.equal(standingEyesInWater(bot, feet), false, "the planned standing eyes are above the top");
});

test("an unqualified version, pose or mounted body keeps the legacy sample", () => {
  const position = new Vec3(0.5, -58.644, 0.5);
  const cells = { "0,-58,0": "water" };
  const older = createFakeBot({ version: "1.20.4", position: new Vec3(0.5, 64.356, 0.5), cells: { "0,65,0": "water" } }).bot;
  assert.equal(botEyesInWater(older), true, "unmeasured version");
  assert.equal(hasQualifiedEyeWaterSample(older), false);

  const { bot } = createFakeBot({ position, cells, entities: { 7: { name: "oak_boat", position } } });
  const pose = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("pose");
  Reflect.set(bot.entity.metadata, pose, 3); // 1.21.4 Pose.SWIMMING.
  assert.equal(botEyesInWater(bot), true, "unmeasured pose");
  assert.equal(hasQualifiedEyeWaterSample(bot), false);
  Reflect.set(bot.entity.metadata, pose, 0);
  bot.vehicle = bot.entities[7]!;
  assert.equal(botEyesInWater(bot), true, "unmeasured rider");
  assert.equal(hasQualifiedEyeWaterSample(bot), false);
});

test("only the default scale qualifies the live and planned eyes", () => {
  const feet = new Vec3(0.5, -58.644, 0.5);
  const { bot } = createFakeBot({ position: feet, cells: { "0,-58,0": "water" } });
  assert.equal(hasQualifiedEyeWaterSample(bot), true, "omitted default scale");
  Reflect.set(bot.entity, "attributes", { "generic.scale": { value: 1, modifiers: [] } });
  assert.equal(hasQualifiedEyeWaterSample(bot), true, "reported default scale");
  assert.equal(botEyesInWater(bot), false);
  Reflect.set(bot.entity, "attributes", { "generic.scale": { value: 0.5, modifiers: [] } });
  assert.equal(eyesInWater(column({ [-58]: source }), feet.y + Math.fround(EYE) * 0.5, feet.x, feet.z), true);
  assert.equal(hasQualifiedEyeWaterSample(bot), false, "reported scaled body");
  assert.equal(botEyesInWater(bot), true, "live legacy fallback");
  assert.equal(standingEyesInWater(bot, feet), true, "planned legacy fallback");
  Reflect.set(bot.entity, "attributes", { "generic.scale": { value: 1, modifiers: [{ amount: -0.5, operation: 0 }] } });
  assert.equal(hasQualifiedEyeWaterSample(bot), false, "reported scale modifier");
});

test("water at eye height fills (8 - level)/9 of its cell for flowing levels 1 through 7", () => {
  // Feet on the floor (y 0): the eye point is at y 1.62, in cell 1.
  for (const [level, under] of [[1, true], [2, true], [3, false], [4, false], [5, false], [7, false]] as const)
    assert.equal(eyesInWater(column({ 1: flowing(level) }), 0 + EYE, 0.5, 0.5), under, `feet 0.0, level ${level}`);
  // Feet at y 0.2 (a swimmer rising): the eye point is at y 1.82.
  for (const [level, under] of [[0, true], [1, false], [2, false], [7, false]] as const)
    assert.equal(eyesInWater(column({ 1: flowing(level) }), 0.2 + EYE, 0.5, 0.5), under, `feet 0.2, level ${level}`);
});

test("source, falling and waterlogged cells have an 8/9 surface", () => {
  const cells = [source, flowing(8),
    { name: "oak_stairs", properties: { waterlogged: true } },
    { name: "oak_slab", properties: { waterlogged: "true" } },
    { name: "light", properties: { level: 15, waterlogged: true } },
  ];
  // 8/9 of the cell is 1.889: the eye point at feet 0.25 (1.87) is under it, at feet 0.3 (1.92) above it.
  for (const cell of cells) {
    const water = column({ 1: cell });
    assert.equal(eyesInWater(water, 0.25 + EYE, 0.5, 0.5), true, JSON.stringify(cell));
    assert.equal(eyesInWater(water, 0.3 + EYE, 0.5, 0.5), false, JSON.stringify(cell));
  }
});

test("water above the eye cell fills the whole cell, so any level is under water", () => {
  assert.equal(eyesInWater(column({ 1: flowing(7), 2: flowing(7) }), EYE, 0.5, 0.5), true);
  assert.equal(eyesInWater(column({ 1: flowing(4), 2: { name: "oak_stairs", properties: { waterlogged: true } } }), EYE, 0.5, 0.5), true);
});

test("a bubble column and water plants count as water", () => {
  for (const name of ["bubble_column", "seagrass", "kelp_plant"]) {
    assert.equal(eyesInWater(column({ 1: { name } }), EYE, 0.5, 0.5), true, name);
  }
});

test("air, cave air, stone, lava and unloaded cells are not water", () => {
  for (const name of ["air", "cave_air", "stone", "lava"])
    assert.equal(eyesInWater(column({ 1: { name, properties: { level: "0" } } }), EYE, 0.5, 0.5), false, name);
  assert.equal(eyesInWater(() => null, EYE, 0.5, 0.5), false);
  assert.equal(eyesInWater(column({ 1: { name: "lava", properties: { level: "0" } }, 2: source }), EYE, 0.5, 0.5), false, "water over lava does not make lava water");
});

test("the live call samples the bot's current feet and the standing call samples a destination", () => {
  const { bot } = createFakeBot({ position: new Vec3(0.5, 0, 0.5), cells: { "0,1,0": { name: "water", properties: { level: 4 } } } });
  assert.equal(botEyesInWater(bot), false, "level 4 at feet 0.0");
  bot.entity.position.y = -0.2; // Feet below the floor line, eye 1.42 under level 4's 1.444.
  assert.equal(botEyesInWater(bot), true);
  assert.equal(standingEyesInWater(bot, new Vec3(0.5, 0, 0.5)), false);
});
