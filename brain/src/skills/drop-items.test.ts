// Tests of the drop_item, craft_item and give skills, and of the chest deposit a drop makes.
import assert from "node:assert/strict";
import test from "node:test";
import { stepSchema } from "../actions.ts";
import { runStep } from "../skills.ts";
import { neededItems } from "../inventory-room.ts";
import { FakeRuntime } from "../testing.ts";
import { contextFor, describeCall, HOUSE_RECIPES, needsOnlyTools } from "./skill-fixtures.test.ts";

const NO_ROOM_CRAFT = "[CRAFT_EXECUTION_FAILED] Mineflayer stopped while executing the selected recipe batch: This crafting execution needs inventory room to store 1 stone_shovel before the next recipe application.";

/** A chest the runtime remembers as the bot's own (`observed_containers`), 6 blocks from the spawn point. */
const OWN_CHEST = { x: 6, y: 64, z: 0, blockName: "chest", slotCount: 27, usedSlots: 3 };

/** A drop of 64 cobblestone against a runtime whose bot remembers `containers`, in `dimension`; the tools it then submitted. */
async function dropWithChests(containers: FakeRuntime["containers"], dimension = "minecraft:overworld"): Promise<{ readonly runtime: FakeRuntime; readonly tools: string[] }> {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, dimension, inventory: [{ name: "cobblestone", count: 64 }] };
  runtime.containers = containers;
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "cobblestone", dropped: 64 }] });
  await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "cobblestone" }] }), { ...contextFor(runtime), self: "Ayla" });
  return { runtime, tools: runtime.submitted.map((call) => call.tool) };
}

test("drop_item drops several items in one step, and the single-item form still reads", async () => {
  // Live 2026-10-04: a full inventory took Tom 20 steps of dropping one item each.
  const runtime = new FakeRuntime();
  const step = stepSchema.parse({ skill: "drop_item", items: [{ item: "snowball" }, { item: "granite", count: 10 }] });
  const result = await runStep(step, contextFor(runtime));
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.submitted.map((call) => [call.input.items, call.input.in_a_hole]), [[[{ item_name: "snowball" }, { item_name: "granite", count: 10 }], true]]);
  assert.equal(stepSchema.safeParse({ skill: "drop_item", item: "dirt" }).success, true);
  assert.equal(stepSchema.safeParse({ skill: "drop_item" }).success, false);
});

test("drop_item names what was really dropped, and says the inventory has room again", async () => {
  // Live 2026-10-10 run 7: every drop was reported "dropped 16 coal, 32 cobblestone" while the action had dropped 0.
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "dirt", count: 5 }] };
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "cobblestone", dropped: 32 }] });
  const result = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "cobblestone", count: 32 }] }), contextFor(runtime));
  assert.equal(result.status, "done");
  assert.match(result.status === "done" ? result.detail : "", /32 cobblestone.*the inventory has room again: 35 of 36 slots free/u);
});

test("a drop that dropped nothing fails with the action's reason, and a water-locked pit falls back to the ground", async () => {
  const runtime = new FakeRuntime();
  runtime.dropOutcomes.push({ status: "failed", error: "[DROP_PICKED_UP] coal came back into the inventory after the toss", dropped: [{ item: "coal", dropped: 0 }] });
  const failed = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "coal" }] }), contextFor(runtime));
  assert.equal(failed.status, "failed");
  assert.match(failed.status === "failed" ? failed.detail : "", /DROP_PICKED_UP/u);
  assert.deepEqual(runtime.submitted.map((call) => call.tool), ["drop_item"], "no ground toss after a pit that failed otherwise");

  const water = new FakeRuntime();
  water.walkOnNavigate = true;
  water.dropOutcomes.push(
    { status: "failed", error: "[DROP_HOLE_UNAVAILABLE] No place within 8 blocks", dropped: [] },
    { status: "succeeded", error: null, dropped: [{ item: "coal", dropped: 4 }] },
  );
  const ground = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "coal" }] }), contextFor(water));
  assert.equal(ground.status, "done");
  assert.deepEqual(water.submitted.map((call) => [call.tool, call.input.in_a_hole]), [["drop_item", true], ["drop_item", undefined]], "the action walks off itself, the step does not");
  assert.match(ground.status === "done" ? ground.detail : "", /4 coal/u);
});

