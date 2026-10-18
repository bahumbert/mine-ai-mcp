// A craft request a reflex splits into attempts: the second crafts only what is left, with no effect doubled.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { craftingBot } from "../../test-support/crafting.js";
import type { WorldBlock } from "../../world/placement.js";
import type { WorkstationOperations } from "../temporary-workstation.js";
import { beginCraftItem, type CraftItemRequest } from "./index.js";

const navigation = {} as NavigationRuntime;
const freshAttempt = () => ({ signal: new AbortController().signal });

/** Aborts the attempt's signal right after the bot's nth craft call (counted over the whole request). */
function reflexAfterCrafts(bot: ReturnType<typeof craftingBot>["bot"], crafts: readonly number[]) {
  const controllers = crafts.map(() => new AbortController());
  const originalCraft = bot.craft.bind(bot);
  let calls = 0;
  bot.craft = async (...argumentsValue) => {
    await originalCraft(...argumentsValue);
    calls += 1;
    const index = crafts.indexOf(calls);
    if (index >= 0) controllers[index]!.abort(new Error("reflex took the body"));
  };
  return controllers.map((controller) => ({ signal: controller.signal }));
}

const count = (counts: Map<number, number>, bot: ReturnType<typeof craftingBot>["bot"], name: string) =>
  counts.get(bot.registry.itemsByName[name]!.id) ?? 0;

test("an attempt aborted after part of the recipes leaves the next to craft only the rest", async () => {
  // 8 planks are two applications of the recipe: a resume that crafts the request again makes 12.
  const { bot, counts, craftCalls } = craftingBot({ oak_log: 2 });
  const [first] = reflexAfterCrafts(bot, [1]);
  const run = beginCraftItem(bot, navigation, { items: [{ itemName: "oak_planks", count: 8 }] }, () => {});

  await assert.rejects(run(first!), /reflex took the body/);
  const result = await run(freshAttempt());

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.equal(count(counts, bot, "oak_planks"), 8);
  assert.equal(count(counts, bot, "oak_log"), 0);
  assert.deepEqual(craftCalls, ["oak_planks", "oak_planks"]);
  assert.equal(result.craft.items[0]!.gained, 8);
  assert.equal(result.craft.items[0]!.requested, 8);
  assert.equal(result.craft.items[0]!.inventoryBefore, 0);
});

test("an abort between an intermediate and its target reuses the intermediate already carried", async () => {
  const { bot, counts, craftCalls } = craftingBot({ oak_log: 1 });
  const [first] = reflexAfterCrafts(bot, [1]);
  const run = beginCraftItem(bot, navigation, { items: [{ itemName: "stick", count: 4 }] }, () => {});

  await assert.rejects(run(first!), /reflex took the body/);
  assert.deepEqual(craftCalls, ["oak_planks"]);
  const result = await run(freshAttempt());

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.deepEqual(craftCalls, ["oak_planks", "stick"]);
  assert.equal(count(counts, bot, "stick"), 4);
  assert.equal(count(counts, bot, "oak_planks"), 2);
});

test("an abort after the last recipe returns the success on the next call without crafting again", async () => {
  const { bot, counts, craftCalls } = craftingBot({ oak_planks: 2 });
  const [first] = reflexAfterCrafts(bot, [1]);
  const run = beginCraftItem(bot, navigation, { items: [{ itemName: "stick", count: 4 }] }, () => {});

  await assert.rejects(run(first!), /reflex took the body/);
  const result = await run(freshAttempt());

  assert.equal(result.status, "succeeded");
  assert.deepEqual(craftCalls, ["stick"]);
  assert.equal(count(counts, bot, "stick"), 4);
  assert.equal(result.craft.items[0]!.gained, 4);
  assert.equal((await run(freshAttempt())).status, "succeeded", "and again");
  assert.deepEqual(craftCalls, ["stick"]);
});

