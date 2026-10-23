import assert from "node:assert/strict";
import minecraftData from "minecraft-data";
import test from "node:test";
import { parseTendCropsRequest } from "./contract.js";
import { block, PLOT_FACTS, cutAfter, cutBefore, FakeFarm } from "../../test-support/fake-farm.js";
import { DEFAULT_MINECRAFT_VERSION } from "../../server/config.js";
import blockTags from "../../world/data/block-tags/1.21.4.json" with { type: "json" };
import { isGroundCover } from "./farm-body.js";
import { beginTendPlot, decideCell, tendPlot } from "./tend-plot.js";

const registry = minecraftData(DEFAULT_MINECRAFT_VERSION);

test("each cell is decided from its soil and what stands on it", () => {
  const air = block("air");
  assert.equal(decideCell(block("farmland"), block("wheat", { age: 7 }), PLOT_FACTS), "harvest");
  assert.deepEqual(decideCell(block("farmland"), block("wheat", { age: 3 }), PLOT_FACTS), { skip: "growing" });
  assert.equal(decideCell(block("grass_block"), block("short_grass"), PLOT_FACTS), "clear");
  assert.equal(decideCell(block("grass_block"), block("poppy"), PLOT_FACTS), "clear");
  assert.equal(decideCell(block("dirt"), air, PLOT_FACTS), "till");
  assert.equal(decideCell(block("farmland"), air, PLOT_FACTS), "plant");
  assert.deepEqual(decideCell(block("water", {}, { liquid: true, empty: true }), air, PLOT_FACTS), { skip: "water" });
  assert.deepEqual(decideCell(block("dirt"), block("chest"), PLOT_FACTS), { skip: "occupied by chest" });
  assert.deepEqual(decideCell(block("dirt"), block("water", {}, { liquid: true, empty: true }), PLOT_FACTS), { skip: "under water" });
  assert.deepEqual(decideCell(null, air, PLOT_FACTS), { skip: "unloaded" });
});

test("corners in any order make the same plot; more than 16 a side is refused", () => {
  assert.deepEqual(parseTendCropsRequest({ x1: 4, z1: -2, x2: 0, z2: 2, y: 63 }), {
    min: { x: 0, z: -2 }, max: { x: 4, z: 2 }, y: 63, plant: null, harvest: true, till: true,
  });
  assert.throws(() => parseTendCropsRequest({ x1: 0, z1: 0, x2: 16, z2: 0, y: 63 }), /TEND_TOO_LARGE.*17 x 1/u);
});


const plot = (input: Record<string, unknown>) => parseTendCropsRequest({ x1: 0, z1: 0, x2: 1, z2: 0, y: 63, ...input });


const tagged = (tag: string): string[] => [...(blockTags.tags[tag] ?? [])];

test("a torch, a sapling and sugar cane on the soil are left and reported occupied", async () => {
  for (const placed of ["torch", "oak_sapling", "sugar_cane"]) assert.deepEqual(decideCell(block("dirt"), block(placed), PLOT_FACTS), { skip: `occupied by ${placed}` });
  const farm = new FakeFarm();
  farm.set(0, 0, "grass_block", "torch");
  farm.set(1, 0, "dirt", "oak_sapling");
  farm.set(2, 0, "dirt", "short_grass");
  const { evidence } = await tendPlot(plot({ x2: 2 }), farm, PLOT_FACTS);
  assert.deepEqual(farm.calls.filter((call) => call.startsWith("break")), ["break short_grass 2,0"]);
  assert.deepEqual(evidence.skipped, { "occupied by torch": [{ x: 0, z: 0 }], "occupied by oak_sapling": [{ x: 1, z: 0 }] });
  assert.equal(farm.read(0, 64, 0)?.name, "torch");
  assert.equal(farm.read(1, 64, 0)?.name, "oak_sapling");
});

test("every block the game calls ground cover is cleared, tall flowers included", () => {
  const liquids = new Set(["water", "lava", "bubble_column"]);
  const cover = [...new Set([...tagged("replaceable"), ...tagged("flowers")])]
    .filter((name) => !tagged("saplings").includes(name) && !liquids.has(name))
    .filter((name) => registry.blocksByName[name]?.boundingBox === "empty" && registry.blocksByName[name]?.diggable === true);
  assert.ok(cover.includes("short_grass") && cover.includes("rose_bush") && cover.includes("tall_grass") && cover.includes("snow"));
  for (const name of cover) assert.equal(decideCell(block("dirt"), block(name), PLOT_FACTS), "clear", name);
});

