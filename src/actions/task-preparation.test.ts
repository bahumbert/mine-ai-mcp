import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { botFixture } from "../test-support/bot.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { NavigationRuntime } from "../navigation/index.js";
import { prepareBotForMovement } from "../session/prepare-body.js";

test("movement preparation returns the bot to a neutral state", async () => {
  const calls: string[] = [];
  const bot = {
    clearControlStates: () => calls.push("controls"),
    deactivateItem: () => calls.push("item"),
    currentWindow: {},
    closeWindow: () => calls.push("window"),
    entity: { vehicle: {}, position: new Vec3(0.5, 64, 0.5) },
    blockAt: () => null,
    dismount: () => calls.push("vehicle"),
    isSleeping: true,
    wake: async () => calls.push("sleep"),
  } as unknown as Bot;

  const navigation = { cancel: () => calls.push("navigation") } as unknown as NavigationRuntime;
  await prepareBotForMovement(bot, navigation);

  assert.deepEqual(calls, ["controls", "navigation", "item", "window", "vehicle", "sleep"]);
});

function webBot(webAt: "feet" | "head" | null) {
  const dug: string[] = [];
  const blocks = webAt === null ? {} : { [`10,${webAt === "feet" ? 64 : 65},20`]: "cobweb" };
  const base = botFixture({ position: new Vec3(10.5, 64, 20.5), blocks });
  const bot = botFixture(
    { position: new Vec3(10.5, 64, 20.5), blocks },
    { blockAt: (cell: Vec3) => { const block = base.blockAt(cell) as { name?: string } | null; return block?.name === "cobweb" ? Object.assign(block, { digTime: () => 1 }) : block; }, clearControlStates: () => undefined, deactivateItem: () => undefined, currentWindow: null, isSleeping: false, canDigBlock: () => true, dig: async (block: { name: string; position: Vec3 }) => void dug.push(`${block.name}@${block.position.y}`) },
  );
  return { bot, dug };
}

test("movement preparation breaks a cobweb in the head cell, so every movement action does, not only navigate", async () => {
  const { bot, dug } = webBot("head");
  await prepareBotForMovement(bot, { cancel: () => undefined } as unknown as NavigationRuntime);
  assert.deepEqual(dug, ["cobweb@65"]);
});

test("movement preparation digs nothing when no cobweb is in the body", async () => {
  const { bot, dug } = webBot(null);
  await prepareBotForMovement(bot, { cancel: () => undefined } as unknown as NavigationRuntime);
  assert.deepEqual(dug, []);
});
