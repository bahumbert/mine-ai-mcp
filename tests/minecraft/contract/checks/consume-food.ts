/**
 * Eating (Mine Labs 1.21.4, 2026-10-23, 3 runs). A golden apple, always edible, eaten at food 20: `bot.consume()` resolves
 * ~1.6 s after the use (1558 to 1576 ms), the server hands the bot regeneration and absorption (`entity_effect`), the stack
 * loses one and the hand-in-use bit is clear. Bread at food 20: Mineflayer refuses ("Food is full") before any packet, and
 * a use sent anyway is ignored by the server (no bit, no bite, the stack kept). A bite released while it is under way
 * (`deactivateItem` once the bit is set; the bite lasts 1.6 s) clears the bit, keeps the stack, and the `consume` promise
 * rejects; the next `consume` eats.
 */
import assert from "node:assert/strict";
import type { Bot } from "mineflayer";
import type { ContractCheck } from "../checks.ts";
import { answerArrives, serverQuiet } from "../server-answer.ts";
import type { ContractSubject } from "../subject.ts";
import { countWrites } from "./bed-scene.ts";
import { finishWithin, holdInHand, useFlagsOf } from "./combat-scene.ts";
import { type TimedMark, latenessRecorded, latenessSaid, markTimed, readingWindow } from "./late-reading-window.ts";
import { type Mark, markNow, tickOf } from "./server-tick-marks.ts";

/**
 * The bite is the game's 32 ticks (the 1.6 s of Minecraft's food usage, `mineflayer/lib/plugins/inventory.js:12-15` says 1.61 s; 1558-1576 ms
 * measured at 20 a second): judged by the server's ticks, since a server below 20 a second holds them in more wall time and Mineflayer's
 * `consume` gives up at 2500 ms (`inventory.js:15`, 12.8 ticks a second and below).
 */
const EATING_TICKS = 32;
const MINEFLAYER_CONSUME_TIMEOUT = /Promise timed out/u;

const USING_HAND = 1;
const APPLE_EFFECTS = ["regeneration", "absorption"];

const countOf = (bot: Bot, name: string) => bot.inventory.count(bot.registry.itemsByName[name]!.id, null);
const effectNames = (bot: Bot) => Object.values(bot.entity.effects).map((effect) => bot.registry.effects[effect.id]?.name?.toLowerCase());

/**
 * Eat the held food and read the server's tick at the use and at the end of the bite (the `consume` promise resolving, or, when Mineflayer gave
 * up at 2500 ms on a slow server, the effects the server sends with the end), whatever the wall time between them; any other rejection fails.
 */
async function eatMarked(subject: ContractSubject, what: string): Promise<{ readonly started: Mark; readonly ended: TimedMark }> {
  const { bot } = subject;
  let ended: TimedMark | null = null;
  const onEffect = (entity: unknown) => {
    if (entity === bot.entity) ended ??= markTimed(subject);
  };
  bot.on("entityEffect", onEffect);
  try {
    const started = markNow(subject);
    const eating = bot.consume().then(
      () => void (ended ??= markTimed(subject)),
      (error: Error) => {
        if (!MINEFLAYER_CONSUME_TIMEOUT.test(error.message)) throw error;
      },
    );
    await finishWithin(subject, eating, what);
    await answerArrives(subject, () => ended !== null, `${what}: the end of the bite`);
    return { started, ended: ended! };
  } finally {
    bot.off("entityEffect", onEffect);
  }
}

export const consumeFood: ContractCheck = {
  name: "consume-food",
  fixture: { cells: {}, carried: { golden_apple: 2, bread: 2 }, position: [0.5, -60, 0.5] },
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    assert.equal(bot.food, 20, "the bot starts hungry");
    await holdInHand(subject, "golden_apple");
    const { started, ended } = await eatMarked(subject, "consume");
    const startTick = await tickOf(subject, started);
    const endTick = await tickOf(subject, ended);
    const tookTicks = endTick - startTick;
    const roundTripMs = await ended.roundTripMs;
    const window = readingWindow(EATING_TICKS, roundTripMs);
    assert.ok(
      tookTicks >= window.min && tookTicks <= window.max,
      `eating took ${tookTicks} server ticks (tick ${startTick} to ${endTick}), not ${window.min} to ${window.max} (${latenessSaid("end", roundTripMs, window.lateTicks)})`,
    );
    // The stack, the bit and the effects come after the resolution; the assertions below say which one never did.
    await answerArrives(subject, () => countOf(bot, "golden_apple") === 1 && (useFlagsOf(bot) & USING_HAND) === 0 && APPLE_EFFECTS.every((effect) => effectNames(bot).includes(effect)), "the eaten apple, the bite over and the effects");
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
      await serverQuiet(subject, "the refusal of bread");
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
    await answerArrives(subject, () => (useFlagsOf(bot) & USING_HAND) === USING_HAND, "no bite under way");
    bot.deactivateItem();
    await answerArrives(subject, () => (useFlagsOf(bot) & USING_HAND) === 0, "the release did not stop the bite");
    await finishWithin(subject, interrupted, "the released bite");
    assert.notEqual(await interrupted, "ate", "a bite released halfway was eaten");
    assert.equal(countOf(bot, "golden_apple"), 1, "a released bite spent the apple");
    await eatMarked(subject, "the next consume");
    await answerArrives(subject, () => countOf(bot, "golden_apple") === 0, "the next consume did not eat it");
    return latenessRecorded(EATING_TICKS, tookTicks, roundTripMs);
  },
};
