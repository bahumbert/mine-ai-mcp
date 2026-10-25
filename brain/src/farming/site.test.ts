import assert from "node:assert/strict";
import test from "node:test";
import type { BlockArea, Position } from "../runtime-client.ts";
import { FakeRuntime } from "../testing.ts";
import { farmPlot } from "./plot.ts";
import { chooseSite, farmStandsOnSoil, REFUSAL_HOLD_MS, TillFacts } from "./site.ts";

/** A fake runtime on flat dirt up to y 63 that counts its area reads and kind lookups. */
class CountingRuntime extends FakeRuntime {
  areaReads: { min: Position; max: Position }[] = [];
  kindLookups: string[][] = [];
  override async blocksIn(min: Position, max: Position): Promise<BlockArea> {
    this.areaReads.push({ min, max });
    return super.blocksIn(min, max);
  }
  override async blockKinds(names: readonly string[]) {
    this.kindLookups.push([...names]);
    return super.blockKinds(names);
  }
}

const asked = farmPlot({ x: 0, y: 63, z: 4 }, 5);

/** Sets every cell of the box (inclusive) to a block. */
function fill(runtime: FakeRuntime, from: Position, to: Position, block: string): void {
  for (let x = from.x; x <= to.x; x += 1) for (let y = from.y; y <= to.y; y += 1) for (let z = from.z; z <= to.z; z += 1) runtime.world.set(`${x},${y},${z}`, block);
}

const reach = { from: { x: -20, z: -14 }, to: { x: 20, z: 22 } };
/** One layer over the whole reach of a site search. */
function layer(runtime: FakeRuntime, y: number, block: string): void {
  fill(runtime, { x: reach.from.x, y, z: reach.from.z }, { x: reach.to.x, y, z: reach.to.z }, block);
}

const siteOf = (found: Awaited<ReturnType<typeof chooseSite>>) => ("plot" in found ? found.plot : null);
const refusalOf = (found: Awaited<ReturnType<typeof chooseSite>>) => ("refusal" in found ? found.refusal : "");

test("a fit plot costs one area read and one kind lookup, however wide the site search could be (run 13 review R5)", async () => {
  const runtime = new CountingRuntime();
  assert.deepEqual(siteOf(await chooseSite(runtime, asked)), asked);
  assert.equal(runtime.areaReads.length, 1);
  assert.equal(runtime.kindLookups.length, 1);
  // Only the plot's own column (soil level and the sky above it), not the search radius.
  assert.ok(runtime.areaReads[0]!.max.x - runtime.areaReads[0]!.min.x <= 4, JSON.stringify(runtime.areaReads[0]));
});

test("a plot that is not fit reads the wide box once, and asks the tags of the grounds only (R5)", async () => {
  const runtime = new CountingRuntime();
  layer(runtime, 63, "stone");
  layer(runtime, 64, "dandelion");
  await chooseSite(runtime, asked);
  assert.equal(runtime.areaReads.length, 2);
  // The flowers above the ground are not looked up: they are no ground.
  assert.ok(!runtime.kindLookups.flat().includes("dandelion"), runtime.kindLookups.flat().join());
});

test("water counts as ground in the middle cell only: a plot on a lake is refused (R4)", async () => {
  const lake = new CountingRuntime();
  for (let y = 59; y <= 63; y += 1) layer(lake, y, "water");
  const site = await chooseSite(lake, asked);
  assert.equal(siteOf(site), null);
  assert.match(refusalOf(site), /24 water/u);
  // With only the middle cell water, the plot is fit.
  const pond = new CountingRuntime();
  pond.world.set("0,63,4", "water");
  assert.deepEqual(siteOf(await chooseSite(pond, asked)), asked);
});

test("air is never soil: a plot over a pit is moved to ground, a hollow one block deep is left to the leveling (R4)", async () => {
  const pit = new CountingRuntime();
  fill(pit, { x: -2, y: 60, z: 2 }, { x: 2, y: 63, z: 6 }, "air");
  const moved = siteOf(await chooseSite(pit, asked));
  assert.ok(moved !== null);
  assert.ok(moved.min.x > 2 || moved.max.x < -2 || moved.min.z > 6 || moved.max.z < 2, JSON.stringify(moved));
  // One block deep (soil level air over dirt): the leveling fills it, the plot stays.
  const hollow = new CountingRuntime();
  fill(hollow, { x: -2, y: 63, z: 2 }, { x: 2, y: 63, z: 6 }, "air");
  assert.deepEqual(siteOf(await chooseSite(hollow, asked)), asked);
});

