// What a stage needs from the ground up: the cells out of reach of a bot standing on the site's level need blocks to stand on.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SCAFFOLD_BLOCKS } from "../testing.ts";
import type { WorldCell } from "./blueprint.ts";
import { planTemplate } from "./plan.ts";
import { fetchClause, missingForStage, scaffoldNeed, scaffoldReserve, callWorks, stageCells } from "./stage-progress.ts";
import { templateFor } from "./templates.ts";

const DOOR_Y = 76;
const cellAt = (above: number, block = "spruce_planks"): WorldCell => ({ x: 0, y: DOOR_Y + above, z: 0, block, role: block === "air" ? "air" : "roof" });
const without = (...kinds: string[]) => DEFAULT_SCAFFOLD_BLOCKS.filter((block) => !kinds.includes(block));
const dirt = (count: number) => [{ name: "dirt", count }];

/** The first height above the feet where a cell straight over the bot is out of the eye's reach (its lower face 7 above: 5.38 from the eye at 1.62). */
const FIRST_OUT_OF_REACH = 7;

test("a stage needs the blocks of the stand columns that serve its cells the eye cannot reach from the ground, unless enough are carried", () => {
  const cases: { name: string; cells: WorldCell[]; carried?: { name: string; count: number }[]; kept?: string[]; unread?: true; need: { count: number; height: number; admitted: readonly string[] } | null }[] = [
    { name: "all within reach", cells: [cellAt(1), cellAt(2), cellAt(FIRST_OUT_OF_REACH - 1)], need: null },
    { name: "no cells", cells: [], need: null },
    { name: "Bruno's roof, top 5 above the door (count 4 by the old feet rule): the eye reaches it from the ground", cells: [cellAt(1), cellAt(5)], need: null },
    { name: "the first cell out of reach: a column of one block", cells: [cellAt(FIRST_OUT_OF_REACH)], need: { count: 1, height: 7, admitted: DEFAULT_SCAFFOLD_BLOCKS } },
    { name: "a cell 8 above the ground on a tower: a 2-block column beside it (scenario roof-cell-from-a-stand-column)", cells: [cellAt(8)], need: { count: 2, height: 8, admitted: DEFAULT_SCAFFOLD_BLOCKS } },
    { name: "12 above: the column grows with the height", cells: [cellAt(1), cellAt(12)], need: { count: 6, height: 12, admitted: DEFAULT_SCAFFOLD_BLOCKS } },
    { name: "an air cell is dug clear, not placed", cells: [cellAt(8, "air")], need: null },
    { name: "the house's own blocks are not offered", cells: [cellAt(8)], kept: ["cobblestone", "spruce_planks"], need: { count: 2, height: 8, admitted: without("cobblestone") } },
    { name: "every admitted block is a house block: fetching one cannot help", cells: [cellAt(8)], kept: [...DEFAULT_SCAFFOLD_BLOCKS], need: null },
    { name: "1 dirt of 2 needed still stops", cells: [cellAt(8)], carried: dirt(1), need: { count: 2, height: 8, admitted: DEFAULT_SCAFFOLD_BLOCKS } },
    { name: "2 blocks of the admitted kinds together cover it", cells: [cellAt(8)], carried: [{ name: "dirt", count: 1 }, { name: "basalt", count: 1 }], need: null },
    { name: "a block the policy does not admit is no scaffold", cells: [cellAt(8)], carried: [{ name: "oak_planks", count: 64 }], need: { count: 2, height: 8, admitted: DEFAULT_SCAFFOLD_BLOCKS } },
    { name: "carried cobblestone of the bill is kept for the house", cells: [cellAt(8)], carried: [{ name: "cobblestone", count: 64 }], kept: ["cobblestone"], need: { count: 2, height: 8, admitted: without("cobblestone") } },
    { name: "no policy read: the runtime's refusal says why it could not stand", cells: [cellAt(8)], unread: true, need: null },
  ];
  for (const { name, cells, carried = [], kept = [], unread = false, need } of cases) {
    assert.deepEqual(scaffoldNeed([{ cells, built: [] }], DOOR_Y, carried, unread ? undefined : DEFAULT_SCAFFOLD_BLOCKS, kept), need, name);
  }
});

