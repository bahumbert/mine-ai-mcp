import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import type { WindowsExports } from "prismarine-windows";
import { snapshotBotStatus, updateBotStatus } from "./bot-status.js";
import { temporaryBotData } from "../test-support/bot-data.js";
import { createFakeBot, itemOf } from "../test-support/fake-bot/index.js";

const require = createRequire(import.meta.url);
/** Prismarine's windows for a version, as Mineflayer opens them; its typings miss the loader's call signature. */
const loadWindows = require("prismarine-windows") as (version: string) => WindowsExports;

test("an open furnace supplies live carried slots in player-inventory coordinates", () => {
  const { bot, inventory } = createFakeBot({ slots: { 5: { name: "iron_helmet" }, 40: { name: "beef", count: 10 } } });
  inventory.setQuickBarSlot(2);
  // The window Mineflayer opens for a furnace: its carried slots start at 3, not the inventory's 9.
  const furnace = loadWindows(bot.version).createWindow(1, "minecraft:furnace", "Furnace");
  const fuel = itemOf(bot.registry, "birch_planks", 11);
  const sword = Object.assign(itemOf(bot.registry, "stone_sword"), { durabilityUsed: 130 });
  furnace.updateSlot(5, fuel);
  furnace.updateSlot(32, sword);
  bot.currentWindow = furnace;

  assert.deepEqual(snapshotBotStatus(bot).inventory, [
    // A worn helmet wears down: Prismarine's item reads its maximum from the version's data, as at runtime.
    { slot: 5, location: "head", name: "iron_helmet", count: 1, held: false, durability: { remaining: 165, maximum: 165 } },
    { slot: 11, location: "main", name: "birch_planks", count: 11, held: false, durability: null },
    {
      slot: 38,
      location: "hotbar",
      name: "stone_sword",
      count: 1,
      held: true,
      durability: { remaining: 1, maximum: 131 },
    },
  ]);
  assert.equal(fuel.slot, 5);
  assert.equal(sword.slot, 32);
});

test("captures and persists the bot's queryable live status", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const { bot } = createFakeBot({
    username: "bot1",
    dimension: "minecraft:overworld",
    position: { x: 100.5, y: 64, z: -200.25 },
    health: 18.5,
    food: 20,
  });
  bot.entity.yaw = 1.57;

  updateBotStatus(data, { ...snapshotBotStatus(bot), updatedAt: "2026-08-21T00:00:00.000Z" });

  assert.deepEqual(data.read("SELECT bot_id, dimension, x, y, z, chunk_x, chunk_z, health, food FROM bot_status"), [
    {
      bot_id: "bot1",
      dimension: "minecraft:overworld",
      x: 100.5,
      y: 64,
      z: -200.25,
      chunk_x: 6,
      chunk_z: -13,
      health: 18.5,
      food: 20,
    },
  ]);
});
