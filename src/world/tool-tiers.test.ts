import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { watchServerTags } from "./server-tags.js";
import { formatToolChange, snapshotTools, toolChanges } from "./tool-tiers.js";

const registry = minecraftData("1.21.4");
function entry(snapshot: ReturnType<typeof snapshotTools>, kind: string) {
  return [...snapshot.tools, ...snapshot.armour].find((candidate) => candidate.class === kind)!;
}

/** The snapshot entry of a class for a bot carrying only `items`. */
function carried(kind: string, ...items: string[]) {
  const { bot } = createFakeBot({ slots: Object.fromEntries(items.map((name, i) => [9 + i, { name }])) });
  return entry(snapshotTools(bot), kind);
}

test("snapshots the best carried item and exact remaining durability", () => {
  const { bot } = createFakeBot({
    slots: {
      9: { name: "golden_pickaxe" },
      10: { name: "stone_pickaxe" },
      11: { name: "iron_pickaxe" },
      5: { name: "diamond_helmet" },
      12: { name: "water_bucket" },
    },
  });
  bot.inventory.slots[10]!.durabilityUsed = 126;
  bot.inventory.slots[11]!.durabilityUsed = 240;
  bot.inventory.slots[5]!.durabilityUsed = 3;
  const snapshot = snapshotTools(bot);
  const pickaxe = entry(snapshot, "pickaxe");
  assert.deepEqual({ ...pickaxe, rank: undefined }, {
    class: "pickaxe", rank: undefined, item: "iron_pickaxe", slot: 11, durabilityLeft: 10, maximumDurability: 250,
  });
  assert.ok(pickaxe.rank > 0);
  assert.equal(entry(snapshot, "water_bucket").item, "water_bucket");
  assert.equal(entry(snapshot, "helmet").durabilityLeft, 360);
  assert.deepEqual([entry(snapshot, "shovel").item, entry(snapshot, "shovel").rank], [null, 0], "no item: rank 0");
});

test("an item a datapack adds to pickaxes is a pickaxe", () => {
  const harness = createFakeBot({ slots: { 9: { name: "stick" } } });
  watchServerTags(harness.bot);
  assert.equal(entry(snapshotTools(harness.bot), "pickaxe").item, null);
  harness.emitTags([{ tagType: "minecraft:item", tags: [{ tagName: "minecraft:pickaxes", entries: [registry.itemsByName.stick!.id] }] }]);
  assert.equal(entry(snapshotTools(harness.bot), "pickaxe").item, "stick", "the next snapshot reads the new tags");
});

test("1.20.4 armour, bow and shield are classed (shipped tags plus the override)", () => {
  const { bot } = createFakeBot({
    version: "1.20.4",
    slots: { 5: { name: "iron_helmet" }, 6: { name: "leather_chestplate" }, 7: { name: "golden_leggings" }, 8: { name: "diamond_boots" }, 9: { name: "bow" }, 10: { name: "shield" }, 11: { name: "turtle_helmet" } },
  });
  const snapshot = snapshotTools(bot);
  assert.deepEqual(["helmet", "chestplate", "leggings", "boots", "bow", "shield"].map((kind) => entry(snapshot, kind).item),
    ["turtle_helmet", "leather_chestplate", "golden_leggings", "diamond_boots", "bow", "shield"],
    "the turtle helmet (275) outranks the iron one (165) on maximum durability");
});

test("netherite_pickaxe is the best pickaxe carried with diamond and stone; B1: a wooden sword is chosen over a golden one; each ranks above the other", () => {
  const best = carried("pickaxe", "stone_pickaxe", "netherite_pickaxe", "diamond_pickaxe");
  assert.equal(best.item, "netherite_pickaxe");
  assert.ok(best.rank > carried("pickaxe", "diamond_pickaxe").rank);
  assert.ok(carried("pickaxe", "diamond_pickaxe").rank > carried("pickaxe", "stone_pickaxe").rank);
  const wooden = carried("sword", "golden_sword", "wooden_sword");
  assert.equal(wooden.item, "wooden_sword");
  assert.ok(wooden.rank > carried("sword", "golden_sword").rank);
});

test("B2: a fresh chainmail chestplate beats a worn iron one", () => {
  const { bot } = createFakeBot({ slots: { 6: { name: "iron_chestplate" }, 9: { name: "chainmail_chestplate" } } });
  bot.inventory.slots[6]!.durabilityUsed = 100;
  assert.equal(entry(snapshotTools(bot), "chestplate").item, "chainmail_chestplate");
});

test("B3: a milk_bucket is no bucket; the empty bucket is", () => {
  const { bot } = createFakeBot({ slots: { 9: { name: "milk_bucket" } } });
  assert.equal(entry(snapshotTools(bot), "bucket").item, null);
  const { bot: empty } = createFakeBot({ slots: { 9: { name: "milk_bucket" }, 10: { name: "bucket" } } });
  assert.equal(entry(snapshotTools(empty), "bucket").item, "bucket");
});

test("tool change prints item names", () => {
  const before = { tools: [{ class: "pickaxe", rank: 3, item: "wooden_pickaxe", slot: 36, durabilityLeft: 1, maximumDurability: 59 }], armour: [] } as never;
  const replacement = { tools: [{ class: "pickaxe", rank: 5, item: "stone_pickaxe", slot: 9, durabilityLeft: 131, maximumDurability: 131 }], armour: [] } as never;
  const worn = { tools: [{ class: "pickaxe", rank: 5, item: "stone_pickaxe", slot: 9, durabilityLeft: 120, maximumDurability: 131 }], armour: [] } as never;
  const gone = { tools: [{ class: "pickaxe", rank: 0, item: null, slot: null, durabilityLeft: null, maximumDurability: null }], armour: [] } as never;
  const changed = toolChanges(before, replacement)[0]!;
  assert.equal(changed.reason, "replaced");
  assert.equal(formatToolChange(changed), "pickaxe: wooden_pickaxe → stone_pickaxe");
  assert.equal(formatToolChange(toolChanges(replacement, worn)[0]!), "pickaxe durability 131 → 120");
  assert.equal(formatToolChange(toolChanges(worn, gone)[0]!), "pickaxe: stone_pickaxe → none");
});
