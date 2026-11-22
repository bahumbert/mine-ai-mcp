import assert from "node:assert/strict";
import test from "node:test";
import { houseBillItems } from "./building/house-facts.ts";
import { shapesForMaterials } from "./building/materials.ts";
import { templateFor } from "./building/templates.ts";
import { FakeRuntime } from "./testing.ts";
import { houseReserve } from "./walks.ts";

// Merge review 2026-11-22 S1: an unfinished house is planned with its saved substitute shapes everywhere the agent reads it
// (the bill the model keeps items for, the reserve every get_items and walk keeps), as the build itself plans it.

const medieval = templateFor("medieval-small")!;
const materials = { roof: "oak_planks" } as const;
const shapes = shapesForMaterials(medieval, materials);
const unfinished = { kind: medieval.kind, template: medieval.id, family: medieval.family, site: { door: { x: 0, y: 64, z: 0 }, facing: "north" as const }, part: 0, prepared: true, materials, shapes };

test("the substitute roof of an unfinished house has stairs and slabs (the fixture's premise)", () => {
  assert.deepEqual(shapes, { roof: { stairs: "oak_stairs", slab: "oak_slab" } });
});

test("an unfinished house with a substitute roof needs the roof's stairs and slabs", () => {
  const items = houseBillItems(unfinished);
  assert.ok(items.includes("oak_stairs"), `houseBillItems: ${items.join(", ")}`);
  assert.ok(items.includes("oak_slab"), `houseBillItems: ${items.join(", ")}`);
});

test("the unfinished house's reserve bills the substitute roof's stairs, not full planks for every roof cell", async () => {
  const runtime = new FakeRuntime();
  const withShapes = await houseReserve({ runtime, building: { unfinished } as never });
  const names = withShapes.bill.map((entry) => entry.item);
  assert.ok(names.includes("oak_stairs"), `houseReserve bill: ${JSON.stringify(withShapes.bill)}`);
  const planks = (bill: readonly { item: string; count: number }[]) => bill.find((entry) => entry.item === "oak_planks")?.count ?? 0;
  const { shapes: _gone, ...noShapes } = unfinished;
  const withoutShapes = await houseReserve({ runtime, building: { unfinished: noShapes } as never });
  assert.ok(planks(withShapes.bill) < planks(withoutShapes.bill), "the roof cells that are stairs are not billed as planks");
});
