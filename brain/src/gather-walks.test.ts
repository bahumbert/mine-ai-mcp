import assert from "node:assert/strict";
import test from "node:test";
import { Body } from "./body.ts";
import { gatherMaterials, type GatherContext } from "./gathering/gather-materials.ts";
import { HostileInterruptions } from "./gathering/hostile-interruptions.ts";
import { FakeRuntime } from "./testing.ts";
import type { WalkKeep } from "./walk-keep.ts";

// Plan 2026-11-14-house-build-fixes-2 Task 7a (ticket 4): every walk a fetch makes keeps the fetched items by name and what
// the work in hand needs (`walkKeep`), and a kept walk that finds no way is walked once more by the one retry rule.

const NO_PATH = "[NAVIGATION_STOPPED] Pathfinder stopped: no path.";
const NONE_NEAR = "[NO_TARGET_IN_RANGE] No oak_log block left within 64 blocks of where the run started; none is loaded farther either.";
/** What the work in hand keeps: 15 cobblestone by count (a bill), 4 dirt by count (a roof's scaffold). */
const WALK_KEEP: WalkKeep = { items: [], reserve: [{ item: "cobblestone", count: 15 }], scaffold: [{ item: "dirt", count: 4 }] };

function contextFor(runtime: FakeRuntime, walkKeep: WalkKeep = WALK_KEEP): GatherContext {
  return { runtime, body: new Body(runtime, () => undefined), signal: new AbortController().signal, hostileInterruptions: new HostileInterruptions(() => 0), walkKeep };
}

/** A runtime whose first collect finds no log near and that knows a forest 150 blocks off: the fetch walks there. */
function fetchingFarther(inventory: readonly { readonly name: string; readonly count: number }[] = []): FakeRuntime {
  const runtime = new FakeRuntime();
  runtime.walkOnNavigate = true;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [...inventory] };
  runtime.failNext.collect_block = { error: NONE_NEAR };
  runtime.seen = { oak_log: { dimension: "overworld", x: 150, z: 8 } };
  return runtime;
}

const walksOf = (runtime: FakeRuntime) => runtime.submitted.filter((call) => call.tool === "navigate").map((call) => call.input);

test("the walk to a seen block keeps the fetched items by name and the walkKeep by count", async () => {
  const runtime = fetchingFarther();
  const gathered = await gatherMaterials(contextFor(runtime), [{ item: "oak_log", count: 4 }], "a house", runtime.snapshot.position);
  assert.equal(gathered.status, "done", JSON.stringify(gathered));
  const [walk] = walksOf(runtime);
  assert.equal(walk!.x, 150);
  assert.deepEqual(walk!.keep_items, ["oak_log"], "the fetched item");
  assert.deepEqual(walk!.reserve_items, [{ item: "cobblestone", count: 15 }, { item: "dirt", count: 4 }], "the bill by count, the scaffold by count");
});

test("the walk to dry ground for a workstation keeps them too", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { oak_door: { makes: 3, needs: [{ item: "oak_planks", count: 6 }] }, oak_planks: { makes: 4, needs: [{ item: "oak_log", count: 1 }] }, crafting_table: { makes: 1, needs: [{ item: "oak_planks", count: 4 }] } };
  runtime.simulateInventory = true;
  runtime.walkOnNavigate = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_log", count: 4 }, { name: "crafting_table", count: 1 }] };
  runtime.water = { "0,0": 1, "2,0": 0 };
  runtime.failNext.craft_item = { error: "[WORKSTATION_PLACEMENT_FAILED] crafting_table: no_cell (no dry, clear cell with something solid to set it on within reach: in water, a tunnel or a crowded spot); move to open dry ground first." };
  const gathered = await gatherMaterials(contextFor(runtime), [{ item: "oak_door", count: 3 }], "a house", runtime.snapshot.position);
  assert.equal(gathered.status, "done", JSON.stringify(gathered));
  const [dry] = walksOf(runtime);
  assert.equal(dry!.range, 4, "the walk to dry ground");
  assert.deepEqual(dry!.keep_items, ["oak_door"]);
  assert.deepEqual(dry!.reserve_items, [{ item: "cobblestone", count: 15 }, { item: "dirt", count: 4 }]);
  const home = walksOf(runtime).at(-1)!;
  assert.deepEqual(home.reserve_items, [{ item: "cobblestone", count: 15 }, { item: "dirt", count: 4 }], "the walk back home keeps them as before");
});

test("a kept walk that finds no path is walked once more by the relaxed keep, and the collect runs", async () => {
  // 5 dirt carried for a reserve of 4: the first walk may place 1, the second (the scaffold dropped) all 5.
  const runtime = fetchingFarther([{ name: "dirt", count: 5 }]);
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "navigate" && input.reserve_items !== undefined) runtime.failNext.navigate = { error: NO_PATH };
    return submit(tool, input, ...rest);
  };
  const gathered = await gatherMaterials(contextFor(runtime, { items: [], reserve: [], scaffold: [{ item: "dirt", count: 4 }] }), [{ item: "oak_log", count: 4 }], "a house", runtime.snapshot.position);
  assert.equal(gathered.status, "done", JSON.stringify(gathered));
  const walks = walksOf(runtime);
  assert.equal(walks.length, 2, "kept, then relaxed");
  assert.equal(walks[1]!.reserve_items, undefined, "the scaffold dropped");
  assert.deepEqual(runtime.submitted.map((call) => call.tool), ["collect_block", "navigate", "navigate", "collect_block"], "next: the collect runs at the forest");
});

test("a walk with nothing kept is not walked again after a no path", async () => {
  const runtime = fetchingFarther([{ name: "dirt", count: 5 }]);
  runtime.failures.navigate = NO_PATH;
  const gathered = await gatherMaterials(contextFor(runtime, { items: [], reserve: [], scaffold: [] }), [{ item: "oak_log", count: 4 }], "a house", runtime.snapshot.position);
  assert.equal(gathered.status, "failed");
  assert.equal(walksOf(runtime).length, 1, "keep_items has the fetched oak_log only, none carried: the same walk");
});