/** The cells of the stage `stage` of template `id` with the door at y 64 (walking level 64), and what the brain says that stage needs to stand on from there. */
function needOfStage(id: string, stage: string) {
  const plan = planTemplate(templateFor(id)!, { door: { x: 0, y: 64, z: 2 }, facing: "north" });
  const found = plan.stages.find((candidate) => candidate.name === stage)!;
  const cells = stageCells(plan, found);
  return { plan, found, cells, need: scaffoldNeed(callWorks(plan, found, cells), 64, [], DEFAULT_SCAFFOLD_BLOCKS, []) };
}

test("the hanok roof (191 cells) and the medieval-small roof (43 cells) ask no blocks to stand on: the runtime needs 0 columns for both (plan 2026-11-14-house-build-fixes-2 Task 2a)", () => {
  for (const [id, cellCount] of [["hanok", 191], ["medieval-small", 43]] as const) {
    const { cells, need } = needOfStage(id, "roof");
    assert.equal(cells.length, cellCount, `${id}: the roof's cells`);
    assert.equal(need, null, id);
  }
});

/** The runtime's planned columns per roof call of the saltbox, summed heights (`.agent/scripts/scenario/house-stand-columns-per-call.ts saltbox`: calls 9, 10, 11). */
const SALTBOX_RUNTIME_PER_CALL = [6, 10, 11];

test("adobe-pueblo's upper level asks the runtime's 4 blocks or more, never the 2 of a count that ignored the earlier stages (live scenario 0 of 4: 'no scaffold block carried to stand on')", () => {
  const { need } = needOfStage("adobe-pueblo", "upper level");
  assert.equal(need!.count, 5, "the footprint's middle as the tie-break: 5 here, 4 at the door (the bot's own place is not known)");
});

test("the saltbox roof's count is the runtime's per-call maximum or more, and the reserve of the whole house gives the same: one function for the stage's check and a floor's walk (the walk kept 10, the roof asked 12)", () => {
  const { plan, need } = needOfStage("saltbox", "roof");
  assert.equal(need?.height, 9);
  assert.ok(need!.count >= Math.max(...SALTBOX_RUNTIME_PER_CALL), `count ${need!.count} against the runtime's ${SALTBOX_RUNTIME_PER_CALL.join(", ")}`);
  const last = plan.stages.at(-1)!.last;
  const fromFloor = scaffoldReserve(callWorks(plan, { first: 0, last }, stageCells(plan, { first: 0, last })), 64, DEFAULT_SCAFFOLD_BLOCKS, []);
  assert.deepEqual(fromFloor, DEFAULT_SCAFFOLD_BLOCKS.map((item) => ({ item, count: need!.count })));
});

test("a call's work is its cells still to place with the cells standing then: the calls before, and the house's own already right (a resumed stage), air left out; the calls after are not there yet", () => {
  const { plan } = needOfStage("saltbox", "roof");
  const roof = plan.stages.find((stage) => stage.name === "roof")!;
  const cells = stageCells(plan, roof);
  const works = callWorks(plan, roof, cells);
  assert.deepEqual(works.map((work) => work.cells.length), [35, 24, 20, 9], "the roof's four calls, each cell in its last call");
  const keys = (list: readonly WorldCell[]) => new Set(list.map(({ x, y, z }) => `${x},${y},${z}`));
  works.forEach((work, index) => {
    assert.ok(work.built.every((cell) => cell.block !== "air"), "no air cell stands");
    assert.ok(work.cells.every((cell) => !keys(work.built).has(`${cell.x},${cell.y},${cell.z}`)), "its own cells to place do not stand");
    const before = works.slice(0, index).flatMap((earlier) => earlier.cells);
    assert.ok(before.every((cell) => keys(work.built).has(`${cell.x},${cell.y},${cell.z}`)), "the calls before stand");
    const after = works.slice(index + 1).flatMap((later) => later.cells);
    assert.ok(after.every((cell) => !keys(work.built).has(`${cell.x},${cell.y},${cell.z}`)), "the calls after are not there yet");
  });
  const resumed = callWorks(plan, roof, cells.slice(1));
  assert.equal(resumed[0]!.built.length, works[0]!.built.length + 1, "the one cell already right stands");
});

