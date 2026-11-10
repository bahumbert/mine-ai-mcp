import assert from "node:assert/strict";
import test from "node:test";
import { chooseSite, planTemplate } from "./plan.ts";
import { templateFor } from "./templates.ts";

const site = chooseSite({ x: 0, y: 64, z: 0 }, null);
const medieval = templateFor("medieval-small")!;

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
});

test("air windows leave no glass in the bill", () => {
  const plan = planTemplate(medieval, site, { window: "air" });
  assert.ok(plan.bill.every((entry) => entry.item !== "glass_pane" && entry.item !== "air"));
  assert.ok(plan.cells.some((cell) => cell.role === "window" && cell.block === "air"));
});
