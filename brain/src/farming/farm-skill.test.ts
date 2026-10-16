import assert from "node:assert/strict";
import test from "node:test";
import { stepSchema } from "../actions.ts";
import { Body } from "../body.ts";
import type { KnownFarm } from "../memory.ts";
import { runStep, type SkillContext } from "../skills.ts";
import { FakeRuntime } from "../testing.ts";

function contextFor(runtime: FakeRuntime, extra: Partial<SkillContext> = {}): SkillContext {
  return { runtime, body: new Body(runtime, () => undefined), signal: new AbortController().signal, self: "Ayla", ...extra };
}

/** A runtime standing on flat ground (dirt up to y 63, feet at 64) carrying what a farm needs. */
function farmRuntime(inventory: { name: string; count: number }[]): FakeRuntime {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  // What view_block_drops answers for the crops used here: the planted block and the item it is planted from.
  runtime.dropSources = {
    wheat_seeds: [{ block: "wheat", chance: 0.5, planted: true, seed: "wheat_seeds" }],
    wheat: [{ block: "wheat", chance: 1, planted: true, seed: "wheat_seeds" }],
    carrot: [{ block: "carrots", chance: 1, planted: true, seed: "carrot" }],
  };
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory };
  return runtime;
}

/** Foreground actions only (protecting an area is not one). */
const calls = (runtime: FakeRuntime) => runtime.submitted.filter((call) => !["send_message", "protect_region", "unprotect_region"].includes(call.tool)).map((call) => call.tool === "use_bucket" ? `use_bucket ${String(call.input.action)}` : call.tool);

test("a farm step plants the item asked for, nine by nine unless told; coordinates come all together", () => {
  assert.deepEqual(stepSchema.parse({ skill: "farm", crop: "wheat_seeds" }), { skill: "farm", crop: "wheat_seeds", size: 9 });
  assert.equal(stepSchema.safeParse({ skill: "farm", crop: "wheat_seeds", size: 4 }).success, false);
  assert.equal(stepSchema.safeParse({ skill: "farm", crop: "wheat_seeds", x: 3 }).success, false);
});

test("a new farm needs a hoe, the crop and a bucket: what is missing is named as the get_items step to take", async () => {
  const runtime = farmRuntime([{ name: "wheat_seeds", count: 5 }]);
  const result = await runStep({ skill: "farm", crop: "wheat_seeds", size: 9 }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /needs 1 wooden_hoe, 1 bucket .*get_items/u);
  assert.deepEqual(calls(runtime), []);
});

test("a new farm is protected, leveled, watered from a filled bucket, tilled and planted, then remembered", async () => {
  const runtime = farmRuntime([{ name: "stone_hoe", count: 1 }, { name: "wheat_seeds", count: 20 }, { name: "bucket", count: 1 }]);
  const remembered: KnownFarm[] = [];
  const facts: string[] = [];
  const result = await runStep({ skill: "farm", crop: "wheat_seeds", size: 5 }, contextFor(runtime, {
    rememberFarm: (farm) => remembered.push(farm),
    progress: (fact) => facts.push(fact),
  }));
  assert.equal(result.status, "done", JSON.stringify(result));
  // Behind her (nobody asked: south), soil at y 63, the middle cell at 0 63 4.
  assert.deepEqual(runtime.areas.map((area) => [area.label, area.min, area.max]), [["farm wheat_seeds", { x: -3, y: 62, z: 1 }, { x: 3, y: 65, z: 7 }]]);
  // The ground is already flat (leveling sets its zone aside and finds nothing to do), then the water hole.
  assert.ok(runtime.submitted.some((call) => call.tool === "protect_region" && String(call.input.label).startsWith("leveling ")));
  assert.deepEqual(calls(runtime), ["build_structure", "use_bucket fill", "use_bucket pour", "tend_crops"]);
  // The hole is dug as an air cell of build_structure, which works inside her own farm region (live 2026-10-03:
  // collect_block refused it there).
  assert.deepEqual(runtime.submitted.find((call) => call.tool === "build_structure")!.input.blocks, [{ x: 0, y: 63, z: 4, block_name: "air" }]);
  const tend = runtime.submitted.find((call) => call.tool === "tend_crops")!.input;
  assert.deepEqual(tend, { x1: -2, z1: 2, x2: 2, z2: 6, y: 63, plant: "wheat_seeds" });
  const pour = runtime.submitted.find((call) => call.tool === "use_bucket" && call.input.action === "pour")!.input;
  assert.deepEqual([pour.x, pour.y, pour.z], [0, 63, 4]);
  assert.equal(remembered.length, 1);
  assert.deepEqual([remembered[0]!.crop, remembered[0]!.size, remembered[0]!.centre], ["wheat_seeds", 5, { x: 0, y: 63, z: 4 }]);
  assert.match(result.status === "done" ? result.detail : "", /made a 5x5 wheat_seeds farm around 0 63 4/u);
  assert.ok(facts.some((fact) => /fetching water/u.test(fact)), facts.join(" | "));
});

