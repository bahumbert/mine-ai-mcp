import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { NavigationRuntime } from "../navigation/index.js";
import { prepareBotForMovement } from "../session/prepare-body.js";

test("movement preparation returns the bot to a neutral state", async () => {
  const calls: string[] = [];
  const { bot } = createFakeBot({
    entities: { 2: { name: "minecart", position: new Vec3(0.5, 64, 0.5) } },
    overrides: {
      clearControlStates: () => void calls.push("controls"),
      deactivateItem: () => void calls.push("item"),
      closeWindow: async () => void calls.push("window"),
      dismount: () => void calls.push("vehicle"),
      isSleeping: true,
      wake: async () => void calls.push("sleep"),
    },
  });
  // A container window is open and the bot rides a minecart, not a boat.
  Object.assign(bot, { currentWindow: {} });
  bot.entity.vehicle = bot.entities[2]!;

  const navigation = { cancel: () => calls.push("navigation") } as unknown as NavigationRuntime;
  await prepareBotForMovement(bot, navigation);

  assert.deepEqual(calls, ["controls", "navigation", "item", "window", "vehicle", "sleep"]);
});

/** A bot at 10.5,64,20.5 with a cobweb in its feet or head cell (or none); `dug` names each block it starts to dig. */
function webBot(webAt: "feet" | "head" | null) {
  const dug: string[] = [];
  const cells = webAt === null ? {} : { [`10,${webAt === "feet" ? 64 : 65},20`]: "cobweb" };
  const harness = createFakeBot({
    position: new Vec3(10.5, 64, 20.5),
    cells,
    overrides: { deactivateItem: () => undefined, isSleeping: false, canDigBlock: () => true },
  });
  const { bot } = harness;
  const dig = bot.dig;
  const recordedDig = async (block: Block, forceLook?: boolean | "ignore") => {
    dug.push(`${block.name}@${block.position.y}`);
    return dig(block, forceLook);
  };
  bot.dig = recordedDig;
  return { bot, dug, clock: harness.clock };
}

test("movement preparation breaks a cobweb in the head cell, so every movement action does, not only navigate", async () => {
  const { bot, dug, clock } = webBot("head");
  // A cobweb takes 20 s by hand (hardness 4, no harvesting tool): the clock runs until the dig is done.
  await clock.settle(prepareBotForMovement(bot, { cancel: () => undefined } as unknown as NavigationRuntime), 30_000);
  assert.deepEqual(dug, ["cobweb@65"]);
});

test("movement preparation digs nothing when no cobweb is in the body", async () => {
  const { bot, dug, clock } = webBot(null);
  await clock.settle(prepareBotForMovement(bot, { cancel: () => undefined } as unknown as NavigationRuntime), 30_000);
  assert.deepEqual(dug, []);
});
