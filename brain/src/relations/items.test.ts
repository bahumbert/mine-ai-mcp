import assert from "node:assert/strict";
import test from "node:test";
import { carriedOf, sideText } from "./items.ts";

test("sideText lists count and item per entry, empty for no entry", () => {
  assert.equal(sideText([{ item: "oak_log", count: 2 }, { item: "iron_ingot", count: 1 }]), "2 oak_log, 1 iron_ingot");
  assert.equal(sideText([]), "");
});

test("carriedOf adds up every stack of the item and counts nothing for a missing one", () => {
  const inventory = [{ name: "oak_log", count: 40 }, { name: "stone", count: 3 }, { name: "oak_log", count: 5 }] as never;
  assert.equal(carriedOf(inventory, "oak_log"), 45);
  assert.equal(carriedOf(inventory, "dirt"), 0);
});
