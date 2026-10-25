import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { botEyesInWater, eyesInWater, type WaterCell } from "./eyes-in-water.js";

/** A column at x 0, z 0 read from cells by y; every other cell is air. */
const column = (cells: Record<number, WaterCell>) => (x: number, y: number, z: number): WaterCell | null =>
  x === 0 && z === 0 ? (cells[y] ?? { name: "air" }) : { name: "air" };
const flowing = (level: number): WaterCell => ({ name: "water", properties: { level: String(level) } });
const source: WaterCell = { name: "water", properties: { level: "0" } };
const EYE = 1.62;

test("flowing water at eye height fills (8 - level)/9 of its cell: the eyes are under it only when the point 1/9 below them is lower", () => {
  // Feet on the floor (y 0): the point is at y 1.509, in cell 1.
  for (const [level, under] of [[1, true], [2, true], [3, true], [4, false], [5, false], [7, false]] as const)
    assert.equal(eyesInWater(column({ 1: flowing(level) }), 0 + EYE, 0.5, 0.5), under, `feet 0.0, level ${level}`);
  // Feet at y 0.2 (a swimmer rising): the point is at y 1.709.
  for (const [level, under] of [[1, true], [2, false], [3, false], [7, false]] as const)
    assert.equal(eyesInWater(column({ 1: flowing(level) }), 0.2 + EYE, 0.5, 0.5), under, `feet 0.2, level ${level}`);
});

test("a source, a falling block and a waterlogged block fill 8/9 of their cell", () => {
  assert.equal(eyesInWater(column({ 1: source }), EYE, 0.5, 0.5), true);
  assert.equal(eyesInWater(column({ 1: flowing(8) }), EYE, 0.5, 0.5), true);
  assert.equal(eyesInWater(column({ 1: { name: "oak_stairs", properties: { waterlogged: true } } }), EYE, 0.5, 0.5), true);
  assert.equal(eyesInWater(column({ 1: { name: "oak_slab", properties: { waterlogged: "true" } } }), EYE, 0.5, 0.5), true);
  // 8/9 of the cell is 1.889: the eye point at feet 0.3 (1.809) is under it, at feet 0.4 (1.909) above it.
  assert.equal(eyesInWater(column({ 1: source }), 0.3 + EYE, 0.5, 0.5), true);
  assert.equal(eyesInWater(column({ 1: source }), 0.4 + EYE, 0.5, 0.5), false);
});

test("water above the eye cell fills the whole cell, so any level is under water", () => {
  assert.equal(eyesInWater(column({ 1: flowing(7), 2: flowing(7) }), EYE, 0.5, 0.5), true);
  assert.equal(eyesInWater(column({ 1: flowing(4), 2: { name: "oak_stairs", properties: { waterlogged: true } } }), EYE, 0.5, 0.5), true);
});

test("a bubble column counts as water", () => {
  assert.equal(eyesInWater(column({ 1: { name: "bubble_column", properties: { drag: true } } }), EYE, 0.5, 0.5), true);
});

test("air, cave air, stone, lava and unloaded cells are not water", () => {
  for (const name of ["air", "cave_air", "stone", "lava"])
    assert.equal(eyesInWater(column({ 1: { name, properties: { level: "0" } } }), EYE, 0.5, 0.5), false, name);
  assert.equal(eyesInWater(() => null, EYE, 0.5, 0.5), false);
  assert.equal(eyesInWater(column({ 1: { name: "lava", properties: { level: "0" } }, 2: source }), EYE, 0.5, 0.5), false, "water over lava does not make lava water");
});

test("botEyesInWater reads the bot's own position at eye height, or a given feet position", () => {
  const { bot } = createFakeBot({ position: new Vec3(0.5, 0, 0.5), cells: { "0,1,0": { name: "water", properties: { level: 4 } } } });
  assert.equal(botEyesInWater(bot), false, "level 4 at feet 0.0");
  bot.entity.position.y = 0.2 - 0.4; // feet below the floor line: point 1.309 in cell 1, under level 4's 1.444
  assert.equal(botEyesInWater(bot), true);
  assert.equal(botEyesInWater(bot, new Vec3(0.5, 0, 0.5)), false);
});

test("a waterlogged light block fills 8/9 of its cell whatever its light level: only water's own level is a flow level", () => {
  const light = { name: "light", properties: { level: 15, waterlogged: true } };
  assert.equal(eyesInWater(column({ 1: light }), 0.3 + EYE, 0.5, 0.5), true);
});
