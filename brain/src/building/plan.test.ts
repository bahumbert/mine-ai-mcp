import assert from "node:assert/strict";
import test from "node:test";
import { chooseSite, planHouse } from "./plan.ts";
import { STYLES } from "./styles.ts";

const site = chooseSite({ x: 0, y: 64, z: 0 }, null);
const medieval = STYLES.get("medieval")!;

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

test("a roof built with another block builds full blocks: the style's stairs and slabs are not asked", () => {
  const plan = planHouse(medieval, "small", site, { roof: "dirt" });
  const roof = plan.cells.filter((cell) => cell.role === "roof");
  assert.ok(roof.length > 0 && roof.every((cell) => cell.block === "dirt" && cell.facing === undefined && cell.half === undefined));
  assert.ok(plan.bill.every((entry) => entry.item !== "spruce_stairs" && entry.item !== "spruce_slab"));
  assert.ok(planHouse(medieval, "small", site, { wall: "dirt" }).bill.some((entry) => entry.item === "spruce_stairs"));
});

test("air windows leave no glass in the bill", () => {
  const plan = planHouse(medieval, "small", site, { window: "air" });
  assert.ok(plan.bill.every((entry) => entry.item !== "glass_pane" && entry.item !== "air"));
  assert.ok(plan.cells.some((cell) => cell.role === "window" && cell.block === "air"));
});
