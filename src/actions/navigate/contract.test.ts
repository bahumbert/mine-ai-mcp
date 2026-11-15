/** Navigation results retain the server-time evidence of a boat left behind. */
import assert from "node:assert/strict";
import test from "node:test";
import { navigateResultSchema } from "./contract.js";

test("a navigate result requires nonnegative whole server ticks when a boat was left", () => {
  const boatLeft = { cause: "still_there", reason: "the boat is still under you", hits: 34, elapsedMs: 10_000, elapsedTicks: 120, goneAfterHit: null };
  const navigation = {
    startDimension: "overworld", endDimension: "overworld",
    target: { x: 270, y: -60, z: 0 }, range: 2,
    start: { x: 0.5, y: -60, z: 0.5 }, end: { x: 270.5, y: -60, z: 0.5 },
    remainingDistance: 0.5, elapsedMs: 60_000, scaffolding: [],
    bucketDrops: { count: 0, waterRecovered: 0 }, missingDigTools: [], boatLeft,
  };
  const parsed = navigateResultSchema.parse({ status: "succeeded", navigation });
  assert.equal(parsed.navigation.boatLeft?.elapsedTicks, 120);
  for (const elapsedTicks of [undefined, -1, 0.5]) {
    assert.equal(navigateResultSchema.safeParse({ status: "succeeded", navigation: { ...navigation, boatLeft: { ...boatLeft, elapsedTicks } } }).success, false);
  }
  assert.equal(navigateResultSchema.safeParse({ status: "succeeded", navigation: { ...navigation, boatLeft: { ...boatLeft, elapsedTicks: 0 } } }).success, true);
});
