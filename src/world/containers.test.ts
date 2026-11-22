import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { isLocationOwnedContainer } from "./containers.js";
import { familyIndexOf } from "./item-families.js";

// Every block of today's table keeping its answer on each shipped version is asserted by the block-family parity test
// of `item-families-parity.test.ts` (it also holds the B5 exception); these tests pin the wrapper's own answers.

test("B5: a plain shulker_box is a container", () => {
  const index = familyIndexOf(createFakeBot().bot);
  assert.equal(isLocationOwnedContainer(index, "shulker_box"), true);
  assert.equal(isLocationOwnedContainer(index, "blue_shulker_box"), true);
});

test("an ender chest is not a location-owned container", () => {
  const index = familyIndexOf(createFakeBot().bot);
  assert.equal(isLocationOwnedContainer(index, "ender_chest"), false);
  assert.equal(isLocationOwnedContainer(index, "crafting_table"), false);
  assert.equal(isLocationOwnedContainer(index, "not_a_block"), false);
});