test("with a water bucket already carried, or water already in the middle, there is no trip to fill a bucket", async () => {
  const carrying = farmRuntime([{ name: "wooden_hoe", count: 1 }, { name: "wheat_seeds", count: 20 }, { name: "water_bucket", count: 1 }]);
  assert.equal((await runStep({ skill: "farm", crop: "wheat_seeds", size: 5 }, contextFor(carrying))).status, "done");
  assert.deepEqual(calls(carrying), ["build_structure", "use_bucket pour", "tend_crops"]);

  const watered = farmRuntime([{ name: "wooden_hoe", count: 1 }, { name: "wheat_seeds", count: 20 }]);
  watered.world.set("0,63,4", "water");
  const result = await runStep({ skill: "farm", crop: "wheat_seeds", size: 5 }, contextFor(watered));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(calls(watered), ["tend_crops"]);
});

test("a farm's ground is filled with dirt, never cobblestone: soil must be tillable", async () => {
  // Live 2026-10-03: carrying more cobblestone than dirt, the leveling filled 10 hollows of the plot with it and
  // tend_crops skipped them "not tillable (cobblestone)".
  const runtime = farmRuntime([{ name: "wooden_hoe", count: 1 }, { name: "wheat_seeds", count: 20 }, { name: "water_bucket", count: 1 }, { name: "cobblestone", count: 64 }, { name: "dirt", count: 30 }]);
  runtime.groundTop = 62;
  runtime.world.set("0,63,4", "dirt");
  const result = await runStep({ skill: "farm", crop: "wheat_seeds", size: 5 }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  const fills = runtime.submitted
    .filter((call) => call.tool === "build_structure")
    .flatMap((call) => (call.input.blocks as { block_name: string }[]).map((cell) => cell.block_name))
    .filter((block) => block !== "air");
  assert.ok(fills.length > 0, "the hollow plot was filled");
  assert.deepEqual([...new Set(fills)], ["dirt"]);
});

test("a new farm that cannot be finished releases its protection, so trying again elsewhere is not refused", async () => {
  // Live 2026-10-03: a worn-out shovel stopped the leveling; the plot stayed protected, and every new try from a
  // step aside overlapped it ("overlaps protected area #20 'farm wheat_seeds'").
  const runtime = farmRuntime([{ name: "wooden_hoe", count: 1 }, { name: "wheat_seeds", count: 20 }, { name: "water_bucket", count: 1 }]);
  runtime.failures.use_bucket = "[BUCKET_FAILED] The water did not land.";
  const result = await runStep({ skill: "farm", crop: "wheat_seeds", size: 5 }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.ok(!runtime.areas.some((area) => area.label === "farm wheat_seeds"), JSON.stringify(runtime.areas));
});

test("farming near a farm she knows tends it: ripe crops harvested and replanted, nothing leveled or poured", async () => {
  const runtime = farmRuntime([{ name: "wooden_hoe", count: 1 }]);
  const farms: KnownFarm[] = [{ crop: "wheat_seeds", size: 9, centre: { x: 4, y: 63, z: 6 }, madeAt: "t0", tendedAt: "t0", state: { planted: 80, ripe: 0, empty: 0 } }];
  const remembered: KnownFarm[] = [];
  const result = await runStep({ skill: "farm", crop: "wheat_seeds", size: 9 }, contextFor(runtime, { farms, rememberFarm: (farm) => remembered.push(farm) }));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(calls(runtime), ["tend_crops"]);
  // No seeds carried: the harvested cells are replanted with their own seed, nothing else is planted.
  assert.deepEqual(runtime.submitted[0]!.input, { x1: 0, z1: 2, x2: 8, z2: 10, y: 63 });
  assert.deepEqual([remembered[0]!.centre, remembered[0]!.madeAt], [{ x: 4, y: 63, z: 6 }, "t0"]);
  assert.match(result.status === "done" ? result.detail : "", /tended your wheat_seeds farm around 4 63 6/u);
});

test("farmland left empty for want of seeds says so, naming the get_items step", async () => {
  // Live 2026-10-03: 4 of 24 cells stayed empty (20 seeds), the result only said "4 farmland empty", and the model
  // tended the farm three more times until the repeat guard failed the order.
  const runtime = farmRuntime([{ name: "wooden_hoe", count: 1 }]);
  runtime.tendAfter = { crops: { "wheat age 0": 20 }, emptyFarmland: 4, dryFarmland: 0, water: 1 };
  const farms: KnownFarm[] = [{ crop: "wheat_seeds", size: 5, centre: { x: 4, y: 63, z: 6 }, madeAt: "t0", tendedAt: "t0", state: { planted: 20, ripe: 0, empty: 4 } }];
  const result = await runStep({ skill: "farm", crop: "wheat_seeds", size: 5 }, contextFor(runtime, { farms }));
  assert.equal(result.status, "done");
  assert.match(result.status === "done" ? result.detail : "", /4 farmland empty because you carry no wheat_seeds: get_items wheat_seeds 4, then farm again to plant them/u);
});

test("cells a tend left as they were are counted by reason, not left as a list she never sees", async () => {
  // Live 2026-10-03: told "11 cells could not be farmed; see skipped", she guessed she needed a hoe, fetched one,
  // dropped the two she carried and fetched them again.
  const runtime = farmRuntime([{ name: "stone_hoe", count: 2 }, { name: "wheat_seeds", count: 20 }]);
  runtime.tendSkipped = { "not tillable (cobblestone)": [{ x: 1, z: 1 }, { x: 2, z: 1 }], "unreachable: no path": [{ x: 3, z: 3 }] };
  const farms: KnownFarm[] = [{ crop: "wheat_seeds", size: 5, centre: { x: 4, y: 63, z: 6 }, madeAt: "t0", tendedAt: "t0", state: { planted: 20, ripe: 0, empty: 0 } }];
  const result = await runStep({ skill: "farm", crop: "wheat_seeds", size: 5 }, contextFor(runtime, { farms }));
  assert.equal(result.status, "done");
  const detail = result.status === "done" ? result.detail : "";
  assert.match(detail, /partly: .*; 3 cells left as they were: 2 not tillable \(cobblestone\), 1 unreachable: no path$/u);
  assert.doesNotMatch(detail, /see skipped/u);
  // Live 2026-10-03, minutes later: the same tend settled failed (no cell changed) and said "see skipped" again.
  runtime.tendSkippedStatus = "failed";
  const failed = await runStep({ skill: "farm", crop: "wheat_seeds", size: 5 }, contextFor(runtime, { farms }));
  assert.match(failed.status === "failed" ? failed.detail : "", /stopped: .*; 3 cells left as they were: 2 not tillable \(cobblestone\), 1 unreachable: no path$/u);
});

test("a plot whose ground is air says it is in a cave or over a pit, and to farm under the open sky", async () => {
  // Live 2026-10-09: Ayla, in a cave at y 10, farmed there 20 times, each "25 not tillable (air)".
  const runtime = farmRuntime([{ name: "stone_hoe", count: 1 }, { name: "wheat_seeds", count: 20 }, { name: "water_bucket", count: 1 }]);
  runtime.groundTop = 9;
  runtime.tendSkipped = { "not tillable (air)": Array.from({ length: 25 }, (_, index) => ({ x: index % 5, z: Math.floor(index / 5) })) };
  runtime.tendSkippedStatus = "failed";
  const result = await runStep({ skill: "farm", crop: "wheat_seeds", size: 5, x: 4, y: 10, z: 6 }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /25 not tillable \(air\); there is no ground at y \d+ here \(a cave or a pit\): farm on grass or dirt under the open sky/u);
});

test("a farm she knows, asked for another crop: the crop asked is planted on empty farmland when carried", async () => {
  const runtime = farmRuntime([{ name: "wooden_hoe", count: 1 }, { name: "carrot", count: 6 }]);
  const farms: KnownFarm[] = [{ crop: "wheat_seeds", size: 9, centre: { x: 4, y: 63, z: 6 }, madeAt: "t0", tendedAt: "t0", state: { planted: 70, ripe: 0, empty: 10 } }];
  await runStep({ skill: "farm", crop: "carrot", size: 9 }, contextFor(runtime, { farms }));
  assert.equal(runtime.submitted[0]!.input.plant, "carrot");
});

test("a new farm whose plot overlaps a protected area names the nearest clear plot and protects nothing (live 2026-10-10: her own house undone)", async () => {
  const runtime = farmRuntime([{ name: "stone_hoe", count: 1 }, { name: "wheat_seeds", count: 20 }, { name: "bucket", count: 1 }]);
  runtime.areas = [{ regionId: 4, owner: "self", label: "small medieval house", min: { x: -3, y: 60, z: -3 }, max: { x: 3, y: 75, z: 3 } }];
  const result = await runStep({ skill: "farm", crop: "wheat_seeds", size: 9 }, contextFor(runtime, { self: "self" }));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /overlaps protected area #4 'small medieval house' \(yours.*the nearest plot clear of them has its middle \d+ blocks .*, at -?\d+ 64 -?\d+: farm there/u);
  assert.equal(runtime.submitted.filter((call) => call.tool === "protect_region").length, 0);
  assert.deepEqual(calls(runtime), []);
});

test("a farm asked for the harvest plants its seed: wheat is fetched as wheat_seeds and says so", async () => {
  const runtime = farmRuntime([{ name: "wooden_hoe", count: 1 }, { name: "bucket", count: 1 }]);
  const missing = await runStep({ skill: "farm", crop: "wheat", size: 5 }, contextFor(runtime));
  assert.match(missing.status === "failed" ? missing.detail : "", /a 5x5 wheat_seeds farm needs 16 wheat_seeds .*get_items/u);
  assert.deepEqual(calls(runtime), []);

  const ready = farmRuntime([{ name: "stone_hoe", count: 1 }, { name: "wheat_seeds", count: 20 }, { name: "water_bucket", count: 1 }]);
  const remembered: KnownFarm[] = [];
  const result = await runStep({ skill: "farm", crop: "wheat", size: 5 }, contextFor(ready, { rememberFarm: (farm) => remembered.push(farm) }));
  assert.equal(ready.submitted.find((call) => call.tool === "tend_crops")!.input.plant, "wheat_seeds");
  assert.equal(remembered[0]!.crop, "wheat_seeds");
  assert.match(result.status === "done" ? result.detail : "", /wheat is the harvest: planted wheat_seeds/u);
});

test("a crop that is its own seed is planted as it is, with no note", async () => {
  const runtime = farmRuntime([{ name: "stone_hoe", count: 1 }, { name: "carrot", count: 20 }, { name: "water_bucket", count: 1 }]);
  const result = await runStep({ skill: "farm", crop: "carrot", size: 5 }, contextFor(runtime));
  assert.equal(runtime.submitted.find((call) => call.tool === "tend_crops")!.input.plant, "carrot");
  assert.doesNotMatch(result.status === "done" ? result.detail : "", /harvest/u);
});

test("an item no crop grows from is no farm: the failure says so and nothing is protected", async () => {
  const runtime = farmRuntime([{ name: "stone_hoe", count: 1 }, { name: "oak_log", count: 20 }, { name: "bucket", count: 1 }]);
  const result = await runStep({ skill: "farm", crop: "oak_log", size: 5 }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /oak_log grows on no crop: a farm is planted with what a crop drops whatever its age \(its seed\)/u);
  assert.deepEqual(runtime.submitted, []);
});

test("tending a known wheat farm asked for wheat plants wheat_seeds", async () => {
  const runtime = farmRuntime([{ name: "wheat_seeds", count: 6 }]);
  const farms: KnownFarm[] = [{ crop: "wheat_seeds", size: 5, centre: { x: 4, y: 63, z: 6 }, madeAt: "t0", tendedAt: "t0", state: { planted: 20, ripe: 0, empty: 4 } }];
  const result = await runStep({ skill: "farm", crop: "wheat", size: 5 }, contextFor(runtime, { farms }));
  assert.equal(runtime.submitted[0]!.input.plant, "wheat_seeds");
  assert.match(result.status === "done" ? result.detail : "", /wheat is the harvest: planted wheat_seeds/u);
});

test("a new farm is not made on stone: the plot behind her is stone, so the nearest grass patch is used instead", async () => {
  const runtime = farmRuntime([{ name: "wooden_hoe", count: 1 }, { name: "wheat_seeds", count: 20 }, { name: "water_bucket", count: 1 }]);
  // Soil level 63 is stone everywhere in reach, except a grass patch 6 blocks east of the plot behind her.
  for (let x = -20; x <= 20; x += 1) for (let z = -12; z <= 20; z += 1) runtime.world.set(`${x},63,${z}`, x >= 4 && x <= 14 && z >= -1 && z <= 9 ? "grass_block" : "stone");
  const result = await runStep({ skill: "farm", crop: "wheat_seeds", size: 5 }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  const tend = runtime.submitted.find((call) => call.tool === "tend_crops")!.input;
  assert.ok(Number(tend.x1) >= 4 && Number(tend.x2) <= 14, JSON.stringify(tend));
});

test("a new farm on stone with no tillable ground near is refused with the reason, nothing protected or tended", async () => {
  const runtime = farmRuntime([{ name: "wooden_hoe", count: 1 }, { name: "wheat_seeds", count: 20 }, { name: "water_bucket", count: 1 }]);
  for (let x = -20; x <= 20; x += 1) for (let z = -12; z <= 20; z += 1) runtime.world.set(`${x},63,${z}`, "stone");
  const result = await runStep({ skill: "farm", crop: "wheat_seeds", size: 5 }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /no ground to farm within .*25 stone.*open sky/u);
  assert.deepEqual(calls(runtime), []);
  assert.deepEqual(runtime.areas, []);
});

test("a new farm under a roof is refused: a cave floor of dirt is not open to the sky", async () => {
  const runtime = farmRuntime([{ name: "wooden_hoe", count: 1 }, { name: "wheat_seeds", count: 20 }, { name: "water_bucket", count: 1 }]);
  for (let x = -20; x <= 20; x += 1) for (let z = -12; z <= 20; z += 1) runtime.world.set(`${x},66,${z}`, "stone");
  const result = await runStep({ skill: "farm", crop: "wheat_seeds", size: 5 }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /roofed/u);
});

test("a remembered farm standing on stone is not tended again", async () => {
  const runtime = farmRuntime([{ name: "wooden_hoe", count: 1 }, { name: "wheat_seeds", count: 20 }, { name: "water_bucket", count: 1 }]);
  for (let x = -20; x <= 20; x += 1) for (let z = -12; z <= 20; z += 1) runtime.world.set(`${x},63,${z}`, "stone");
  const known: KnownFarm = { crop: "wheat_seeds", size: 5, centre: { x: 0, y: 63, z: 4 }, madeAt: "2026-10-14T00:00:00Z", tendedAt: "2026-10-14T00:00:00Z", state: { planted: 0, ripe: 0, empty: 0 } };
  const result = await runStep({ skill: "farm", crop: "wheat_seeds", size: 5 }, contextFor(runtime, { farms: [known] }));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /no ground to farm/u);
  assert.deepEqual(calls(runtime), []);
});