test("two reflexes in a row make three attempts and one total", async () => {
  const { bot, counts, craftCalls } = craftingBot({ oak_log: 3 });
  const [first, second] = reflexAfterCrafts(bot, [1, 2]);
  const run = beginCraftItem(bot, navigation, { items: [{ itemName: "oak_planks", count: 12 }] }, () => {});

  await assert.rejects(run(first!), /reflex/);
  await assert.rejects(run(second!), /reflex/);
  const result = await run(freshAttempt());

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.deepEqual(craftCalls, ["oak_planks", "oak_planks", "oak_planks"]);
  assert.equal(count(counts, bot, "oak_planks"), 12);
});

test("materials taken between attempts end the request with the plan's own shortfall, nothing crafted twice", async () => {
  const { bot, counts, craftCalls } = craftingBot({ oak_log: 2 });
  const [first] = reflexAfterCrafts(bot, [1]);
  const run = beginCraftItem(bot, navigation, { items: [{ itemName: "oak_planks", count: 8 }] }, () => {});

  await assert.rejects(run(first!), /reflex/);
  counts.set(bot.registry.itemsByName.oak_log!.id, 0);
  const result = await run(freshAttempt());

  assert.equal(result.status, "failed");
  assert.match(result.error, /CRAFT_MATERIALS_MISSING/);
  assert.deepEqual(craftCalls, ["oak_planks"]);
  assert.equal(result.craft.items[0]!.gained, 4, "the first attempt's planks still count");
});

test("the progress read by the runner is taken once, before the first attempt", async () => {
  const { bot } = craftingBot({ oak_log: 2 });
  let observed = 0;
  const [first] = reflexAfterCrafts(bot, [1]);
  const run = beginCraftItem(bot, navigation, { items: [{ itemName: "oak_planks", count: 8 }] }, () => {
    observed += 1;
  });

  await assert.rejects(run(first!), /reflex/);
  await run(freshAttempt());

  assert.equal(observed, 1);
});

/** A temporary table that stands between attempts, with the operations a bot has for it. */
function tableOperations(
  bot: ReturnType<typeof craftingBot>["bot"],
  counts: Map<number, number>,
  calls: string[],
): WorkstationOperations {
  const position = new Vec3(1, 64, 0);
  const table = { name: "crafting_table", position } as WorldBlock;
  const id = bot.registry.itemsByName.crafting_table!.id;
  let standing = false;
  Object.assign(bot, {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt: () => (standing ? table : ({ name: "air", position } as WorldBlock)),
  });
  return {
    place: async () => {
      calls.push("place");
      standing = true;
      counts.set(id, (counts.get(id) ?? 0) - 1);
      return { kind: "placed", block: table, position };
    },
    moveToOpenGround: async () => false,
    collect: async () => {
      calls.push("collect");
      standing = false;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return { status: "succeeded" };
    },
  };
}

test("a temporary table placed by an aborted attempt is reused, never placed twice, and recovered once", async () => {
  const { bot, counts, craftCalls } = craftingBot({ crafting_table: 1, oak_log: 1, cobblestone: 3 });
  const calls: string[] = [];
  const operations = tableOperations(bot, counts, calls);
  const [first] = reflexAfterCrafts(bot, [1]);
  const request: CraftItemRequest = { items: [{ itemName: "stone_pickaxe", count: 1 }], temporaryWorkstation: true };
  const run = beginCraftItem(bot, navigation, request, () => {}, undefined, operations);

  await assert.rejects(run(first!), /reflex took the body/);
  assert.deepEqual(calls, ["place"], "an aborted attempt leaves the table standing");
  const result = await run(freshAttempt());

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.deepEqual(calls, ["place", "collect"]);
  assert.equal(result.workstation?.recovered, true);
  assert.equal(count(counts, bot, "stone_pickaxe"), 1);
  assert.equal(count(counts, bot, "crafting_table"), 1, "the table is carried again");
  assert.deepEqual(craftCalls, ["oak_planks", "stick", "stone_pickaxe"]);
});
