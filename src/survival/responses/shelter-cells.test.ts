// The cells a shelter's projectile margin box overlaps: which, in what order, and what changes them.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { combatTestContext } from "../../test-support/combat.js";
import { createFakeBot, type FakeCell } from "../../test-support/fake-bot/index.js";
import { SEALED_BOX } from "../../test-support/shelter-shell.js";
import { marginBoxCells, marginCells, nearestThreatDirection, SIDES, sidesByThreat } from "./shelter-cells.js";

const FEET = new Vec3(0, 64, 0);
const key = (cell: Vec3) => `${cell.x},${cell.y},${cell.z}`;

/** The 16 margin cells at the cell's centre in the order of D9b: feet layer, head layer, the cap layer's eaves then corners. */
const CENTRE_ORDER = [
  "-1,64,-1", "-1,64,1", "1,64,-1", "1,64,1",
  "-1,65,-1", "-1,65,1", "1,65,-1", "1,65,1",
  "-1,66,0", "0,66,-1", "0,66,1", "1,66,0",
  "-1,66,-1", "-1,66,1", "1,66,-1", "1,66,1",
];

function shelterBot(cells: Record<string, FakeCell> = {}, x = 0.5) {
  return createFakeBot({ position: new Vec3(x, 64, 0.5), cells: { ...SEALED_BOX, ...cells } });
}

test("the margin cells at the centre are the 16 around the shell, feet and head layers before the cap layer", () => {
  const { bot } = shelterBot();
  assert.deepEqual(marginCells(bot, FEET, null).map(key), CENTRE_ORDER);
  const all = marginBoxCells(bot, FEET).map(key);
  assert.equal(all.length, 25);
  assert.deepEqual(all.slice(0, 16), CENTRE_ORDER);
  assert.ok(all.slice(16).every((cell) => cell.split(",")[1] === "63"), "the nine floor-layer cells come last");
});

test("the margin sets the box: 0 gives none, 0.3 gives 16", () => {
  const { bot } = shelterBot();
  assert.equal(marginBoxCells(bot, FEET, 0).length, 0);
  assert.equal(marginCells(bot, FEET, null).length, 16);
});

test("the position sets the box: a face with no positive overlap adds no cells (0.40, 0.41, 0.65)", () => {
  const near = shelterBot({}, 0.4).bot;
  assert.equal(marginCells(near, FEET, null).length, 9, "box max x is exactly 1.00");
  assert.ok(marginCells(near, FEET, null).every((cell) => cell.x !== 1));
  assert.equal(marginCells(shelterBot({}, 0.41).bot, FEET, null).length, 16);
  const far = shelterBot({}, 0.65).bot;
  assert.equal(marginCells(far, FEET, null).length, 9);
  assert.ok(marginCells(far, FEET, null).every((cell) => cell.x !== -1));
});

test("a full block is not a margin cell, an unloaded cell is not, a bottom slab is", () => {
  assert.equal(marginCells(shelterBot({ "1,64,1": "stone" }).bot, FEET, null).length, 15, "one diagonal already stone");
  const { bot } = shelterBot({ "1,64,1": "stone", "-1,64,-1": "void", "-1,65,1": "stone_slab" });
  const cells = marginCells(bot, FEET, null).map(key);
  assert.equal(cells.length, 14, "the stone diagonal and the unloaded one are absent, the slab stays");
  assert.ok(!cells.includes("1,64,1") && !cells.includes("-1,64,-1"));
  assert.ok(cells.includes("-1,65,1"), "a slab does not stop a projectile's terrain ray");
});

test("the nearest threat's side goes first inside each layer and distance group", () => {
  const { bot } = createFakeBot({ position: new Vec3(0.5, 64, 0.5), cells: SEALED_BOX,
    entities: { 70: { name: "blaze", position: new Vec3(8.5, 64, 0.5) } } });
  const context = combatTestContext(bot);
  const toward = nearestThreatDirection(bot, context);
  assert.deepEqual(toward?.toArray(), [8, 0, 0]);
  const order = marginCells(bot, FEET, toward).map(key);
  assert.deepEqual(order.slice(0, 4), ["1,64,-1", "1,64,1", "-1,64,-1", "-1,64,1"]);
  assert.deepEqual(order.slice(8, 12), ["1,66,0", "0,66,-1", "0,66,1", "-1,66,0"]);
  assert.deepEqual(order.slice(12, 16), ["1,66,-1", "1,66,1", "-1,66,-1", "-1,66,1"]);
});

test("no threat gives no direction, and the sides keep their order", () => {
  const { bot } = shelterBot();
  const context = combatTestContext(bot);
  assert.equal(nearestThreatDirection(bot, context), null);
  assert.deepEqual(sidesByThreat(bot, context), SIDES);
});

test("over a drop the floor layer adds up to 8, and the body's own layers still come first", () => {
  // Floor only under the feet: air at the other eight floor-layer cells.
  const air = Object.fromEntries([-1, 0, 1].flatMap((x) => [-1, 0, 1].map((z) => [`${x},63,${z}`, "air" as FakeCell])));
  const { bot } = createFakeBot({ position: new Vec3(0.5, 64, 0.5), groundY: null,
    cells: { ...air, "0,63,0": "stone", ...SEALED_BOX } });
  const cells = marginCells(bot, FEET, null).map(key);
  assert.equal(cells.length, 24);
  assert.deepEqual(cells.slice(0, 16), CENTRE_ORDER);
  assert.ok(cells.slice(16).every((cell) => cell.split(",")[1] === "63"));
});
