import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import {
  anyRegionAt,
  cellsOutsideRegionsFirst,
  describeProtectedRegion,
  foreignRegionAt,
  protectedRegionAt,
  regionChangeRefusal,
  regionRefusalText,
  setProtectedRegionsProvider,
  type ProtectedRegion,
} from "./protected-regions.js";

const house: ProtectedRegion = {
  regionId: 1, dimension: "overworld", min: { x: 0, y: 63, z: 0 }, max: { x: 6, y: 70, z: 4 }, owner: "Ayla", label: "small medieval house",
  heldBy: "Ayla", peer: false,
};

test("a region holds its cells inclusively, in its own dimension only", () => {
  assert.equal(protectedRegionAt([house], "overworld", 0, 63, 0), house);
  assert.equal(protectedRegionAt([house], "overworld", 6, 70, 4), house);
  assert.equal(protectedRegionAt([house], "overworld", 7, 70, 4), null);
  assert.equal(protectedRegionAt([house], "overworld", 3, 62, 2), null);
  assert.equal(protectedRegionAt([house], "the_nether", 3, 65, 2), null);
});

test("the owner's own build is exempt, whatever the name's case", () => {
  assert.equal(protectedRegionAt([house], "overworld", 3, 65, 2, "ayla"), null);
  assert.equal(protectedRegionAt([house], "overworld", 3, 65, 2, "Tom"), house);
  assert.equal(describeProtectedRegion(house), "protected region #1 'small medieval house' (owner Ayla)");
});

test("a region another bot holds is never exempt, even when its owner is the asking bot", () => {
  const forAyla: ProtectedRegion = { ...house, heldBy: "Tom", peer: true };
  assert.equal(protectedRegionAt([forAyla], "overworld", 3, 65, 2, "Ayla"), forAyla);
});

test("a peer region is described without an id", () => {
  const description = describeProtectedRegion({ ...house, regionId: 4, heldBy: "Tom", peer: true });
  assert.equal(description, "Tom's protected area 'small medieval house' (owner Ayla)");
  assert.ok(!description.includes("#"));
});

