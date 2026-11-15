// Smelt receipts wait for the returned input's server correction, including on a slow or stopped server.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock, itemOf } from "../../test-support/fake-bot/index.js";
import { watch } from "../../test-support/pending.js";
import { countAttemptIngots, type CookAttempt } from "./attempt-ingots.js";

for (const { stopped, elapsed, count, produced } of [
  { stopped: false, elapsed: 7_000, count: 1, produced: 7 },
  { stopped: true, elapsed: 20_000, count: 2, produced: 6 },
]) {
  test(`returned smelt input ${stopped ? "waits 20 s for a stopped clock" : "is corrected at 7 s at 5 tps"}`, async () => {
    const { bot, clock, inventory, server } = createFakeBot({
      clock: createFakeClock({ mode: "mocked" }),
      server: { ticksPerSecond: 5 },
      carried: { raw_iron: 2 },
    });
    using _timers = clock.install();
    // closeWindow copies predicted slots; a trailing set_slot can correct one input cooked in the take's tick
    // (mineflayer inventory.js, lastClosedWindow; facts/gathering.md "An aborted attempt counts its ingots").
    const cook: CookAttempt = {
      verdict: "execution_failed", executionError: "interrupted", recovery: { input: 2, fuel: 0, output: null, errors: [] },
      harvest: { taken: () => 0, item: () => null, takeReady: async () => {}, credit: () => {} },
      loaded: { carriedBefore: 8, count: 8 }, inputLeft: 0, recoveredAtAge: bot.time.age,
    };
    if (stopped) server.stop();
    else clock.after(7_000, () => inventory.updateSlot(36, itemOf(bot.registry, "raw_iron", 1)));
    const pending = countAttemptIngots(bot, { itemName: "raw_iron", fuelItemName: "coal" }, cook);
    const observed = watch(pending);

    await clock.advance(elapsed - 50);
    assert.equal(observed.over, false, "still waiting for the correction or the stopped-clock bound");
    const result = await clock.settle(pending, 50);

    assert.deepEqual(result.inputAfter, { count, confirmed: true });
    assert.equal(result.produced, produced);
  });
}