test("walking to a crafting table close by sends navigate its coordinates only, never the block's name", async () => {
  const runtime = new FakeRuntime();
  runtime.world.set("3,64,0", "crafting_table");
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 4 }] };
  runtime.recipes = { stick: { makes: 4, needs: [{ item: "oak_planks", count: 2 }] } };
  await runStep({ skill: "craft_item", item: "stick", count: 4 }, contextFor(runtime));
  assert.deepEqual(runtime.submitted.find((call) => call.tool === "navigate")?.input, { x: 3, y: 64, z: 0, range: 2 });
});

test("drop_item keeps the last tool of a class, the last bed and the last boat (live 2026-10-10 run 8: pickaxe, axe, shovel, boat and bed dropped)", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "stone_pickaxe", count: 1 }, { name: "dirt", count: 20 }, { name: "white_bed", count: 1 }, { name: "oak_boat", count: 1 }] };
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "dirt", dropped: 20 }] });
  const result = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "stone_pickaxe" }, { item: "dirt" }, { item: "white_bed" }, { item: "oak_boat" }] }), contextFor(runtime));
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.submitted.map((call) => call.input.items), [[{ item_name: "dirt" }]], "only the dirt went to the action");
  const detail = result.status === "done" ? result.detail : "";
  assert.match(detail, /kept 1 stone_pickaxe: your only pickaxe/u);
  assert.match(detail, /kept 1 white_bed: your only bed/u);
  assert.match(detail, /kept 1 oak_boat: your only boat/u);

  const several = new FakeRuntime();
  several.snapshot = { ...several.snapshot, inventory: [{ name: "stone_pickaxe", count: 3 }, { name: "wooden_pickaxe", count: 1 }] };
  several.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "stone_pickaxe", dropped: 2 }] });
  await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "stone_pickaxe", count: 2 }] }), contextFor(several));
  assert.deepEqual(several.submitted.map((call) => call.input.items), [[{ item_name: "stone_pickaxe", count: 2 }]], "two of three is fine");

  // Dropping every pickaxe keeps the best one, not the one named first: the best is the one the runtime reports the larger durability maximum for.
  const tiers = new FakeRuntime();
  tiers.snapshot = { ...tiers.snapshot, inventory: [{ name: "wooden_pickaxe", count: 1, durability: { remaining: 59, maximum: 59 } }, { name: "iron_pickaxe", count: 1, durability: { remaining: 250, maximum: 250 } }] };
  tiers.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "wooden_pickaxe", dropped: 1 }] });
  await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "wooden_pickaxe" }, { item: "iron_pickaxe" }] }), contextFor(tiers));
  assert.deepEqual(tiers.submitted.map((call) => call.input.items), [[{ item_name: "wooden_pickaxe" }]]);

  // A golden pickaxe wears out sooner than a stone one: dropping both keeps the stone one (review 2026-10-18 #9).
  const golden = new FakeRuntime();
  golden.snapshot = { ...golden.snapshot, inventory: [{ name: "golden_pickaxe", count: 1, durability: { remaining: 32, maximum: 32 } }, { name: "stone_pickaxe", count: 1, durability: { remaining: 100, maximum: 131 } }] };
  golden.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "golden_pickaxe", dropped: 1 }] });
  await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "golden_pickaxe" }, { item: "stone_pickaxe" }] }), contextFor(golden));
  assert.deepEqual(golden.submitted.map((call) => call.input.items), [[{ item_name: "golden_pickaxe" }]]);

  const only = new FakeRuntime();
  only.snapshot = { ...only.snapshot, inventory: [{ name: "stone_axe", count: 1 }] };
  const refused = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "stone_axe" }] }), contextFor(only));
  assert.equal(refused.status, "failed");
  assert.match(refused.status === "failed" ? refused.detail : "", /kept 1 stone_axe: your only axe/u);
  assert.deepEqual(only.submitted, []);
});