test("a sapling that is also in the flowers tag is not cleared", () => {
  const both = tagged("flowers").filter((name) => tagged("saplings").includes(name));
  assert.ok(both.includes("mangrove_propagule"));
  for (const name of both) assert.deepEqual(decideCell(block("dirt"), block(name), PLOT_FACTS), { skip: `occupied by ${name}` }, name);
});

test("a block with no shipped tag is never cleared, and a version with no shipped tags clears nothing", () => {
  const modded = { name: "somemod_glow_flower", properties: {}, liquid: false, empty: true, breakable: true };
  assert.deepEqual(decideCell(block("dirt"), modded, PLOT_FACTS), { skip: "occupied by somemod_glow_flower" });
  assert.equal(isGroundCover("short_grass", "1.21.4"), true);
  assert.equal(isGroundCover("short_grass", "1.20.1"), false);
});

test("soil is tilled when its block state has moisture", () => {
  assert.equal(decideCell(block("farmland"), block("air"), PLOT_FACTS), "plant");
  // A modded soil is tilled by its state, not by its name.
  assert.equal(decideCell(block("somemod_soil", { moisture: 3 }), block("air"), PLOT_FACTS), "plant");
  for (const soil of ["dirt", "grass_block", "dirt_path", "coarse_dirt"]) assert.equal(decideCell(block(soil), block("air"), PLOT_FACTS), "till", soil);
});


test("ripe crops are harvested first, their drops picked up, then the cells replanted with the crop's own seed", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland", "wheat", 7);
  farm.set(1, 0, "farmland", "wheat", 7);
  const { evidence, stop } = await tendPlot(plot({}), farm, PLOT_FACTS);
  assert.equal(stop, null);
  assert.deepEqual(farm.calls, ["break wheat 0,0", "break wheat 1,0", "collect drops", "plant wheat_seeds 0,0", "plant wheat_seeds 1,0"]);
  assert.equal(evidence.harvested, 2);
  assert.equal(evidence.planted, 2);
  assert.deepEqual(evidence.after.crops, { "wheat age 0": 2 });
  assert.deepEqual(evidence.skipped, {});
});

test("bare soil is cleared, tilled and planted with the item asked for", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "grass_block", "short_grass");
  farm.set(1, 0, "dirt");
  farm.inventory.set("carrot", 5);
  const { evidence } = await tendPlot(plot({ plant: "carrot" }), farm, PLOT_FACTS);
  assert.deepEqual(farm.calls, ["break short_grass 0,0", "collect drops", "till 0,0", "plant carrot 0,0", "till 1,0", "plant carrot 1,0"]);
  assert.deepEqual([evidence.cleared, evidence.tilled, evidence.planted], [1, 2, 2]);
  // The soil each till worked on, so the brain learns which blocks a hoe really turns (SF2).
  assert.deepEqual(evidence.tilledSoil, { grass_block: 1, dirt: 1 });
  assert.deepEqual(evidence.after.crops, { "carrots age 0": 2 });
});

test("a mixed plot farms what it can and says why it left the rest", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "stone");
  farm.set(1, 0, "water");
  farm.set(2, 0, "dirt", "chest");
  farm.set(3, 0, "farmland", "wheat", 4);
  farm.set(4, 0, "dirt");
  farm.set(5, 0, "dirt");
  farm.unreachable.add("5,0");
  farm.inventory.set("wheat_seeds", 9);
  const { evidence, stop } = await tendPlot(plot({ x2: 5, plant: "wheat_seeds" }), farm, PLOT_FACTS);
  assert.equal(stop, null);
  assert.deepEqual(evidence.skipped, {
    "not tillable (stone)": [{ x: 0, z: 0 }],
    water: [{ x: 1, z: 0 }],
    "occupied by chest": [{ x: 2, z: 0 }],
    growing: [{ x: 3, z: 0 }],
    "unreachable: no route": [{ x: 5, z: 0 }],
  });
  assert.deepEqual([evidence.tilled, evidence.planted], [1, 1]);
  // Only the stone, which a hoe was used on and did not change, is untillable; the unreachable cell is not.
  assert.deepEqual(evidence.untillable, { stone: [{ x: 0, z: 0 }] });
  assert.deepEqual(evidence.after, { crops: { "wheat age 4": 1, "wheat age 0": 1 }, emptyFarmland: 0, dryFarmland: 0, water: 1 });
});

