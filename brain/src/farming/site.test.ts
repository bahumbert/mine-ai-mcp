import assert from "node:assert/strict";
import test from "node:test";
import type { BlockArea, Position } from "../runtime-client.ts";
import { FakeRuntime } from "../testing.ts";
import { farmPlot } from "./plot.ts";
import { chooseSite, farmStandsOnSoil } from "./site.ts";

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
