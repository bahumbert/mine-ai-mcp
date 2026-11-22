// The condition facts of view_status (plan 2026-11-07-p4-03-condition-line task 2): armour points, worn and carried armour, light, combat readout, respawn.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { viewStatusResultSchema } from "./contract.js";
import { formatViewStatusResult, observeLiveSituation } from "./view-status.js";
import { FEET, idleActivity, liveBot } from "./view-status-fixtures.test.js";
import { recordWake } from "../portal-entry/respawn-knowledge.js";
import { gearExposure } from "../../world/gear-exposure.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";

/** Open ground under the bot's feet: the fake answers sky 15 / block 0 for open air over a block (measured, light-in-cells). */
const GROUND = { "-10,98,18": "stone" } as const;

const situationOf = (bot: Bot, t: test.TestContext) => observeLiveSituation(bot, temporaryBotData({ botId: "TestBot", closeAfter: t }), idleActivity);

/** Every cell the bot reads above its feet reports the sky light `skyAt` gives for its height, and `null` where it says so: the scene of a shaft or a cave mouth, which the fake has no measured shape for. */
function skyByHeight(bot: Bot, skyAt: (y: number) => number | null | undefined): void {
  const read = bot.blockAt.bind(bot);
  bot.blockAt = (point, extraInfos) => {
    const sky = skyAt(Math.floor(point.y));
    if (sky === null) return null;
    const block = read(point, extraInfos);
    if (block && sky !== undefined) Object.assign(block, { skyLight: sky, light: 0 });
    return block;
  };
}

test("worn and carried armour are read from slots", (t) => {
  const bot = liveBot({ carried: { 36: { name: "stone_pickaxe" }, 9: { name: "diamond_helmet" }, 10: { name: "iron_chestplate" }, 11: { name: "iron_chestplate" } } });
  const situation = situationOf(bot, t);
  assert.deepEqual(situation.armourWorn, [
    { slot: "head", item: "diamond_helmet" },
    { slot: "torso", item: null },
    { slot: "legs", item: null },
    { slot: "feet", item: null },
  ]);
  assert.deepEqual(situation.armourCarried, [
    { item: "diamond_helmet", count: 1, slot: "head" },
    { item: "iron_chestplate", count: 2, slot: "torso" },
  ], "each carried piece with the slot it is for, summed per item; the worn helmet is not listed");
  assert.equal(situation.tools.armour.find((entry) => entry.class === "chestplate")?.item, "iron_chestplate", "tools.armour still names the best carried piece, unchanged");
});

test("view_status reports armour points, light, combat and respawn", (t) => {
  const bot = liveBot({ cells: GROUND, carried: { 36: { name: "iron_sword" }, 9: { name: "bow" }, 45: { name: "shield" } } });
  Object.assign(bot, { spawnPoint: new Vec3(FEET.x, FEET.y, FEET.z + 12) });
  const situation = situationOf(bot, t);
  assert.equal(viewStatusResultSchema.parse({ status: "succeeded", situation }).situation.light.sky, 15, "the result parses under the schema");
  assert.deepEqual(situation.light, { sky: 15, block: 0, openSkyAbove: null }, "open floor: the measured open values, and no open-sky distance to give");
  assert.deepEqual(situation.combat, { melee: "iron_sword", bow: "bow", arrows: 0, shield: "shield", exposure: gearExposure(bot).exposure });
  assert.deepEqual(situation.respawn, { kind: "world_spawn", position: { x: FEET.x, y: FEET.y, z: FEET.z + 12 }, distance: 12 });
  assert.deepEqual([situation.vitals.armour, situation.vitals.armourToughness], [null, null], "a piece is worn and the server told no armour attribute: unknown, not 0");
});

test("view_status reports full exposure with no gear", (t) => {
  const { bot } = createFakeBot();
  assert.equal(situationOf(bot, t).combat.exposure, 1);
});

test("view_status requires exposure within its inclusive bounds", (t) => {
  const situation = situationOf(liveBot(), t);
  const { melee, bow, arrows, shield } = situation.combat;
  const baseCombat = { melee, bow, arrows, shield };
  for (const [exposure, valid] of [[0.15, true], [1, true], [0.1499, false], [1.0001, false], [undefined, false]] as const) {
    const combat = exposure === undefined ? baseCombat : { ...baseCombat, exposure };
    const parse = () => viewStatusResultSchema.parse({ status: "succeeded", situation: { ...situation, combat } });
    if (valid) assert.equal(parse().situation.combat.exposure, exposure);
    else assert.throws(parse);
  }
});

test("view_status describes the last wake and parses its kind", (t) => {
  const bot = liveBot({ cells: GROUND });
  recordWake(bot, { x: FEET.x, y: FEET.y, z: FEET.z + 12 }, "overworld");
  const result = viewStatusResultSchema.parse({ status: "succeeded", situation: situationOf(bot, t) });
  assert.equal(result.situation.respawn?.kind, "last_wake");
  assert.match(formatViewStatusResult(result), /respawn where it last woke 12 blocks away/);
});

test("the open sky distance is counted up the column", (t) => {
  const bot = liveBot({ cells: GROUND });
  const feetY = Math.floor(FEET.y);
  skyByHeight(bot, (y) => (y <= feetY + 2 ? 0 : 15));
  assert.deepEqual(situationOf(bot, t).light, { sky: 0, block: 0, openSkyAbove: 3 }, "sealed at the feet and the two cells over them, open sky from the third");
});

test("a cell with no light data reads null, not dark; an unloaded column above gives no open sky distance", (t) => {
  // A world of only air has no measured light section: the fake says nothing, and so does the report (never sky 0).
  assert.deepEqual(situationOf(liveBot(), t).light, { sky: null, block: null, openSkyAbove: null }, "no light data at the feet");
  const shaft = liveBot({ cells: GROUND });
  const feetY = Math.floor(FEET.y);
  skyByHeight(shaft, (y) => (y === feetY ? 0 : y === feetY + 1 ? null : 15));
  assert.deepEqual(situationOf(shaft, t).light, { sky: 0, block: 0, openSkyAbove: null }, "the cell above is not loaded: no distance, no throw");
});

test("the text names the condition facts on one line, a null piece left out", (t) => {
  const bot = liveBot({ cells: GROUND, carried: { 36: { name: "iron_sword" }, 9: { name: "iron_chestplate" } } });
  Object.assign(bot, { spawnPoint: new Vec3(FEET.x, FEET.y, FEET.z + 12) });
  const text = formatViewStatusResult(viewStatusResultSchema.parse({ status: "succeeded", situation: situationOf(bot, t) }));
  const line = text.split("\n").find((entry) => entry.startsWith("Condition facts:"));
  assert.equal(line, "Condition facts: worn head diamond_helmet; carried armour iron_chestplate; light sky 15 block 0; combat iron_sword, shield; respawn world spawn 12 blocks away.");
});
