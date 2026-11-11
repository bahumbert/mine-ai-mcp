// What a stage needs from the ground up: the cells out of reach of a bot standing on the site's level need blocks to stand on.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SCAFFOLD_BLOCKS } from "../testing.ts";
import type { WorldCell } from "./blueprint.ts";
import { planTemplate } from "./plan.ts";
import { BUILD_REACH, missingForStage, scaffoldNeed } from "./stage-progress.ts";
import { templateFor } from "./templates.ts";

const DOOR_Y = 76;
const cellAt = (above: number, block = "spruce_planks"): WorldCell => ({ x: 0, y: DOOR_Y + above, z: 0, block, role: block === "air" ? "air" : "roof" });
const without = (...kinds: string[]) => DEFAULT_SCAFFOLD_BLOCKS.filter((block) => !kinds.includes(block));
const dirt = (count: number) => [{ name: "dirt", count }];

test("BUILD_REACH is the runtime's (src/navigation/processes/building/build-process.ts:67)", () => {
  assert.equal(BUILD_REACH, 4);
});

test("a stage needs a column of blocks to stand on for its cells BUILD_REACH or more above the ground, unless enough are carried", () => {
  const cases: { name: string; cells: WorldCell[]; carried?: { name: string; count: number }[]; kept?: string[]; unread?: true; need: { count: number; height: number; admitted: readonly string[] } | null }[] = [
    { name: "all within reach", cells: [cellAt(1), cellAt(2), cellAt(BUILD_REACH - 1)], need: null },
    { name: "no cells", cells: [], need: null },
    { name: "Bruno's roof: top 5 above the door, 3 blocks", cells: [cellAt(1), cellAt(5)], need: { count: 3, height: 5, admitted: DEFAULT_SCAFFOLD_BLOCKS } },
    { name: "the first cell out of reach: the column of one plus the route's own step", cells: [cellAt(BUILD_REACH)], need: { count: 2, height: 4, admitted: DEFAULT_SCAFFOLD_BLOCKS } },
    { name: "the pagoda's roof, 8 above", cells: [cellAt(8)], need: { count: 6, height: 8, admitted: DEFAULT_SCAFFOLD_BLOCKS } },
    { name: "an air cell is dug clear, not placed", cells: [cellAt(5, "air")], need: null },
    { name: "the house's own blocks are not offered", cells: [cellAt(5)], kept: ["cobblestone", "spruce_planks"], need: { count: 3, height: 5, admitted: without("cobblestone") } },
    { name: "every admitted block is a house block: fetching one cannot help", cells: [cellAt(5)], kept: [...DEFAULT_SCAFFOLD_BLOCKS], need: null },
    { name: "1 dirt of 3 needed still stops", cells: [cellAt(5)], carried: dirt(1), need: { count: 3, height: 5, admitted: DEFAULT_SCAFFOLD_BLOCKS } },
    { name: "3 blocks of the admitted kinds together cover it", cells: [cellAt(5)], carried: [{ name: "dirt", count: 2 }, { name: "basalt", count: 1 }], need: null },
    { name: "a block the policy does not admit is no scaffold", cells: [cellAt(5)], carried: [{ name: "oak_planks", count: 64 }], need: { count: 3, height: 5, admitted: DEFAULT_SCAFFOLD_BLOCKS } },
    { name: "carried cobblestone of the bill is kept for the house", cells: [cellAt(5)], carried: [{ name: "cobblestone", count: 64 }], kept: ["cobblestone"], need: { count: 3, height: 5, admitted: without("cobblestone") } },
    { name: "no policy read: the runtime's refusal says why it could not stand", cells: [cellAt(5)], unread: true, need: null },
  ];
  for (const { name, cells, carried = [], kept = [], unread = false, need } of cases) {
    assert.deepEqual(scaffoldNeed(cells, DOOR_Y, carried, unread ? undefined : DEFAULT_SCAFFOLD_BLOCKS, kept), need, name);
  }
});

test("a new house's refusal offers 'materials' only for items: other blocks do not remove a need to stand on", () => {
  const plan = planTemplate(templateFor("medieval-small")!, { door: { x: 0, y: 64, z: 2 }, facing: "north" });
  const standOn = { count: 3, height: 5, admitted: ["dirt"] };
  const items = { missing: [{ item: "oak_planks", count: 2 }], owedNote: "", scaffold: null };
  assert.match(missingForStage(plan, 0, "a house", items, { fresh: true }), /or build that stage from blocks you carry with "materials"/u);
  assert.doesNotMatch(missingForStage(plan, 0, "a house", { ...items, scaffold: standOn }, { fresh: true }), /"materials"/u);
  assert.match(missingForStage(plan, 0, "a house", { missing: [], owedNote: "", scaffold: standOn }, { fresh: true }), /^missing about 3 blocks to stand on for its cells 5 above the ground .*; or choose another house/u);
});