test("a failed drop still says which tools it kept (live 2026-10-10 run 9: the kept hoe and pickaxe vanished from the failure text)", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_hoe", count: 1 }, { name: "wooden_pickaxe", count: 1 }, { name: "oak_log", count: 4 }] };
  runtime.dropOutcomes.push({ status: "failed", error: "[DROP_INCOMPLETE] 1 of 1 item could not be dropped: oak_log: [DROP_PICKED_UP] oak_log came back", dropped: [{ item: "oak_log", dropped: 0 }] });
  const result = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "oak_log" }, { item: "wooden_hoe" }, { item: "wooden_pickaxe" }] }), contextFor(runtime));
  assert.equal(result.status, "failed");
  const detail = result.status === "failed" ? result.detail : "";
  assert.match(detail, /DROP_PICKED_UP/u);
  assert.match(detail, /kept 1 wooden_pickaxe: your only pickaxe/u);
  assert.match(detail, /kept 1 wooden_hoe: your only hoe/u);
});

test("a drop of her own work keeps what the work needs (the best tool of each class, the house planks; a lesser axe is spare, run 15 N5); an order drops anything", async () => {
  const inventory = [{ name: "stone_pickaxe", count: 1 }, { name: "stone_axe", count: 1 }, { name: "wooden_axe", count: 1 }, { name: "oak_planks", count: 16 }, { name: "snowball", count: 40 }];
  const step = stepSchema.parse({ skill: "drop_item", items: [{ item: "stone_axe" }, { item: "wooden_axe" }, { item: "oak_planks" }, { item: "snowball" }] });
  const own = new FakeRuntime();
  own.snapshot = { ...own.snapshot, inventory };
  own.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "snowball", dropped: 40 }] });
  const result = await runStep(step, { ...contextFor(own), needed: (snapshot) => neededItems(snapshot, { houseBill: ["oak_planks"] }) });
  assert.deepEqual(own.submitted.map((call) => call.input.items), [[{ item_name: "wooden_axe" }, { item_name: "snowball" }]]);
  const detail = result.status === "done" ? result.detail : "";
  assert.match(detail, /kept all 16 oak_planks: your current work needs them/u);
  assert.match(detail, /kept 1 stone_axe: your only axe/u);

  const ordered = new FakeRuntime();
  ordered.snapshot = { ...ordered.snapshot, inventory };
  ordered.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "oak_planks", dropped: 16 }] });
  await runStep(step, contextFor(ordered));
  assert.deepEqual(ordered.submitted.map((call) => call.input.items), [[{ item_name: "wooden_axe" }, { item_name: "oak_planks" }, { item_name: "snowball" }]], "an order drops the planks and the spare axe (the best axe stays anyway)");
});

test("a drop that keeps everything names what may go; with only needed items carried, the needed ones go (run 11: Mira's dead end)", async () => {
  const needed = (snapshot: Parameters<typeof neededItems>[0]) => neededItems(snapshot, { houseBill: ["cobblestone"] });
  const kept = new FakeRuntime();
  kept.snapshot = { ...kept.snapshot, inventory: [{ name: "cobblestone", count: 64 }, { name: "granite", count: 20 }] };
  const refused = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "cobblestone" }] }), { ...contextFor(kept), needed });
  assert.equal(refused.status, "failed");
  assert.match(refused.status === "failed" ? refused.detail : "", /nothing dropped; kept all 64 cobblestone: your current work needs them; .*20 granite/u);
  assert.deepEqual(kept.submitted, []);

  const all = new FakeRuntime();
  all.snapshot = { ...all.snapshot, inventory: [{ name: "cobblestone", count: 64 }] };
  all.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "cobblestone", dropped: 64 }] });
  await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "cobblestone" }] }), { ...contextFor(all), needed });
  assert.deepEqual(all.submitted.map((call) => call.input.items), [[{ item_name: "cobblestone" }]]);
});

