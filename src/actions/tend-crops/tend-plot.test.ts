import assert from "node:assert/strict";
import test from "node:test";
import { parseTendCropsRequest } from "./contract.js";
import { decideCell, tendPlot, type CellBlock, type CropFacts, type FarmBody } from "./tend-plot.js";

const block = (name: string, properties: CellBlock["properties"] = {}, traits: Partial<Pick<CellBlock, "liquid" | "empty">> = {}): CellBlock => ({
  name,
  properties,
  liquid: traits.liquid ?? false,
  breakable: name !== "air" && name !== "water",
  empty: traits.empty ?? (name === "air" || name === "short_grass" || name === "poppy" || name.startsWith("wheat") || name === "carrots"),
});

/** Wheat and carrots as the loot tables have them: ripe at age 7, planted from their unripe drop. */
const CROPS: CropFacts = {
  isRipe: (cell) => (cell.name === "wheat" || cell.name === "carrots" ? cell.properties.age === 7 : null),
  seedOf: (name) => ({ wheat: "wheat_seeds", carrots: "carrot" })[name] ?? null,
};

test("each cell is decided from its soil and what stands on it", () => {
  const air = block("air");
  assert.equal(decideCell(block("farmland"), block("wheat", { age: 7 }), CROPS), "harvest");
  assert.deepEqual(decideCell(block("farmland"), block("wheat", { age: 3 }), CROPS), { skip: "growing" });
  assert.equal(decideCell(block("grass_block"), block("short_grass"), CROPS), "clear");
  assert.equal(decideCell(block("grass_block"), block("poppy"), CROPS), "clear");
  assert.equal(decideCell(block("dirt"), air, CROPS), "till");
  assert.equal(decideCell(block("farmland"), air, CROPS), "plant");
  assert.deepEqual(decideCell(block("water", {}, { liquid: true, empty: true }), air, CROPS), { skip: "water" });
  assert.deepEqual(decideCell(block("dirt"), block("chest"), CROPS), { skip: "occupied by chest" });
  assert.deepEqual(decideCell(block("dirt"), block("water", {}, { liquid: true, empty: true }), CROPS), { skip: "under water" });
  assert.deepEqual(decideCell(null, air, CROPS), { skip: "unloaded" });
});

test("corners in any order make the same plot; more than 16 a side is refused", () => {
  assert.deepEqual(parseTendCropsRequest({ x1: 4, z1: -2, x2: 0, z2: 2, y: 63 }), {
    min: { x: 0, z: -2 }, max: { x: 4, z: 2 }, y: 63, plant: null, harvest: true, till: true,
  });
  assert.throws(() => parseTendCropsRequest({ x1: 0, z1: 0, x2: 16, z2: 0, y: 63 }), /TEND_TOO_LARGE.*17 x 1/u);
});

/** A world of soil at y 63 and what stands on it at y 64, changed the way the server would. */
class FakeFarm implements FarmBody {
  readonly world = new Map<string, CellBlock>();
  readonly inventory = new Map<string, number>();
  readonly calls: string[] = [];
  hoe = true;
  /** What breaking each crop drops on the ground, picked up by `collectDrops`. */
  readonly ground: string[] = [];
  unreachable = new Set<string>();
  tillable = new Set(["dirt", "grass_block"]);

  set(x: number, z: number, soil: string, above = "air", age?: number): void {
    this.world.set(`${x},63,${z}`, block(soil, soil === "farmland" ? { moisture: 7 } : {}, { liquid: soil === "water", empty: soil === "water" }));
    this.world.set(`${x},64,${z}`, block(above, age === undefined ? {} : { age }));
  }

  read(x: number, y: number, z: number): CellBlock | null {
    return this.world.get(`${x},${y},${z}`) ?? null;
  }

  async reach(cell: { x: number; y: number; z: number }): Promise<string | null> {
    return this.unreachable.has(`${cell.x},${cell.z}`) ? "no route" : null;
  }

  async breakBlock(cell: { x: number; y: number; z: number }): Promise<string | null> {
    const broken = this.read(cell.x, cell.y, cell.z)!;
    this.calls.push(`break ${broken.name} ${cell.x},${cell.z}`);
    if (broken.name === "wheat") this.ground.push("wheat", "wheat_seeds", "wheat_seeds");
    this.world.set(`${cell.x},${cell.y},${cell.z}`, block("air"));
    return null;
  }

  async till(cell: { x: number; y: number; z: number }): Promise<string | null> {
    const soil = this.read(cell.x, cell.y, cell.z)!;
    this.calls.push(`till ${cell.x},${cell.z}`);
    if (!this.tillable.has(soil.name)) return "nothing changed";
    this.world.set(`${cell.x},${cell.y},${cell.z}`, block("farmland", { moisture: 7 }));
    return null;
  }

