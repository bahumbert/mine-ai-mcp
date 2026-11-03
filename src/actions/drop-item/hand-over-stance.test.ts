// Where a giver may stand to hand an item over: within reach in the plane and on a floor the toss can reach the recipient's
// from (measured in Mine Labs, scenarios `drop/toss-to-ledge-*`, facts/relations.md "Hand-over stance").
import assert from "node:assert/strict";
import test from "node:test";
import { GIVER_HIGHER_MAX, HANDOVER_RANGE, heightBetweenText, heightBlocksStance, inHandOverStance, RECIPIENT_HIGHER_MAX } from "./hand-over-stance.js";

const giver = { x: 0.5, y: 64, z: 0.5 };
const recipient = (dx: number, dy: number, dz = 0) => ({ x: giver.x + dx, y: giver.y + dy, z: giver.z + dz });

test("the stance is judged in the plane: reach is the horizontal distance, not the 3-D one", () => {
  assert.equal(inHandOverStance(giver, recipient(HANDOVER_RANGE, 0)), true);
  assert.equal(inHandOverStance(giver, recipient(HANDOVER_RANGE + 0.1, 0)), false);
  assert.equal(inHandOverStance(giver, recipient(1.5, 0, 1.5)), false, "2.12 blocks in the plane");
  assert.equal(inHandOverStance(giver, recipient(1.4, 0, 1.4)), true, "1.98 blocks in the plane");
});

test("a recipient up to half a block above (a slab) is in reach, one block above (a ledge) is not", () => {
  assert.equal(inHandOverStance(giver, recipient(1.5, RECIPIENT_HIGHER_MAX)), true);
  assert.equal(inHandOverStance(giver, recipient(1.5, 1)), false);
  assert.equal(inHandOverStance(giver, recipient(1, 2)), false, "2.2 blocks away in 3-D, and a ledge");
  assert.equal(inHandOverStance(giver, recipient(0.5, 1.5)), false, "within 1.6 blocks in 3-D, but a ledge's height");
});

test("a recipient below the giver is in reach down to the measured depth, not past it", () => {
  assert.equal(inHandOverStance(giver, recipient(1.5, -1)), true);
  assert.equal(inHandOverStance(giver, recipient(1.5, -GIVER_HIGHER_MAX)), true);
  assert.equal(inHandOverStance(giver, recipient(1.5, -GIVER_HIGHER_MAX - 0.5)), false);
});

test("a fractional feet height (a recipient sinking in water) keeps the band", () => {
  assert.equal(inHandOverStance(giver, recipient(1, 0.3)), true);
  assert.equal(inHandOverStance(giver, recipient(1, -0.7)), true);
  assert.equal(inHandOverStance(giver, recipient(1, 0.9)), false);
});

test("the height is told in blocks, naming which way", () => {
  assert.equal(heightBetweenText(giver, recipient(1, 2)), "2 blocks above me");
  assert.equal(heightBetweenText(giver, recipient(1, 1)), "1 block above me");
  assert.equal(heightBetweenText(giver, recipient(1, -3)), "3 blocks below me");
  assert.equal(heightBetweenText(giver, recipient(1, 0)), "on my level");
});

test("the height blocks the stance only when the band is what is missed, not the distance", () => {
  assert.equal(heightBlocksStance(giver, recipient(30, 0)), false, "far on the same level: a walk problem");
  assert.equal(heightBlocksStance(giver, recipient(30, 2)), true);
  assert.equal(heightBlocksStance(giver, recipient(1, RECIPIENT_HIGHER_MAX)), false);
  assert.equal(heightBlocksStance(giver, recipient(1, -GIVER_HIGHER_MAX - 1)), true);
});
