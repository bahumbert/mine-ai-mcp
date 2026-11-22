// get_items: the walk back that keeps what it fetched, the way back named by a failed fetch, and the means fetches.
import assert from "node:assert/strict";
import test from "node:test";
import { stepSchema } from "../actions.ts";
import { runStep } from "../skills.ts";
import { FakeRuntime } from "../testing.ts";
import { HOUSE_RECIPES, builds, contextFor, describeCall } from "./skill-fixtures.test.ts";

/** A `get_items` of 3 oak_log whose collect moves the bot to `ends` and fails (or aborts `controller`), from {0.5, 64, 0.5}. */
async function failedFetchEndingAt(ends: { x: number; y: number; z: number }, change: { dimension?: string; abort?: AbortController } = {}) {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 } };
  runtime.failures.collect_block = "[COLLECT_FAILED] No oak_log could be reached";
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "collect_block") {
      runtime.snapshot = { ...runtime.snapshot, position: ends, ...(change.dimension !== undefined && { dimension: change.dimension }) };
      change.abort?.abort();
    }
    return submit(tool, input, ...rest);
  };
  const context = contextFor(runtime, change.abort === undefined ? {} : { signal: change.abort.signal });
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 3 }] }, context);
  return { runtime, result };
}

// Plan 2026-11-14-house-build-fixes-2 Task 5 (ticket 2): the fetches that make the means of the work in hand (the table of
// `craft_item`, the levelling's tools and fill, the hole fill) go on with kept items when no log is near, and say so; the
// model's own `get_items` still stops with the replacement sentence.
const NO_LOG_NEAR = "[NO_TARGET_IN_RANGE] no oak_log within 64 blocks of you";

test("get_items walks back keeping what it fetched: the walk back does not lay the dirt it just got", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 } };
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "collect_block") runtime.snapshot = { ...runtime.snapshot, position: { x: 40.5, y: 64, z: 0.5 } };
    return submit(tool, input, ...rest);
  };
  const result = await runStep({ skill: "get_items", items: [{ item: "dirt", count: 4 }] }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  const walks = runtime.submitted.filter((call) => call.tool === "navigate");
  assert.equal(walks.length, 1);
  assert.deepEqual(walks[0]!.input.keep_items, ["dirt"]);
});

test("a walk back that finds no way while the fetched items are kept is walked again, keeping by count what was carried before (plan 2026-11-14 Task 6)", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: [{ name: "dirt", count: 5 }] };
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "collect_block") runtime.snapshot = { ...runtime.snapshot, position: { x: 40.5, y: 64, z: 0.5 } };
    if (tool === "navigate" && input.keep_items !== undefined) runtime.failNext.navigate = { error: "[NAVIGATION_STOPPED] Pathfinder stopped: no path." };
    return submit(tool, input, ...rest);
  };
  const result = await runStep({ skill: "get_items", items: [{ item: "dirt", count: 4 }] }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.match(result.status === "done" ? result.detail : "", /^got 4 dirt, now carrying 9 dirt/u, "walked back at the second try: no 'could not walk back'");
  const walks = runtime.submitted.filter((call) => call.tool === "navigate");
  assert.equal(walks.length, 2);
  assert.deepEqual(walks[0]!.input.keep_items, ["dirt"]);
  assert.equal(walks[1]!.input.keep_items, undefined, "no name kept the second time");
  assert.deepEqual(walks[1]!.input.reserve_items, [{ item: "dirt", count: 5 }], "the 5 carried before the fetch stay kept; the 4 fetched may bridge");
});

test("a failed fetch far from its start names the way back as a go_to step, and walks nowhere itself", async () => {
  const { runtime, result } = await failedFetchEndingAt({ x: 40.5, y: 64, z: 0.5 });
  assert.equal(result.status, "failed");
  const detail = result.status === "failed" ? result.detail : "";
  assert.match(detail, /; you are 40 blocks east from where you started fetching: \{"skill":"go_to","x":0,"y":64,"z":0\} walks back$/u);
  assert.ok(!runtime.submitted.some((call) => call.tool === "navigate"), "no walk: the choice stays with the model");
  // The next action from it: the quoted step is a valid step.
  const quoted = /(\{"skill":"go_to"[^}]*\})/u.exec(detail)![1]!;
  assert.deepEqual(stepSchema.parse(JSON.parse(quoted)), { skill: "go_to", x: 0, y: 64, z: 0 });
});

