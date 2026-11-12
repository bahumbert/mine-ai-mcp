// What a stage needs from the ground up: the cells out of reach of a bot standing on the site's level need blocks to stand on.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SCAFFOLD_BLOCKS } from "../testing.ts";
import type { WorldCell } from "./blueprint.ts";
import { planTemplate } from "./plan.ts";
import { BUILD_REACH, fetchClause, missingForStage, scaffoldKinds, scaffoldNeed } from "./stage-progress.ts";
import { templateFor } from "./templates.ts";

const DOOR_Y = 76;
const cellAt = (above: number, block = "spruce_planks"): WorldCell => ({ x: 0, y: DOOR_Y + above, z: 0, block, role: block === "air" ? "air" : "roof" });
const without = (...kinds: string[]) => DEFAULT_SCAFFOLD_BLOCKS.filter((block) => !kinds.includes(block));
const dirt = (count: number) => [{ name: "dirt", count }];

test("BUILD_REACH is the runtime's (src/navigation/processes/building/build-process.ts)", () => {
  assert.equal(BUILD_REACH, 4);
});

test("a stage needs a column of blocks to stand on for its cells BUILD_REACH or more above the ground, unless enough are carried", () => {
  const cases: { name: string; cells: WorldCell[]; carried?: { name: string; count: number }[]; kept?: string[]; unread?: true; need: { count: number; height: number; admitted: readonly string[] } | null }[] = [
    { name: "all within reach", cells: [cellAt(1), cellAt(2), cellAt(BUILD_REACH - 1)], need: null },
    { name: "no cells", cells: [], need: null },
    { name: "Bruno's roof: top 5 above the door, 4 blocks (Mine Labs placed 4 in one roof call)", cells: [cellAt(1), cellAt(5)], need: { count: 4, height: 5, admitted: DEFAULT_SCAFFOLD_BLOCKS } },
    { name: "the first cell out of reach: two columns of the one height it lacks", cells: [cellAt(BUILD_REACH)], need: { count: 2, height: 4, admitted: DEFAULT_SCAFFOLD_BLOCKS } },
    { name: "the pagoda's roof, 8 above", cells: [cellAt(8)], need: { count: 10, height: 8, admitted: DEFAULT_SCAFFOLD_BLOCKS } },
    { name: "an air cell is dug clear, not placed", cells: [cellAt(5, "air")], need: null },
    { name: "the house's own blocks are not offered", cells: [cellAt(5)], kept: ["cobblestone", "spruce_planks"], need: { count: 4, height: 5, admitted: without("cobblestone") } },
    { name: "every admitted block is a house block: fetching one cannot help", cells: [cellAt(5)], kept: [...DEFAULT_SCAFFOLD_BLOCKS], need: null },
    { name: "1 dirt of 4 needed still stops", cells: [cellAt(5)], carried: dirt(1), need: { count: 4, height: 5, admitted: DEFAULT_SCAFFOLD_BLOCKS } },
    { name: "4 blocks of the admitted kinds together cover it", cells: [cellAt(5)], carried: [{ name: "dirt", count: 3 }, { name: "basalt", count: 1 }], need: null },
    { name: "a block the policy does not admit is no scaffold", cells: [cellAt(5)], carried: [{ name: "oak_planks", count: 64 }], need: { count: 4, height: 5, admitted: DEFAULT_SCAFFOLD_BLOCKS } },
    { name: "carried cobblestone of the bill is kept for the house", cells: [cellAt(5)], carried: [{ name: "cobblestone", count: 64 }], kept: ["cobblestone"], need: { count: 4, height: 5, admitted: without("cobblestone") } },
    { name: "no policy read: the runtime's refusal says why it could not stand", cells: [cellAt(5)], unread: true, need: null },
  ];
  for (const { name, cells, carried = [], kept = [], unread = false, need } of cases) {
    assert.deepEqual(scaffoldNeed(cells, DOOR_Y, carried, unread ? undefined : DEFAULT_SCAFFOLD_BLOCKS, kept), need, name);
  }
});

test("a new house's refusal offers 'materials' only for items: other blocks do not remove a need to stand on", () => {
  const plan = planTemplate(templateFor("medieval-small")!, { door: { x: 0, y: 64, z: 2 }, facing: "north" });
  const standOn = { count: 4, height: 5, admitted: ["dirt"] };
  const items = { missing: [{ item: "oak_planks", count: 2 }], owedNote: "", scaffold: null };
  assert.match(missingForStage(plan, 0, "a house", items, { fresh: true }), /or build that stage from blocks you carry with "materials"/u);
  assert.doesNotMatch(missingForStage(plan, 0, "a house", { ...items, scaffold: standOn }, { fresh: true }), /"materials"/u);
  assert.match(missingForStage(plan, 0, "a house", { missing: [], owedNote: "", scaffold: standOn }, { fresh: true }), /^missing about 4 blocks to stand on for its cells 5 above the ground .*; or choose another house/u);
});

test("scaffoldKinds names the admitted kinds a walk must not spend: only while every carried block is needed", () => {
  const kinds = (cells: WorldCell[], carried: { name: string; count: number }[] = [], options: { kept?: string[] } = {}) => scaffoldKinds(cells, DOOR_Y, carried, DEFAULT_SCAFFOLD_BLOCKS, options.kept ?? []);
  assert.deepEqual(kinds([cellAt(1), cellAt(BUILD_REACH - 1)]), [], "all within reach");
  assert.deepEqual(kinds([cellAt(1), cellAt(5)]), DEFAULT_SCAFFOLD_BLOCKS, "a high cell, none carried: the kinds that would be fetched");
  assert.deepEqual(kinds([cellAt(5)], dirt(4)), DEFAULT_SCAFFOLD_BLOCKS, "4 dirt carried for a count of 4: every block is needed");
  assert.deepEqual(kinds([cellAt(5)], dirt(5)), [], "5 carried for a count of 4: a surplus the walk may bridge with");
  assert.deepEqual(kinds([cellAt(5)], dirt(64)), [], "64 dirt: the walk may bridge");
  assert.deepEqual(kinds([cellAt(5)], [], { kept: [...DEFAULT_SCAFFOLD_BLOCKS] }), [], "every admitted kind is a house block (the rest of the cases are scaffoldNeed's table)");
});

test("the fetch clause says 'exactly' for the items only and names the blocks to stand on by 'N or more'", () => {
  const standOn = { count: 4, height: 5, admitted: DEFAULT_SCAFFOLD_BLOCKS };
  assert.equal(fetchClause({ missing: [{ item: "oak_planks", count: 2 }], scaffold: null }), "fetch exactly the missing items with get_items");
  assert.equal(fetchClause({ missing: [{ item: "oak_planks", count: 2 }], scaffold: standOn }), "fetch exactly the missing items and 4 or more blocks to stand on with get_items");
  assert.equal(fetchClause({ missing: [], scaffold: standOn }), "fetch 4 or more blocks to stand on with get_items");
});
