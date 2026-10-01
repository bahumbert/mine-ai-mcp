import assert from "node:assert/strict";
import test from "node:test";
import { stepSchema } from "./actions.ts";
import { Body } from "./body.ts";
import { houseBox, runStep, type SkillContext } from "./skills.ts";
import type { ProtectedArea } from "./runtime-client.ts";
import type { KnownPlace } from "./mind.ts";
import { FakeRuntime, SMALL_MEDIEVAL_HOUSE as SMALL_MEDIEVAL } from "./testing.ts";

function contextFor(runtime: FakeRuntime, extra: Partial<SkillContext> = {}): SkillContext {
  return { runtime, body: new Body(runtime, () => undefined), signal: new AbortController().signal, ...extra };
}

function builds(runtime: FakeRuntime) {
  return runtime.submitted.filter((call) => call.tool === "build_structure").map((call) => call.input as { blocks: { x: number; y: number; z: number; block_name: string; facing?: string }[]; remove_wrong_blocks: boolean });
}

test("a build step defaults to a small house; the style is always the persona's, never the model's", () => {
  assert.deepEqual(stepSchema.parse({ skill: "build" }), { skill: "build", structure: "house", size: "small" });
  assert.equal(stepSchema.safeParse({ skill: "build", style: "japanese" }).success, false);
  assert.equal(stepSchema.safeParse({ skill: "build", structure: "castle" }).success, false);
});

/** Enough of Minecraft's recipes for a small medieval house. */
const HOUSE_RECIPES = {
  oak_planks: { makes: 4, needs: [{ item: "oak_log", count: 1 }] },
  spruce_planks: { makes: 4, needs: [{ item: "spruce_log", count: 1 }] },
  stick: { makes: 4, needs: [{ item: "oak_planks", count: 2 }] },
  crafting_table: { makes: 1, needs: [{ item: "oak_planks", count: 4 }] },
  wooden_pickaxe: { makes: 1, needs: [{ item: "oak_planks", count: 3 }, { item: "stick", count: 2 }] },
  oak_fence: { makes: 3, needs: [{ item: "oak_planks", count: 4 }, { item: "stick", count: 2 }] },
  oak_door: { makes: 3, needs: [{ item: "oak_planks", count: 6 }] },
};

function describeCall(call: { readonly tool: string; readonly input: Readonly<Record<string, unknown>> }): string {
  if (call.tool === "collect_block") return `collect ${String(call.input.block_name)}`;
  if (call.tool === "craft_item") {
    const items = (call.input.items as { item_name: string }[]).map((item) => item.item_name).join("+");
    return `craft ${items}${call.input.temporary_workstation === true ? " at table" : ""}`;
  }
  return call.tool;
}

test("get_items fetches items like a player: logs, a table to carry, a wooden pickaxe for stone, then the crafts", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  const items = SMALL_MEDIEVAL.map(({ name, count }) => ({ item: name, count }));
  const result = await runStep({ skill: "get_items", items }, contextFor(runtime));
  assert.equal(result.status, "done");
  assert.deepEqual([...new Set(runtime.submitted.map(describeCall))], [
    "collect oak_log",
    "collect spruce_log",
    "craft crafting_table",
    "craft wooden_pickaxe at table",
    "collect stone",
    "craft spruce_planks+oak_planks+oak_fence+oak_door at table",
  ]);
  assert.ok(runtime.submitted.filter((call) => call.tool === "collect_block").every((call) => Number(call.input.count) <= 32));
});

test("a pickaxe that breaks while digging is a setback, not a failure: another one is crafted and digging goes on", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_log", count: 10 }, { name: "crafting_table", count: 1 }, { name: "wooden_pickaxe", count: 1 }] };
  runtime.failNext.collect_block = {
    error: "[TOOL_TIER_LOST] wooden_pickaxe was lost; no pickaxe remains. Broke 15 matching blocks; inventory gained 15/16 requested items.",
    effect: () => {
      runtime.addItem("cobblestone", 15);
      runtime.addItem("wooden_pickaxe", -1);
    },
  };
  const result = await runStep({ skill: "get_items", items: [{ item: "cobblestone", count: 16 }] }, contextFor(runtime));
  assert.equal(result.status, "done");
  // The logs the new pickaxe used up are chopped again: get_items keeps what it carried.
  assert.deepEqual(runtime.submitted.map(describeCall), ["collect stone", "craft wooden_pickaxe at table", "collect oak_log", "collect stone"]);
});

test("items that cannot be found end get_items, saying why", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.failures.collect_block = "[NO_LOADED_MATCHING_TARGETS] Observed 0 loaded spruce_log blocks.";
  const result = await runStep({ skill: "get_items", items: [{ item: "spruce_planks", count: 8 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /^\[NO_LOADED_MATCHING_TARGETS\]/u);
});

test("a house without its blocks is refused with the exact shortfall, before any block is touched", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 30 }, { name: "cobblestone", count: 64 }] };
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval" }));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /^missing 49 spruce_planks, 6 oak_planks, 24 oak_log, 3 oak_fence, 1 oak_door for a small medieval house/u);
  assert.equal(runtime.submitted.length, 0);
});

