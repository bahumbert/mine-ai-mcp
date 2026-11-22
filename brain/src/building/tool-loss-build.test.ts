import assert from "node:assert/strict";
import test from "node:test";
import { Body } from "../body.ts";
import { runStep, type SkillContext, type UnfinishedHouse } from "../skills.ts";
import { DEFAULT_POLICY, FakeRuntime, SMALL_MEDIEVAL_HOUSE, TEMPLATES_WITH_HIGH_ROOF } from "../testing.ts";

// Live 2026-10-09: Tom's stone pickaxe wore out at part 1/9 of his house and the build ended there.
const RECIPES = {
  stick: { makes: 4, needs: [{ item: "oak_planks", count: 2 }] },
  wooden_pickaxe: { makes: 1, needs: [{ item: "oak_planks", count: 3 }, { item: "stick", count: 2 }] },
};
const LOST = "[TOOL_TIER_LOST] stone_pickaxe was lost at -732,111,87; family: pickaxe; no pickaxe remains.";

function contextFor(runtime: FakeRuntime, extra: Partial<SkillContext> = {}): SkillContext {
  return { runtime, body: new Body(runtime, () => undefined), signal: new AbortController().signal, style: "medieval", ...extra };
}

/** A runtime carrying the house, a stone pickaxe, and spare planks and sticks (the table is carried too). */
function builder(): FakeRuntime {
  const runtime = new FakeRuntime();
  runtime.recipes = RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = {
    ...runtime.snapshot,
    position: { x: 0.5, y: 64, z: 0.5 },
    inventory: SMALL_MEDIEVAL_HOUSE.map((stack) => stack.name === "oak_planks" ? { ...stack, count: stack.count + 3 } : stack)
      .concat([{ name: "stone_pickaxe", count: 1 }, { name: "stick", count: 2 }, { name: "crafting_table", count: 1 }]),
  };
  return runtime;
}

const wear = (runtime: FakeRuntime) => ({ error: LOST, effect: () => runtime.addItem("stone_pickaxe", -1) });
const calls = (runtime: FakeRuntime) => runtime.submitted.filter((call) => call.tool === "build_structure" || call.tool === "craft_item").map((call) => call.tool === "craft_item" ? `craft ${(call.input.items as { item_name: string }[]).map((item) => item.item_name).join("+")}` : "build");

test("a pickaxe worn out in the middle of a house is made again and the part done again", async () => {
  const runtime = builder();
  runtime.failNext.build_structure = wear(runtime);
  const building = { unfinished: null as UnfinishedHouse | null };
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { building }));
  assert.equal(result.status, "done", JSON.stringify(result));
  const log = calls(runtime);
  assert.equal(log[0], "build");
  // The refetch is a means fetch (plan 2026-11-14 Task 5): the pickaxe is crafted at once from the 2 sticks carried, which are
  // then made again; before it (plan 2026-11-12 Task 4) the sticks were replaced first.
  assert.deepEqual(log.slice(1, 4), ["craft wooden_pickaxe", "craft stick", "build"]);
  assert.equal(building.unfinished, null);
});

/**
 * `builder()` with 5 spare planks and no sticks (a wooden pickaxe takes 3 planks and 2 sticks, which take 2 planks: all 5),
 * planks made from logs, as the game does. The pickaxe is lost on the first call of the final check (the 10th: nine parts
 * before it); `logsUsed`: the walls' logs are used by then (the fake's `build_structure` places nothing out of the bag), so
 * none is carried and the planks cannot be made again.
 */
function builderWithSparePlanks(logsUsed: boolean, then?: { readonly error: string }): FakeRuntime {
  const runtime = builder();
  runtime.recipes = { ...RECIPES, oak_planks: { makes: 4, needs: [{ item: "oak_log", count: 1 }] } };
  const house = SMALL_MEDIEVAL_HOUSE.map((stack) => stack.name === "oak_planks" ? { ...stack, count: stack.count + 5 } : stack);
  runtime.snapshot = { ...runtime.snapshot, inventory: house.concat([{ name: "stone_pickaxe", count: 1 }, { name: "crafting_table", count: 1 }]) };
  let sent = 0;
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "build_structure" && (sent += 1) === 10) {
      runtime.failNext.build_structure = { error: LOST, effect: () => {
        runtime.addItem("stone_pickaxe", -1);
        if (logsUsed) runtime.addItem("oak_log", -24);
        if (then !== undefined) runtime.failNext.build_structure = then;
      } };
    }
    return submit(tool, input, ...rest);
  };
  return runtime;
}

const NO_LOG_NEAR = "[NO_TARGET_IN_RANGE] no oak_log within 64 blocks of you";

test("a pickaxe lost mid-stage is made from the house's planks when no log is near; the build goes on and says so (plan 2026-11-14 Task 5)", async () => {
  const runtime = builderWithSparePlanks(true);
  runtime.failures.collect_block = NO_LOG_NEAR;
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { building: { unfinished: null as UnfinishedHouse | null } }));
  assert.equal(result.status, "done", JSON.stringify(result));
  const log = calls(runtime);
  assert.equal(log[0], "build");
  assert.ok(log.includes("craft wooden_pickaxe"), "the pickaxe was made from the planks carried");
  assert.equal(log.at(-1), "build", "the stage's next build_structure was sent after it");
  assert.match(result.status === "done" ? result.detail : "", /^built a small medieval house.*; remade wooden_pickaxe \(used 5 oak_planks of what you carried\)$/u);
});

