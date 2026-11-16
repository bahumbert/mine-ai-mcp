import assert from "node:assert/strict";
import test from "node:test";
import { Body } from "./body.ts";
import { NO_KEEP, relaxedKeep, walkKeepInput, type WalkKeep } from "./walk-keep.ts";
import { walkKeeping } from "./walks.ts";
import { FakeRuntime } from "./testing.ts";

// Plan 2026-11-14-house-build-fixes-2 Task 6: what a walk keeps is names (`keep_items`: never placed) and counts
// (`reserve_items`: placed only above the count), and one rule gives a walk that kept too much a second try.

const stand = { x: 4.5, y: 64, z: 4.5 };
const NO_PATH = "[NAVIGATION_STOPPED] Pathfinder stopped: no path.";

function contextFor(runtime: FakeRuntime) {
  return { runtime, body: new Body(runtime, () => undefined), signal: new AbortController().signal };
}

/** A runtime carrying `carrying`, whose walks are refused (no path) while `refuse` says the keep leaves none. */
function walkingRuntime(carrying: readonly { readonly name: string; readonly count: number }[], refuse: (input: Record<string, unknown>) => boolean) {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [...carrying] };
  const walks: Record<string, unknown>[] = [];
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "navigate") {
      walks.push(input);
      if (refuse(input)) runtime.failNext.navigate = { error: NO_PATH };
    }
    return submit(tool, input, ...rest);
  };
  return { runtime, walks };
}

test("walkKeepInput names the kept items and the counted reserve, and nothing for no keep", () => {
  assert.deepEqual(walkKeepInput(NO_KEEP), {});
  assert.deepEqual(walkKeepInput({ items: ["oak_planks", "oak_planks"], reserve: [{ item: "cobblestone", count: 15 }], scaffold: [{ item: "dirt", count: 4 }] }), {
    keep_items: ["oak_planks"],
    reserve_items: [{ item: "cobblestone", count: 15 }, { item: "dirt", count: 4 }],
  });
  assert.deepEqual(walkKeepInput({ items: [], reserve: [], scaffold: [{ item: "dirt", count: 4 }] }), { reserve_items: [{ item: "dirt", count: 4 }] });
});

test("relaxedKeep keeps the bill at its need and drops the scaffold", () => {
  const keep: WalkKeep = { items: ["oak_planks", "glass"], reserve: [{ item: "cobblestone", count: 15 }], scaffold: [{ item: "dirt", count: 4 }] };
  assert.deepEqual(relaxedKeep(keep, [{ item: "oak_planks", count: 20 }, { item: "glass", count: 3 }]), {
    items: [],
    reserve: [{ item: "cobblestone", count: 15 }, { item: "oak_planks", count: 20 }, { item: "glass", count: 3 }],
    scaffold: [],
  });
  assert.deepEqual(relaxedKeep(keep, [{ item: "oak_planks", count: 20 }]).reserve.map((entry) => entry.item), ["cobblestone", "oak_planks"], "a name with no count before is not kept by count (a reserve count is at least 1)");
});

test("the second walk lets the asked item's spare bridge: dirt asked and the only bridge block, kept by the count carried before the fetch", async () => {
  const { runtime, walks } = walkingRuntime([{ name: "dirt", count: 8 }], (input) => input.keep_items !== undefined);
  // 5 dirt were carried before the fetch, 3 more fetched: the first walk keeps dirt by name, the second only the 5.
  const outcome = await walkKeeping(contextFor(runtime), stand, "Walk to the site.", { items: ["dirt"], reserve: [], scaffold: [] }, [{ item: "dirt", count: 5 }]);
  assert.equal(outcome.status, "succeeded");
  assert.equal(walks.length, 2);
  assert.deepEqual(walks[0]!.keep_items, ["dirt"]);
  assert.equal(walks[1]!.keep_items, undefined, "no name kept in the second walk");
  assert.deepEqual(walks[1]!.reserve_items, [{ item: "dirt", count: 5 }]);
});

test("a walk that fails with a keep that frees nothing when relaxed is not walked again", async () => {
  // 5 dirt carried, 5 kept by count before the fetch: the second walk would keep the same blocks.
  const { runtime, walks } = walkingRuntime([{ name: "dirt", count: 5 }], () => true);
  const outcome = await walkKeeping(contextFor(runtime), stand, "Walk to the site.", { items: ["dirt"], reserve: [], scaffold: [] }, [{ item: "dirt", count: 5 }]);
  assert.equal(outcome.status, "failed");
  assert.equal(walks.length, 1);
});

test("a walk that fails for another reason, or after a stop, is not walked again", async () => {
  const other = walkingRuntime([{ name: "dirt", count: 8 }], () => false);
  other.runtime.failNext.navigate = { error: "[NAVIGATION_DEEP_WATER] Deep open water ahead" };
  assert.equal((await walkKeeping(contextFor(other.runtime), stand, "w", { items: [], reserve: [], scaffold: [{ item: "dirt", count: 4 }] }, [])).status, "failed");
  assert.equal(other.walks.length, 1);
  const controller = new AbortController();
  const stopped = walkingRuntime([{ name: "dirt", count: 8 }], () => true);
  const submit = stopped.runtime.submit.bind(stopped.runtime);
  stopped.runtime.submit = async (tool, input, ...rest) => {
    if (tool === "navigate") controller.abort();
    return submit(tool, input, ...rest);
  };
  await walkKeeping({ ...contextFor(stopped.runtime), signal: controller.signal }, stand, "w", { items: [], reserve: [], scaffold: [{ item: "dirt", count: 4 }] }, []);
  assert.equal(stopped.walks.length, 1);
});

test("an item in both the reserve and the scaffold is sent once, at the larger count (the input's list is capped)", () => {
  const input = walkKeepInput({ items: [], reserve: [{ item: "dirt", count: 2 }, { item: "cobblestone", count: 15 }], scaffold: [{ item: "dirt", count: 4 }] });
  assert.deepEqual(input.reserve_items, [{ item: "dirt", count: 4 }, { item: "cobblestone", count: 15 }]);
});

test("a scaffold reserve the carried blocks cannot cover is dropped by the second walk, the bill kept at its need", async () => {
  const { runtime, walks } = walkingRuntime([{ name: "dirt", count: 4 }, { name: "cobblestone", count: 16 }], (input) => (input.reserve_items as { item: string }[] | undefined)?.some((entry) => entry.item === "dirt") === true);
  const outcome = await walkKeeping(contextFor(runtime), stand, "w", { items: ["cobblestone"], reserve: [], scaffold: [{ item: "dirt", count: 4 }] }, [{ item: "cobblestone", count: 16 }]);
  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(walks.map((walk) => walk.reserve_items), [[{ item: "dirt", count: 4 }], [{ item: "cobblestone", count: 16 }]]);
  assert.deepEqual(walks[0]!.keep_items, ["cobblestone"]);
  assert.equal(walks[1]!.keep_items, undefined);
});
