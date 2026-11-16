// Tests of the boat hint of get_items: a far place across the water is named with its way, and a walk stopped by deep
// water does not forget the place (plan 2026-11-16-p4-21-signs-a4 T1; live T6 re-run, seq167 and seq183).
import assert from "node:assert/strict";
import test from "node:test";
import { acrossWaterWords } from "../gathering/fetch-farther.ts";
import { runStep } from "../skills.ts";
import { FakeRuntime } from "../testing.ts";
import { contextFor } from "./skill-fixtures.test.ts";

const NONE_NEAR = "[NO_TARGET_IN_RANGE] No oak_log block left within 64 blocks of where the run started; none is loaded farther either.";
/** The live answer of walk submission 50ec0380 (T6 re-run), numbers changed: the walk stops at deep water with no boat carried. */
const DEEP_WATER = "[NAVIGATION_DEEP_WATER] The way to 300, 8 crosses deep open water from about 40, 0 (32+ blocks of it seen); no boat is carried: carry a boat to cross by boat, or choose a way over land.";

/** The sea the walks explored, one chunk per column on the row of the bot: chunks `from`..`to` at 1 (all water). */
function sea(from: number, to: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: to - from + 1 }, (_unused, index) => [`${from + index},0`, 1]));
}

/** One get_items of one oak_log whose near collect finds none. */
async function fetchOak(runtime: FakeRuntime): Promise<{ readonly status: string; readonly detail: string }> {
  runtime.failNext.collect_block = { error: NONE_NEAR };
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 1 }] }, contextFor(runtime));
  return { status: result.status, detail: "detail" in result ? result.detail : "" };
}

const navigateX = (runtime: FakeRuntime): unknown[] => runtime.submitted.filter((call) => call.tool === "navigate").map((call) => call.input.x);
const withBoat = (runtime: FakeRuntime): void => { runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_boat", count: 1 }] }; };

test("a known place across the sea is named with its way, and a fetch with a boat walks there", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.seen = { oak_log: { dimension: "overworld", x: 700, z: 8 } };
  runtime.water = sea(1, 40);
  const told = await fetchOak(runtime);
  assert.equal(told.status, "failed");
  assert.ok(told.detail.includes("the nearest oak_log you know of is across the water, 700 blocks east, around 700 8: take a boat (get_items oak_boat); with a boat carried, get_items oak_log again also goes to the places across the water"), told.detail);
  assert.deepEqual(navigateX(runtime), []);
  withBoat(runtime);
  assert.equal((await fetchOak(runtime)).status, "done");
  assert.deepEqual(navigateX(runtime), [700]);
  assert.equal(runtime.submitted.filter((call) => call.tool === "navigate").at(-1)?.input.z, 8);
});

test("a walk stopped by deep water keeps the place for a boat: A fails, the water is then known, a boat fetch goes to A", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.seen = { oak_log: { dimension: "overworld", x: 300, z: 8 } };
  runtime.alsoSeen = { oak_log: [{ dimension: "overworld", x: 400, z: 8 }] };
  runtime.failNext.navigate = { error: DEEP_WATER };
  const first = await fetchOak(runtime);
  assert.match(first.detail, /300 blocks east, around 300 8/u);
  assert.deepEqual(navigateX(runtime), [300]);
  // The walk explored the sea before the place: its chunks are known now, the places themselves are on land.
  runtime.water = sea(1, 17);
  const second = await fetchOak(runtime);
  assert.deepEqual(navigateX(runtime), [300], "no second walk without a boat");
  assert.match(second.detail, /the nearest oak_log you know of is across the water, 300 blocks east, around 300 8/u);
  withBoat(runtime);
  assert.equal((await fetchOak(runtime)).status, "done");
  assert.deepEqual(navigateX(runtime), [300, 300], "A was not marked tried by the deep-water stop");
});

test("a boat lost on the way: the same answer, the place kept", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.seen = { oak_log: { dimension: "overworld", x: 300, z: 8 } };
  withBoat(runtime);
  runtime.failNext.navigate = { error: DEEP_WATER, effect: () => { runtime.snapshot = { ...runtime.snapshot, inventory: [] }; } };
  const lost = await fetchOak(runtime);
  assert.equal(lost.status, "failed");
  assert.match(lost.detail, /take a boat \(get_items oak_boat\)/u);
  assert.match(lost.detail, /around 300 8/u);
  withBoat(runtime);
  assert.equal((await fetchOak(runtime)).status, "done");
  assert.deepEqual(navigateX(runtime), [300, 300]);
});

test("a nearer place skipped across water is the one named when a farther walk stops on deep water", async () => {
  const runtime = new FakeRuntime();
  runtime.seen = { oak_log: { dimension: "overworld", x: 300, z: 8 } };
  runtime.alsoSeen = { oak_log: [{ dimension: "overworld", x: 400, z: -100 }] };
  runtime.water = sea(1, 17);
  runtime.failNext.navigate = { error: DEEP_WATER };
  const told = await fetchOak(runtime);
  assert.deepEqual(navigateX(runtime), [400], "the nearer place is skipped across the water, the farther one walked");
  assert.match(told.detail, /the nearest oak_log you know of is across the water, 300 blocks east, around 300 8/u);
});

test("the words of a place across the water give the nearest block, its distance, its direction and the options", () => {
  // The first live walk's target from where it stopped (action_executions 50ec0380, end 582.8 760.8).
  const words = acrossWaterWords("spruce_log", "oak_boat", { x: 583, z: 761 }, { x: -696, z: 216 }, "none near");
  assert.ok(words.includes("1390 blocks north-west, around -696 216"), words);
  assert.ok(words.startsWith("the nearest spruce_log you know of is across the water, "), words);
  assert.ok(words.endsWith("Or use another material, or say so (none near)"), words);
});
