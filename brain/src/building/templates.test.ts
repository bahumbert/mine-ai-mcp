import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import minecraftData from "minecraft-data";
import { recipesFor } from "#src/world/smelting.ts";
import { billOfMaterials, placeBlueprint, type Facing, type MaterialCount, type WorldCell } from "./blueprint.ts";
import { catalogueLine, chooseSite, planTemplate } from "./plan.ts";
import { supportGroups, TEMPLATE_REGISTRY_VERSION, validateBlueprint } from "./support.ts";
import { classicTemplate, familiesOf, loadTemplates, stagesOf, TEMPLATES, templateFor, templateOfHouse, templateOfKind, type Template } from "./templates.ts";

const PALETTE = { foundation: "cobblestone", floor: "oak_planks", wall: "oak_planks", pillar: "oak_log", trim: "oak_log", roof: "spruce_planks", window: "glass_pane", door: "oak_door" };
const KEY = { f: { role: "foundation" }, F: { role: "floor" }, w: { role: "wall" }, p: { role: "pillar", axis: "y" }, r: { role: "roof" }, D: { role: "door" }, _: { role: "air" } };
const HUT_LAYERS = [
  [".....", "fffff", "fFFFf", "fFFFf", "fFFFf", "fffff"],
  [".....", "wwDww", "w___w", "w___w", "w___w", "wwwww"],
  [".....", "ww.ww", "w___w", "w___w", "w___w", "wwwww"],
  [".....", "rrrrr", "rrrrr", "rrrrr", "rrrrr", "rrrrr"],
];
/** A house on pillars: nothing but pillars in its lowest layer, the floor one layer up. */
const STILT_LAYERS = [
  [".....", "p...p", ".....", ".....", ".....", "p...p"],
  [".....", "FFFFF", "FFFFF", "FFFFF", "FFFFF", "FFFFF"],
  [".....", "wwDww", "w___w", "w___w", "w___w", "wwwww"],
  [".....", "ww.ww", "w___w", "w___w", "w___w", "wwwww"],
  [".....", "rrrrr", "rrrrr", "rrrrr", "rrrrr", "rrrrr"],
];

function templateFile(id: string, extra: Record<string, unknown> = {}, layers: readonly (readonly string[])[] = HUT_LAYERS): Record<string, unknown> {
  return { id, family: "test-land", name: `${id} house`, description: "A square hut of planks under a flat roof.", palette: PALETTE, key: KEY, layers, ...extra };
}

