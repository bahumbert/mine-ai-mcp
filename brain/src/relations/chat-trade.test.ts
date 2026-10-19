import assert from "node:assert/strict";
import test from "node:test";
import { describeLacks, itemsYieldedBy } from "./chat-trade.ts";

test("lacks are the wanted items none of which is carried", () => {
  assert.deepEqual(describeLacks(new Set(["iron_ingot", "oak_log"]), [{ name: "oak_log", count: 3 }]), ["iron_ingot"]);
  assert.deepEqual(describeLacks([], [{ name: "oak_log", count: 3 }]), []);
});

test("a running step yields the items it is out to get, and the block it mines", () => {
  assert.deepEqual([...itemsYieldedBy({ skill: "collect_block", block: "oak_log", count: 3 })], ["oak_log"]);
  assert.deepEqual([...itemsYieldedBy({ skill: "get_items", items: [{ item: "stick", count: 2 }] })], ["stick"]);
  assert.deepEqual([...itemsYieldedBy({ skill: "go_to_player", player: "Theo" })], []);
});
