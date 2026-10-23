/**
 * A night bed with a zombie four blocks away: Mineflayer refuses before any packet (`bed.js` `there are monsters nearby`),
 * and when the use is sent anyway (`activateBlock`) the server seats nobody and answers with the action-bar message.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { holdsWithin } from "../subject.ts";
import { BED_FIXTURE, REFUSAL_WATCH_MS, countWrites, trySleep, useBed } from "./bed-scene.ts";

/** What the server says to a player in a bed with a monster near (`Player.BedSleepingProblem.NOT_SAFE`). */
const NOT_SAFE = "block.minecraft.bed.not_safe";
const ZOMBIE_WALL_MS = 5_000;

export const bedRefusedMonsterNear: ContractCheck = {
  name: "bed-refused-monster-near",
  withoutRuntime: true,
  fixture: { ...BED_FIXTURE, timeOfDay: 14_000, daylightCycle: true, entities: [{ name: "zombie", position: [4.5, -60, 3.5] }] },
  async run(subject) {
    const { bot } = subject;
    assert.ok(await holdsWithin(subject, () => Object.values(bot.entities).some((entity) => entity.name === "zombie"), ZOMBIE_WALL_MS), "no zombie in view");
    const blockPlaces = countWrites(bot, "block_place");
    const messages: string[] = [];
    const onActionBar = (message: { translate?: string; toString(): string }) => void messages.push(message.translate ?? message.toString());
    bot.on("actionBar", onActionBar);
    try {
      const refused = await trySleep(subject);
      assert.equal(refused.slept, false);
      assert.match(refused.error ?? "", /monsters nearby/u, "Mineflayer refuses with a monster near");
      assert.equal(blockPlaces.count(), 0, "Mineflayer's refusal writes no packet");

      // The server's own answer to the use that Mineflayer would not send.
      await useBed(subject);
      assert.ok(await holdsWithin(subject, () => messages.length > 0, REFUSAL_WATCH_MS), "the server said nothing to the use");
      assert.equal(blockPlaces.count(), 1);
      assert.deepEqual(messages, [NOT_SAFE], "the action bar says it is not safe");
      assert.equal(bot.isSleeping, false);
    } finally {
      bot.off("actionBar", onActionBar);
      blockPlaces.stop();
    }
  },
};
