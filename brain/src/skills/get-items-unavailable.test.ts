// Requested-item context in get_items failures when a source block cannot be fetched.
import assert from "node:assert/strict";
import test from "node:test";
import { runStep } from "../skills.ts";
import { FakeRuntime } from "../testing.ts";
import { contextFor, GLASS_RECIPES } from "./skill-fixtures.test.ts";

/** The T14 bill whose spruce fetch failed (live 2026-11-16). */
const T14_BILL = [
  { item: "spruce_stairs", count: 42 }, { item: "oak_planks", count: 36 },
  { item: "cobblestone", count: 16 }, { item: "spruce_slab", count: 7 },
  { item: "glass_pane", count: 3 }, { item: "oak_door", count: 1 },
];

for (const situation of ["after progress", "with no progress yet", "across water", "in wet chunks"] as const) {
  test(`a missing log names the asked items it was for ${situation}`, async () => {
    const runtime = new FakeRuntime();
    runtime.recipes = GLASS_RECIPES;
    runtime.smelting = { glass: ["sand"] };
    runtime.simulateInventory = true;
    runtime.snapshot = { ...runtime.snapshot, inventory: [
      { name: "sand", count: 100 }, { name: "crafting_table", count: 1 },
      ...(situation === "after progress" ? [] : [{ name: "oak_log", count: 100 }]),
    ] };
    // Oak is available; collecting it first leaves the later spruce fetch empty.
    if (situation === "after progress") {
      runtime.succeedEffects.collect_block = () => { runtime.failures.collect_block = "[NO_TARGET_IN_RANGE] none near"; };
    } else runtime.failures.collect_block = "[NO_TARGET_IN_RANGE] none near";
    if (situation === "across water" || situation === "in wet chunks") {
      runtime.seen = { spruce_log: { dimension: "overworld", x: 700, z: 8 } };
      runtime.water = situation === "across water"
        ? Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`${index + 1},0`, 1]))
        : { "43,0": 0.9 };
    }
    const items = situation === "after progress" ? [{ item: "oak_log", count: 24 }, ...T14_BILL] : T14_BILL;
    const result = await runStep({ skill: "get_items", items }, contextFor(runtime));
    assert.equal(result.status, "failed");
    const detail = result.status === "failed" ? result.detail : "";
    if (situation === "after progress") assert.match(detail, /carried now: /u);
    if (situation === "across water") assert.match(detail, /across the water/u);
    if (situation === "in wet chunks") assert.match(detail, /chunks that are mostly water/u);
    assert.ok(detail.includes("spruce_log is for 42 spruce_stairs, 7 spruce_slab"), detail);
    assert.match(detail, /use another material/u);
  });
}

test("a stone source names the cobblestone items", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { cobblestone_stairs: { makes: 4, needs: [{ item: "cobblestone", count: 6 }] } };
  runtime.dropSources = { cobblestone: [{ block: "stone", chance: 1, planted: false }] };
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_pickaxe", count: 1 }, { name: "crafting_table", count: 1 }] };
  runtime.failures.collect_block = "[NO_TARGET_IN_RANGE] none near";
  const result = await runStep({ skill: "get_items", items: [{ item: "cobblestone_stairs", count: 4 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.ok(result.detail.includes("stone is for 4 cobblestone_stairs"), result.detail);
});