test("a house is built behind the bot in batches facing the requester, the door hung last", async () => {
  const places: KnownPlace[] = [];
  const runtime = new FakeRuntime();
  runtime.snapshot = {
    ...runtime.snapshot,
    position: { x: 0.5, y: 64, z: 0.5 },
    inventory: SMALL_MEDIEVAL,
    players: [{ username: "Steve", position: { x: 8, y: 64, z: 1 } }],
  };
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { requester: "steve", style: "unknown-style", remember: (place) => places.push(place) }));
  assert.deepEqual(result, { status: "done", detail: "built a small medieval house, door at -2 64 0 facing east" });
  // The gable ridge runs across the door's axis, two blocks behind it; its centre is straight behind the door.
  assert.deepEqual(places, [{ name: "the small medieval house you built for steve", detail: "door -2 64 0 facing east; stand on its roof at -4 70 0" }]);
  const calls = builds(runtime);
  assert.ok(calls.length > 2);
  assert.ok(calls.every((call) => call.remove_wrong_blocks && call.blocks.length <= 256));
  // Hung from the doorstep, facing into the house, so it swings along the doorway.
  assert.deepEqual(calls.at(-1)!.blocks.at(-1), { x: -2, y: 64, z: 0, block_name: "oak_door", facing: "west" });
  assert.deepEqual(calls.at(-1)!.blocks.at(0), { x: -2, y: 63, z: 0, block_name: "cobblestone" }, "with the block it stands on");
  assert.ok(calls.slice(0, -1).flatMap((call) => call.blocks).every((cell) => cell.x <= -1), "the house stands behind the bot, away from Steve");
});

test("a batch that does not finish stops the build and says where", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: SMALL_MEDIEVAL };
  runtime.failures.build_structure = "3 cells left: nothing_to_place_against";
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval" }));
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /^a small medieval house stopped at part 1\/\d+: 3 cells left: nothing_to_place_against$/);
  assert.equal(builds(runtime).length, 1);
});

test("building again resumes an unfinished house at the same site and part, without asking for the whole bill", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  const building = { unfinished: null };
  runtime.failNext.build_structure = { error: "[BUILD_INCOMPLETE] 1 cell still wrong" };
  const context = contextFor(runtime, { style: "medieval", building });
  const first = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.match(first.status === "failed" ? first.detail : "", /stopped at part 1\/\d+: .*; building it again resumes it there$/u);
  runtime.snapshot = { ...runtime.snapshot, position: { x: 20.5, y: 64, z: 0.5 }, inventory: [{ name: "oak_door", count: 1 }] };
  const second = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.equal(second.status, "done");
  const calls = builds(runtime);
  assert.deepEqual(calls[1]!.blocks, calls[0]!.blocks, "the refused part is built again where it was");
  assert.equal(building.unfinished, null);
});

test("an unfinished house is checked again from its first part, so what was dug out since is put back", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  const building = { unfinished: null };
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "build_structure" && builds(runtime).length === 2) runtime.failNext.build_structure = { error: "[BUILD_INCOMPLETE] 1 cell still wrong" };
    return submit(tool, input, ...rest);
  };
  const context = contextFor(runtime, { style: "medieval", building });
  const first = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.match(first.status === "failed" ? first.detail : "", /stopped at part 3\/\d+/u);
  const second = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.equal(second.status, "done");
  const calls = builds(runtime);
  assert.deepEqual(calls[3]!.blocks, calls[0]!.blocks, "the second build starts again at part 1");
});

test("get_items fetches that many more of each item", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_log", count: 5 }] };
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 3 }] }, contextFor(runtime));
  assert.match(result.status === "done" ? result.detail : "", /^got 3 oak_log, now carrying 8 oak_log/u);
  assert.deepEqual(runtime.submitted.map((call) => [call.tool, call.input.count]), [["collect_block", 3]]);
});

test("get_items keeps what it carried: planks that crafting the new items used up are made again", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 20 }] };
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_fence", count: 3 }] }, contextFor(runtime));
  assert.equal(result.status, "done");
  const count = (item: string) => runtime.snapshot.inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
  assert.ok(count("oak_fence") >= 3);
  assert.ok(count("oak_planks") >= 20, `still carries the 20 planks (${count("oak_planks")})`);
  assert.ok(runtime.submitted.some((call) => call.tool === "collect_block" && call.input.block_name === "oak_log"), "chopped logs to make the planks again");
});

test("get_items does not fetch back the scaffold blocks spent walking home to craft", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "dirt", count: 10 }, { name: "crafting_table", count: 1 }] };
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    // The logs are far away; the way back home pillars and bridges with carried dirt.
    if (tool === "collect_block") runtime.snapshot = { ...runtime.snapshot, position: { x: 30, y: 64, z: 0 } };
    if (tool === "navigate") {
      runtime.addItem("dirt", -3);
      runtime.snapshot = { ...runtime.snapshot, position: { x: 0, y: 64, z: 0 } };
    }
    return submit(tool, input, ...rest);
  };
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_planks", count: 8 }] }, contextFor(runtime));
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.submitted.map(describeCall), ["collect oak_log", "navigate", "craft oak_planks at table"]);
});

