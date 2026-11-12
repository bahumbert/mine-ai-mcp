import assert from "node:assert/strict";
import test from "node:test";
import { Body } from "../body.ts";
import { runStep, type SkillContext, type UnfinishedHouse } from "../skills.ts";
import { DEFAULT_POLICY, FakeRuntime, SMALL_MEDIEVAL_HOUSE } from "../testing.ts";

// Live 2026-10-09: Tom's stone pickaxe wore out at part 1/9 of his house and the build ended there.
const RECIPES = {
  stick: { makes: 4, needs: [{ item: "oak_planks", count: 2 }] },
  wooden_pickaxe: { makes: 1, needs: [{ item: "oak_planks", count: 3 }, { item: "stick", count: 2 }] },
};
const LOST = "[TOOL_TIER_LOST] stone_pickaxe was lost at -732,111,87; no pickaxe remains.";

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
  // The pickaxe takes the 2 sticks carried (kept): they are crafted again first (plan 2026-11-12-house-build-fixes Task 4).
  assert.deepEqual(log.slice(1, 4), ["craft stick", "craft wooden_pickaxe", "build"]);
  assert.equal(building.unfinished, null);
});

test("a tool lost mid-stage refetches keeping the stage's scaffold: the walk back does not lay the roof's dirt", async () => {
  const runtime = builder();
  runtime.snapshot = { ...runtime.snapshot, policy: DEFAULT_POLICY, inventory: [...runtime.snapshot.inventory, { name: "dirt", count: 4 }] };
  // The pickaxe is lost on the first part of the roof (the fifth call: the floor and the walls took four); making the new one
  // takes the bot 40 blocks off, so the fetch walks back.
  let sent = 0;
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "build_structure" && (sent += 1) === 5) runtime.failNext.build_structure = wear(runtime);
    if (tool === "craft_item") runtime.snapshot = { ...runtime.snapshot, position: { x: 40.5, y: 64, z: 0.5 } };
    return submit(tool, input, ...rest);
  };
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { building: { unfinished: null as UnfinishedHouse | null } }));
  assert.equal(result.status, "done", JSON.stringify(result));
  const walks = runtime.submitted.filter((call) => call.tool === "navigate");
  // Two walks, both far from the site: back home between the stick craft and the pickaxe craft, then the fetch's way back.
  assert.equal(walks.length, 2, "the walk home before the pickaxe craft, and the fetch's way back");
  // The admitted kinds besides the house's own (its cobblestone is kept by the build's own policy keep).
  const admitted = DEFAULT_POLICY.scaffoldBlocks!.filter((kind) => !SMALL_MEDIEVAL_HOUSE.some((stack) => stack.name === kind));
  for (const walk of walks) {
    const keep = (walk.input.keep_items ?? []) as string[];
    assert.ok(admitted.includes("dirt") && admitted.every((kind) => keep.includes(kind)), `the roof's scaffold kinds are kept (${keep.join(", ")})`);
  }
  assert.ok((walks.at(-1)!.input.keep_items as string[]).includes("wooden_pickaxe"), "the tool it fetched");
  assert.equal(runtime.snapshot.inventory.find((stack) => stack.name === "dirt")?.count, 4, "no walk laid the roof's dirt");
});

test("the pickaxe lost again in the same step ends the build, saying what was remade", async () => {
  const runtime = builder();
  runtime.failNext.build_structure = {
    error: LOST,
    effect: () => {
      runtime.addItem("stone_pickaxe", -1);
      // The new one wears out on the part done again.
      runtime.failNext.build_structure = { error: "[TOOL_TIER_LOST] wooden_pickaxe was lost; no pickaxe remains.", effect: () => runtime.addItem("wooden_pickaxe", -1) };
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
