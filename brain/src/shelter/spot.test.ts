import assert from "node:assert/strict";
import test from "node:test";
import { areaKey, type BlockArea, type BlockKind, type ProtectedArea } from "../runtime-client.ts";
import { coverOver, describeNoSpot, isInHole, roofBlock, shelterBox, shelterSpots, spotCells, type ShelterSpot, type SpotReason } from "./spot.ts";

const solid = (hardness: number | null, extra: Partial<BlockKind> = {}): BlockKind =>
  ({ tool: null, solid: true, fullCube: true, harvest: null, hardness, fluid: false, known: true, tags: [], ...extra });
const open = (extra: Partial<BlockKind> = {}): BlockKind => ({ tool: null, solid: false, harvest: null, hardness: 0, fluid: false, known: true, tags: [], ...extra });

// Hardness values are the registry's for dirt (0.5) and stone (1.5); grass is given dirt's so the arithmetic of the
// cost tests reads: 3 cells of 0.5 by hand (factor 1.5) = 2.25 s.
const KINDS: Record<string, BlockKind> = {
  air: open(),
  short_grass: open(),
  water: open({ fluid: true }),
  seagrass: open({ fluid: true }),
  unloaded: open({ known: false, hardness: null }),
  grass_block: solid(0.5, { tool: "shovel" }),
  dirt: solid(0.5, { tool: "shovel" }),
  stone: solid(1.5, { tool: "pickaxe", harvest: ["wooden_pickaxe"] }),
  obsidian: solid(50, { tool: "pickaxe", harvest: ["diamond_pickaxe"] }),
  bedrock: solid(null),
  oak_planks: solid(2, { tags: ["planks"] }),
  oak_leaves: solid(0.2, { fullCube: false, tags: ["leaves"] }),
};

const FROM = { x: 0.5, y: 64, z: 0.5 };
const COLUMNS = 169;

/** Flat ground: grass at y 63, dirt to 60, stone under; air above. `change` edits single cells. */
function ground(change: Record<string, string> = {}): BlockArea {
  const blocks = new Map<string, string>();
  const box = shelterBox({ x: 0, y: 64, z: 0 });
  for (let x = box.min.x - 4; x <= box.max.x + 4; x += 1) {
    for (let y = box.min.y; y <= box.max.y; y += 1) {
      for (let z = box.min.z - 4; z <= box.max.z + 4; z += 1) {
        blocks.set(areaKey(x, y, z), y > 63 ? "air" : y === 63 ? "grass_block" : y >= 60 ? "dirt" : "stone");
      }
    }
  }
  for (const [key, name] of Object.entries(change)) blocks.set(key, name);
  return { blocks, kinds: KINDS };
}

/** `name` in every cell of the column `x z` from `y0` to `y1`, as a `change` for {@link ground}. */
function column(x: number, z: number, y0: number, y1: number, name: string): Record<string, string> {
  const cells: Record<string, string> = {};
  for (let y = y0; y <= y1; y += 1) cells[areaKey(x, y, z)] = name;
  return cells;
}

/** `name` over the square of columns within `reach` of the origin, y0..y1. */
function square(reach: number, y0: number, y1: number, name: string): Record<string, string> {
  const cells: Record<string, string> = {};
  for (let x = -reach; x <= reach; x += 1) for (let z = -reach; z <= reach; z += 1) Object.assign(cells, column(x, z, y0, y1, name));
  return cells;
}

const at = (spot: ShelterSpot | undefined) => [spot?.x, spot?.z];
const near = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test("on flat ground the hole is dug where she stands: three cells of hand-dug soil, roofed against the ground beside it", () => {
  const search = shelterSpots(ground(), FROM, []);
  const [best] = search.spots;
  assert.deepEqual({ ...best, cost: undefined }, { x: 0, y: 64, z: 0, support: { x: 1, y: 63, z: 0 }, face: "west", dug: 0, cost: undefined });
  near(best?.cost, 2.25);
  assert.equal(search.spots.length, 3, "at most MAX_CANDIDATES");
  assert.equal(search.columns, COLUMNS);
});

test("water beside the roof cell floods the hole once dug: the column is skipped as open_walls", () => {
  const search = shelterSpots(ground({ [areaKey(1, 63, 0)]: "water" }), FROM, []);
  assert.notDeepEqual(at(search.spots[0]), [0, 0]);
  assert.ok(search.reasons.open_walls >= 1);
});

test("seagrass in a dug cell is a fluid by game data, not by name: the column is skipped", () => {
  const search = shelterSpots(ground({ [areaKey(0, 62, 0)]: "seagrass" }), FROM, []);
  assert.notDeepEqual(at(search.spots[0]), [0, 0]);
  assert.ok(search.reasons.open_walls >= 1);
});

test("bedrock in a dug cell (hardness null) is too_hard and the next column is chosen", () => {
  const search = shelterSpots(ground({ [areaKey(0, 62, 0)]: "bedrock" }), FROM, []);
  assert.notDeepEqual(at(search.spots[0]), [0, 0]);
  assert.equal(search.reasons.too_hard, 1);
});

