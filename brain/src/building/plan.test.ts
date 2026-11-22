import assert from "node:assert/strict";
import test from "node:test";
import { billOfMaterials, blueprintSchema, describeMaterials, placeBlueprint, placeSign, type Facing } from "./blueprint.ts";
import { houseBox } from "./house-site.ts";
import { catalogueLine, chooseSite, planTemplate } from "./plan.ts";
import minecraftData from "minecraft-data";
import { TEMPLATES, templateFor, type Template } from "./templates.ts";

const site = chooseSite({ x: 0, y: 64, z: 0 }, null);
const medieval = templateFor("medieval-small")!;

test("sign spot rotates with the door and stays outside the build", () => {
  const expected = {
    north: { x: 1, y: -60, z: -1 }, east: { x: 1, y: -60, z: 1 },
    south: { x: -1, y: -60, z: 1 }, west: { x: -1, y: -60, z: -1 },
  } as const;
  for (const facing of Object.keys(expected) as Facing[]) {
    const plan = planTemplate(medieval, { door: { x: 0, y: -60, z: 0 }, facing });
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

test("every plan carries the sign spot of its template's sign cell", () => {
  for (const template of TEMPLATES.values()) assert.notEqual(planTemplate(template, site).sign, null, template.id);
});

test("blueprint sign validates bounds, occupancy and both doorway walk cells", () => {
  const blueprint = medieval.blueprint;
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

test("a role built with another block takes it in every cell of the role, the others stay the template's", () => {
  const plain = planTemplate(medieval, site);
  const dirt = planTemplate(medieval, site, { wall: "dirt" });
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

test("a block named for a role the template has none for changes nothing and is not kept as a material", () => {
  // medieval has no accent or railing: no cell asks them, so a house "built with" them is the plain house, not a temporary one
  const plain = planTemplate(medieval, site);
  const named = planTemplate(medieval, site, { accent: "dirt", railing: "air", wall: "dirt" });
  assert.deepEqual(named.materials, { wall: "dirt" });
  assert.deepEqual(planTemplate(medieval, site, { accent: "dirt" }).materials, {});
  assert.deepEqual(planTemplate(medieval, site, { accent: "dirt" }).cells, plain.cells);
});

test("pillars and trim built with another block ask no log axis (live 2026-10-10: cobblestone corners never audited right)", () => {
  const plain = planTemplate(medieval, site);
  assert.ok(plain.cells.some((cell) => (cell.role === "pillar" || cell.role === "trim") && cell.axis !== undefined));
  const plan = planTemplate(medieval, site, { pillar: "cobblestone", trim: "cobblestone" });
  const frame = plan.cells.filter((cell) => cell.role === "pillar" || cell.role === "trim");
  assert.ok(frame.length > 0 && frame.every((cell) => cell.block === "cobblestone" && cell.axis === undefined));
});

test("a roof built with another block builds full blocks: the template's stairs and slabs are not asked", () => {
  const plan = planTemplate(medieval, site, { roof: "dirt" });
  const roof = plan.cells.filter((cell) => cell.role === "roof");
  assert.ok(roof.length > 0 && roof.every((cell) => cell.block === "dirt" && cell.facing === undefined && cell.half === undefined));
  assert.ok(plan.bill.every((entry) => entry.item !== "spruce_stairs" && entry.item !== "spruce_slab"));
  assert.ok(planTemplate(medieval, site, { wall: "dirt" }).bill.some((entry) => entry.item === "spruce_stairs"));
  // Legacy oak, with no saved shapes, is full blocks too.
  assert.ok(planTemplate(medieval, site, { roof: "oak_planks" }).cells.filter((cell) => cell.role === "roof").every((cell) => cell.block === "oak_planks" && cell.facing === undefined && cell.half === undefined));
});

// Task 7b bug 2: the classic japanese files give their trim `axis` over dark_oak_planks; the audit asked a state the planks
// lack and the 16 trim cells never counted as right (backlog "Vex's medium japanese house fails part 4/9", runs 15, 16).
test("a cell asks only the states its block has: japanese trim planks ask no axis", () => {
  const plan = planTemplate(templateFor("japanese-medium")!, site);
  const trim = plan.cells.filter((cell) => cell.role === "trim");
  assert.equal(trim.length, 16);
  assert.ok(trim.every((cell) => cell.block === "dark_oak_planks" && cell.axis === undefined));
});

test("every cell of every template names only properties its block has", () => {
  const registry = minecraftData("1.21.4");
  for (const template of TEMPLATES.values()) {
    for (const cell of planTemplate(template, site).cells) {
      const names = new Set((registry.blocksByName[cell.block]?.states ?? []).map((state) => state.name));
      const where = `${template.id} ${cell.x},${cell.y},${cell.z} ${cell.block}`;
      if (cell.axis !== undefined) assert.ok(names.has("axis"), `${where} asks axis`);
      if (cell.facing !== undefined) assert.ok(names.has("facing"), `${where} asks facing`);
      if (cell.half !== undefined) assert.ok(names.has("half") || names.has("type"), `${where} asks half`);
    }
  }
});

test("air windows leave no glass in the bill", () => {
  const plan = planTemplate(medieval, site, { window: "air" });
  assert.ok(plan.bill.every((entry) => entry.item !== "glass_pane" && entry.item !== "air"));
  assert.ok(plan.cells.some((cell) => cell.role === "window" && cell.block === "air"));
});

test("a catalogue line names id, size, floors, blocks, the three main blocks without counts, and the first stage's bill", () => {
  const origin = { x: 0, y: 0, z: 0 };
  const bill = billOfMaterials(placeBlueprint(medieval.blueprint, medieval.palette, origin, "north", medieval.variants));
  const blocks = bill.reduce((sum, { count }) => sum + count, 0);
  const plan = planTemplate(medieval, { door: origin, facing: "north" });
  const first = plan.stages[0]!;
  const mostly = bill.slice(0, 3).map(({ item }) => item).join(", ");
  assert.equal(catalogueLine(medieval), `medieval-small (7x7, 1 floor, ${blocks} blocks, mostly ${mostly}; its first stage, the ${first.name}, takes ${describeMaterials(plan.stageBill(first))}) ${medieval.description}`);
  assert.match(catalogueLine(medieval), /its first stage, the floor, takes 15 cobblestone, 9 oak_planks\)/u);
  assert.doesNotMatch(catalogueLine(medieval).split("; its first stage")[0]!, /mostly [^;]*\d/u, "no count of the main blocks to paste into get_items");
});

test("a catalogue line gives the size of the house as built (merge review 2026-11-22 N1): every shipped template, the rondavel's sign row and the hanok's padding included", () => {
  const sizeOf = (template: Template) => {
    const cells = planTemplate(template, { door: { x: 0, y: 0, z: 0 }, facing: "north" }).cells.filter((cell) => cell.block !== "air");
    const span = (axis: "x" | "z") => Math.max(...cells.map((cell) => cell[axis])) - Math.min(...cells.map((cell) => cell[axis])) + 1;
    return `${span("x")}x${span("z")}`;
  };
  for (const template of TEMPLATES.values()) assert.ok(catalogueLine(template).startsWith(`${template.id} (${sizeOf(template)}, `), `${template.id}: ${catalogueLine(template).slice(0, 40)}`);
  assert.ok(catalogueLine(templateFor("rondavel")!).startsWith("rondavel (7x7, "), "a hut of 7 by 7 cells, its blueprint pads a front row for the sign");
});

test("a substitute roof keeps the template's stair and slab cells when its shapes are supplied", () => {
  const plain = planTemplate(medieval, site);
  const plan = planTemplate(medieval, site, { roof: "oak_planks" }, { roof: { stairs: "oak_stairs", slab: "oak_slab" } });
  const roof = plan.cells.filter((cell) => cell.role === "roof");
  assert.equal(roof.length, plain.cells.filter((cell) => cell.role === "roof").length);
  for (const cell of plain.cells.filter((cell) => cell.role === "roof")) {
    assert.deepEqual(roof.find((other) => other.x === cell.x && other.y === cell.y && other.z === cell.z), {
      ...cell, block: cell.block === "spruce_stairs" ? "oak_stairs" : "oak_slab",
    });
  }
  const stairs = plain.cells.filter((cell) => cell.block === "spruce_stairs").length;
  const slabs = plain.cells.filter((cell) => cell.block === "spruce_slab").length;
  assert.deepEqual(plan.bill.filter((entry) => ["oak_stairs", "oak_slab"].includes(entry.item)), [{ item: "oak_stairs", count: stairs }, { item: "oak_slab", count: slabs }]);
  assert.ok(plan.bill.every((entry) => !entry.item.startsWith("spruce_")));
  assert.deepEqual(plan.materials, { roof: "oak_planks" });
});