test("running out of seeds leaves the last farmland empty, said as such", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland");
  farm.set(1, 0, "farmland");
  farm.inventory.set("wheat_seeds", 1);
  const { evidence } = await tendPlot(plot({ plant: "wheat_seeds" }), farm, PLOT_FACTS);
  assert.equal(evidence.planted, 1);
  assert.deepEqual(evidence.skipped, { "no wheat_seeds left": [{ x: 1, z: 0 }] });
  assert.equal(evidence.after.emptyFarmland, 1);
});

test("with no hoe the plot is harvested and replanted, the cells needing tilling skipped as no hoe, and a hoe later tills them (G2)", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "dirt");
  farm.set(1, 0, "farmland", "wheat", 7);
  farm.hoe = false;
  farm.inventory.set("wheat_seeds", 4);
  const first = await tendPlot(plot({ plant: "wheat_seeds" }), farm, PLOT_FACTS);
  assert.equal(first.refused, null);
  assert.equal(first.evidence.harvested, 1);
  assert.equal(first.evidence.planted, 1);
  assert.deepEqual(first.evidence.skipped, { "no hoe": [{ x: 0, z: 0 }] });
  assert.deepEqual(farm.calls.filter((call) => call.startsWith("till")), []);
  // Next farm call with a hoe tills the skipped cell.
  farm.hoe = true;
  const second = await tendPlot(plot({ plant: "wheat_seeds" }), farm, PLOT_FACTS);
  assert.equal(second.evidence.tilled, 1);
  assert.deepEqual(farm.calls.filter((call) => call.startsWith("till")), ["till 0,0"]);
});

test("with the plant item not carried the harvest still goes on and the plantable cells say so (G2)", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland", "wheat", 7);
  farm.set(1, 0, "farmland");
  const { evidence, refused } = await tendPlot(plot({ plant: "carrot" }), farm, PLOT_FACTS);
  assert.equal(refused, null);
  assert.equal(evidence.harvested, 1);
  assert.deepEqual(evidence.skipped, { "no carrot left": [{ x: 1, z: 0 }] });
  // Without tilling asked, soil is left as it is and nothing needs a hoe.
  farm.hoe = false;
  const none = await tendPlot(plot({ till: false }), farm, PLOT_FACTS);
  assert.equal(none.refused, null);
});

test("progress is reported at each phase and each cell farmed", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland", "wheat", 7);
  farm.set(1, 0, "dirt");
  const seen: string[] = [];
  await tendPlot(plot({}), farm, PLOT_FACTS, () => null, (progress) => seen.push(`${progress.phase} h${progress.harvested} t${progress.tilled} p${progress.planted}`));
  assert.deepEqual(seen, [
    "clearing h0 t0 p0", "clearing h1 t0 p0", "collecting drops h1 t0 p0", "planting h1 t0 p0",
    "planting h1 t0 p1", "planting h1 t1 p1",
  ]);
});

test("an item that does not take is not tried again, and a harvested cell falls back to its crop's own seed", async () => {
  // Live 2026-10-03: asked to farm "wheat" (the harvest, not the seed), all 13 harvested cells stayed empty.
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland", "wheat", 7);
  farm.set(1, 0, "farmland", "wheat", 7);
  farm.set(2, 0, "farmland");
  farm.inventory.set("wheat", 5);
  const { evidence } = await tendPlot(plot({ x2: 2, plant: "wheat" }), farm, PLOT_FACTS);
  assert.deepEqual(farm.calls.filter((call) => call.startsWith("plant")), ["plant wheat 0,0", "plant wheat_seeds 0,0", "plant wheat_seeds 1,0"]);
  assert.equal(evidence.planted, 2);
  assert.deepEqual(evidence.skipped, { "wheat cannot be planted": [{ x: 2, z: 0 }] });
});

test("drops it could not pick up are reported by name, so a harvest short of its wheat says why", async () => {
  // Live 2026-10-03: 14 ripe wheat harvested, 2 wheat gained, and nothing said what stayed on the ground.
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland", "wheat", 7);
  farm.collectDrops = async () => {
    farm.calls.push("collect drops");
    farm.inventory.set("wheat_seeds", 2);
    return { left: ["wheat", "wheat_seeds"] };
  };
  const { evidence } = await tendPlot(plot({ x2: 0 }), farm, PLOT_FACTS);
  assert.deepEqual(evidence.dropsLeft, ["wheat", "wheat_seeds"]);
});

