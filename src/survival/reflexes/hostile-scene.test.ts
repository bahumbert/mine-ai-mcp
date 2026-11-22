import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { shieldInOffHand } from "../weapons/equipment.js";
import { carriedShields, offHandItem } from "./hostile-scene.js";

test("the hostile scene sees a shield in the off-hand and one still in the bag, by family", () => {
  const raised = createFakeBot({ slots: { 45: { name: "shield" }, 12: { name: "stick" } } }).bot;
  assert.equal(shieldInOffHand(raised), true);
  assert.equal(offHandItem(raised), "shield");
  assert.deepEqual(carriedShields(raised), [], "the off-hand shield is not an inventory item to equip");

  const packed = createFakeBot({ slots: { 12: { name: "shield" }, 13: { name: "stick" } } }).bot;
  assert.equal(shieldInOffHand(packed), false);
  assert.deepEqual(carriedShields(packed).map((item) => item.slot), [12]);
});
