import assert from "node:assert/strict";
import test from "node:test";
import { chooseSite, planHouse } from "./plan.ts";
import { STYLES } from "./styles.ts";
import { billOfMaterials, blueprintSchema, placeSign, type Facing } from "./blueprint.ts";
import { house, HOUSE_SIZES } from "./house.ts";
import { houseBox } from "../skills/build-house.ts";

const site = chooseSite({ x: 0, y: 64, z: 0 }, null);
const medieval = STYLES.get("medieval")!;

test("sign spot rotates with the door for both house sizes and stays outside the build", () => {
  const expected = {
    north: { x: 1, y: -60, z: -1 }, east: { x: 1, y: -60, z: 1 },
    south: { x: -1, y: -60, z: 1 }, west: { x: -1, y: -60, z: -1 },
  } as const;
  for (const size of ["small", "medium"] as const) for (const facing of Object.keys(expected) as Facing[]) {
    const plan = planHouse(medieval, size, { door: { x: 0, y: -60, z: 0 }, facing });
    const spot = plan.sign!;
    assert.deepEqual(spot.position, expected[facing]);
    assert.equal(spot.facing, facing);
    assert.deepEqual(spot.support, { ...spot.position, y: spot.position.y - 1 });
    assert.ok(plan.cells.some((cell) => cell.role === "wall" && cell.x === spot.wall.x && cell.y === spot.wall.y && cell.z === spot.wall.z));
    const box = houseBox(plan.batches.flat());
    for (const axis of ["x", "y", "z"] as const) assert.ok(spot.position[axis] >= box.min[axis] && spot.position[axis] <= box.max[axis]);
    assert.ok(plan.batches.flat().every((cell) => cell.x !== spot.position.x || cell.y !== spot.position.y || cell.z !== spot.position.z));
    assert.deepEqual(plan.bill, billOfMaterials(plan.cells));
  }
});

test("blueprint sign validates bounds, occupancy and both doorway walk cells", () => {
  const blueprint = house({ ...HOUSE_SIZES.small, ...medieval.house });
  const door = blueprint.cells.find((cell) => cell.role === "door")!;
  const sign = blueprint.sign!;
  assert.equal(placeSign({ ...blueprint, sign: undefined }, { x: 0, y: 0, z: 0 }, "north"), null);
  for (const bad of [
    { ...sign, x: blueprint.size.x },
    { ...sign, x: door.x, y: door.y, z: door.z },
    { ...sign, x: door.x, y: door.y, z: door.z - 1 },
    { ...sign, x: door.x, y: door.y + 1, z: door.z - 1 },
  ]) assert.equal(blueprintSchema.safeParse({ ...blueprint, sign: bad }).success, false);
  assert.equal(blueprintSchema.safeParse(blueprint).success, true);
  assert.equal(blueprintSchema.safeParse({ ...blueprint, cells: [...blueprint.cells, { ...sign, role: "air" }] }).success, true);
  assert.equal(placeSign({ ...blueprint, sign: { ...sign, facing: "east" } }, { x: 0, y: 0, z: 0 }, "east")?.facing, "south");
});

test("a role built with another block takes it in every cell of the role, the others stay the style's", () => {
  const plain = planHouse(medieval, "small", site);
  const dirt = planHouse(medieval, "small", site, { wall: "dirt" });
  assert.equal(dirt.cells.length, plain.cells.length);
  plain.cells.forEach((cell, index) => {
    const other = dirt.cells[index]!;
    assert.equal(other.block, cell.role === "wall" ? "dirt" : cell.block, `${cell.x},${cell.y},${cell.z} ${cell.role}`);
  });
  assert.deepEqual(dirt.materials, { wall: "dirt" });
  assert.deepEqual(plain.materials, {});
  assert.equal(dirt.bill.find((entry) => entry.item === "dirt")?.count, plain.cells.filter((cell) => cell.role === "wall").length);
  assert.equal(dirt.bill.find((entry) => entry.item === "oak_planks")?.count, 36 - plain.cells.filter((cell) => cell.role === "wall").length);
});

test("pillars and trim built with another block ask no log axis (live 2026-10-10: cobblestone corners never audited right)", () => {
  const plain = planHouse(medieval, "small", site);
  assert.ok(plain.cells.some((cell) => (cell.role === "pillar" || cell.role === "trim") && cell.axis !== undefined));
  const plan = planHouse(medieval, "small", site, { pillar: "cobblestone", trim: "cobblestone" });
  const frame = plan.cells.filter((cell) => cell.role === "pillar" || cell.role === "trim");
  assert.ok(frame.length > 0 && frame.every((cell) => cell.block === "cobblestone" && cell.axis === undefined));
});

test("a substitute roof without saved shapes stays 49 full blocks, including legacy oak", () => {
  for (const block of ["dirt", "oak_planks"]) {
    const plan = planHouse(medieval, "small", site, { roof: block });
    const roof = plan.cells.filter((cell) => cell.role === "roof");
    assert.equal(roof.length, 49);
    assert.ok(roof.every((cell) => cell.block === block && cell.facing === undefined && cell.half === undefined));
    assert.ok(plan.bill.every((entry) => entry.item !== "spruce_stairs" && entry.item !== "spruce_slab"));
  }
});

test("air windows leave no glass in the bill", () => {
  const plan = planHouse(medieval, "small", site, { window: "air" });
  assert.ok(plan.bill.every((entry) => entry.item !== "glass_pane" && entry.item !== "air"));
  assert.ok(plan.cells.some((cell) => cell.role === "window" && cell.block === "air"));
});

test("a substitute roof keeps the style's stair and slab cells when its shapes are supplied", () => {
  const plain = planHouse(medieval, "small", site);
  const plan = planHouse(medieval, "small", site, { roof: "oak_planks" }, { roof: { stairs: "oak_stairs", slab: "oak_slab" } });
  const roof = plan.cells.filter((cell) => cell.role === "roof");
  assert.equal(roof.length, 49);
  for (const cell of plain.cells.filter((cell) => cell.role === "roof")) {
    assert.deepEqual(roof.find((other) => other.x === cell.x && other.y === cell.y && other.z === cell.z), {
      ...cell, block: cell.block === "spruce_stairs" ? "oak_stairs" : "oak_slab",
    });
  }
  assert.deepEqual(plan.bill.filter((entry) => ["oak_stairs", "oak_slab"].includes(entry.item)), [{ item: "oak_stairs", count: 42 }, { item: "oak_slab", count: 7 }]);
  assert.ok(plan.bill.every((entry) => !entry.item.startsWith("spruce_")));
  assert.deepEqual(plan.materials, { roof: "oak_planks" });
});