  async plant(cell: { x: number; y: number; z: number }, item: string): Promise<string | null> {
    this.calls.push(`plant ${item} ${cell.x},${cell.z}`);
    // Only seeds take on farmland; the server leaves anything else in the hand.
    if (item !== "wheat_seeds" && item !== "carrot") return "nothing grew";
    this.inventory.set(item, (this.inventory.get(item) ?? 0) - 1);
    this.world.set(`${cell.x},${cell.y + 1},${cell.z}`, block(item === "carrot" ? "carrots" : "wheat", { age: 0 }));
    return null;
  }

  async collectDrops(): Promise<{ readonly left: readonly string[] }> {
    this.calls.push("collect drops");
    for (const item of this.ground.splice(0)) this.inventory.set(item, (this.inventory.get(item) ?? 0) + 1);
    return { left: [] };
  }

  carried(item: string): number {
    return this.inventory.get(item) ?? 0;
  }

  hasHoe(): boolean {
    return this.hoe;
  }
}

const plot = (input: Record<string, unknown>) => parseTendCropsRequest({ x1: 0, z1: 0, x2: 1, z2: 0, y: 63, ...input });

test("ripe crops are harvested first, their drops picked up, then the cells replanted with the crop's own seed", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland", "wheat", 7);
  farm.set(1, 0, "farmland", "wheat", 7);
  const { evidence, stop } = await tendPlot(plot({}), farm, CROPS);
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
  const { evidence } = await tendPlot(plot({ plant: "carrot" }), farm, CROPS);
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
  const { evidence, stop } = await tendPlot(plot({ x2: 5, plant: "wheat_seeds" }), farm, CROPS);
  assert.equal(stop, null);
  assert.deepEqual(evidence.skipped, {
    "not tillable (stone)": [{ x: 0, z: 0 }],
    water: [{ x: 1, z: 0 }],
    "occupied by chest": [{ x: 2, z: 0 }],
    growing: [{ x: 3, z: 0 }],
    "unreachable: no route": [{ x: 5, z: 0 }],
  });
  assert.deepEqual([evidence.tilled, evidence.planted], [1, 1]);
  assert.deepEqual(evidence.after, { crops: { "wheat age 4": 1, "wheat age 0": 1 }, emptyFarmland: 0, dryFarmland: 0, water: 1 });
});

test("running out of seeds leaves the last farmland empty, said as such", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland");
  farm.set(1, 0, "farmland");
  farm.inventory.set("wheat_seeds", 1);
  const { evidence } = await tendPlot(plot({ plant: "wheat_seeds" }), farm, CROPS);
  assert.equal(evidence.planted, 1);
  assert.deepEqual(evidence.skipped, { "no wheat_seeds left": [{ x: 1, z: 0 }] });
  assert.equal(evidence.after.emptyFarmland, 1);
});

test("tilling without a hoe is refused before any work; so is planting what is not carried", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "dirt");
  farm.set(1, 0, "farmland", "wheat", 7);
  farm.hoe = false;
  assert.match((await tendPlot(plot({}), farm, CROPS)).refused ?? "", /^\[TEND_NO_HOE\] 1 cell need tilling/u);
  assert.deepEqual(farm.calls, []);
  farm.hoe = true;
  assert.match((await tendPlot(plot({ plant: "carrot" }), farm, CROPS)).refused ?? "", /^\[TEND_PLANT_MISSING\] No carrot/u);
  assert.deepEqual(farm.calls, []);
  // Without tilling asked, soil is left as it is and nothing needs a hoe.
  farm.hoe = false;
  const { evidence, refused } = await tendPlot(plot({ till: false }), farm, CROPS);
  assert.equal(refused, null);
  assert.equal(evidence.harvested, 1);
  assert.deepEqual(evidence.skipped, { "not farmland": [{ x: 0, z: 0 }] });
});

test("progress is reported at each phase and each cell farmed", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland", "wheat", 7);
  farm.set(1, 0, "dirt");
  const seen: string[] = [];
  await tendPlot(plot({}), farm, CROPS, () => null, (progress) => seen.push(`${progress.phase} h${progress.harvested} t${progress.tilled} p${progress.planted}`));
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
  const { evidence } = await tendPlot(plot({ x2: 2, plant: "wheat" }), farm, CROPS);
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
  const { evidence } = await tendPlot(plot({ x2: 0 }), farm, CROPS);
  assert.deepEqual(evidence.dropsLeft, ["wheat", "wheat_seeds"]);
});

test("a stop asked between cells ends the run with what was done so far", async () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland", "wheat", 7);
  farm.set(1, 0, "farmland", "wheat", 7);
  let calls = 0;
  const { evidence, stop } = await tendPlot(plot({}), farm, CROPS, () => (++calls > 1 ? "[TEND_STALLED] stalled" : null));
  assert.equal(stop, "[TEND_STALLED] stalled");
  assert.equal(evidence.harvested, 1);
});
