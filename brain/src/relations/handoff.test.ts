import assert from "node:assert/strict";
import test from "node:test";
import { Body } from "../body.ts";
import type { SkillContext } from "../skills.ts";
import { FakeRuntime } from "../testing.ts";
import { handoffOutcome, runHandoff } from "./handoff.ts";

function contextFor(runtime: FakeRuntime): SkillContext {
  return { runtime, body: new Body(runtime, () => undefined), signal: new AbortController().signal };
}

const near = (runtime: FakeRuntime): void => {
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Theo", position: { x: 2, y: 64, z: 0 } }], inventory: [{ name: "bread", count: 5 }, { name: "oak_log", count: 4 }] };
};

test("a give hands each entry of my side to the partner and ends done", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  const result = await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "bread", count: 5 }, { item: "oak_log", count: 2 }] });
  assert.equal(handoffOutcome(result).outcome, "done");
  const drops = runtime.submitted.filter((call) => call.tool === "drop_item").map((call) => call.input);
  assert.deepEqual(drops.map((d) => [(d.items as { item_name: string; count: number }[])[0], d.to_player]), [[{ item_name: "bread", count: 5 }, "Theo"], [{ item_name: "oak_log", count: 2 }, "Theo"]]);
});

test("a give with items missing ends items_gone and hands over nothing", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  const result = await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "oak_log", count: 2 }, { item: "bread", count: 9 }] });
  const ended = handoffOutcome(result);
  assert.equal(ended.outcome, "items_gone");
  assert.match(ended.detail, /bread/u);
  assert.equal(runtime.submitted.some((call) => call.tool === "drop_item"), false);
});

test("a give that fails for another reason ends failed with the reason", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  runtime.failures.drop_item = "[PLAYER_UNREACHABLE] cannot reach Theo";
  const ended = handoffOutcome(await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "bread", count: 1 }] }));
  assert.equal(ended.outcome, "failed");
  assert.match(ended.detail, /PLAYER_UNREACHABLE/u);
});

test("a stopped hand-off is dropped, not failed", () => {
  assert.equal(handoffOutcome({ status: "stopped" }).outcome, "dropped");
});

test("a collect picks up each item of their side within 6 blocks", async () => {
  const runtime = new FakeRuntime();
  const result = await runHandoff(contextFor(runtime), { kind: "collect", tradeId: "t", items: [{ item: "iron_ingot", count: 5 }, { item: "bread", count: 1 }] });
  assert.equal(handoffOutcome(result).outcome, "done");
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "pick_up_items").map((call) => call.input), [{ item: "iron_ingot", radius: 6 }, { item: "bread", radius: 6 }]);
});

test("a collect after a give left items on the ground picks them up", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.groundItems = [{ item: "iron_ingot", count: 5 }, { item: "stick", count: 3 }];
  const result = await runHandoff(contextFor(runtime), { kind: "collect", tradeId: "t", items: [{ item: "iron_ingot", count: 5 }] });
  assert.equal(handoffOutcome(result).outcome, "done");
  assert.deepEqual(runtime.snapshot.inventory.map((s) => [s.name, s.count]), [["iron_ingot", 5]]);
  assert.deepEqual(runtime.groundItems, [{ item: "stick", count: 3 }]);
});

test("a collect that fails reports it", async () => {
  const runtime = new FakeRuntime();
  runtime.failures.pick_up_items = "[NO_ITEMS] nothing to pick up";
  const ended = handoffOutcome(await runHandoff(contextFor(runtime), { kind: "collect", tradeId: "t", items: [{ item: "bread", count: 1 }] }));
  assert.equal(ended.outcome, "failed");
});
