import assert from "node:assert/strict";
import test from "node:test";
import type { BlockKind } from "../runtime-client.ts";
import { checkMaterials, improvement, temporaryRoles } from "./materials.ts";
import { STYLES } from "./styles.ts";

const medieval = STYLES.get("medieval")!;
const full: BlockKind = { tool: "shovel", solid: true, fullCube: true, harvest: null };
const kinds: Record<string, BlockKind> = {
  dirt: full,
  cobblestone: { ...full, tool: "pickaxe" },
  oak_stairs: { ...full, fullCube: false },
  glass_pane: { ...full, fullCube: false },
  glass: { ...full, fullCube: true },
  spruce_door: { tool: "axe", solid: false, fullCube: false, harvest: null, tags: ["doors", "wooden_doors"] },
  oak_slab: { ...full, fullCube: false, tags: ["slabs"] },
};

test("valid materials are accepted, none are accepted", () => {
  assert.equal(checkMaterials({}, medieval, kinds), null);
  assert.equal(checkMaterials({ wall: "dirt", roof: "cobblestone", window: "air", door: "spruce_door" }, medieval, kinds), null);
  assert.equal(checkMaterials({ window: "glass_pane" }, medieval, kinds), null);
});

test("an unknown block id is refused, naming the role and the style's block", () => {
  assert.equal(checkMaterials({ wall: "stone_blok" }, medieval, kinds), "wall: stone_blok is no block id (your style uses oak_planks).");
});

test("a structural role needs a full block", () => {
  assert.equal(checkMaterials({ roof: "oak_stairs" }, medieval, kinds), "roof: oak_stairs is not a full block (your style uses spruce_planks).");
  assert.match(checkMaterials({ foundation: "oak_slab" }, medieval, kinds)!, /^foundation: oak_slab is not a full block \(your style uses cobblestone\)\.$/u);
});

test("a door needs the game's doors tag", () => {
  assert.equal(checkMaterials({ door: "dirt" }, medieval, kinds), "door: dirt is not a door (your style uses oak_door).");
});

test("every bad role gets its own sentence", () => {
  const refusal = checkMaterials({ wall: "stone_blok", door: "dirt" }, medieval, kinds)!;
  assert.match(refusal, /wall: stone_blok is no block id/u);
  assert.match(refusal, /door: dirt is not a door/u);
});

test("the temporary roles are those whose block differs from the style", () => {
  assert.deepEqual(temporaryRoles({}, medieval), []);
  assert.deepEqual(temporaryRoles({ wall: "oak_planks", roof: "dirt", window: "air" }, medieval), ["roof", "window"]);
});

test("improving walls charges only 27 planks and preserves the roof's saved shapes or legacy full blocks", () => {
  for (const row of [
    { block: "dirt", shapes: undefined },
    { block: "oak_planks", shapes: undefined },
    { block: "oak_planks", shapes: { roof: { stairs: "oak_stairs", slab: "oak_slab" } } },
  ]) {
    const house = { size: "small" as const, door: { x: 0, y: 64, z: 0 }, facing: "north" as const, materials: { wall: "dirt", roof: row.block }, shapes: row.shapes };
    const walls = improvement(medieval, house, ["wall"]);
    assert.deepEqual(walls.bill, [{ item: "oak_planks", count: 27 }]);
    assert.deepEqual(walls.rest, { roof: row.block });
    const roof = walls.after.cells.filter((cell) => cell.role === "roof");
    assert.equal(roof.length, 49);
    if (row.shapes === undefined) assert.ok(roof.every((cell) => cell.block === row.block && cell.half === undefined && cell.facing === undefined));
    else {
      assert.equal(roof.filter((cell) => cell.block === "oak_stairs" && cell.half === "bottom" && cell.facing !== undefined).length, 42);
      assert.equal(roof.filter((cell) => cell.block === "oak_slab" && cell.half === "bottom").length, 7);
    }
  }
});

test("restoring temporary roles clears them and charges the style's changed cells", () => {
  const house = { size: "small" as const, door: { x: 0, y: 64, z: 0 }, facing: "north" as const };
  const all = improvement(medieval, { ...house, materials: { wall: "dirt", roof: "dirt" } }, ["wall", "roof"]);
  assert.deepEqual(all.rest, {});
  assert.ok(all.bill.some((entry) => entry.item === "spruce_stairs") && all.bill.every((entry) => entry.item !== "dirt"));
  const roof = improvement(medieval, { ...house, materials: { roof: "oak_planks" }, shapes: { roof: { stairs: "oak_stairs", slab: "oak_slab" } } }, ["roof"]);
  assert.deepEqual(roof.bill, [{ item: "spruce_stairs", count: 42 }, { item: "spruce_slab", count: 7 }]);
  assert.deepEqual(roof.rest, {});
});
