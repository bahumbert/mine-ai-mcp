import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { formatToolChange, harvestTier, snapshotTools, toolChanges } from "./tool-tiers.js";

const registry = minecraftData("1.21.4");

test("uses registry harvest capability separately from mining speed", () => {
  const { bot } = createFakeBot();
  assert.equal(harvestTier(bot, "golden_pickaxe"), harvestTier(bot, "wooden_pickaxe"));
  assert.ok(harvestTier(bot, "stone_pickaxe") > harvestTier(bot, "golden_pickaxe"));
  assert.ok(registry.materials["mineable/pickaxe"]![registry.itemsByName.golden_pickaxe!.id]! >
    registry.materials["mineable/pickaxe"]![registry.itemsByName.diamond_pickaxe!.id]!);
});

test("snapshots the best carried tier and exact remaining durability", () => {
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
  assert.deepEqual(snapshot.tools.find((entry) => entry.class === "pickaxe"), {
    class: "pickaxe", tier: "iron", item: "iron_pickaxe", slot: 11, durabilityLeft: 10, maximumDurability: 250,
  });
  assert.equal(snapshot.tools.find((entry) => entry.class === "water_bucket")?.tier, "other");
  assert.equal(snapshot.armour.find((entry) => entry.class === "helmet")?.durabilityLeft, 360);
});

test("reports replacement and wear without inferring a break from batched inventory updates", () => {
  const before = { tools: [{ class: "pickaxe", tier: "diamond", item: "diamond_pickaxe", slot: 36, durabilityLeft: 1, maximumDurability: 1561 }], armour: [] } as never;
  const replacement = { tools: [{ class: "pickaxe", tier: "stone", item: "stone_pickaxe", slot: 9, durabilityLeft: 131, maximumDurability: 131 }], armour: [] } as never;
  const worn = { tools: [{ class: "pickaxe", tier: "stone", item: "stone_pickaxe", slot: 9, durabilityLeft: 120, maximumDurability: 131 }], armour: [] } as never;
  const changed = toolChanges(before, replacement)[0]!;
  assert.equal(changed.reason, "replaced");
  assert.equal(formatToolChange(changed), "pickaxe: diamond → stone");
  assert.equal(formatToolChange(toolChanges(replacement, worn)[0]!), "pickaxe durability 131 → 120");
});