test("a stop asked between cells ends the run with what was done so far", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland", "wheat", 7);
  farm.set(1, 0, "farmland", "wheat", 7);
  let calls = 0;
  const { evidence, stop } = await tendPlot(plot({}), farm, PLOT_FACTS, () => (++calls > 1 ? "[TEND_STALLED] stalled" : null));
  assert.equal(stop, "[TEND_STALLED] stalled");
  assert.equal(evidence.harvested, 1);
});

test("a hoe that breaks mid-plot stops the tilling under its own reason, and no soil is untillable (V1)", async () => {
  const farm = new FakeFarm();
  for (const x of [0, 1, 2, 3]) farm.set(x, 0, "dirt");
  farm.hoeLasts = 1;
  farm.inventory.set("wheat_seeds", 9);
  const { evidence, stop, refused } = await tendPlot(plot({ x2: 3, plant: "wheat_seeds" }), farm, PLOT_FACTS);
  assert.deepEqual([stop, refused], [null, null]);
  assert.equal(evidence.tilled, 1);
  assert.deepEqual(farm.calls.filter((call) => call.startsWith("till")), ["till 0,0"]);
  assert.deepEqual(evidence.skipped, { "no hoe left": [{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }] });
  assert.deepEqual(evidence.untillable, {});
});

test("a use that fails or times out is its own reason, never untillable (V4)", async () => {
  const farm = new FakeFarm();
  for (const x of [0, 1, 2]) farm.set(x, 0, "dirt");
  farm.useFails = "The use of stone_hoe was not confirmed within 40 ticks";
  const { evidence } = await tendPlot(plot({ x2: 2 }), farm, PLOT_FACTS);
  assert.deepEqual(evidence.untillable, {});
  assert.deepEqual(Object.keys(evidence.skipped), ["till failed: The use of stone_hoe was not confirmed within 40 ticks"]);
  assert.equal(Object.values(evidence.skipped)[0]!.length, 3);
});

test("a block the hoe was used on and did not change is untillable, by name, with its cells (V4)", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "podzol");
  farm.set(1, 0, "podzol");
  const { evidence } = await tendPlot(plot({}), farm, PLOT_FACTS);
  assert.deepEqual(evidence.untillable, { podzol: [{ x: 0, z: 0 }, { x: 1, z: 0 }] });
});

test("a use the server was not seen to answer teaches nothing, beside one it did answer, in one call (server behind)", async () => {
  const farm = new FakeFarm();
  for (const x of [0, 1, 2]) farm.set(x, 0, "dirt");
  farm.set(3, 0, "podzol");
  farm.unconfirmed = new Set(["0,0", "1,0", "2,0"]);
  const { evidence } = await tendPlot(plot({ x2: 3 }), farm, PLOT_FACTS);
  assert.deepEqual(evidence.untillable, { podzol: [{ x: 3, z: 0 }] });
  assert.equal(evidence.skipped["till not confirmed (server behind)"]?.length, 3);
});

// Reflex continuity (spec 2026-10-18, R2): a reflex that takes the body mid-tend hands it back; the next attempt
// re-reads the plot and does only what is left, and the evidence covers the whole request.
const never = () => null;

test("a tend cut while fetching the drops goes on from there: no crop broken twice, the harvested seed replants", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland", "wheat", 7);
  farm.set(1, 0, "farmland", "wheat", 7);
  cutBefore(farm, "collectDrops");
  const run = beginTendPlot(plot({}), farm, PLOT_FACTS);
  await assert.rejects(run.attempt(farm, never), /HUNGER/);
  const { evidence, stop } = await run.attempt(farm, never);
  assert.equal(stop, null);
  assert.deepEqual(farm.calls.filter((call) => call.startsWith("break")), ["break wheat 0,0", "break wheat 1,0"]);
  assert.deepEqual([evidence.harvested, evidence.planted], [2, 2]);
  assert.deepEqual(evidence.gained, { wheat: 2, wheat_seeds: 2 }, "the drops of the first attempt are collected by the second");
  assert.deepEqual(evidence.after.crops, { "wheat age 0": 2 });
});

test("a crop broken just before the reflex's abort threw is counted as harvested and its seed is the one replanted", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland", "wheat", 7);
  farm.set(1, 0, "farmland", "wheat", 7);
  cutAfter(farm, "breakBlock", 1);
  const run = beginTendPlot(plot({}), farm, PLOT_FACTS);
  await assert.rejects(run.attempt(farm, never), /HUNGER/);
  const { evidence } = await run.attempt(farm, never);
  assert.deepEqual(farm.calls.filter((call) => call.startsWith("break")), ["break wheat 0,0", "break wheat 1,0"]);
  assert.deepEqual([evidence.harvested, evidence.planted], [2, 2]);
  assert.deepEqual(farm.calls.filter((call) => call.startsWith("plant")), ["plant wheat_seeds 0,0", "plant wheat_seeds 1,0"]);
});