test("each moved plot is on its own ground height: a terrace above the stone field is found (R6)", async () => {
  const runtime = new CountingRuntime();
  layer(runtime, 63, "stone");
  // A dirt terrace two blocks higher, east of the asked plot.
  fill(runtime, { x: 6, y: 64, z: -2 }, { x: 16, y: 65, z: 10 }, "dirt");
  assert.equal(siteOf(await chooseSite(runtime, asked))?.water.y, 65);
});

test("an unloaded cell is unknown, not air and not soil: a plot with one is not chosen (R22)", async () => {
  const runtime = new CountingRuntime();
  runtime.world.set("1,63,5", "unloaded");
  const chosen = siteOf(await chooseSite(runtime, asked));
  assert.ok(chosen !== null);
  assert.notDeepEqual(chosen, asked);
  // Unloaded all around: no site, and the refusal says the cells are not loaded.
  const unloaded = new CountingRuntime();
  fill(unloaded, { x: reach.from.x, y: 58, z: reach.from.z }, { x: reach.to.x, y: 70, z: reach.to.z }, "unloaded");
  assert.match(refusalOf(await chooseSite(unloaded, asked)), /25 not loaded/u);
});

test("a farm whose cells are not loaded still stands; one on stone does not (R22)", async () => {
  const unloaded = new CountingRuntime();
  fill(unloaded, { x: -2, y: 63, z: 2 }, { x: 2, y: 63, z: 6 }, "unloaded");
  assert.equal(await farmStandsOnSoil(unloaded, asked), true);
  const stone = new CountingRuntime();
  fill(stone, { x: -2, y: 63, z: 2 }, { x: 2, y: 63, z: 6 }, "stone");
  assert.equal(await farmStandsOnSoil(stone, asked), false);
});

test("a block name a till failed on is skipped by the next site search, nothing is listed by name (SF2)", async () => {
  // Podzol carries the game's `dirt` tag, but a hoe does not till it (run 14: a plot on podzol failed "not tillable").
  const runtime = new CountingRuntime();
  runtime.blockTags = { ...runtime.blockTags, podzol: ["dirt"] };
  layer(runtime, 63, "podzol");
  fill(runtime, { x: 6, y: 63, z: -2 }, { x: 16, y: 63, z: 10 }, "dirt");
  const facts = new TillFacts();
  assert.deepEqual(siteOf(await chooseSite(runtime, asked, facts)), asked);
  // One failure proves nothing; the same name failing at a second place (another chunk) does.
  facts.failed("podzol", { x: 1, z: 1 });
  assert.equal(facts.refuses("podzol"), false);
  facts.failed("podzol", { x: 40, z: 1 });
  const moved = siteOf(await chooseSite(runtime, asked, facts));
  assert.ok(moved !== null && moved.min.x >= 6, JSON.stringify(moved));
  // Next action from the new end state: all ground is that name, so the refusal says what is wrong with the plot.
  const all = new CountingRuntime();
  all.blockTags = { ...all.blockTags, podzol: ["dirt"] };
  layer(all, 63, "podzol");
  assert.match(refusalOf(await chooseSite(all, asked, facts)), /25 podzol/u);
  assert.equal(await farmStandsOnSoil(all, asked, facts), false);
  // A fact is per name: dirt is still soil.
  assert.deepEqual(siteOf(await chooseSite(new CountingRuntime(), asked, facts)), asked);
});

test("a block that failed once, or whose till later worked, is still soil: one failure never ends every farm (SF2 review)", async () => {
  const facts = new TillFacts();
  facts.failed("dirt", { x: 1, z: 1 });
  facts.failed("dirt", { x: 1, z: 1 });
  assert.equal(facts.refuses("dirt"), false);
  // Next action from that state: the site search still picks a dirt plot.
  assert.deepEqual(siteOf(await chooseSite(new CountingRuntime(), asked, facts)), asked);
  facts.failed("dirt", { x: 40, z: 1 });
  assert.equal(facts.refuses("dirt"), true);
  facts.tilled("dirt");
  assert.equal(facts.refuses("dirt"), false);
  assert.deepEqual(siteOf(await chooseSite(new CountingRuntime(), asked, facts)), asked);
});

/** A clock the test moves by hand (the facts take it as their `now`). */
function clock() {
  const time = { now: 1_000_000 };
  return { time, now: () => time.now };
}

test("many untillable cells of one plot in one call are one place: the name stays soil (SKL-02)", () => {
  const facts = new TillFacts();
  // Cells of one plot, two calls on it, and two bots on it all give the plot middle: one chunk.
  for (const middle of [{ x: 0, z: 4 }, { x: 0, z: 4 }, { x: 3, z: 6 }, { x: 15, z: 15 }]) facts.failed("grass_block", middle);
  assert.equal(facts.refuses("grass_block"), false);
});

