// drop_item, making room and eat keep what an agreed trade owes.
import assert from "node:assert/strict";
import test from "node:test";
import { stepSchema } from "../actions.ts";
import { runStep } from "../skills.ts";
import { type BotSnapshot } from "../runtime-client.ts";
import { FakeRuntime } from "../testing.ts";
import { HOUSE_RECIPES, contextFor, needsOnlyTools, owedToAyla } from "./skill-fixtures.test.ts";

const NO_ROOM_CRAFT = "[CRAFT_EXECUTION_FAILED] Mineflayer stopped while executing the selected recipe batch: This crafting execution needs inventory room to store 1 stone_shovel before the next recipe application.";

/** One trade of Ayla's owing `count` dirt: the kind a craft with a full bag would drop first. */
const owedDirt = (count: number) => [{ item: "dirt", count, partner: "Ayla", tradeId: "t1" }];

const roomRig = (inventory: BotSnapshot["inventory"]) => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.snapshot = { ...runtime.snapshot, inventory };
  runtime.failNext.craft_item = { error: NO_ROOM_CRAFT };
  return runtime;
};

const stickStep = { skill: "craft_item", item: "stick", count: 4 } as const;

const owedBread = (count: number) => [{ item: "bread", count, partner: "Ayla", tradeId: "t1" }];

test("drop_item keeps an owed item even for an order, and says so", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "crafting_table", count: 1 }, { name: "dirt", count: 4 }] };
  const result = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "crafting_table" }, { item: "dirt" }] }), contextFor(runtime, { requester: "Finn", owed: () => owedToAyla }));
  assert.equal(result.status, "done");
  assert.match(result.status === "done" ? result.detail : "", /kept 1 crafting_table: you owe 1 crafting_table to Ayla \(trade\)/u);
  assert.deepEqual(runtime.submitted.map((call) => call.input.items), [[{ item_name: "dirt" }]]);

  const only = new FakeRuntime();
  only.snapshot = { ...only.snapshot, inventory: [{ name: "crafting_table", count: 1 }] };
  const refused = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "crafting_table" }] }), contextFor(only, { requester: "Finn", owed: () => owedToAyla }));
  assert.equal(refused.status, "failed");
  assert.doesNotMatch(refused.status === "failed" ? refused.detail : "", /"item":"crafting_table"/u, "the hint never tells the model to drop what is owed");
  assert.deepEqual(only.submitted, []);
});

test("drop_item of a counted owed item drops only the spare ones", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "crafting_table", count: 3 }] };
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "crafting_table", dropped: 2 }] });
  await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "crafting_table", count: 3 }] }), contextFor(runtime, { owed: () => owedToAyla }));
  assert.deepEqual(runtime.submitted.map((call) => call.input.items), [[{ item_name: "crafting_table", count: 2 }]]);
});

test("making room never drops a kind with no spare to an open trade: the next kind goes and the craft is done", async () => {
  const runtime = roomRig([{ name: "wooden_pickaxe", count: 1 }, { name: "oak_planks", count: 8 }, { name: "dirt", count: 64 }, { name: "gravel", count: 16 }]);
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "gravel", dropped: 16 }] });
  const result = await runStep(stickStep, { ...contextFor(runtime), needed: needsOnlyTools, owed: () => owedDirt(64) });
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "drop_item").map((call) => call.input.items), [[{ item_name: "gravel", count: 16 }]]);
});

test("making room drops a partly owed kind down to its spare, 64 carried with 2 owed lose 62", async () => {
  const runtime = roomRig([{ name: "wooden_pickaxe", count: 1 }, { name: "oak_planks", count: 8 }, { name: "dirt", count: 64 }, { name: "gravel", count: 16 }]);
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "dirt", dropped: 62 }] });
  const result = await runStep(stickStep, { ...contextFor(runtime), needed: needsOnlyTools, owed: () => owedDirt(2) });
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "drop_item").map((call) => call.input.items), [[{ item_name: "dirt", count: 62 }]]);
});

test("a full bag where every kind is owed: the craft fails with no drop, and a give to the partner is the next action that works", async () => {
  const runtime = roomRig([{ name: "wooden_pickaxe", count: 1 }, { name: "oak_planks", count: 8 }, { name: "dirt", count: 4 }]);
  runtime.walkOnNavigate = true;
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Ayla", position: { x: 3, y: 64, z: 0 } }] };
  const context = { ...contextFor(runtime), needed: needsOnlyTools, owed: () => owedDirt(4) };
  const crafted = await runStep(stickStep, context);
  assert.equal(crafted.status, "failed");
  assert.match(crafted.status === "failed" ? crafted.detail : "", /needs inventory room/u);
  assert.equal(runtime.submitted.some((call) => call.tool === "drop_item"), false, "nothing owed is dropped");
  const given = await runStep(stepSchema.parse({ skill: "give_item", player: "Ayla", item: "dirt", count: 4 }), context);
  assert.equal(given.status, "done", "the owed item goes to the one it is owed to");
});

test("eat is refused with a held fact when the food was handed over for a trade that ended", async () => {
  const none = new FakeRuntime();
  none.snapshot = { ...none.snapshot, inventory: [{ name: "bread", count: 4 }] };
  const refused = await runStep({ skill: "eat", food: "bread" }, contextFor(none, { owed: () => [{ item: "bread", count: 4, partner: "Ayla", tradeId: "t1", held: true as const }] }));
  assert.deepEqual(refused, { status: "failed", detail: "you hold 4 bread Ayla handed over for a trade that ended, not given back; you carry no bread beyond it" });
});

test("eat is refused with the fact when the named food has no spare, and eats when one is spare", async () => {
  const none = new FakeRuntime();
  none.snapshot = { ...none.snapshot, inventory: [{ name: "bread", count: 4 }] };
  const refused = await runStep({ skill: "eat", food: "bread" }, contextFor(none, { owed: () => owedBread(4) }));
  assert.deepEqual(refused, { status: "failed", detail: "you owe 4 bread to Ayla (trade); you carry no bread beyond it" });
  assert.equal(none.submitted.some((call) => call.tool === "eat_food"), false);

  const spare = new FakeRuntime();
  spare.snapshot = { ...spare.snapshot, inventory: [{ name: "bread", count: 5 }] };
  assert.equal((await runStep({ skill: "eat", food: "bread" }, contextFor(spare, { owed: () => owedBread(4) }))).status, "done");
  assert.equal(spare.submitted.some((call) => call.tool === "eat_food"), true);

  const other = new FakeRuntime();
  other.snapshot = { ...other.snapshot, inventory: [{ name: "apple", count: 1 }] };
  assert.equal((await runStep({ skill: "eat", food: "apple" }, contextFor(other, { owed: () => owedBread(4) }))).status, "done", "an unowed food is eaten as ever");
});
