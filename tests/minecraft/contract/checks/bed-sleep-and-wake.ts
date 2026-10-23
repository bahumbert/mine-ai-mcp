/**
 * A night bed: the server seats the player (the `sleep` event, `isSleeping`, pose and sleeping position in her metadata, the
 * bed shown occupied), `wake` frees her at once with the night still on, and a sleep left alone is cut off by the server
 * skipping the night once every player has slept long enough, which wakes her at dawn.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { holdsWithin } from "../subject.ts";
import { BED_ANSWER_WALL_MS, BED_FIXTURE, BED_HEAD, bedOccupied, sleepMetadataOf, trySleep, untilBedOccupied } from "./bed-scene.ts";

/** Night: past the 12541 Mineflayer's `sleep` allows, with a long way to the 23458 it stops at. */
const NIGHT_TICK = 14_000;
/** `pose` 2 is sleeping (`entities.js:483`). */
const SLEEPING_POSE = 2;
/** The server skips the night once every player has slept 100 ticks: 5003, 5009 and 5003 ms after the `sleep` event in 3 runs (2026-10-23). */
const SKIP_AFTER_SLEEP_MS = 5_000;
/** A server a little behind its schedule, and a round trip for the packets. */
const SKIP_SLACK_MS = 3_000;
const DAWN_TICK = 24_000;
const DAWN_SLACK_TICKS = 20;

export const bedSleepAndWake: ContractCheck = {
  name: "bed-sleep-and-wake",
  // Our runtime would walk to or sleep in the bed.
  withoutRuntime: true,
  fixture: { ...BED_FIXTURE, timeOfDay: NIGHT_TICK, daylightCycle: true },
  async run(subject) {
    const { bot } = subject;
    assert.equal(bot.isSleeping, false, "awake at the start");
    assert.ok(bot.time.timeOfDay >= 12_541 && bot.time.timeOfDay <= 23_458, `it is night: ${bot.time.timeOfDay}`);
    const events: string[] = [];
    const onSleep = () => void events.push("sleep");
    const onWake = () => void events.push("wake");
    bot.on("sleep", onSleep);
    bot.on("wake", onWake);
    try {
      const first = await trySleep(subject);
      assert.deepEqual({ slept: first.slept, error: first.error }, { slept: true, error: undefined }, "the night bed accepts the sleep");
      assert.equal(bot.isSleeping, true);
      const { pose, sleepingPos } = sleepMetadataOf(bot);
      assert.equal(pose, SLEEPING_POSE, "her pose is sleeping");
      assert.deepEqual(sleepingPos, { x: BED_HEAD.x, y: BED_HEAD.y, z: BED_HEAD.z }, "her sleeping position is the bed's head");
      await untilBedOccupied(subject, true);

      // A wake before the skip: at once, the night still on.
      const nightBefore = bot.time.timeOfDay;
      await bot.wake();
      assert.ok(await holdsWithin(subject, () => !bot.isSleeping, BED_ANSWER_WALL_MS), "wake() did not free her");
      assert.deepEqual(events, ["sleep", "wake"]);
      await untilBedOccupied(subject, false);
      assert.ok(bot.time.timeOfDay >= nightBefore && bot.time.timeOfDay <= 23_458, `a wake before the skip leaves the night on: ${bot.time.timeOfDay}`);

      // Left alone, the sleep ends in the skip: the time packet at the dawn after, and the wake.
      const heardTimes: number[] = [];
      const onTime = () => void heardTimes.push(bot.time.time);
      bot.on("time", onTime);
      const second = await trySleep(subject);
      assert.equal(second.slept, true, `the second sleep: ${String(second.error)}`);
      assert.ok(await holdsWithin(subject, () => events.length === 4, SKIP_AFTER_SLEEP_MS + SKIP_SLACK_MS), `no wake for the sleep left alone: ${events.join(",")}`);
      const sleptMs = subject.now() - second.atMs;
      assert.ok(Math.abs(sleptMs - SKIP_AFTER_SLEEP_MS) <= SKIP_SLACK_MS, `woke ${Math.round(sleptMs)} ms after the sleep: ${SKIP_AFTER_SLEEP_MS} within ${SKIP_SLACK_MS}`);
      assert.ok(await holdsWithin(subject, () => bot.time.timeOfDay < 12_541, BED_ANSWER_WALL_MS), `the night was not skipped: ${bot.time.timeOfDay}`);
      // The skip sets the time to the next dawn; the packet the client reads is that dawn a tick or two on (24001 was heard).
      assert.ok(bot.time.time >= DAWN_TICK && bot.time.time <= DAWN_TICK + DAWN_SLACK_TICKS, `dawn is the next multiple of a day: ${bot.time.time}`);
      assert.equal(bot.isSleeping, false);
      assert.equal(bedOccupied(bot), false, "the bed is free again");
      assert.ok(heardTimes.length > 0 && heardTimes.at(-1)! - DAWN_TICK <= DAWN_SLACK_TICKS, `the last time packet heard is the dawn: ${heardTimes.join(", ")}`);
      bot.off("time", onTime);
    } finally {
      bot.off("sleep", onSleep);
      bot.off("wake", onWake);
    }
  },
};
