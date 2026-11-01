/**
 * The weather the client is told: the state a player joins in, then `rain` and `thunder` each raising a level a step a tick
 * (`rain_level_change`, `thunder_level_change`: `rainState`, `thunderState`, `weatherUpdate`) and `clear` lowering them;
 * and what it allows at noon: a use of the bed is refused by day and in the rain, a sleep is accepted once the thunder is full.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { answerArrives, answerArrivesWhileMoving } from "../server-answer.ts";
import { BED_FIXTURE, countWrites, trySleep, useBed } from "./bed-scene.ts";
import { type Mark, READING_TICKS, markNow, tickOf } from "./server-tick-marks.ts";

/** What the server says to a bed used by day (`Player.BedSleepingProblem.NOT_POSSIBLE_NOW`). */
const NO_SLEEP = "block.minecraft.bed.no_sleep";
const NOON = 6_000;
/**
 * A level moves a hundredth a tick (`ServerLevel.advanceWeatherCycle`): a full ramp is 100 ticks. Measured 4999 to 5000 ms from the first
 * `weatherUpdate` to the full level and 100 steps (102 updates) in 3 runs on a server on time (2026-10-23): the 5000 ms were 100 ticks.
 */
const LEVEL_STEP = 0.01;
const FULL_RAMP_TICKS = 100;
const FLOAT_SLACK = 1e-5;

export const rainAndThunderState: ContractCheck = {
  name: "rain-and-thunder-state",
  withoutRuntime: true,
  exclusive: "the subject sets the weather (`/weather`), which every lane of a shared server would see",
  fixture: { ...BED_FIXTURE, timeOfDay: NOON, daylightCycle: false, weather: "clear" },
  async run(subject) {
    const { bot } = subject;
    const levels: { rain: number; thunder: number }[] = [];
    // The rain ramp is judged in server ticks between its first update and its full level: two readings, not one per update.
    const ramp: { first?: Mark; full?: Mark } = {};
    const onWeather = () => {
      levels.push({ rain: bot.rainState, thunder: bot.thunderState });
      ramp.first ??= markNow(subject);
      if (bot.rainState === 1) ramp.full ??= markNow(subject);
    };
    /** What a ramp shows while it goes on: a wait on a level fails only when no update came for `ANSWER_WALL_MS`, however slowly the server ticks. */
    const updatesHeard = () => levels.length;
    const messages: string[] = [];
    const onActionBar = (message: { translate?: string; toString(): string }) => void messages.push(message.translate ?? message.toString());
    bot.on("weatherUpdate", onWeather);
    bot.on("actionBar", onActionBar);
    const blockPlaces = countWrites(bot, "block_place");
    try {
      assert.deepEqual([bot.isRaining, bot.rainState, bot.thunderState], [false, 0, 0], "a clear world joins clear");

      // By day in the clear: the use is answered with the action bar, and nobody sleeps.
      await useBed(subject);
      await answerArrives(subject, () => messages.length > 0, "the server said nothing to the use by day");
      assert.deepEqual(messages, [NO_SLEEP]);
      assert.equal(bot.isSleeping, false);

      await subject.setWeather("rain");
      await answerArrives(subject, () => bot.isRaining, "no rain");
      await answerArrivesWhileMoving(subject, () => bot.rainState === 1, updatesHeard, "the rain level never reached full");
      const rainRamp = levels.filter((level) => level.thunder === 0);
      const rainSteps = rainRamp.slice(1).map((level, index) => level.rain - rainRamp[index]!.rain);
      // Floats: a step is 0.01 to 6 digits, and an update that repeats the level (the thunder's, with the rain's) is a step of 0.
      assert.ok(rainSteps.every((step) => step >= 0 && step <= LEVEL_STEP + FLOAT_SLACK), `rain steps ${rainSteps.map((step) => step.toFixed(4)).join(", ")}: each up to ${LEVEL_STEP}`);
      assert.ok(rainSteps.filter((step) => step > 0).length >= FULL_RAMP_TICKS - 2, `${rainSteps.length} rain updates: a hundred steps of ${LEVEL_STEP}`);
      const rainTicks = (await tickOf(subject, ramp.full!)) - (await tickOf(subject, ramp.first!));
      assert.ok(Math.abs(rainTicks - FULL_RAMP_TICKS) <= READING_TICKS, `rain ramp took ${rainTicks} server ticks (the readings +-${READING_TICKS}): ${FULL_RAMP_TICKS}`);
      assert.equal(bot.thunderState, 0, "rain alone leaves the thunder at 0");

      // Rain by day: Mineflayer refuses, with no packet.
      const rained = await trySleep(subject);
      assert.deepEqual([rained.slept, /not night/u.test(rained.error ?? "")], [false, true], `rain alone: ${String(rained.error)}`);
      assert.equal(blockPlaces.count(), 1, "only the first use wrote a block_place");

      await subject.setWeather("thunder");
      await answerArrivesWhileMoving(subject, () => bot.thunderState === 1, updatesHeard, "the thunder level never reached full");
      assert.equal(bot.isRaining, true);
      const storm = await trySleep(subject);
      assert.deepEqual({ slept: storm.slept, error: storm.error }, { slept: true, error: undefined }, "a full thunderstorm lets her sleep at noon");
      await bot.wake();
      await answerArrives(subject, () => !bot.isSleeping, "wake() did not free her");

      await subject.setWeather("clear");
      await answerArrivesWhileMoving(subject, () => !bot.isRaining, updatesHeard, "the rain never stopped");
      await answerArrivesWhileMoving(subject, () => bot.rainState === 0 && bot.thunderState === 0, updatesHeard, "the rain and thunder levels never returned to 0 after clear");
    } finally {
      bot.off("weatherUpdate", onWeather);
      bot.off("actionBar", onActionBar);
      blockPlaces.stop();
    }
  },
};
