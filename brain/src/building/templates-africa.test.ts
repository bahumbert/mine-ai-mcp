import assert from "node:assert/strict";
import test from "node:test";
import { chooseSite, planTemplate } from "./plan.ts";
import { TEMPLATES, templateFor } from "./templates.ts";

const AFRICA = ["rondavel", "sahel-mud-house", "ndebele-house"] as const;
const nonAirCells = (id: string) => TEMPLATES.get(id)!.blueprint.cells.filter((cell) => cell.role !== "air").length;

test("the three africa houses are in the africa family, each at most 700 cells and one small enough for one fetch", () => {
  for (const id of AFRICA) {
    assert.equal(templateFor(id)?.family, "africa", id);
    assert.ok(nonAirCells(id) <= 700, `${id} has ${nonAirCells(id)} cells`);
  }
  assert.ok(AFRICA.some((id) => nonAirCells(id) <= 200), "one africa house has at most 200 cells");
});

test("the rondavel declares its floor, walls and roof stages", () => {
  const plan = planTemplate(templateFor("rondavel")!, chooseSite({ x: 0, y: 64, z: 0 }, null));
  assert.deepEqual(plan.stages.map((stage) => stage.name), ["floor", "walls", "roof"]);
});
