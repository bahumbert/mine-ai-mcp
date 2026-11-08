import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import type { NavigationRuntime } from "../../navigation/index.js";
import { setProtectedRegionsProvider } from "../../world/protected-regions.js";
import { mineflayerFarmBody, plotFacts, tilledSoilNames, tillFailure } from "./farm-body.js";
import { Vec3 } from "vec3";
import { PLOT_FACTS, cutAfter, FakeFarm } from "../../test-support/fake-farm.js";
import type { StallClock } from "../stall-watch.js";
import { parseTendCropsRequest } from "./contract.js";
import { beginTendCrops, formatTendCropsResult, settleTend } from "./tend-crops.js";
import type { CellBlock } from "./tend-plot.js";
import { tendEvidenceSchema, type TendEvidence } from "./contract.js";

const { bot } = createFakeBot({ version: "1.21.4" });
const crop = (name: string, age: number): CellBlock => ({ name, properties: { age }, liquid: false, empty: true, breakable: true });

test("a crop is ripe in the state its loot table drops the crop in, and planted from its unripe drop", () => {
  const crops = plotFacts(bot);
  assert.equal(crops.isRipe(crop("wheat", 7)), true);
  assert.equal(crops.isRipe(crop("wheat", 6)), false);
  assert.equal(crops.isRipe(crop("beetroots", 3)), true);
  assert.equal(crops.isRipe(crop("carrots", 2)), false);
  // Nether wart drops the same at any age: ripe at its last age (3).
  assert.equal(crops.isRipe(crop("nether_wart", 3)), true);
  assert.equal(crops.isRipe(crop("nether_wart", 1)), false);
  assert.equal(crops.isRipe({ name: "short_grass", properties: {}, liquid: false, empty: true, breakable: true }), null);
  assert.equal(crops.seedOf("potatoes"), "potato");
  assert.equal(crops.seedOf("short_grass"), "wheat_seeds");
});

test("a crop's ripe age is the age its loot table drops it in, else its last age, null for a block that is no crop", () => {
  const crops = plotFacts(bot);
  assert.equal(crops.ripeAge("wheat"), 7);
  assert.equal(crops.ripeAge("beetroots"), 3);
  assert.equal(crops.ripeAge("nether_wart"), 3);
  assert.equal(crops.ripeAge("short_grass"), null);
  assert.equal(crops.ripeAge("somemod_unknown_crop"), null);
  // The ripe age and `isRipe` agree for a crop whose ripe state is its age alone.
  for (const name of ["wheat", "beetroots", "nether_wart"]) assert.equal(crops.isRipe(crop(name, crops.ripeAge(name)!)), true, name);
});

const evidence = (overrides: Partial<TendEvidence> = {}): TendEvidence => ({
  cells: 4, harvested: 0, cleared: 0, tilled: 0, tilledSoil: {}, untillable: {}, planted: 0, gained: {}, skipped: {}, dropsLeft: [],
  before: { crops: {} },
  after: { crops: {}, ripeAge: {}, emptyFarmland: 0, dryFarmland: 0, water: 0 }, ...overrides,
});

test("growing crops and water are a farm as it should be; other skipped cells make the run partial, or failed with no work", () => {
  assert.equal(settleTend(evidence({ planted: 2, skipped: { growing: [{ x: 0, z: 0 }], water: [{ x: 1, z: 0 }] } }), null, null).status, "succeeded");
  const partial = settleTend(evidence({ planted: 1, skipped: { "no wheat_seeds left": [{ x: 0, z: 0 }, { x: 1, z: 0 }] } }), null, null);
  assert.equal(partial.status, "partial");
  assert.match("error" in partial ? partial.error : "", /^\[TEND_INCOMPLETE\] 2 cells could not be farmed/u);
  assert.equal(settleTend(evidence({ skipped: { "not tillable (stone)": [{ x: 0, z: 0 }] } }), null, null).status, "failed");
  const stalled = settleTend(evidence({ harvested: 1 }), "[TEND_STALLED] No cell changed for 180 s (walked 40 blocks meanwhile).", null);
  assert.equal(stalled.status, "partial");
  assert.equal(settleTend(evidence(), null, "[TEND_NO_HOE] 4 cells need tilling and no hoe is carried.").status, "failed");
});

test("tend_crops presents what each cell became and what was left, with why", () => {
  const text = formatTendCropsResult(settleTend(evidence({
    harvested: 2, planted: 3, gained: { wheat: 2, wheat_seeds: 1 },
    skipped: { "no wheat_seeds left": [{ x: 3, z: 0 }] },
    before: { crops: { "wheat age 7 ripe": 2 } },
    after: { crops: { "wheat age 0": 3 }, ripeAge: { wheat: 7 }, emptyFarmland: 1, dryFarmland: 0, water: 0 },
  }), null, null));
  assert.match(text, /harvested 2, cleared 0, tilled 0, planted 3/u);
  assert.match(text, /Items gained: wheat 2, wheat_seeds 1/u);
  assert.match(text, /After: 3 wheat age 0; empty farmland 1/u);
  assert.match(text, /Skipped \(no wheat_seeds left\): 3,0/u);
  assert.match(text, /Observed stop:.*TEND_INCOMPLETE/su);
});

