import assert from "node:assert/strict";
import test from "node:test";
import { FACING_VECTOR } from "./blueprint.ts";
import { TEMPLATES, templateFor, type Template } from "./templates.ts";

// Owner decisions 2026-11-10 and 2026-11-11: the regional houses are built by bots that start with nothing; only the rondavel (thatch and mud), the minka (3 hay_block) and the hanok (12 white_wool) keep costly blocks.
const blocksOf = (template: Template): string[] => {
  const shapes = Object.values(template.variants).flatMap((variant) => Object.values(variant));
  return [...Object.values(template.palette), ...shapes];
};
// What this file calls costly: thatch, mud, painted terracotta (the checks below) and wool (the hanok's walls).
const COSTLY_BLOCK = /hay_block|mud|terracotta|wool/u;
const costlyBlocksOf = (template: Template): string[] => blocksOf(template).filter((block) => COSTLY_BLOCK.test(block));
const cellsOfBlock = (template: Template, block: string): number => {
  const roles = Object.entries(template.palette).filter(([, name]) => name === block).map(([role]) => role);
  return template.blueprint.cells.filter((cell) => roles.includes(cell.role)).length;
};

test("the ndebele house is built of cheap common blocks: no mud, hay, thatch, terracotta or wool", () => {
  const template = templateFor("ndebele-house")!;
  assert.deepEqual(costlyBlocksOf(template), []);
  assert.doesNotMatch(template.description, /terracotta/iu, "the description says what it is made of");
});

test("the ndebele roof steps up toward its ridge: each stair's high side leads into the roof, never out to the eaves", () => {
  const { cells } = templateFor("ndebele-house")!.blueprint;
  const stairs = cells.filter((cell) => cell.role === "roof" && cell.shape === "stairs");
  assert.ok(stairs.length > 0, "the roof has stairs");
  for (const stair of stairs) {
    const [dx, dz] = FACING_VECTOR[stair.facing!];
    const uphill = cells.find((cell) => cell.role === "roof" && cell.x === stair.x + dx && cell.y === stair.y && cell.z === stair.z + dz);
    assert.ok(uphill !== undefined, `stair ${stair.x},${stair.y},${stair.z} faces ${stair.facing}, out of the roof`);
  }
});

test("the sahel mud house is built of sandstone, not mud (its blocks: the costly-house list below holds them)", () => {
  const template = templateFor("sahel-mud-house")!;
  assert.ok(blocksOf(template).includes("sandstone"));
  assert.doesNotMatch(template.description, /mud/u, "the description says what it is made of");
});

test("the adobe pueblo is sandstone (no terracotta: the costly-house list below holds it)", () => {
  assert.match(templateFor("adobe-pueblo")!.palette.wall ?? "", /sandstone/u);
});

test("the pagoda house has no cherry block", () => {
  const template = templateFor("pagoda-house")!;
  for (const block of blocksOf(template)) assert.doesNotMatch(block, /cherry/u, block);
  assert.doesNotMatch(template.description, /cherry/u);
});

test("the rondavel keeps its thatch and mud, the minka its 3 hay blocks, the hanok its 12 white wool: no other regional house has a costly block", () => {
  const blocks = blocksOf(templateFor("rondavel")!);
  assert.ok(blocks.includes("hay_block") && blocks.some((block) => block.includes("mud")), blocks.join(", "));
  assert.equal(cellsOfBlock(templateFor("minka")!, "hay_block"), 3);
  assert.equal(cellsOfBlock(templateFor("hanok")!, "white_wool"), 12);
  const costlyHouses = [...TEMPLATES.values()].filter((template) => costlyBlocksOf(template).length > 0).map((template) => template.id).sort();
  assert.deepEqual(costlyHouses, ["hanok", "minka", "rondavel"]);
});