test("a new house's refusal offers 'materials' only for items: other blocks do not remove a need to stand on", () => {
  const plan = planTemplate(templateFor("medieval-small")!, { door: { x: 0, y: 64, z: 2 }, facing: "north" });
  const standOn = { count: 4, height: 5, admitted: ["dirt"] };
  const items = { missing: [{ item: "oak_planks", count: 2 }], owedNote: "", scaffold: null };
  assert.match(missingForStage(plan, 0, "a house", items, { fresh: true }), /or build that stage from blocks you carry with "materials"/u);
  assert.doesNotMatch(missingForStage(plan, 0, "a house", { ...items, scaffold: standOn }, { fresh: true }), /"materials"/u);
  assert.match(missingForStage(plan, 0, "a house", { missing: [], owedNote: "", scaffold: standOn }, { fresh: true }), /^missing about 4 blocks to stand on for its cells 5 above the ground .*; or choose another house/u);
});

test("scaffoldReserve counts the blocks a walk must keep of every admitted kind: what the cells out of reach take, whatever is carried", () => {
  const reserve = (cells: WorldCell[], options: { kept?: string[]; unread?: true } = {}) => scaffoldReserve([{ cells, built: [] }], DOOR_Y, options.unread === true ? undefined : DEFAULT_SCAFFOLD_BLOCKS, options.kept ?? []);
  const each = (count: number, blocks: readonly string[] = DEFAULT_SCAFFOLD_BLOCKS) => blocks.map((item) => ({ item, count }));
  assert.deepEqual(reserve([cellAt(1), cellAt(FIRST_OUT_OF_REACH - 1)]), [], "all within the eye's reach");
  assert.deepEqual(reserve([cellAt(1), cellAt(8)]), each(2), "a high cell: every admitted kind at the count, carried or not (blocks gathered on the walk are kept too)");
  assert.deepEqual(reserve([cellAt(8)]), each(2), "5 dirt for a count of 2 reserve 2, not all five: the count is the need, never the carried total");
  assert.deepEqual(reserve([cellAt(12)]), each(6), "the count follows the height");
  assert.deepEqual(reserve([cellAt(8)], { unread: true }), [], "policy unread");
  assert.deepEqual(reserve([cellAt(8)], { kept: [...DEFAULT_SCAFFOLD_BLOCKS] }), [], "every admitted kind is a bill item");
  assert.deepEqual(reserve([cellAt(8)], { kept: ["cobblestone"] }), each(2, without("cobblestone")), "the bill's own blocks are kept by name, not counted here");
});

test("the fetch clause says 'exactly' for the items only and names the blocks to stand on by 'N or more'", () => {
  const standOn = { count: 4, height: 5, admitted: DEFAULT_SCAFFOLD_BLOCKS };
  assert.equal(fetchClause({ missing: [{ item: "oak_planks", count: 2 }], scaffold: null }), "fetch exactly the missing items with get_items");
  assert.equal(fetchClause({ missing: [{ item: "oak_planks", count: 2 }], scaffold: standOn }), "fetch exactly the missing items and 4 or more blocks to stand on with get_items");
  assert.equal(fetchClause({ missing: [], scaffold: standOn }), "fetch 4 or more blocks to stand on with get_items");
});