test("the tend result schema carries the untillable cells by block name, each crop's ripe age and the crops before the tend", () => {
  const parsed = tendEvidenceSchema.parse(evidence({
    untillable: { podzol: [{ x: 2, z: 3 }] },
    before: { crops: { "wheat age 7 ripe": 2 } },
    after: { crops: { "wheat age 3": 1 }, ripeAge: { wheat: 7 }, emptyFarmland: 0, dryFarmland: 0, water: 0 },
  }));
  assert.deepEqual([parsed.untillable, parsed.before, parsed.after.ripeAge], [{ podzol: [{ x: 2, z: 3 }] }, { crops: { "wheat age 7 ripe": 2 } }, { wheat: 7 }]);
  assert.throws(() => tendEvidenceSchema.parse({ ...evidence(), untillable: { podzol: [{ x: 2 }] } }));
  assert.throws(() => tendEvidenceSchema.parse({ ...evidence(), untillable: undefined }));
  assert.throws(() => tendEvidenceSchema.parse({ ...evidence(), before: undefined }));
  assert.throws(() => tendEvidenceSchema.parse({ ...evidence(), after: { ...evidence().after, ripeAge: { wheat: -1 } } }));
});

test("a cancel ends the quiet look for dropped items at once when physics has stopped, not at Mineflayer's 5 s tick timeout", async () => {
  // A death turns physics off (`physics.js:480`): `bot.waitForTicks(10)` alone ends only at 10 * 50 + 5000 ms.
  const { bot: farmer, clock } = createFakeBot({ version: "1.21.4", position: new Vec3(0.5, 64, 0.5) });
  const stop = new AbortController();
  const body = mineflayerFarmBody(farmer, {} as NavigationRuntime, wheatPlot(), stop.signal);
  farmer.physicsEnabled = false;
  clock.after(100, () => stop.abort(new Error("bot died")));
  await assert.rejects(clock.settle(body.collectDrops(), 1_000), /bot died/);
  assert.equal(farmer.listenerCount("physicsTick"), 0, "the aborted wait left no tick listener");
});

/** Protected regions at the farm's own digs and tills (plan 2026-11-07-p4-06a-threat T5b, ADR-012). */
function farmerIn(owner: string | null, cells: Record<string, string>, carried: Record<string, number> = {}) {
  const harness = createFakeBot({ version: "1.21.4", position: new Vec3(0.5, 64, 0.5), cells, carried });
  const region = (name: string) => ({
    regionId: 3, dimension: "overworld", owner: name, label: "Tom's farm", min: { x: 0, y: 62, z: -1 }, max: { x: 2, y: 66, z: 1 },
  });
  setProtectedRegionsProvider(harness.bot, () => (owner === null ? [] : [region(owner === "own" ? harness.bot.username : owner)]));
  return { ...harness, body: mineflayerFarmBody(harness.bot, {} as NavigationRuntime, wheatPlot()) };
}

test("clearing a cell in another owner's region is refused naming the region, and the block stays", async () => {
  const { body, bot, server } = farmerIn("Tom", { "1,65,0": "short_grass" });
  const failed = await body.breakBlock({ x: 1, y: 65, z: 0 });
  assert.ok(failed?.includes("inside protected region #3 'Tom's farm' (owner Tom)"), String(failed));
  assert.equal(bot.blockAt(new Vec3(1, 65, 0))?.name, "short_grass");
  assert.equal(server.packets.filter((packet) => packet.name === "block_dig").length, 0);
});

test("clearing a cell in the bot's own region proceeds", async () => {
  const { body, bot, clock } = farmerIn("own", { "1,65,0": "short_grass" });
  const clearing = body.breakBlock({ x: 1, y: 65, z: 0 });
  await clock.advance(10_000);
  assert.equal(await clearing, null);
  assert.equal(bot.blockAt(new Vec3(1, 65, 0))?.name, "air");
});

test("tilling soil in another owner's region is an error naming the region, with no use packet", async () => {
  const { body, server } = farmerIn("Tom", { "1,63,0": "dirt" }, { wooden_hoe: 1 });
  const result = await body.till({ x: 1, y: 63, z: 0 });
  assert.equal(result?.kind, "error");
  assert.ok(result?.kind === "error" && result.error.includes("(owner Tom)"), JSON.stringify(result));
  assert.equal(server.packets.filter((packet) => packet.name === "block_place" || packet.name === "use_item").length, 0);
});