test("a pickaxe whose planks are made again from the logs carried adds no note to the build's result", async () => {
  const runtime = builderWithSparePlanks(false);
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { building: { unfinished: null as UnfinishedHouse | null } }));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.doesNotMatch(result.status === "done" ? result.detail : "", /remade|of what you carried/u);
});

test("a pickaxe made from the house's planks and a build that then stops still tells what was used", async () => {
  const runtime = builderWithSparePlanks(true, { error: "[BUILD_STOPPED] the route stopped" });
  runtime.failures.collect_block = NO_LOG_NEAR;
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { building: { unfinished: null as UnfinishedHouse | null } }));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /; remade wooden_pickaxe \(used 5 oak_planks of what you carried\)/u);
});

test("a tool lost mid-stage refetches keeping the stage's scaffold: the walk back does not lay the roof's dirt", async () => {
  const runtime = builder();
  runtime.snapshot = { ...runtime.snapshot, policy: DEFAULT_POLICY, inventory: [...runtime.snapshot.inventory, { name: "dirt", count: 5 }] };
  // The pickaxe is lost on the first part of the roof (the fifth call: the floor and the walls took four); making the new one
  // takes the bot 40 blocks off, so the fetch walks back.
  let sent = 0;
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "build_structure" && (sent += 1) === 5) runtime.failNext.build_structure = wear(runtime);
    if (tool === "craft_item") runtime.snapshot = { ...runtime.snapshot, position: { x: 40.5, y: 64, z: 0.5 } };
    return submit(tool, input, ...rest);
  };
  // The raised-roof fixture: the real roof is within the eye's reach from the door's level and asks no block to stand on.
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { building: { unfinished: null as UnfinishedHouse | null }, templates: TEMPLATES_WITH_HIGH_ROOF }));
  assert.equal(result.status, "done", JSON.stringify(result));
  const walks = runtime.submitted.filter((call) => call.tool === "navigate");
  // Two walks, both far from the site: back home between the stick craft and the pickaxe craft, then the fetch's way back.
  assert.equal(walks.length, 2, "the walk home before the pickaxe craft, and the fetch's way back");
  // The admitted kinds besides the house's own (its cobblestone is kept by the build's own policy keep).
  const admitted = DEFAULT_POLICY.scaffoldBlocks!.filter((kind) => !SMALL_MEDIEVAL_HOUSE.some((stack) => stack.name === kind));
  // Plan 2026-11-14 Task 6: kept by count (the raised roof's stand columns: 3 of each, the busiest call's), not by name.
  for (const walk of walks) {
    const reserve = (walk.input.reserve_items ?? []) as { item: string; count: number }[];
    assert.ok(admitted.includes("dirt"), "dirt is an admitted kind");
    assert.deepEqual(reserve, admitted.map((item) => ({ item, count: 3 })), "the roof's scaffold kinds are reserved at its count");
  }
  assert.ok((walks.at(-1)!.input.keep_items as string[]).includes("wooden_pickaxe"), "the tool it fetched");
  assert.equal(runtime.snapshot.inventory.find((stack) => stack.name === "dirt")?.count, 5, "no walk laid the roof's dirt");
});

test("the pickaxe lost again in the same step ends the build, saying what was remade", async () => {
  const runtime = builder();
  runtime.failNext.build_structure = {
    error: LOST,
    effect: () => {
      runtime.addItem("stone_pickaxe", -1);
      // The new one wears out on the part done again.
      runtime.failNext.build_structure = { error: "[TOOL_TIER_LOST] wooden_pickaxe was lost; family: pickaxe; no pickaxe remains.", effect: () => runtime.addItem("wooden_pickaxe", -1) };
    },
  };
  const context = contextFor(runtime, { building: { unfinished: null as UnfinishedHouse | null } });
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.equal(result.status, "failed");
  const detail = result.status === "failed" ? result.detail : "";
  assert.match(detail, /^a small medieval house stopped at part 1\/\d+: \[TOOL_TIER_LOST\] wooden_pickaxe was lost/u);
  assert.match(detail, /wooden_pickaxe was remade earlier in this step and lost again/u);
  assert.match(detail, /; \{"skill":"build","template":"medieval-small","x":-?\d+,"y":\d+,"z":-?\d+\} resumes it$/u);
  assert.equal(calls(runtime).filter((call) => call === "craft wooden_pickaxe").length, 1);
});

test("when the new pickaxe cannot be made, the build says why", async () => {
  const runtime = builder();
  runtime.snapshot = { ...runtime.snapshot, inventory: SMALL_MEDIEVAL_HOUSE.concat([{ name: "stone_pickaxe", count: 1 }]) };
  runtime.failNext.build_structure = wear(runtime);
  runtime.failNext.collect_block = { error: "[NO_REACHABLE_MATCHING_TARGETS] none" };
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { building: { unfinished: null } }));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /stopped at part 1\/\d+: \[TOOL_TIER_LOST\] stone_pickaxe was lost.*; making a new wooden_pickaxe failed: /u);
});