test("an obsidian column is over MAX_DIG_SECONDS (3 x 250 s) and a dirt column 5 away is chosen", () => {
  const search = shelterSpots(ground(square(4, 61, 63, "obsidian")), FROM, []);
  const [best] = search.spots;
  assert.equal(Math.max(Math.abs(best?.x ?? 0), Math.abs(best?.z ?? 0)), 5);
  assert.equal(search.reasons.too_hard, 81);
});

test("dirt 3 away (3/4.3 s walk + 2.25 s dig) beats stone 0 away (22.5 s dig)", () => {
  const search = shelterSpots(ground(square(2, 61, 63, "stone")), FROM, []);
  const [best] = search.spots;
  assert.equal(Math.hypot(best?.x ?? 0, best?.z ?? 0), 3);
  near(best?.cost, 3 / 4.3 + 2.25);
});

test("an open hole 3 deep with solid walls is a candidate with no dig cost: dug 3, cost is its walk", () => {
  const search = shelterSpots(ground(column(2, 0, 61, 63, "air")), FROM, []);
  const [best] = search.spots;
  assert.deepEqual([best?.x, best?.y, best?.z, best?.dug], [2, 64, 0, 3]);
  near(best?.cost, 2 / 4.3);
});

test("an unloaded cell (kind known false) is unknown_cells, never an existing hole nor solid ground", () => {
  const search = shelterSpots(ground(column(0, 0, 61, 63, "unloaded")), FROM, []);
  assert.ok(!search.spots.some((spot) => spot.x === 0 && spot.z === 0));
  assert.ok(search.reasons.unknown_cells >= 1);
});

test("a column 6 away is found, a column 7 away is not searched", () => {
  const sea = square(10, 58, 63, "water");
  const island = (centre: number) => { for (let x = centre - 1; x <= centre + 1; x += 1) for (let z = -1; z <= 1; z += 1) Object.assign(sea, column(x, z, 58, 63, "dirt")); };
  island(6);
  const six = shelterSpots(ground(sea), FROM, []);
  assert.deepEqual(six.spots.map(({ x, z }) => [x, z]), [[6, 0]]);
  for (let x = 5; x <= 7; x += 1) for (let z = -1; z <= 1; z += 1) Object.assign(sea, column(x, z, 58, 63, "water"));
  island(7);
  assert.deepEqual(shelterSpots(ground(sea), FROM, []).spots, []);
});

test("a slope: the reason is read at the best height (feet open only at fy+1, a cave under): open_floor, not no_room", () => {
  const search = shelterSpots(ground({ ...column(0, 0, 64, 64, "dirt"), [areaKey(0, 61, 0)]: "air" }), FROM, []);
  assert.ok(search.reasons.open_floor >= 1);
  assert.equal(search.reasons.no_room, 0);
});

test("a column with no open feet and head cell at any of the four heights is no_room", () => {
  const search = shelterSpots(ground(column(0, 0, 62, 67, "stone")), FROM, []);
  assert.equal(search.reasons.no_room, 1);
});

test("a column whose standing cells are unloaded is unknown_cells, not no_room: nothing was seen to be solid", () => {
  const search = shelterSpots(ground(column(0, 0, 62, 67, "unloaded")), FROM, []);
  assert.ok(search.reasons.unknown_cells >= 1);
  assert.equal(search.reasons.no_room, 0);
});

test("open air beside the roof cell is no wall: the roof goes against another solid neighbour; none solid is no_support", () => {
  const oneSide = shelterSpots(ground({ [areaKey(1, 63, 0)]: "air" }), FROM, []);
  assert.deepEqual(oneSide.spots[0] && [oneSide.spots[0].x, oneSide.spots[0].z, oneSide.spots[0].support, oneSide.spots[0].face], [0, 0, { x: -1, y: 63, z: 0 }, "east"]);
  const noSide = shelterSpots(ground({ [areaKey(1, 63, 0)]: "air", [areaKey(-1, 63, 0)]: "air", [areaKey(0, 63, 1)]: "air", [areaKey(0, 63, -1)]: "air" }), FROM, []);
  assert.ok(!noSide.spots.some((spot) => spot.x === 0 && spot.z === 0));
  assert.equal(noSide.reasons.no_support, 1);
});

test("an occupant in the best column makes it occupied and the next one is chosen", () => {
  const search = shelterSpots(ground(), FROM, [], [{ x: 0.5, y: 64, z: 0.5 }]);
  assert.notDeepEqual(at(search.spots[0]), [0, 0]);
  assert.equal(search.reasons.occupied, 1);
});

