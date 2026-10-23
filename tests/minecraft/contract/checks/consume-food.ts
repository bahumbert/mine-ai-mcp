/**
 * Eating (Mine Labs 1.21.4, 2026-10-23, 3 runs). A golden apple, always edible, eaten at food 20: `bot.consume()` resolves
 * ~1.6 s after the use (1558 to 1576 ms), the server hands the bot regeneration and absorption (`entity_effect`), the stack
 * loses one and the hand-in-use bit is clear. Bread at food 20: Mineflayer refuses ("Food is full") before any packet, and
 * a use sent anyway is ignored by the server (no bit, no bite, the stack kept). A bite released halfway (`deactivateItem`)
 * clears the bit, keeps the stack, and the `consume` promise rejects; the next `consume` eats.
 */
import assert from "node:assert/strict";
import type { Bot } from "mineflayer";
import type { ContractCheck } from "../checks.ts";
import { countWrites } from "./bed-scene.ts";
import { CALL_WALL_MS, finishWithin, holdInHand, useFlagsOf } from "./combat-scene.ts";

const EATING_MS = { min: 1_400, max: 2_100 } as const;
const BITE_MS = 600;
const SETTLE_MS = 400;
const REFUSED_WATCH_MS = 2_000;
const USING_HAND = 1;
const APPLE_EFFECTS = ["regeneration", "absorption"];

const countOf = (bot: Bot, name: string) => bot.inventory.count(bot.registry.itemsByName[name]!.id, null);
const effectNames = (bot: Bot) => Object.values(bot.entity.effects).map((effect) => bot.registry.effects[effect.id]?.name?.toLowerCase());

export const consumeFood: ContractCheck = {
  name: "consume-food",
  fixture: { cells: {}, carried: { golden_apple: 2, bread: 2 }, position: [0.5, -60, 0.5] },
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    assert.equal(bot.food, 20, "the bot starts hungry");
    await holdInHand(subject, "golden_apple");
    const startedAt = subject.now();
    const tookMs = (await finishWithin(subject, bot.consume(), CALL_WALL_MS, "consume")) - startedAt;
    assert.ok(tookMs >= EATING_MS.min && tookMs <= EATING_MS.max, `eating took ${tookMs} ms, not ${EATING_MS.min} to ${EATING_MS.max}`);
    await subject.wait(SETTLE_MS);
    assert.equal(countOf(bot, "golden_apple"), 1, "an eaten apple stays in the stack");
    assert.equal(useFlagsOf(bot) & USING_HAND, 0, "the bite is over: the bit stays");
    assert.equal(bot.usingHeldItem, false);
    for (const effect of APPLE_EFFECTS) assert.ok(effectNames(bot).includes(effect), `no ${effect} after the apple: ${effectNames(bot).join(", ")}`);

    await holdInHand(subject, "bread");
    const uses = countWrites(bot, "use_item");
    try {
      await assert.rejects(bot.consume(), /Food is full/u, "Mineflayer lets a full bot eat bread");
      assert.equal(uses.count(), 0, "the refusal wrote a use");
      bot.activateItem();
      await subject.wait(REFUSED_WATCH_MS);
      assert.equal(useFlagsOf(bot) & USING_HAND, 0, "the server took the use of bread at food 20");
      assert.equal(countOf(bot, "bread"), 2, "bread was eaten at food 20");
      assert.equal(bot.usingHeldItem, true, "the client forgot its own use");
      bot.deactivateItem();
      assert.equal(bot.usingHeldItem, false);
    } finally {
      uses.stop();
    }

    await holdInHand(subject, "golden_apple");
    const interrupted = bot.consume().then(() => "ate", (error: Error) => error.message);
    await subject.wait(BITE_MS);
    assert.equal(useFlagsOf(bot) & USING_HAND, USING_HAND, "no bite under way");
    bot.deactivateItem();
    await subject.wait(SETTLE_MS);
    assert.equal(useFlagsOf(bot) & USING_HAND, 0, "the release did not stop the bite");
    await finishWithin(subject, interrupted, CALL_WALL_MS, "the released bite");
    assert.notEqual(await interrupted, "ate", "a bite released halfway was eaten");
    assert.equal(countOf(bot, "golden_apple"), 1, "a released bite spent the apple");
    await finishWithin(subject, bot.consume(), CALL_WALL_MS, "the next consume");
    await subject.wait(SETTLE_MS);
    assert.equal(countOf(bot, "golden_apple"), 0, "the next consume did not eat it");
  },
};
