import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeWorld, type FakeCell } from "./fake-world.js";

const VERSION = "1.21.4";
const at = (x: number, y: number, z: number) => new Vec3(x, y, z);
const lightOf = (world: ReturnType<typeof createFakeWorld>, cell: Vec3) => {
  const block = world.blockAt(cell)!;
  return { sky: block.skyLight, block: block.light };
};

/** A stone box of walls and roof around the cells `inside`, on a floor at y -1 (the box's floor included): every cell of x -1..width, z -1..1, y 0..1 not inside. */
function boxAround(inside: readonly Vec3[], width: number): Record<string, FakeCell> {
  const insideKeys = new Set(inside.map((cell) => `${cell.x},${cell.y},${cell.z}`));
  const cells: Record<string, FakeCell> = {};
  for (let x = -1; x <= width; x++) for (let y = 0; y <= 1; y++) for (let z = -1; z <= 1; z++) if (!insideKeys.has(`${x},${y},${z}`)) cells[`${x},${y},${z}`] = "stone";
  return cells;
}

// The measured shapes (open air, a closed box, a torch's row at 1-3 cells) are asserted on the fake by contract check `light-in-cells` (bot-contract.test.ts).
// Every shape below is unmeasured, so the fake says nothing: undefined, never 0.
const SEALED_ROW = [0, 1, 2, 3, 4, 5].map((x) => at(x, 0, 0));
const LEAKING_BOX = (() => {
  const walls = boxAround([at(0, 0, 0)], 1);
  delete walls["1,0,0"];
  return walls;
})();
const UNMEASURED_SHAPES: readonly [name: string, cells: Record<string, FakeCell>, probe: Vec3, expected: { sky: number | undefined; block: number | undefined }][] = [
  ["a sealed region with a torch 4 cells away (the measure stops at 3)", { ...boxAround(SEALED_ROW, 6), "0,0,0": "torch" }, at(4, 0, 0), { sky: 0, block: undefined }],
  ["a box with a gap in a wall", LEAKING_BOX, at(0, 0, 0), { sky: undefined, block: undefined }],
  ["a solid block", { "0,0,5": "stone" }, at(0, 0, 5), { sky: undefined, block: undefined }],
  ["a slab", { "0,0,6": "oak_slab" }, at(0, 0, 6), { sky: undefined, block: undefined }],
  ["air under an overhang", { "5,2,5": "stone" }, at(5, 1, 5), { sky: undefined, block: undefined }],
  ["a sealed box with a glowstone wall (an emitter that is no torch)", { ...boxAround([at(0, 0, 0)], 1), "1,0,0": "glowstone" }, at(0, 0, 0), { sky: undefined, block: undefined }],
  ["open air beside glowstone", { "4,0,0": "glowstone" }, at(3, 0, 0), { sky: 15, block: undefined }],
  ["open air 3 cells from a torch standing in the open", { "0,0,0": "torch" }, at(3, 0, 0), { sky: 15, block: undefined }],
];

test("an unmeasured shape leaves what it does not know undefined, the sky it does know alone", () => {
  for (const [name, cells, probe, expected] of UNMEASURED_SHAPES) assert.deepEqual(lightOf(createFakeWorld(VERSION, { groundY: -1, cells }), probe), expected, name);
});

test("a torch in open air does not reach cells past its 15 cells: they are open air again", () => {
  const world = createFakeWorld(VERSION, { groundY: -1, cells: { "0,0,0": "torch" } });
  assert.deepEqual(lightOf(world, at(40, 0, 0)), { sky: 15, block: 0 });
});

test("a cell in a section above the one over the highest block holds no light, where the real client holds 0 and 0 with no section", () => {
  const world = createFakeWorld(VERSION, { groundY: -61 });
  assert.deepEqual(lightOf(world, at(0, -60, 0)), { sky: 15, block: 0 });
  assert.deepEqual(lightOf(world, at(0, -13, 0)), { sky: undefined, block: undefined });
});

test("the light follows a block placed later, and a test's own assignment wins", () => {
  const world = createFakeWorld(VERSION, { groundY: -1, cells: boxAround([at(0, 0, 0)], 1) });
  world.setCell(at(1, 0, 0), "air");
  assert.deepEqual(lightOf(world, at(0, 0, 0)), { sky: undefined, block: undefined }, "the wall removed: the shape is unmeasured");
  const block = world.blockAt(at(5, 0, 5))!;
  block.skyLight = 7;
  assert.equal(block.skyLight, 7);
  assert.equal(block.light, 0, "the other field is still the measured one");
});

test("the world answers `getColumnAt` as prismarine-world does: the loaded column holding the point, none where no chunk was sent", () => {
  const world = createFakeWorld(VERSION, { groundY: -1, loadedColumns: [[0, 0]] });
  assert.equal(world.getColumnAt(at(15.5, 3, 0.2)), world.getColumn(0, 0));
  assert.equal(world.getColumnAt(at(-0.5, 3, 0)), undefined);
});
