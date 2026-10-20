import assert from "node:assert/strict";
import test from "node:test";
import { botFixture } from "../../test-support/bot.js";
import { planPlugKeep } from "./plug-reserve.js";

/** A bot on the version whose block tags the common-stock fallback reads, carrying `items`. */
const carrying = (...items: Array<[string, number]>) =>
  botFixture({ items: items.map(([name, count]) => ({ name, count })) }, { version: "1.21.4" });

const tossing = (...tosses: Array<[string, number]>) => new Map(tosses);

test("nothing is kept when another plug-capable block stays carried", () => {
  const bot = carrying(["cobblestone", 70], ["dirt", 64]);
  assert.equal(planPlugKeep(bot, tossing(["cobblestone", 70])), null);
});

test("two are kept from the first plug-capable item an \"all\" request buries", () => {
  const bot = carrying(["cobblestone", 70], ["oak_log", 16]);
  assert.deepEqual(planPlugKeep(bot, tossing(["oak_log", 16], ["cobblestone", 70])), { item: "cobblestone", count: 2 });
});

test("a request of 2 plug blocks keeps 1 and buries 1", () => {
  const bot = carrying(["cobblestone", 2]);
  assert.deepEqual(planPlugKeep(bot, tossing(["cobblestone", 2])), { item: "cobblestone", count: 1 });
});

test("a request of 1 plug block keeps nothing", () => {
  const bot = carrying(["cobblestone", 1]);
  assert.equal(planPlugKeep(bot, tossing(["cobblestone", 1])), null);
});

test("one plug block left carried by an explicit count keeps only the missing one", () => {
  const bot = carrying(["cobblestone", 40]);
  assert.deepEqual(planPlugKeep(bot, tossing(["cobblestone", 39])), { item: "cobblestone", count: 1 });
  assert.equal(planPlugKeep(bot, tossing(["cobblestone", 38])), null, "two stay carried");
});

test("a common-stock block (planks tag) counts when the policy list has none carried", () => {
  const bot = carrying(["oak_planks", 30]);
  assert.deepEqual(planPlugKeep(bot, tossing(["oak_planks", 30])), { item: "oak_planks", count: 2 });
  const withStone = carrying(["oak_planks", 30], ["stone", 12]);
  assert.equal(planPlugKeep(withStone, tossing(["oak_planks", 30])), null, "twelve stone stay carried");
});

test("a log or a wool is never kept", () => {
  assert.equal(planPlugKeep(carrying(["oak_log", 64]), tossing(["oak_log", 64])), null);
  assert.equal(planPlugKeep(carrying(["white_wool", 64]), tossing(["white_wool", 64])), null);
});

test("an item the request does not toss never counts as buried, and a plug-capable block is kept from the next one", () => {
  const bot = carrying(["oak_log", 16], ["cobblestone", 5]);
  assert.deepEqual(planPlugKeep(bot, tossing(["oak_log", 0], ["cobblestone", 5])), { item: "cobblestone", count: 2 });
});
