import assert from "node:assert/strict";
import test from "node:test";
import type { Scenario } from "mine-labs";
import { fixtureScenario } from "../shared/scenario-fixture.ts";
import { loadAllScenarios } from "./all-scenarios.ts";
import { laneOf } from "./lanes.ts";
import { chunkCount, templateArea, type ChunkBox } from "./template-area.ts";

const VIEW = 8;
/** The spawn box and every arena margin grow by the view distance plus one chunk. */
const REACH = VIEW + 1;
const CHUNKS_PER_LANE = laneOf(1).offset.z / 16;

type Local = readonly [minX: number, minZ: number, maxX: number, maxZ: number];

/** A flat scenario whose arena is the square `from`..`to` in blocks (the player stands at `from`): Mine Labs' region is that square grown by 8 blocks. */
function arenaScenario(name: string, from: readonly [number, number], to: readonly [number, number], changes: Partial<Scenario> = {}): Scenario {
  const base = fixtureScenario(10, name);
  return {
    ...base,
    setup: [`fill ${from[0]} -61 ${from[1]} ${to[0]} -61 ${to[1]} stone`],
    players: [{ ...base.players[0]!, pos: [from[0] + 0.5, -60, from[1] + 0.5] }],
    entities: [],
    geometry: [],
    reset: [],
    ...changes,
  };
}

function chunksOf(boxes: readonly ChunkBox[]): Set<string> {
  const chunks = new Set<string>();
  for (const box of boxes) for (let x = box.minX; x <= box.maxX; x++) for (let z = box.minZ; z <= box.maxZ; z++) chunks.add(`${x},${z}`);
  return chunks;
}

/** The chunks listed, an overlap counted each time it is listed: equals the distinct chunks only for boxes that do not overlap. */
function areaSum(boxes: readonly ChunkBox[]): number {
  return boxes.reduce((total, box) => total + (box.maxX - box.minX + 1) * (box.maxZ - box.minZ + 1), 0);
}

function expectedChunks(local: readonly Local[], lanes: readonly number[]): Set<string> {
  const boxes: ChunkBox[] = [{ minX: -REACH, minZ: -REACH, maxX: REACH, maxZ: REACH }];
  for (const lane of lanes) {
    const shift = lane * CHUNKS_PER_LANE;
    for (const [minX, minZ, maxX, maxZ] of local) boxes.push({ minX, minZ: minZ + shift, maxX, maxZ: maxZ + shift });
  }
  return chunksOf(boxes);
}

const OPTIONS = { lanes: 3, viewChunks: VIEW };

// Scenario A: blocks 0..15 + 8 margin = -8..23 = chunks -1..1; grown by 9 = -10..10. Its pristine copy is parked
// 31 + 512 blocks along x (Mine Labs `scratchRegion`: the arena's width plus 512): blocks 535..566 = chunks 33..35.
const A = arenaScenario("a", [0, 0], [15, 15]);
const A_LOCAL: readonly Local[] = [[-10, -10, 10, 10], [33, -1, 35, 1], [-31, -15, -31, -15]];
// Scenario B: blocks 100..115 + 8 = 92..123 = chunks 5..7; grown by 9 = -4..16; copy 543 blocks along x: 635..666 = chunks 39..41.
const B = arenaScenario("b", [100, 100], [115, 115]);
const B_LOCAL: readonly Local[] = [[-4, -4, 16, 16], [39, 5, 41, 7]];

test("two scenarios: the union per lane, shifted by 32 chunks per lane", () => {
  const boxes = templateArea([A, B], OPTIONS);
  assert.deepEqual(chunksOf(boxes), expectedChunks([...A_LOCAL, ...B_LOCAL], [1, 2, 3]));
});

test("the control chunk of each lane is in", () => {
  const chunks = chunksOf(templateArea([A], { lanes: 28, viewChunks: VIEW }));
  for (let lane = 1; lane <= 28; lane++) assert.ok(chunks.has(`-31,${lane * CHUNKS_PER_LANE - 15}`), `lane ${lane}`);
});

test("a refused flat scenario adds its boxes at lane 0 and in no lane", () => {
  const exclusive = arenaScenario("timing", [0, 0], [15, 15], { tags: ["exclusive"] });
  assert.deepEqual(chunksOf(templateArea([exclusive], OPTIONS)), expectedChunks([[-10, -10, 10, 10], [33, -1, 35, 1]], [0]));
});

