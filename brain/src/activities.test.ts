import assert from "node:assert/strict";
import test from "node:test";
import type { Step } from "./actions.ts";
import { activityOf, activityTimes, describeActivity, gatheringActivity, parseActivity, type ActionTime, type ActivityFacts } from "./activities.ts";

// Fixture tags, so the rule is tested rather than the names: a log is whatever the game files under `logs`.
const facts: ActivityFacts = {
  tags: {
    spruce_log: ["logs", "mineable/axe"],
    crimson_stem: ["logs", "mineable/axe"],
    stone: ["mineable/pickaxe"],
    dirt: ["mineable/shovel"],
    pumpkin: ["mineable/axe"],
    short_grass: [],
  },
  hostile: new Set(["zombie"]),
  foods: new Set(["bread", "cooked_beef"]),
};

const timed = (tool: ActionTime["tool"], input: Record<string, unknown>, ms: number): ActionTime => ({ tool, input, ms });

test("gathering is told apart by the game's block tags: logs, pickaxe, shovel, anything else foraging", () => {
  assert.equal(gatheringActivity("spruce_log", facts), "woodcutting");
  assert.equal(gatheringActivity("crimson_stem", facts), "woodcutting");
  assert.equal(gatheringActivity("stone", facts), "mining");
  assert.equal(gatheringActivity("dirt", facts), "digging");
  assert.equal(gatheringActivity("pumpkin", facts), "foraging", "an axe block that is not a log");
  assert.equal(gatheringActivity("short_grass", facts), "foraging");
  assert.equal(gatheringActivity("unknown_block", facts), "foraging");
});

test("each skill has its activity, hunting by the mob's category, errands none", () => {
  assert.equal(activityOf({ skill: "build", structure: "house", size: "small" }, [], facts), "building");
  assert.equal(activityOf({ skill: "level_area", radius: 5 }, [], facts), "terraforming");
  assert.equal(activityOf({ skill: "farm", size: 9 }, [], facts), "farming");
  assert.equal(activityOf({ skill: "hunt", mob: "cow", drop: "beef", count: 1 }, [], facts), "hunting");
  assert.equal(activityOf({ skill: "hunt", mob: "zombie", drop: "rotten_flesh", count: 1 }, [], facts), "mob_combat");
  assert.equal(activityOf({ skill: "go_to", x: 1, y: 64, z: 1 }, [], facts), "travelling");
  assert.equal(activityOf({ skill: "explore", toward: "north", chunks: 4 }, [], facts), "exploring");
  assert.equal(activityOf({ skill: "follow_player", player: "Tom", distance: 3 }, [], facts), "following");
  assert.equal(activityOf({ skill: "collect_block", block: "stone", count: 4 }, [], facts), "mining");
  assert.equal(activityOf({ skill: "craft_item", item: "bread", count: 1 }, [], facts), "cooking");
  assert.equal(activityOf({ skill: "craft_item", item: "stone_pickaxe", count: 1 }, [], facts), "crafting");
  for (const step of [
    { skill: "give_item", player: "Tom", item: "bread", count: 1 },
    { skill: "drop_item", item: "dirt" },
    { skill: "protect_area", radius: 8, label: "farm" },
    { skill: "eat", food: "bread" },
  ] satisfies Step[]) assert.equal(activityOf(step, [], facts), null, step.skill);
});

test("get_items is the activity it spent most time on, walking aside", () => {
  const house: Step = { skill: "get_items", items: [{ item: "oak_planks", count: 30 }, { item: "cobblestone", count: 16 }] };
  assert.equal(activityOf(house, [
    timed("navigate", { x: 0, z: 0 }, 90_000),
    timed("collect_block", { block_name: "spruce_log", count: 8 }, 60_000),
    timed("collect_block", { block_name: "stone", count: 16 }, 70_000),
    timed("craft_item", { items: [{ item_name: "oak_planks", count: 30 }] }, 5_000),
  ], facts), "mining");
  assert.equal(activityOf({ skill: "get_items", items: [{ item: "bread", count: 2 }] }, [timed("craft_item", { items: [{ item_name: "bread", count: 2 }] }, 3_000)], facts), "cooking");
  assert.equal(activityOf({ skill: "get_items", items: [{ item: "glass", count: 4 }] }, [timed("smelt_item", { item_name: "glass", count: 4 }, 40_000)], facts), "crafting");
  assert.equal(activityOf({ skill: "get_items", items: [{ item: "cooked_beef", count: 1 }] }, [timed("smelt_item", { item_name: "cooked_beef", count: 1 }, 10_000)], facts), "cooking");
  // Nothing timed (it already had everything, or failed at once): what it was asked for.
  assert.equal(activityOf({ skill: "get_items", items: [{ item: "bread", count: 2 }] }, [], facts), "cooking");
  assert.equal(activityOf({ skill: "get_items", items: [{ item: "torch", count: 2 }] }, [], facts), "crafting");
});

test("activities read as words in the prompts", () => {
  assert.equal(describeActivity("mob_combat"), "fighting monsters");
  assert.equal(describeActivity("pvp"), "fighting players");
  assert.equal(describeActivity("farming"), "farming");
});

test("a step's walking counts travelling, its phases change the activity, and steps that are all walking keep it whole", () => {
  // Spec 2026-10-04-activity-time-travel-terraforming: Ayla's walk to a far farm counted as farming, Vex's following as
  // exploring.
  const walk = (ms: number, ended: number): ActionTime => ({ tool: "navigate", input: {}, ms, ended });
  const farmTrip = activityTimes({ skill: "farm", size: 9 }, [walk(360_000, 360_000)], facts, 0, 420_000);
  assert.deepEqual(farmTrip, [{ activity: "travelling", ms: 360_000 }, { activity: "farming", ms: 60_000 }]);
  const house = activityTimes({ skill: "build", structure: "house", size: "small" }, [walk(10_000, 20_000)], facts, 0, 300_000, [
    { activity: "terraforming", at: 30_000 },
    { activity: "building", at: 130_000 },
  ]);
  assert.deepEqual(house, [{ activity: "building", ms: 190_000 }, { activity: "terraforming", ms: 100_000 }, { activity: "travelling", ms: 10_000 }]);
  assert.deepEqual(activityTimes({ skill: "follow_player", player: "Tom", distance: 3 }, [walk(50_000, 50_000)], facts, 0, 60_000), [{ activity: "following", ms: 60_000 }]);
  assert.deepEqual(activityTimes({ skill: "give_item", player: "Tom", item: "bread", count: 1 }, [walk(8_000, 8_000)], facts, 0, 9_000), [{ activity: "travelling", ms: 8_000 }]);
});

test("a model's name for a kind of work is read as the activity, by id or as the prompts word it; anything else is none", () => {
  assert.equal(parseActivity("building"), "building");
  assert.equal(parseActivity("  Mining "), "mining");
  assert.equal(parseActivity("mob_combat"), "mob_combat");
  assert.equal(parseActivity("fighting monsters"), "mob_combat");
  assert.equal(parseActivity("cutting wood"), "woodcutting");
  assert.equal(parseActivity("Digging Out A Cellar, A Pond Or A Tunnel"), "digging");
  assert.equal(parseActivity("none"), null);
  assert.equal(parseActivity(""), null);
  assert.equal(parseActivity("knitting"), null);
  assert.equal(parseActivity(undefined), null);
});