test("an eat step with the food bar full is tried and the game's answer is reported (golden apples are edible when full)", async () => {
  // Run 12: `[EAT_REJECTED] ... Food is full` for bread; golden_apple / chorus_fruit are accepted by the game when full.
  const rejected = new FakeRuntime();
  rejected.snapshot = { ...rejected.snapshot, food: 20, foods: [{ name: "bread", hunger: 5, count: 2 } as never] };
  rejected.failures.eat_food = "[EAT_REJECTED] Mineflayer could not consume the selected food: Food is full";
  const refused = await runStep({ skill: "eat", food: "bread" }, contextFor(rejected));
  assert.equal(refused.status, "failed");
  assert.match("detail" in refused ? refused.detail : "", /Food is full/u);
  assert.deepEqual(rejected.submitted.map((call) => call.tool), ["eat_food"]);

  const accepted = new FakeRuntime();
  accepted.snapshot = { ...accepted.snapshot, food: 20 };
  const ate = await runStep({ skill: "eat", food: "golden_apple" }, contextFor(accepted));
  assert.equal(ate.status, "done");
  assert.deepEqual(accepted.submitted.map((call) => call.tool), ["eat_food"]);
});

test("an eat step with the food bar not full still eats", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, food: 14 };
  const result = await runStep({ skill: "eat", food: "bread" }, contextFor(runtime));
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.submitted.map((call) => call.tool), ["eat_food"]);
});

test("a craft step that lacks raw materials says get_items gathers and crafts them", async () => {
  // Run 12: 16 `[CRAFT_MATERIALS_MISSING] Missing leaf materials: birch_log x1 / iron_ingot x3`.
  const runtime = new FakeRuntime();
  runtime.failures.craft_item = "[CRAFT_MATERIALS_MISSING] Missing leaf materials: birch_log x1, oak_log x1.";
  const result = await runStep({ skill: "craft_item", item: "wooden_axe", count: 1 }, contextFor(runtime));
  assert.equal(result.status, "failed");
  const detail = "detail" in result ? result.detail : "";
  assert.match(detail, /CRAFT_MATERIALS_MISSING/u);
  assert.match(detail, /get_items wooden_axe 1/u);
});

test("a craft step failing for another reason gets no get_items hint", async () => {
  const runtime = new FakeRuntime();
  runtime.failures.craft_item = "[UNKNOWN_CRAFT_ITEMS] Minecraft has no registry items named: oak_wooden_axe.";
  const result = await runStep({ skill: "craft_item", item: "oak_wooden_axe", count: 1 }, contextFor(runtime));
  assert.doesNotMatch("detail" in result ? result.detail : "", /get_items/u);
});

test("a craft step that finds no inventory room drops what the work does not need, then crafts again (run 12: bruno, oskar)", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_pickaxe", count: 1 }, { name: "oak_planks", count: 8 }, { name: "dirt", count: 64 }, { name: "gravel", count: 16 }] };
  runtime.failNext.craft_item = { error: NO_ROOM_CRAFT };
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "dirt", dropped: 64 }] });
  const result = await runStep({ skill: "craft_item", item: "stick", count: 4 }, { ...contextFor(runtime), needed: needsOnlyTools });
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.map((call) => call.tool).filter((tool) => tool === "craft_item" || tool === "drop_item"), ["craft_item", "drop_item", "craft_item"]);
  const dropped = runtime.submitted.find((call) => call.tool === "drop_item")!.input.items as { item_name: string }[];
  assert.deepEqual(dropped.map((entry) => entry.item_name).sort(), ["dirt"], "one stack, of the kind junkStacks lists first (equal stacks: the biggest count), only until a slot is free");
});

