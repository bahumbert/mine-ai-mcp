import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { ZERO_ARENA, arenaFrame } from "./frame.ts";
import { arenaCell, arenaPoint, arenaX } from "./params.ts";

const LANE_3 = arenaFrame({ x: 0, z: 1536 });
/** Both axes moved, so a helper that shifts one axis only (or swaps them) is seen. */
const SIDEWAYS = arenaFrame({ x: 64, z: 512 });

test("arenaPoint turns a params tuple into the lane's world position and keeps y", () => {
  assert.deepEqual(z.object({ target: arenaPoint(LANE_3) }).parse({ target: [105, -60, -4] }).target, [105, -60, 1532]);
  assert.deepEqual(arenaPoint(SIDEWAYS).parse([1.5, -58, 2.5]), [65.5, -58, 514.5]);
});

test("arenaCell turns an {x, y, z} params object into the lane's world cell", () => {
  assert.deepEqual(arenaCell(LANE_3).parse({ x: 3, y: -60, z: 7 }), { x: 3, y: -60, z: 1543 });
  assert.deepEqual(arenaCell(SIDEWAYS).parse({ x: 3, y: -60, z: 7 }), { x: 67, y: -60, z: 519 });
});

test("arenaX moves a lone x by the x offset, so an observed position and a param compare in one frame", () => {
  assert.equal(arenaX(SIDEWAYS).parse(30), 94);
  assert.equal(arenaX(LANE_3).parse(30), 30);
});

test("the zero frame parses every helper to what the params say", () => {
  const zero = arenaFrame(ZERO_ARENA);
  assert.deepEqual(arenaPoint(zero).parse([0.5, -60, 0.5]), [0.5, -60, 0.5]);
  assert.deepEqual(arenaCell(zero).parse({ x: 1, y: 2, z: 3 }), { x: 1, y: 2, z: 3 });
  assert.equal(arenaX(zero).parse(90), 90);
});

test("the helpers refuse what the plain schemas refused: a short tuple, a fractional cell, a string x", () => {
  assert.throws(() => arenaPoint(LANE_3).parse([1, 2]));
  assert.throws(() => arenaCell(LANE_3).parse({ x: 1.5, y: 2, z: 3 }));
  assert.throws(() => arenaCell(LANE_3).parse({ x: 1, y: 2, z: 3, w: 4 }));
  assert.throws(() => arenaX(LANE_3).parse("30"));
});