test("a seed planted just before the abort threw is counted once and the cell is not planted again", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland");
  farm.set(1, 0, "farmland");
  farm.inventory.set("wheat_seeds", 5);
  cutAfter(farm, "plant", 1);
  const run = beginTendPlot(plot({ plant: "wheat_seeds" }), farm, PLOT_FACTS);
  await assert.rejects(run.attempt(farm, never), /HUNGER/);
  const { evidence } = await run.attempt(farm, never);
  assert.deepEqual(farm.calls.filter((call) => call.startsWith("plant")), ["plant wheat_seeds 0,0", "plant wheat_seeds 1,0"]);
  assert.equal(evidence.planted, 2);
  assert.deepEqual(evidence.gained, { wheat_seeds: -2 });
});

test("soil tilled just before the abort threw is counted once, by its block, and is not tilled again", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "dirt");
  farm.set(1, 0, "grass_block");
  farm.inventory.set("wheat_seeds", 5);
  cutAfter(farm, "till", 1);
  const run = beginTendPlot(plot({ plant: "wheat_seeds" }), farm, PLOT_FACTS);
  await assert.rejects(run.attempt(farm, never), /HUNGER/);
  const { evidence } = await run.attempt(farm, never);
  assert.deepEqual(farm.calls.filter((call) => call.startsWith("till")), ["till 0,0", "till 1,0"]);
  assert.deepEqual([evidence.tilled, evidence.planted], [2, 2]);
  assert.deepEqual(evidence.tilledSoil, { dirt: 1, grass_block: 1 });
});

test("a crop another bot harvested between the attempts is not counted as ours, and its cell is replanted", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland", "wheat", 7);
  farm.set(1, 0, "farmland", "wheat", 7);
  farm.inventory.set("wheat_seeds", 5);
  cutAfter(farm, "breakBlock", 1);
  const run = beginTendPlot(plot({ plant: "wheat_seeds" }), farm, PLOT_FACTS);
  await assert.rejects(run.attempt(farm, never), /HUNGER/);
  farm.set(1, 0, "farmland");
  const { evidence } = await run.attempt(farm, never);
  assert.equal(evidence.harvested, 1);
  assert.equal(evidence.planted, 2);
});

test("cells skipped in a cut attempt are reported once by the attempt that finishes", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "podzol");
  farm.set(1, 0, "farmland", "wheat", 7);
  cutBefore(farm, "collectDrops");
  const run = beginTendPlot(plot({}), farm, PLOT_FACTS);
  await assert.rejects(run.attempt(farm, never));
  const { evidence } = await run.attempt(farm, never);
  assert.deepEqual(evidence.skipped, { "not tillable (podzol)": [{ x: 0, z: 0 }] });
  assert.deepEqual(evidence.untillable, { podzol: [{ x: 0, z: 0 }] });
});

test("a tend that already finished answers a second attempt with the same evidence and acts on nothing", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland", "wheat", 7);
  farm.set(1, 0, "farmland");
  farm.inventory.set("wheat_seeds", 3);
  const run = beginTendPlot(plot({ plant: "wheat_seeds" }), farm, PLOT_FACTS);
  const first = await run.attempt(farm, never);
  const callsAfterFirst = farm.calls.length;
  const again = await run.attempt(farm, never);
  assert.equal(farm.calls.length, callsAfterFirst, "no gesture on the second attempt");
  assert.deepEqual({ ...again.evidence, skipped: {} }, { ...first.evidence, skipped: {} }, "the whole request totals, not zero");
  assert.deepEqual(Object.keys(again.evidence.skipped), ["growing"], "the crops it planted are growing, which a farm should be");
});

test("the hoe broken before the request began stays 'no hoe', not 'no hoe left', across the attempts", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "dirt");
  farm.set(1, 0, "farmland", "wheat", 7);
  farm.hoe = false;
  cutBefore(farm, "collectDrops");
  const run = beginTendPlot(plot({}), farm, PLOT_FACTS);
  await assert.rejects(run.attempt(farm, never));
  const { evidence } = await run.attempt(farm, never);
  assert.deepEqual(evidence.skipped, { "no hoe": [{ x: 0, z: 0 }] });
});