test("a craft of stone tools with a full inventory keeps its cobblestone and drops one stack of junk (run 13 review R8)", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { ...HOUSE_RECIPES, stone_shovel: { makes: 1, needs: [{ item: "cobblestone", count: 1 }, { item: "stick", count: 2 }] } };
  const filler = Array.from({ length: 29 }, (_, index) => ({ name: `junk_${index}`, count: 50 }));
  const full = [{ name: "wooden_pickaxe", count: 1 }, { name: "cobblestone", count: 64 }, { name: "cobblestone", count: 64 }, { name: "stick", count: 8 }, { name: "dirt", count: 30 }, { name: "gravel", count: 40 }, { name: "dirt", count: 5 }, ...filler];
  assert.equal(full.length, 36);
  runtime.snapshot = { ...runtime.snapshot, inventory: full };
  runtime.failNext.craft_item = { error: NO_ROOM_CRAFT };
  // The drop frees the first stack of dirt.
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "dirt", dropped: 30 }], effect: () => { runtime.snapshot = { ...runtime.snapshot, inventory: runtime.snapshot.inventory.filter((stack) => !(stack.name === "dirt" && stack.count === 30)) }; } });
  const result = await runStep({ skill: "craft_item", item: "stone_shovel", count: 1 }, { ...contextFor(runtime), needed: needsOnlyTools });
  assert.equal(result.status, "done", JSON.stringify(result));
  const drops = runtime.submitted.filter((call) => call.tool === "drop_item");
  assert.equal(drops.length, 1, "one stack is enough for one free slot");
  assert.deepEqual(drops[0]!.input.items, [{ item_name: "dirt", count: 30 }], "the first dirt stack: the stack losing least, never the cobblestone or sticks the shovel takes");
});

test("a craft with a full inventory of one bucket and five dirt stacks drops a dirt stack, never the bucket (run 14 review SF3)", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { ...HOUSE_RECIPES, stone_shovel: { makes: 1, needs: [{ item: "cobblestone", count: 1 }, { item: "stick", count: 2 }] } };
  const filler = Array.from({ length: 28 }, (_, index) => ({ name: `junk_${index}`, count: 50 }));
  const full = [{ name: "wooden_pickaxe", count: 1 }, { name: "bucket", count: 1 }, ...[30, 10, 20, 5, 40].map((count) => ({ name: "dirt", count })), ...filler, { name: "stick", count: 8 }];
  assert.equal(full.length, 36);
  runtime.snapshot = { ...runtime.snapshot, inventory: full };
  runtime.failNext.craft_item = { error: NO_ROOM_CRAFT };
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "dirt", dropped: 30 }], effect: () => { runtime.snapshot = { ...runtime.snapshot, inventory: runtime.snapshot.inventory.filter((stack) => !(stack.name === "dirt" && stack.count === 30)) }; } });
  const result = await runStep({ skill: "craft_item", item: "stone_shovel", count: 1 }, { ...contextFor(runtime), needed: needsOnlyTools });
  assert.equal(result.status, "done", JSON.stringify(result));
  const drops = runtime.submitted.filter((call) => call.tool === "drop_item");
  assert.equal(drops.length, 1);
  assert.deepEqual(drops[0]!.input.items, [{ item_name: "dirt", count: 30 }], "the kind with most stacks, its first stack (a count drops stacks in inventory order); the lone bucket stays");
});

test("a craft step with nothing to spare fails with the original reason (the agent names what to drop)", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_pickaxe", count: 1 }, { name: "oak_planks", count: 8 }] };
  runtime.failNext.craft_item = { error: NO_ROOM_CRAFT };
  const result = await runStep({ skill: "craft_item", item: "stick", count: 4 }, { ...contextFor(runtime), needed: (snapshot) => neededItems(snapshot, { wanted: new Set(["oak_planks"]) }) });
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /needs inventory room/u);
  assert.equal(runtime.submitted.some((call) => call.tool === "drop_item"), false);
});

test("a craft step with no crafting table carried makes one first, then crafts (run 12: bruno's bed, oskar)", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 8 }] };
  runtime.failNext.craft_item = { error: "[WORKSTATION_NOT_CARRIED] No crafting_table is carried for temporary use." };
  const result = await runStep({ skill: "craft_item", item: "oak_door", count: 3 }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "craft_item").map(describeCall), ["craft oak_door", "craft crafting_table", "craft oak_door"]);
});