test("a failed hoe use is unchanged only when the server clock moved 20 ticks and the hoe is still carried", () => {
  const failed = (serverTicksWaited: number | null) => ({ error: "not confirmed", serverTicksWaited });
  assert.deepEqual(tillFailure(failed(20), true), { kind: "unchanged" });
  assert.deepEqual(tillFailure(failed(19), true), { kind: "unconfirmed" });
  assert.deepEqual(tillFailure(failed(0), true), { kind: "unconfirmed" });
  assert.deepEqual(tillFailure(failed(40), false), { kind: "error", error: "not confirmed" });
  assert.deepEqual(tillFailure(failed(null), true), { kind: "error", error: "not confirmed" });
});

test("a hoe use whose wait ended on the wall clock is never an untillable verdict", () => {
  assert.deepEqual(tillFailure({ error: "not confirmed", serverTicksWaited: 30, timedOut: true }, true), { kind: "unconfirmed" });
  assert.deepEqual(tillFailure({ error: "not confirmed", serverTicksWaited: 40 }, true), { kind: "unchanged" });
});

// Reflex continuity (spec 2026-10-18, R2): the stall watch is per attempt, the totals are per request.
/** A bot whose world never changes, on whose clock the tests count the stall watches opened and closed. */
function stallClock() {
  const harness = createFakeBot({ position: new Vec3(0, 64, 0) });
  const state = { opened: 0, closed: 0 };
  const clock: StallClock = {
    now: harness.clock.now,
    every: (tick, ms) => {
      state.opened += 1;
      const stop = harness.clock.every(tick, ms);
      return () => { state.closed += 1; stop(); };
    },
  };
  /** Let `ms` pass at once: one slice, so the watch samples once, as after a reflex's long hold. */
  const advance = (ms: number) => harness.clock.advance(ms, ms);
  return { state, clock, advance, quietBot: harness.bot };
}

const wheatPlot = () => parseTendCropsRequest({ x1: 0, z1: 0, x2: 1, z2: 0, y: 63 });

test("a tend cut by a reflex runs again under a new stall watch and answers for both attempts", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland", "wheat", 7);
  farm.set(1, 0, "farmland", "wheat", 7);
  cutAfter(farm, "breakBlock", 1);
  const { state, clock, advance, quietBot } = stallClock();
  const run = beginTendCrops(quietBot, wheatPlot(), PLOT_FACTS, () => farm, () => {}, { stallMs: 60_000, clock });
  await assert.rejects(run({}), /HUNGER/);
  assert.deepEqual([state.opened, state.closed], [1, 1], "the cut attempt closed its watch");
  await advance(600_000);
  const result = await run({});
  assert.equal(result.status, "succeeded", "the reflex's ten minutes are not a stall of the resumed attempt");
  assert.deepEqual([result.tended.harvested, result.tended.planted], [2, 2]);
  assert.deepEqual([state.opened, state.closed], [2, 2]);
});

test("a stall in the resumed attempt ends the request with what both attempts did", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland", "wheat", 7);
  farm.set(1, 0, "farmland", "wheat", 7);
  farm.set(2, 0, "farmland", "wheat", 7);
  cutAfter(farm, "breakBlock", 1);
  const { clock, advance, quietBot } = stallClock();
  const originalReach = farm.reach.bind(farm);
  let reaches = 0;
  farm.reach = async (cell) => {
    if (++reaches === 3) await advance(61_000);
    return originalReach(cell);
  };
  const run = beginTendCrops(quietBot, parseTendCropsRequest({ x1: 0, z1: 0, x2: 2, z2: 0, y: 63 }), PLOT_FACTS, () => farm, () => {}, { stallMs: 60_000, clock });
  await assert.rejects(run({}), /HUNGER/);
  const result = await run({});
  assert.equal(result.status, "partial");
  assert.match("error" in result ? result.error : "", /TEND_STALLED/);
  assert.ok(result.tended.harvested >= 2, "the harvests of the cut attempt are in the total");
});

test("ground cover is what the version's tags say, saplings never, and tilled soil is what its state shows moisture", () => {
  const facts = plotFacts(bot);
  assert.equal(facts.isGroundCover("short_grass"), true);
  assert.equal(facts.isGroundCover("poppy"), true);
  assert.equal(facts.isGroundCover("torch"), false);
  assert.equal(facts.isGroundCover("oak_sapling"), false);
  assert.equal(facts.isGroundCover("mangrove_propagule"), false);
  assert.equal(plotFacts({ ...bot, version: "1.18.2" }).isGroundCover("short_grass"), false);
  assert.equal(facts.isTilledSoil({ name: "farmland", properties: { moisture: 0 }, liquid: false, empty: false, breakable: true }), true);
  assert.equal(facts.isTilledSoil({ name: "dirt", properties: {}, liquid: false, empty: false, breakable: true }), false);
});

test("the tilled soils are the registry blocks whose state holds moisture", () => {
  assert.deepEqual(tilledSoilNames(bot), ["farmland"]);
});