/** A small seeded generator so a failure reproduces. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function linearLookup(regions: readonly ProtectedRegion[], dimension: string, x: number, y: number, z: number, exemptOwner?: string) {
  for (const region of regions) {
    if (region.dimension !== dimension) continue;
    if (exemptOwner !== undefined && !region.peer && region.owner.toLowerCase() === exemptOwner.toLowerCase()) continue;
    const { min, max } = region;
    if (x >= min.x && x <= max.x && y >= min.y && y <= max.y && z >= min.z && z <= max.z) return region;
  }
  return null;
}

test("960 random regions: the indexed lookup equals the linear lookup", () => {
  const random = seeded(20261118);
  const dimensions = ["overworld", "the_nether", "the_end"];
  const owners = ["Ayla", "Tom", "Vex", "Mia"];
  const regions: ProtectedRegion[] = Array.from({ length: 960 }, (_, index) => {
    const min = { x: Math.floor(random() * 2000) - 1000, y: Math.floor(random() * 60), z: Math.floor(random() * 2000) - 1000 };
    const owner = owners[Math.floor(random() * owners.length)]!;
    return {
      regionId: (index % 64) + 1, dimension: dimensions[Math.floor(random() * dimensions.length)]!,
      min, max: { x: min.x + Math.floor(random() * 64), y: min.y + Math.floor(random() * 64), z: min.z + Math.floor(random() * 64) },
      owner, label: `region ${index}`, heldBy: owner, peer: random() < 0.5,
    };
  });
  const frozen = Object.freeze(regions);
  let hits = 0;
  for (let probe = 0; probe < 5000; probe += 1) {
    // Half the probes start inside a region so the property is not met only by misses.
    const near = random() < 0.5 ? regions[Math.floor(random() * regions.length)]! : null;
    const x = near === null ? Math.floor(random() * 2200) - 1100 : near.min.x + Math.floor(random() * 70) - 3;
    const y = near === null ? Math.floor(random() * 120) : near.min.y + Math.floor(random() * 70) - 3;
    const z = near === null ? Math.floor(random() * 2200) - 1100 : near.min.z + Math.floor(random() * 70) - 3;
    const dimension = near?.dimension ?? dimensions[Math.floor(random() * dimensions.length)]!;
    for (const exemptOwner of [undefined, owners[probe % owners.length]!]) {
      const expected = linearLookup(frozen, dimension, x, y, z, exemptOwner);
      assert.equal(protectedRegionAt(frozen, dimension, x, y, z, exemptOwner), expected, `${dimension} ${x},${y},${z} exempt ${exemptOwner}`);
      if (expected !== null) hits += 1;
    }
  }
  assert.ok(hits > 500, `the probes must hit regions often enough to mean something (${hits})`);
});

test("a region too large to index, or past 32 bits, is found as the linear walk finds it, without a hang", () => {
  const small: ProtectedRegion[] = Array.from({ length: 20 }, (_, index) => ({
    ...house, regionId: index + 1, min: { x: index * 200, y: 0, z: 100 }, max: { x: index * 200 + 3, y: 10, z: 103 },
  }));
  // A corrupt or foreign row in a peer file is not bound by the 64-block limit `protect` enforces.
  const huge: ProtectedRegion = { ...house, regionId: 98, min: { x: -10, y: 0, z: 0 }, max: { x: 3_000_000_000, y: 10, z: 10 }, heldBy: "Tom", peer: true };
  const wide: ProtectedRegion = { ...house, regionId: 99, min: { x: 0, y: 0, z: 100 }, max: { x: 40_000, y: 10, z: 41_000 } };
  const regions = Object.freeze([...small, wide, huge]);
  for (const [x, z] of [[5, 1], [5, 5], [-10, 0], [2_999_999_999, 10], [3_000_000_001, 10], [30_000, 30_000], [0, 101], [600, 101], [-11, 0]] as const)
    assert.equal(protectedRegionAt(regions, "overworld", x, 5, z)?.regionId, linearLookup(regions, "overworld", x, 5, z)?.regionId, `${x},${z}`);
  assert.equal(protectedRegionAt(regions, "overworld", 601, 5, 101)?.regionId, 4, "array order wins: the small region comes before the large one over it");
  assert.equal(protectedRegionAt(regions, "overworld", 30_000, 5, 30_000)?.regionId, 99);
});

test("regions across chunk borders and negative coordinates are found through the index", () => {
  const many: ProtectedRegion[] = Array.from({ length: 20 }, (_, index) => ({
    ...house, regionId: index + 1, min: { x: index * 200, y: 0, z: 0 }, max: { x: index * 200 + 3, y: 10, z: 3 },
  }));
  const straddling: ProtectedRegion = { ...house, regionId: 99, min: { x: -17, y: 0, z: -17 }, max: { x: 15, y: 10, z: 15 } };
  const regions = Object.freeze([...many, straddling]);
  for (const [x, z] of [[-17, -17], [-16, -1], [-1, -16], [0, 0], [15, 15], [15, -17]] as const) {
    assert.equal(protectedRegionAt(regions, "overworld", x, 5, z)?.regionId, linearLookup(regions, "overworld", x, 5, z)?.regionId, `${x},${z}`);
  }
  assert.equal(protectedRegionAt(regions, "overworld", 16, 5, 16), null);
  assert.equal(protectedRegionAt(regions, "overworld", -18, 5, 0), null);
});

// The bot-aware reads (plan 2026-11-07-p4-06a-threat T5a): own regions never refuse a placement, others' do.
const toms: ProtectedRegion = { ...house, regionId: 2, owner: "Tom", label: "Tom's place" };
const insideHouse = { x: 3, y: 65, z: 2 };

function botWith(regions: readonly ProtectedRegion[], options: { username?: string; dimension?: string } = {}) {
  const { bot } = createFakeBot({ username: options.username ?? "Ayla", dimension: options.dimension ?? "overworld" });
  setProtectedRegionsProvider(bot, () => regions);
  return bot;
}

test("foreignRegionAt skips the bot's own region whatever the name's case, finds another owner's even behind it, and stops at the dimension", () => {
  assert.equal(foreignRegionAt(botWith([house], { username: "Ayla" }), insideHouse), null);
  assert.equal(foreignRegionAt(botWith([house], { username: "AYLA" }), insideHouse), null);
  assert.equal(foreignRegionAt(botWith([house], { username: "Tom" }), insideHouse), house);
  const nested = { ...toms, min: house.min, max: house.max };
  assert.equal(foreignRegionAt(botWith([house, nested]), insideHouse), nested);
  assert.equal(foreignRegionAt(botWith([toms], { dimension: "the_nether" }), insideHouse), null);
  assert.equal(foreignRegionAt(botWith([toms]), { x: 30, y: 65, z: 2 }), null);
});

test("anyRegionAt finds the bot's own region too, and a refusal names the region", () => {
  assert.equal(anyRegionAt(botWith([house]), insideHouse), house);
  assert.equal(anyRegionAt(botWith([]), insideHouse), null);
  assert.equal(regionRefusalText(toms), "inside protected region #2 'Tom's place' (owner Tom)");
});

test("regionChangeRefusal names the cell and the region for a dig and for a placement, and is null for the bot's own region", () => {
  const dig = regionChangeRefusal(botWith([toms]), insideHouse, "dig");
  assert.equal(dig, "Dig cell (3, 65, 2) is inside protected region #2 'Tom's place' (owner Tom): dig elsewhere or ask its owner.");
  const place = regionChangeRefusal(botWith([toms]), insideHouse, "placement");
  assert.equal(place, "Placement cell (3, 65, 2) is inside protected region #2 'Tom's place' (owner Tom): build elsewhere or ask its owner.");
  assert.equal(regionChangeRefusal(botWith([house]), insideHouse, "dig"), null);
  assert.equal(regionChangeRefusal(botWith([toms]), { x: 30, y: 65, z: 2 }, "dig"), null);
});

test("cells outside every region come first, the bot's own region's next, a foreign one's last", () => {
  const own = { ...house, regionId: 3, min: { x: 10, y: 63, z: 0 }, max: { x: 12, y: 70, z: 4 } };
  const foreign = { ...toms, min: { x: 20, y: 63, z: 0 }, max: { x: 22, y: 70, z: 4 } };
  const bot = botWith([own, foreign]);
  const cells = [{ x: 20, y: 65, z: 1 }, { x: 11, y: 65, z: 1 }, { x: 0, y: 65, z: 1 }, { x: 1, y: 65, z: 1 }];
  assert.deepEqual(cellsOutsideRegionsFirst(bot, cells).map((cell) => cell.x), [0, 1, 11, 20]);
});