test("a drop of 4 of 5 wooden swords drops 4 though the work needs a sword; the last one stays (run 15 N5)", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_sword", count: 5 }, { name: "dirt", count: 3 }] };
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "wooden_sword", dropped: 4 }] });
  const needed = (snapshot: Parameters<typeof neededItems>[0]) => neededItems(snapshot);
  const result = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "wooden_sword", count: 4 }] }), { ...contextFor(runtime), needed });
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.map((call) => call.input.items), [[{ item_name: "wooden_sword", count: 4 }]]);
});

test("a drop with an own chest remembered within 32 blocks deposits there; with none (or a full one) it buries as before (run 15 N5)", async () => {
  const stocked = new FakeRuntime();
  stocked.snapshot = { ...stocked.snapshot, inventory: [{ name: "cobblestone", count: 64 }, { name: "dirt", count: 30 }] };
  stocked.containers = [OWN_CHEST];
  const stored = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "cobblestone" }] }), { ...contextFor(stocked), self: "Ayla" });
  assert.equal(stored.status, "done", JSON.stringify(stored));
  assert.match(stored.status === "done" ? stored.detail : "", /stored 64 cobblestone in your chest at 6 64 0/u);
  assert.deepEqual(stocked.submitted.map((call) => [call.tool, call.input.operation, call.input.x, call.input.y, call.input.z, JSON.stringify(call.input.items)]), [["use_container", "deposit", 6, 64, 0, JSON.stringify([{ item_name: "cobblestone", count: 64 }])]]);

  const none = new FakeRuntime();
  none.snapshot = { ...none.snapshot, inventory: [{ name: "cobblestone", count: 64 }] };
  none.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "cobblestone", dropped: 64 }] });
  await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "cobblestone" }] }), { ...contextFor(none), self: "Ayla" });
  assert.deepEqual(none.submitted.map((call) => call.tool), ["drop_item"], "no chest known: buried");

  const full = new FakeRuntime();
  full.snapshot = { ...full.snapshot, inventory: [{ name: "cobblestone", count: 64 }] };
  full.containers = [{ ...OWN_CHEST, usedSlots: 27 }];
  full.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "cobblestone", dropped: 64 }] });
  await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "cobblestone" }] }), { ...contextFor(full), self: "Ayla" });
  assert.deepEqual(full.submitted.map((call) => call.tool), ["drop_item"], "a full chest is no room: buried");

  const failing = new FakeRuntime();
  failing.snapshot = { ...failing.snapshot, inventory: [{ name: "cobblestone", count: 64 }] };
  failing.containers = [OWN_CHEST];
  failing.failures.use_container = "[CONTAINER_UNREACHABLE] Pathfinder could not reach the container";
  failing.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "cobblestone", dropped: 64 }] });
  await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "cobblestone" }] }), { ...contextFor(failing), self: "Ayla" });
  assert.deepEqual(failing.submitted.map((call) => call.tool), ["use_container", "drop_item"], "a chest that cannot be reached: buried after");
});

test("a drop in the Nether with an overworld chest remembered buries, no use_container (review #8)", async () => {
  const { runtime, tools } = await dropWithChests([OWN_CHEST], "the_nether");
  assert.deepEqual(tools, ["drop_item"]);
  assert.deepEqual(runtime.containerQueries, [{ owner: "Ayla", dimension: "the_nether" }], "the chest question names the dimension the bot is in");
});

test("a chest in the Nether the bot placed there takes the deposit", async () => {
  const { tools } = await dropWithChests([{ ...OWN_CHEST, dimension: "the_nether" }], "the_nether");
  assert.deepEqual(tools, ["use_container"]);
});

test("a placed chest never opened takes the deposit (its room is unknown: the deposit's own answer is the truth)", async () => {
  const { tools } = await dropWithChests([{ ...OWN_CHEST, slotCount: null, usedSlots: 0 }]);
  assert.deepEqual(tools, ["use_container"]);
});

test("a chest another bot placed, which this bot only withdrew from, is not used", async () => {
  const { tools } = await dropWithChests([{ ...OWN_CHEST, placedBy: "Mira" }]);
  assert.deepEqual(tools, ["drop_item"]);
});
