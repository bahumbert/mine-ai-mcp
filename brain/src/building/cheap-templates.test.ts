import assert from "node:assert/strict";
import test from "node:test";
import { FACING_VECTOR } from "./blueprint.ts";
import { templateFor, type Template } from "./templates.ts";

// Owner decision 2026-11-10: the regional houses are built by bots that start with nothing; only the rondavel keeps its costly thatch and mud.
const blocksOf = (template: Template): string[] => {
  const shapes = Object.values(template.variants).flatMap((variant) => Object.values(variant));
  return [...Object.values(template.palette), ...shapes];
};

test("the ndebele house has a cheap acacia roof and no mud, hay or thatch, its painted terracotta walls kept", () => {
  const template = templateFor("ndebele-house")!;
  const blocks = blocksOf(template);
  for (const costly of ["hay_block", "packed_mud"]) assert.equal(blocks.includes(costly), false, costly);
  assert.deepEqual({ wall: template.palette.wall, accent: template.palette.accent, trim: template.palette.trim }, { wall: "white_terracotta", accent: "yellow_terracotta", trim: "orange_terracotta" });
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

test("the sahel mud house is built of sandstone, not mud", () => {
  const template = templateFor("sahel-mud-house")!;
  for (const block of blocksOf(template)) assert.doesNotMatch(block, /mud/u, block);
  assert.ok(blocksOf(template).includes("sandstone"));
  assert.doesNotMatch(template.description, /mud/u, "the description says what it is made of");
});

test("the adobe pueblo is sandstone with at most 30 terracotta cells", () => {
  const template = templateFor("adobe-pueblo")!;
  const terracottaRoles = Object.entries(template.palette).filter(([, block]) => block.endsWith("terracotta")).map(([role]) => role);
  const terracotta = template.blueprint.cells.filter((cell) => terracottaRoles.includes(cell.role)).length;
  assert.ok(terracotta <= 30, `${terracotta} terracotta cells`);
  assert.match(template.palette.wall ?? "", /sandstone/u);
});

test("the pagoda house has no cherry block", () => {
  const template = templateFor("pagoda-house")!;
  for (const block of blocksOf(template)) assert.doesNotMatch(block, /cherry/u, block);
  assert.doesNotMatch(template.description, /cherry/u);
});

test("the rondavel keeps its thatch and mud: one costly african house stays", () => {
  const blocks = blocksOf(templateFor("rondavel")!);
  assert.ok(blocks.includes("hay_block") && blocks.some((block) => block.includes("mud")), blocks.join(", "));
});
