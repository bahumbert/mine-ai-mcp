import assert from "node:assert/strict";
import test from "node:test";
import { AnchorTravel } from "./anchor-travel.js";

test("a swimmer bobbing six blocks up and down at one x/z travels nothing over fifty samples", () => {
  const travel = new AnchorTravel();
  let total = travel.add({ x: 0.5, y: 56, z: 0.5 }, true);
  for (let i = 0; i < 50; i++) total += travel.add({ x: 0.5 + (i % 2) * 0.3, y: i % 2 === 0 ? 62 : 56, z: 0.5 }, true);
  assert.equal(total, 0);
});

test("a ten-block straight walk travels ten blocks", () => {
  const travel = new AnchorTravel();
  let total = travel.add({ x: 0, y: 64, z: 0 }, false);
  for (let i = 1; i <= 100; i++) total += travel.add({ x: i / 10, y: 64, z: 0 }, false);
  assert.ok(Math.abs(total - 10) < 1.1, String(total));
});

test("a vertical drop of three blocks counts out of water and not in it", () => {
  const dry = new AnchorTravel();
  dry.add({ x: 0, y: 64, z: 0 }, false);
  assert.equal(dry.add({ x: 0, y: 61, z: 0 }, false), 3);
  const wet = new AnchorTravel();
  wet.add({ x: 0, y: 64, z: 0 }, true);
  assert.equal(wet.add({ x: 0, y: 61, z: 0 }, true), 0);
});
