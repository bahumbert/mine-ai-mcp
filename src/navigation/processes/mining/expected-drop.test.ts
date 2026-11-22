import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { expectedDropOfBreak } from "./expected-drop.js";

/** The block at (0,64,0) as the mine process saw it before it came down, with the bot carrying `carried` (the fake's player window fills the hotbar in order, so the first item is held). */
function breakOf(blockName: string, carried: Record<string, number> = {}) {
  const { bot } = createFakeBot({ cells: { "0,64,0": blockName }, carried });
  const block = bot.blockAt(new Vec3(0, 64, 0))!;
  return { bot, block };
}

const rows: readonly [string, string, Record<string, number>, "drops" | "nothing" | "unknown"][] = [
  ["stone by hand: the registry says it needs a pickaxe", "stone", {}, "nothing"],
  ["stone with a pickaxe", "stone", { wooden_pickaxe: 1 }, "drops"],
  ["diamond ore under its tier", "diamond_ore", { wooden_pickaxe: 1 }, "nothing"],
  ["diamond ore at its tier", "diamond_ore", { iron_pickaxe: 1 }, "drops"],
  ["leaves by hand: only chance drops", "oak_leaves", {}, "nothing"],
  ["leaves with shears", "oak_leaves", { shears: 1 }, "drops"],
  ["a block with no loot data", "bedrock", {}, "unknown"],
  ["the lower half of a door, in its default state", "oak_door", {}, "drops"],
];

for (const [name, block, carried, expected] of rows) {
  test(`expected drop: ${name}`, () => {
    const broken = breakOf(block, carried);
    assert.equal(expectedDropOfBreak(broken.bot, broken.block), expected);
  });
}

test("the tool is the one the bot digs with, not the held item: a sword in hand, a pickaxe in the bag", () => {
  const { bot, block } = breakOf("stone", { iron_sword: 1, iron_pickaxe: 1 });
  assert.equal(bot.heldItem?.name, "iron_sword");
  assert.equal(expectedDropOfBreak(bot, block), "drops");
});
