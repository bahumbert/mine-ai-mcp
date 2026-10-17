import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import { cropFacts } from "./farm-body.js";
import { formatTendCropsResult, settleTend } from "./tend-crops.js";
import type { CellBlock } from "./tend-plot.js";
import type { TendEvidence } from "./contract.js";

const bot = { version: "1.21.4", registry: minecraftData("1.21.4") } as unknown as Pick<Bot, "registry" | "version">;
const crop = (name: string, age: number): CellBlock => ({ name, properties: { age }, liquid: false, empty: true, breakable: true });

test("a crop is ripe in the state its loot table drops the crop in, and planted from its unripe drop", () => {
  const crops = cropFacts(bot);
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

const evidence = (overrides: Partial<TendEvidence> = {}): TendEvidence => ({
  cells: 4, harvested: 0, cleared: 0, tilled: 0, tilledSoil: {}, planted: 0, gained: {}, skipped: {}, dropsLeft: [],
  after: { crops: {}, emptyFarmland: 0, dryFarmland: 0, water: 0 }, ...overrides,
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
    after: { crops: { "wheat age 0": 3 }, emptyFarmland: 1, dryFarmland: 0, water: 0 },
  }), null, null));
  assert.match(text, /harvested 2, cleared 0, tilled 0, planted 3/u);
  assert.match(text, /Items gained: wheat 2, wheat_seeds 1/u);
  assert.match(text, /After: 3 wheat age 0; empty farmland 1/u);
  assert.match(text, /Skipped \(no wheat_seeds left\): 3,0/u);
  assert.match(text, /Observed stop:.*TEND_INCOMPLETE/su);
});