/** A folder holding the given template files (name -> content), removed after `run`. */
function withFolder<T>(files: Readonly<Record<string, unknown>>, run: (directory: URL) => T): T {
  const root = mkdtempSync(join(tmpdir(), "templates-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), typeof content === "string" ? content : JSON.stringify(content));
    return run(pathToFileURL(`${root}/`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const loadOne = (extra: Record<string, unknown> = {}, layers?: readonly (readonly string[])[]) => withFolder({ "hut.json": templateFile("hut", extra, layers) }, (directory) => loadTemplates(directory));
const site = chooseSite({ x: 0, y: 64, z: 0 }, null);

test("a template file loads into a blueprint: its layers are y, its rows z, its characters x, `.` is no cell", () => {
  const template = loadOne().get("hut")!;
  assert.equal(template.kind, "hut house");
  assert.deepEqual(template.blueprint.size, { x: 5, y: 4, z: 6 });
  const door = template.blueprint.cells.find((cell) => cell.role === "door")!;
  assert.deepEqual([door.x, door.y, door.z], [2, 1, 1]);
  assert.equal(template.blueprint.cells.some((cell) => cell.z === 0), false);
  assert.equal(template.blueprint.cells.find((cell) => cell.x === 0 && cell.y === 0 && cell.z === 1)?.role, "foundation");
  assert.equal(template.blueprint.cells.find((cell) => cell.x === 1 && cell.y === 1 && cell.z === 2)?.role, "air");
  assert.deepEqual(template.variants, {});
});

test("an empty folder loads no template", () => {
  assert.equal(withFolder({}, (directory) => loadTemplates(directory)).size, 0);
});

test("a bad file names itself", () => {
  const invalid = (files: Record<string, unknown>, reason: RegExp) => withFolder(files, (directory) => assert.throws(() => loadTemplates(directory), reason));
  const rows = (index: number, row: string) => HUT_LAYERS.map((layer, y) => (y === 0 ? layer.map((old, z) => (z === index ? row : old)) : layer));
  invalid({ "hut.json": templateFile("hut", {}, rows(2, "fFFf")) }, /^Error: \[TEMPLATE_INVALID\] hut\.json: .*row/u);
  invalid({ "hut.json": templateFile("hut", {}, rows(2, "fFXFf")) }, /^Error: \[TEMPLATE_INVALID\] hut\.json: .*"X"/u);
  invalid({ "hut.json": templateFile("hut", {}, rows(2, "fFDFf")) }, /^Error: \[TEMPLATE_INVALID\] hut\.json: .*door/u);
  invalid({ "hut.json": templateFile("shed") }, /^Error: \[TEMPLATE_INVALID\] hut\.json: .*id "shed"/u);
  const { wall: _wall, ...withoutWall } = PALETTE;
  invalid({ "hut.json": templateFile("hut", { palette: withoutWall }) }, /^Error: \[TEMPLATE_INVALID\] hut\.json: .*wall/u);
  invalid({ "hut.json": templateFile("hut"), "tent.json": templateFile("tent", { name: "hut house" }) }, /^Error: \[TEMPLATE_INVALID\] tent\.json: .*hut house/u);
  invalid({ "hut.json": templateFile("hut", { palette: { ...PALETTE, wall: "oak_fence" } }) }, /^Error: \[TEMPLATE_INVALID\] hut\.json: .*oak_fence.*full block/u);
  invalid({ "hut.json": "{ not json" }, /^Error: \[TEMPLATE_INVALID\] hut\.json: /u);
  invalid({ "hut.json": templateFile("hut", { stages: [{ name: "all", top: 2 }] }) }, /^Error: \[TEMPLATE_INVALID\] hut\.json: .*stages/u);
  invalid({ "hut.json": templateFile("hut", { stages: [{ name: "a", top: 2 }, { name: "b", top: 2 }] }) }, /^Error: \[TEMPLATE_INVALID\] hut\.json: .*stages/u);
});

test("the six classic houses are registered", () => {
  // The registry also holds the regional templates (Task 6): the classic six are the ones that carry `classic`.
  const classics = new Map([...TEMPLATES].filter(([, template]) => template.classic !== undefined));
  assert.deepEqual([...classics.keys()].sort(), ["japanese-medium", "japanese-small", "medieval-medium", "medieval-small", "rustic-medium", "rustic-small"]);
  assert.equal(templateFor("medieval-small")?.kind, "small medieval house");
  assert.equal(templateFor("medieval-small")?.family, "europe");
  assert.equal(templateOfKind("small japanese house")?.id, "japanese-small");
  assert.equal(classicTemplate("rustic", "medium")?.id, "rustic-medium");
  assert.deepEqual(familiesOf(classics), ["east-asia", "europe"]);
});

test("templateOfHouse maps old houses", () => {
  const fixture = withFolder({ "rondavel.json": templateFile("rondavel") }, (directory) => loadTemplates(directory));
  assert.equal(templateOfHouse({ template: "rondavel" }, fixture)?.id, "rondavel");
  assert.equal(templateOfHouse({ kind: "small medieval house" })?.id, "medieval-small");
  assert.equal(templateOfHouse({ style: "japanese", size: "medium" })?.id, "japanese-medium");
  assert.equal(templateOfHouse({ style: "gone", size: "small" })?.id, "medieval-small");
  assert.equal(templateOfHouse({ kind: "gone house" }), undefined);
  assert.equal(templateOfHouse({ template: "gone" }), undefined);
  assert.equal(templateOfHouse({ size: "huge" }), undefined);
  assert.equal(classicTemplate(undefined, "small")?.id, "medieval-small");
});

test("a catalogue line of a template on stilts names its footprint and floors (the exact line: plan.test.ts)", () => {
  const stilts = withFolder({ "stilts.json": templateFile("stilts", {}, STILT_LAYERS) }, (directory) => loadTemplates(directory)).get("stilts")!;
  assert.match(catalogueLine(stilts), /^stilts \(5x6, 1 floor, \d+ blocks, mostly /u);
});

test("every shipped template is valid at every facing", () => {
  const facings: readonly Facing[] = ["north", "south", "east", "west"];
  for (const template of TEMPLATES.values()) {
    assert.deepEqual(validateBlueprint(template.blueprint, template.palette, template.variants), [], template.id);
    for (const facing of facings) {
      const cells = placeBlueprint(template.blueprint, template.palette, { x: 0, y: 64, z: 0 }, facing, template.variants);
      assert.deepEqual(supportGroups(cells).unsupported, [], `${template.id} facing ${facing}`);
    }
  }
});

test("every shipped template is built from blocks that exist in 1.21.4 and are placed from an item of the same id; its variants are stairs and slabs", () => {
  const data = minecraftData(TEMPLATE_REGISTRY_VERSION);
  for (const template of TEMPLATES.values()) {
    for (const [role, block] of Object.entries(template.palette)) {
      assert.ok(data.blocksByName[block], `${template.id} ${role}: ${block} is not a block`);
      assert.ok(data.itemsByName[block], `${template.id} ${role}: ${block} has no item`);
    }
    for (const [role, shapes] of Object.entries(template.variants)) {
      for (const [shape, block] of Object.entries(shapes)) {
        assert.ok(data.blocksByName[block]?.name.endsWith(shape === "stairs" ? "_stairs" : "_slab"), `${template.id} ${role} ${shape}: ${block}`);
        assert.ok(data.itemsByName[block], `${template.id} ${role} ${shape}: ${block} has no item`);
      }
    }
  }
  for (const template of TEMPLATES.values()) if (template.classic !== undefined) assert.ok(template.variants.roof?.stairs && template.variants.roof.slab, `${template.id} has a stair roof`);
});

test("a template palette may add accent and railing and may leave them out (a missing required role: \"a bad file names itself\")", () => {
  const withBoth = loadOne({ palette: { ...PALETTE, accent: "ladder", railing: "oak_fence" } }).get("hut")!;
  assert.deepEqual([withBoth.palette.accent, withBoth.palette.railing], ["ladder", "oak_fence"]);
  assert.equal(loadOne().get("hut")!.palette.accent, undefined);
});

test("every shipped block can be made or found: a recipe, a smelting output or some block's drop", () => {
  const data = minecraftData(TEMPLATE_REGISTRY_VERSION);
  for (const template of TEMPLATES.values()) {
    const blocks = [...Object.values(template.palette), ...Object.values(template.variants).flatMap((shapes) => Object.values(shapes))];
    for (const block of blocks) {
      const item = data.itemsByName[block];
      assert.ok(item, `${template.id}: ${block} has no item`);
      const crafted = (data.recipes[item.id] ?? []).length > 0;
      const smelted = recipesFor(block, TEMPLATE_REGISTRY_VERSION).length > 0;
      const dropped = data.blocksArray.some((candidate) => candidate.drops.includes(item.id));
      assert.ok(crafted || smelted || dropped, `${template.id}: ${block} is not craftable, smeltable or dropped by any block`);
    }
  }
});

test("derived stages of a classic small house are floor, walls, roof, finish, contiguous over every batch", () => {
  const plan = planTemplate(templateFor("medieval-small")!, site);
  assert.deepEqual(plan.stages.map((stage) => stage.name), ["floor", "walls", "roof", "finish"]);
  assert.equal(plan.stages[0]!.first, 0);
  assert.equal(plan.stages.at(-1)!.last, plan.batches.length - 1);
  plan.stages.slice(1).forEach((stage, index) => assert.equal(stage.first, plan.stages[index]!.last + 1));
});

test("an empty stage is dropped: a house on pillars has no floor stage", () => {
  const stilts = withFolder({ "stilts.json": templateFile("stilts", {}, STILT_LAYERS) }, (directory) => loadTemplates(directory)).get("stilts")!;
  assert.deepEqual(planTemplate(stilts, site).stages.map((stage) => stage.name), ["walls", "roof", "finish"]);
});

test("declared stages are kept, the doorway and the door going with the last one", () => {
  const stages = [{ name: "base", top: 0 }, { name: "shell", top: 2 }, { name: "lid", top: 3 }];
  const plan = planTemplate(loadOne({ stages }).get("hut")!, site);
  assert.deepEqual(plan.stages.map((stage) => stage.name), ["base", "shell", "lid"]);
  assert.equal(plan.stages.at(-1)!.last, plan.batches.length - 1);
  assert.equal(plan.stages[0]!.last, 0);
});

test("a ladder built with another block asks no facing, as a block built with another block asks no axis", () => {
  const withLadder = HUT_LAYERS.map((layer, y) => (y === 1 ? layer.map((row, z) => (z === 2 ? "wL__w" : row)) : layer));
  const template = withFolder({ "hut.json": templateFile("hut", { palette: { ...PALETTE, accent: "ladder" }, key: { ...KEY, L: { role: "accent", facing: "south" } } }, withLadder) }, (directory) => loadTemplates(directory)).get("hut")!;
  assert.equal(planTemplate(template, site).cells.find((cell) => cell.role === "accent")?.facing !== undefined, true);
  const stone = planTemplate(template, site, { accent: "stone" }).cells.find((cell) => cell.role === "accent")!;
  assert.equal(stone.block, "stone");
  assert.equal(stone.facing, undefined);
  assert.equal(stone.half, undefined);
});

test("a house with no roof role has its top on its highest cell", () => {
  const flat = HUT_LAYERS.map((layer) => layer.map((row) => row.replaceAll("r", "w")));
  const plan = planTemplate(loadOne({}, flat).get("hut")!, site);
  assert.equal(plan.roofTop.y, Math.max(...plan.cells.map((cell) => cell.y)) + 1);
});

/** A template of the given cells' shape for `stagesOf` on hand-made batches (the derived stages read no blueprint). */
function bareTemplate(): Template {
  return { id: "bare", family: "test-land", name: "bare", description: "d", kind: "bare", palette: {}, variants: {}, blueprint: { name: "bare", size: { x: 1, y: 1, z: 1 }, cells: [{ x: 0, y: 0, z: 0, role: "door" }] } };
}
const cellOf = (role: WorldCell["role"], block: string, x: number, y: number): WorldCell => ({ x, y, z: 0, role, block });

test("a stage over 18 stacks is cut at a batch boundary", () => {
  // shulker boxes stack to 1: each cell is a stack.
  const walls = (y: number) => Array.from({ length: 10 }, (_, x) => cellOf("wall", "shulker_box", x, y));
  const batches = [[cellOf("floor", "oak_planks", 0, 0)], walls(1), walls(2), [cellOf("roof", "spruce_planks", 0, 3), cellOf("roof", "spruce_planks", 1, 3), cellOf("roof", "spruce_planks", 2, 3)], [cellOf("door", "oak_door", 0, 1)]];
  const stages = stagesOf(bareTemplate(), batches, new Map());
  assert.deepEqual(stages.map((stage) => stage.name), ["floor", "walls 1/2", "walls 2/2", "roof", "finish"]);
  assert.deepEqual(stages.map((stage) => [stage.first, stage.last]), [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
});

test("a stage counts each cell once: the stage bills add up to the house's bill", () => {
  const plan = planTemplate(templateFor("medieval-small")!, site);
  const total = new Map<string, number>();
  for (const stage of plan.stages) for (const { item, count } of plan.stageBill(stage)) total.set(item, (total.get(item) ?? 0) + count);
  const summed: MaterialCount[] = billOfMaterials([...total].map(([block, count]) => Array.from({ length: count }, (): WorldCell => ({ x: 0, y: 0, z: 0, block, role: "wall" }))).flat());
  assert.deepEqual(summed, plan.bill);
  assert.equal(total.get("cobblestone"), 16);
});