test("a build the runtime stopped reports the audit it returned: what was left and why", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: SMALL_MEDIEVAL };
  runtime.failures.build_structure = "[BUILD_STOPPED] The build stopped: no progress in two passes.";
  runtime.failureResults.build_structure = {
    status: "failed",
    error: "[BUILD_STOPPED] The build stopped: no progress in two passes.",
    structure: {
      placed: 7, dug: 2, wrong: 5, missing: [{ block: "cobblestone", count: 1 }],
      left: [{ reason: "not_reached", count: 4, named: [] }, { reason: "refused", count: 1, named: [] }],
    },
  };
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval" }));
  assert.equal(result.status, "failed");
  assert.match(
    result.detail ?? "",
    /stopped at part 1\/\d+: \[BUILD_STOPPED\] The build stopped: no progress in two passes\. \(placed 7, dug 2; left 4 not_reached, 1 refused; short of 1 cobblestone\)$/u,
  );
});

test("a house protects its box before the first block, one ring wider and one layer deeper, and only once when built again", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  const areas: ProtectedArea[] = [];
  const context = contextFor(runtime, { style: "medieval", areas });
  assert.equal((await runStep({ skill: "build", structure: "house", size: "small" }, context)).status, "done");
  assert.equal(runtime.submitted[0]?.tool, "protect_region", "protected before any block is touched");
  const cellsBuilt = builds(runtime).flatMap((call) => call.blocks);
  const box = runtime.areas[0]!;
  assert.deepEqual(box.min, {
    x: Math.min(...cellsBuilt.map((cell) => cell.x)) - 1,
    y: Math.min(...cellsBuilt.map((cell) => cell.y)) - 1,
    z: Math.min(...cellsBuilt.map((cell) => cell.z)) - 1,
  });
  assert.deepEqual(box.max, {
    x: Math.max(...cellsBuilt.map((cell) => cell.x)) + 1,
    y: Math.max(...cellsBuilt.map((cell) => cell.y)),
    z: Math.max(...cellsBuilt.map((cell) => cell.z)) + 1,
  });
  assert.equal(box.label, "small medieval house");
  assert.deepEqual(areas, [box]);

  // The same site again (a resume, or a rebuild after a restart): the same box, nothing new stored.
  await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.equal(runtime.areas.length, 1);
  assert.equal(areas.length, 1);
});

test("houseBox spans the cells plus a ring around them and the layer below, not above", () => {
  assert.deepEqual(houseBox([{ x: 0, y: 64, z: 0 }, { x: 4, y: 70, z: 2 }]), { min: { x: -1, y: 63, z: -1 }, max: { x: 5, y: 70, z: 3 } });
});

test("protect_area keeps a radius around a seen player, owned by that player, and release_area gives it back", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Tom", position: { x: 10.4, y: 64, z: -3.6 } }] };
  const areas: ProtectedArea[] = [];
  const context = contextFor(runtime, { areas });
  const kept = await runStep(stepSchema.parse({ skill: "protect_area", player: "tom", radius: 5, label: "Tom's place" }), context);
  assert.deepEqual(kept, { status: "done", detail: "protected area #1 'Tom's place' (11 blocks across around 10 64 -4): I will not dig or place blocks there" });
  assert.deepEqual(areas, [{ regionId: 1, label: "Tom's place", owner: "tom", min: { x: 5, y: 59, z: -9 }, max: { x: 15, y: 69, z: 1 } }]);

  assert.deepEqual(await runStep({ skill: "release_area", area: 1 }, context), { status: "done", detail: "released area #1: I may dig and place blocks there again" });
  assert.deepEqual(areas, []);
  assert.equal((await runStep({ skill: "release_area", area: 1 }, context)).status, "failed");
});

test("protect_area needs a player in sight or coordinates", async () => {
  const runtime = new FakeRuntime();
  const context = contextFor(runtime);
  assert.deepEqual(await runStep(stepSchema.parse({ skill: "protect_area", player: "Tom", label: "x" }), context), { status: "failed", detail: "cannot see Tom to protect the area around them" });
  assert.deepEqual(await runStep(stepSchema.parse({ skill: "protect_area", label: "x" }), context), { status: "failed", detail: "protect_area needs a player or x, y and z" });
  assert.equal((await runStep(stepSchema.parse({ skill: "protect_area", x: 1, y: 64, z: 1, radius: 2, label: "spot" }), context)).status, "done");
  assert.equal(runtime.areas[0]?.owner, "self", "coordinates alone protect the character's own area");
  assert.equal(stepSchema.safeParse({ skill: "protect_area", player: "Tom", radius: 32, label: "x" }).success, false);
});