test("a failed fetch under its start says how far below, and above", async () => {
  const below = await failedFetchEndingAt({ x: 0.5, y: 52, z: 0.5 });
  assert.match(below.result.status === "failed" ? below.result.detail : "", /you are 12 below from where you started fetching: \{"skill":"go_to","x":0,"y":64,"z":0\} walks back$/u);
  const farAndBelow = await failedFetchEndingAt({ x: 40.5, y: 52, z: 0.5 });
  assert.match(farAndBelow.result.status === "failed" ? farAndBelow.result.detail : "", /you are 40 blocks east and 12 below from where/u);
  const above = await failedFetchEndingAt({ x: 0.5, y: 80, z: 0.5 });
  assert.match(above.result.status === "failed" ? above.result.detail : "", /you are 16 above from where/u);
});

test("a failed fetch in another dimension, or near its start, adds nothing; a stopped fetch stays stopped", async () => {
  const elsewhere = await failedFetchEndingAt({ x: 40.5, y: 64, z: 0.5 }, { dimension: "minecraft:the_nether" });
  assert.equal(elsewhere.result.status, "failed");
  assert.doesNotMatch(elsewhere.result.status === "failed" ? elsewhere.result.detail : "", /where you started fetching/u);
  const near = await failedFetchEndingAt({ x: 2.5, y: 64, z: 0.5 });
  assert.equal(near.result.status, "failed");
  assert.doesNotMatch(near.result.status === "failed" ? near.result.detail : "", /where you started fetching/u);
  const stopped = await failedFetchEndingAt({ x: 40.5, y: 64, z: 0.5 }, { abort: new AbortController() });
  assert.deepEqual(stopped.result, { status: "stopped" });
});

test("craft_item's table fetch is a means fetch: the table is made from the planks carried when no log is near", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 10 }] };
  runtime.failNext.craft_item = { error: "[WORKSTATION_NOT_CARRIED] crafting_table is not carried" };
  runtime.failures.collect_block = NO_LOG_NEAR;
  const result = await runStep({ skill: "craft_item", item: "oak_door", count: 3 }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.ok(runtime.submitted.map(describeCall).includes("craft crafting_table"), "the table was crafted from the kept planks");
});

test("the levelling's tools are a means fetch: the shovel is made from the planks carried when no log is near", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { ...HOUSE_RECIPES, wooden_shovel: { makes: 1, needs: [{ item: "oak_planks", count: 1 }, { item: "stick", count: 2 }] } };
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 8 }, { name: "crafting_table", count: 1 }] };
  runtime.world.set("2,64,2", "gold_block");
  runtime.world.set("6,64,5", "gold_block");
  runtime.world.set("4,64,3", "grass_block");
  runtime.failures.collect_block = NO_LOG_NEAR;
  const result = await runStep(stepSchema.parse({ skill: "level_area", markers: "gold_block" }), contextFor(runtime, { areas: [] }));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.ok(runtime.submitted.map(describeCall).some((call) => call.startsWith("craft wooden_shovel")), "the shovel was crafted from the kept planks");
});

test("the hole fill is a means fetch: a fill crafted from the planks carried goes on when no log is near", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: [{ name: "oak_planks", count: 12 }, { name: "crafting_table", count: 1 }] };
  runtime.world.set("2,64,2", "gold_block");
  runtime.world.set("6,64,5", "gold_block");
  runtime.world.set("5,63,4", "air");
  runtime.failures.collect_block = NO_LOG_NEAR;
  const result = await runStep(stepSchema.parse({ skill: "level_area", markers: "gold_block", fill: "oak_fence" }), contextFor(runtime, { areas: [] }));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(builds(runtime).flatMap((call) => call.blocks).map((cell) => cell.block_name), ["oak_fence"]);
});

test("the get_items step is not a means fetch: the same craft from the planks carried stops with the sentence", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 12 }, { name: "crafting_table", count: 1 }] };
  runtime.failures.collect_block = NO_LOG_NEAR;
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_fence", count: 3 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /^oak_fence would be crafted from \d+ of the oak_planks you carry/u);
});