test("failures on plots in two chunks refuse the name; a chunk is 16 wide, negative coordinates included (SKL-02)", () => {
  const facts = new TillFacts();
  facts.failed("podzol", { x: 0, z: 0 });
  facts.failed("podzol", { x: 15, z: 15 });
  assert.equal(facts.refuses("podzol"), false);
  facts.failed("podzol", { x: 16, z: 0 });
  assert.equal(facts.refuses("podzol"), true);
  const west = new TillFacts();
  west.failed("mud", { x: -1, z: 0 });
  west.failed("mud", { x: -16, z: 0 });
  assert.equal(west.refuses("mud"), false);
  west.failed("mud", { x: -17, z: 0 });
  assert.equal(west.refuses("mud"), true);
});

test("a refusal holds 30 minutes after its latest failure, then one site of it is chosen again (the probe) (SKL-02)", async () => {
  const { time, now } = clock();
  const facts = new TillFacts(now);
  facts.failed("podzol", { x: 0, z: 0 });
  facts.failed("podzol", { x: 40, z: 0 });
  assert.equal(facts.refuses("podzol"), true);
  time.now += REFUSAL_HOLD_MS - 1;
  assert.equal(facts.refuses("podzol"), true);
  // A clock that went back is still within the hold, and nothing throws.
  time.now -= 10 * REFUSAL_HOLD_MS;
  assert.equal(facts.refuses("podzol"), true);
  time.now += 11 * REFUSAL_HOLD_MS;
  assert.equal(facts.refuses("podzol"), false);
  // Next action from the expired state: the site search picks a plot of that name again.
  const runtime = new CountingRuntime();
  runtime.blockTags = { ...runtime.blockTags, podzol: ["dirt"] };
  layer(runtime, 63, "podzol");
  assert.deepEqual(siteOf(await chooseSite(runtime, asked, facts)), asked);
});

test("a failure at the probe refuses the name again at once; a till that works clears it (SKL-02)", () => {
  const { time, now } = clock();
  const facts = new TillFacts(now);
  facts.failed("podzol", { x: 0, z: 0 });
  facts.failed("podzol", { x: 40, z: 0 });
  time.now += REFUSAL_HOLD_MS;
  assert.equal(facts.refuses("podzol"), false);
  // The probe fails at one place: the earlier places still count, so the name is refused again with one failure.
  facts.failed("podzol", { x: 0, z: 0 });
  assert.equal(facts.refuses("podzol"), true);
  time.now += REFUSAL_HOLD_MS;
  assert.equal(facts.refuses("podzol"), false);
  facts.failed("podzol", { x: 80, z: 0 });
  facts.tilled("podzol");
  assert.equal(facts.refuses("podzol"), false);
  facts.failed("podzol", { x: 0, z: 0 });
  assert.equal(facts.refuses("podzol"), false);
});

test("at most 8 places are kept per name: the oldest is dropped (SKL-02)", () => {
  const { time, now } = clock();
  const facts = new TillFacts(now);
  for (let place = 0; place < 10; place += 1) {
    facts.failed("podzol", { x: place * 16, z: 0 });
    time.now += 60_000;
  }
  assert.equal(facts.failedPlaces("podzol"), 8);
  // The oldest places are the ones dropped: failing again at the first one makes it a new, latest place.
  facts.failed("podzol", { x: 0, z: 0 });
  assert.equal(facts.failedPlaces("podzol"), 8);
  assert.equal(facts.refuses("podzol"), true);
  // A name nothing failed on has no places.
  assert.equal(facts.failedPlaces("dirt"), 0);
});

test("a refused name is named as learned in the refusal, and the hint does not send the bot to it (SKL-02)", async () => {
  const facts = new TillFacts();
  facts.failed("grass_block", { x: 0, z: 0 });
  facts.failed("grass_block", { x: 40, z: 0 });
  const runtime = new CountingRuntime();
  runtime.blockTags = { ...runtime.blockTags, grass_block: ["dirt"] };
  layer(runtime, 63, "grass_block");
  const refusal = refusalOf(await chooseSite(runtime, asked, facts));
  assert.match(refusal, /25 grass_block \(a hoe failed on it at 2 places lately\)/u);
  assert.doesNotMatch(refusal, /walk to grass or dirt/u);
  assert.match(refusal, /walk to ground a hoe tills under the open sky/u);
  // A farm on a refused name still counts its cells as wrong (the label starts with the count).
  assert.equal(await farmStandsOnSoil(runtime, asked, facts), false);
  // Without a learned name the hint is the old one.
  const stone = new CountingRuntime();
  layer(stone, 63, "stone");
  assert.match(refusalOf(await chooseSite(stone, asked, facts)), /walk to grass or dirt under the open sky/u);
});