test("a scenario with another client lands at lane 0", () => {
  const other = arenaScenario("node-client", [0, 0], [15, 15], { client: { ...A.client, command: "node" } });
  assert.deepEqual(chunksOf(templateArea([other], OPTIONS)), expectedChunks([[-10, -10, 10, 10], [33, -1, 35, 1]], [0]));
});

test("a scenario with `time set` in setup lands in lanes (the settings lift takes it out; a bare shift would refuse it)", () => {
  const timed = arenaScenario("timed", [0, 0], [15, 15]);
  const withTime = { ...timed, setup: ["time set day", ...timed.setup] };
  assert.deepEqual(templateArea([withTime], OPTIONS), templateArea([timed], OPTIONS));
  assert.ok(chunksOf(templateArea([withTime], OPTIONS)).has(`33,${CHUNKS_PER_LANE}`), "lane 1 holds the scratch copy");
});

test("a default world adds nothing, in a lane or at lane 0", () => {
  const natural = arenaScenario("natural", [0, 0], [15, 15], { world: { ...A.world, type: "default" } });
  assert.deepEqual(templateArea([natural], OPTIONS), templateArea([], OPTIONS));
});

test("a scenario in another dimension adds nothing (the template holds overworld chunks)", () => {
  const nether = arenaScenario("nether", [0, 0], [15, 15], { world: { ...A.world, dimension: "the_nether" } });
  assert.deepEqual(templateArea([nether], OPTIONS), templateArea([], OPTIONS));
});

test("the spawn box is in, with no scenario at all", () => {
  const boxes = templateArea([], OPTIONS);
  assert.deepEqual(boxes, [{ minX: -REACH, minZ: -REACH, maxX: REACH, maxZ: REACH }]);
});

test("the view distance sets the reach: nothing is a constant of this file", () => {
  assert.deepEqual(templateArea([], { lanes: 0, viewChunks: 2 }), [{ minX: -3, minZ: -3, maxX: 3, maxZ: 3 }]);
});

test("the list is the same whatever the input order, and has no box inside another", () => {
  const forward = templateArea([A, B], OPTIONS);
  assert.deepEqual(templateArea([B, A], OPTIONS), forward);
  assert.deepEqual(templateArea([A, B, A], OPTIONS), forward);
  assert.equal(areaSum(forward), chunksOf(forward).size, "no chunk is listed twice");
});

test("`chunkCount` counts overlaps once", () => {
  assert.equal(chunkCount([{ minX: 0, minZ: 0, maxX: 3, maxZ: 3 }, { minX: 2, minZ: 2, maxX: 5, maxZ: 5 }]), 28);
  assert.equal(chunkCount([{ minX: 0, minZ: 0, maxX: 1, maxZ: 1 }, { minX: 0, minZ: 0, maxX: 1, maxZ: 1 }]), 4);
  assert.equal(chunkCount([{ minX: 0, minZ: 0, maxX: 1, maxZ: 1 }, { minX: 2, minZ: 0, maxX: 3, maxZ: 1 }]), 8, "touching boxes");
  assert.equal(chunkCount([]), 0);
});

test("a lane count or view distance that is not a whole number of at least 0 is refused", () => {
  for (const bad of [-1, 1.5, Number.NaN]) {
    assert.throws(() => templateArea([A], { lanes: bad, viewChunks: VIEW }), RangeError, `lanes ${bad}`);
    assert.throws(() => templateArea([A], { lanes: 1, viewChunks: bad }), RangeError, `view ${bad}`);
  }
});

test("lanes: 0 adds no lane chunks", () => {
  assert.deepEqual(chunksOf(templateArea([A], { lanes: 0, viewChunks: VIEW })), expectedChunks([], []));
});

test("census: the real scenarios at 28 lanes, every lane's chunks inside its cell grown by the reach", async () => {
  const scenarios = (await loadAllScenarios()).map(({ scenario }) => scenario);
  const boxes = templateArea(scenarios, { lanes: 28, viewChunks: VIEW });
  const count = chunkCount(boxes);
  console.log(`template census: ${scenarios.length} scenarios, 28 lanes, ${boxes.length} boxes, ${count} chunks`);
  assert.ok(count > chunkCount(templateArea([], { lanes: 28, viewChunks: VIEW })), "the scenarios add chunks");
  assert.equal(count, areaSum(boxes), "the boxes do not overlap, so the count is the sum of their areas");
  assert.equal(count, chunksOf(boxes).size);
  const last = laneOf(28).cell;
  const reach = REACH * 16;
  for (const box of boxes) assert.ok(box.maxZ * 16 + 15 <= last.maxZ + reach, `box ${JSON.stringify(box)} lies past lane 28`);
});