test("a cave under the hole or a protected area move the hole aside", () => {
  const cave = shelterSpots(ground({ [areaKey(0, 60, 0)]: "air" }), FROM, []);
  assert.notDeepEqual(at(cave.spots[0]), [0, 0]);
  assert.ok(cave.reasons.open_floor >= 1);
  const house: ProtectedArea = { regionId: 1, label: "house", owner: "Ayla", min: { x: -1, y: 60, z: -1 }, max: { x: 1, y: 70, z: 1 } };
  const walled = shelterSpots(ground(), FROM, [house]);
  assert.ok(walled.spots.every((spot) => Math.abs(spot.x) > 1 || Math.abs(spot.z) > 1));
  assert.equal(walled.reasons.protected, 9);
});

test("no hole anywhere near on open water, and the reasons say water", () => {
  const search = shelterSpots(ground(square(10, 58, 63, "water")), FROM, []);
  assert.deepEqual(search.spots, []);
  assert.equal(search.reasons.open_walls, COLUMNS);
});

test("describeNoSpot lists the counts largest first with their words", () => {
  const reasons: Record<SpotReason, number> = { open_walls: 80, open_floor: 41, too_hard: 30, unknown_cells: 12, protected: 6, occupied: 0, no_support: 0, no_room: 0 };
  assert.equal(
    describeNoSpot({ spots: [], reasons, columns: COLUMNS }),
    "no ground near here to dig a closed hole in (of 169 columns: 80 water or open walls, 41 cave or open floor, 30 too hard or unbreakable, 12 unknown cells, 6 protected)",
  );
});

const STACKS = (...entries: [string, number, string[]?][]) => entries.map(([name, count, families]) => ({ name, count, families: families ?? [] }));
const ROOF_KINDS: Record<string, BlockKind> = {
  sand: solid(0.5), oak_slab: solid(2, { fullCube: false }), torch: open(), dirt: solid(0.5), cobblestone: solid(2),
};

test("the roof is the largest carried full solid block that does not fall: not sand, a slab or a torch", () => {
  const carried = STACKS(["sand", 30, ["falling_block"]], ["oak_slab", 20], ["torch", 10], ["dirt", 4]);
  assert.equal(roofBlock(carried, ROOF_KINDS), "dirt");
  assert.equal(roofBlock(STACKS(["cobblestone", 5], ["dirt", 9]), ROOF_KINDS), "dirt");
  assert.equal(roofBlock(STACKS(["cobblestone", 5], ["dirt", 9]), ROOF_KINDS, new Set(["dirt"])), "cobblestone");
  assert.equal(roofBlock(STACKS(["sand", 30, ["falling_block"]]), ROOF_KINDS), null);
  assert.equal(roofBlock(STACKS(["dirt", 5], ["cobblestone", 5]), ROOF_KINDS), "cobblestone", "equal stacks tie by name");
  assert.equal(roofBlock(STACKS(["stick", 64]), ROOF_KINDS), null, "a name the kinds do not know");
});

test("rock or a roof over her head is cover; open sky, leaves by tag or a block 25 up are not", () => {
  const over = { x: 0.5, y: 64, z: 0.5 };
  const cells = (names: Record<number, string>): BlockArea => ({ blocks: new Map(Object.entries(names).map(([y, name]) => [areaKey(0, Number(y), 0), name])), kinds: KINDS });
  assert.equal(coverOver(cells({ 66: "air", 70: "air" }), over), false);
  assert.equal(coverOver(cells({ 66: "air", 72: "oak_leaves" }), over), false);
  assert.equal(coverOver(cells({ 66: "air", 80: "oak_planks" }), over), true);
  assert.equal(coverOver(cells({ 95: "stone" }), over), false);
});

test("spotCells: the three dug cells and the four neighbours of each, 15 cells, none twice", () => {
  const spot: ShelterSpot = { x: 0, y: 64, z: 0, support: { x: 1, y: 63, z: 0 }, face: "west", dug: 0, cost: 0 };
  const cells = spotCells(spot);
  assert.equal(cells.length, 15);
  assert.equal(new Set(cells.map(({ x, y, z }) => areaKey(x, y, z))).size, 15);
  assert.deepEqual(cells.filter(({ x, z }) => x === 0 && z === 0).map(({ y }) => y), [63, 62, 61]);
  assert.ok(cells.some(({ x, y, z }) => x === 1 && y === 63 && z === 0), "the roof cell's support side");
  assert.ok(cells.every(({ y }) => y >= 61 && y <= 63), "no cell above the roof cell or under the floor");
});

test("isInHole: the column and the depth, not a neighbour column, not the surface", () => {
  const spot: ShelterSpot = { x: 0, y: 64, z: 0, support: { x: 1, y: 63, z: 0 }, face: "west", dug: 0, cost: 0 };
  assert.equal(isInHole({ x: 0.5, y: 61, z: 0.5 }, spot), true);
  assert.equal(isInHole({ x: 0.5, y: 63, z: 0.5 }, spot), true);
  assert.equal(isInHole({ x: 1.5, y: 61, z: 0.5 }, spot), false);
  assert.equal(isInHole({ x: 0.5, y: 64, z: 0.5 }, spot), false);
  assert.equal(isInHole({ x: 0.5, y: 70, z: 0.5 }, spot), false);
});
