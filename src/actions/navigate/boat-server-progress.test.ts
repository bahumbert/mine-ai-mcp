// Rowing credit waits for server time, including slow packets and a stopped server.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { waitForBoatStep } from "./boat-server-progress.js";

test("a slow server's next boat step waits past ten seconds for its time packet", async () => {
  // Contract world-age-at-slow-tick: one packet per 20 server ticks, even at 2 tps.
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, server } = createFakeBot({ clock, server: { ticksPerSecond: 2 } });
  using _timers = clock.install();
  server.stop();
  clock.after(500, () => server.resume());
  const credit = { age: bot.time.age, steps: 20 };
  const pending = waitForBoatStep(bot, credit, () => false);
  assert.equal(await clock.settle(pending, 11_000), true);
  assert.ok(clock.now() >= 10_500, "the packet arrives after ten seconds plus the server's delay");
  assert.equal(credit.steps, 1, "the new packet grants the next batch of rowing steps");
});

for (const heardTime of [true, false]) {
  test(`a boat step with ${heardTime ? "a stopped" : "no known"} world age gives up after twenty seconds and can resume`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    const { bot, server } = createFakeBot({ clock, server: { timePacketYet: heardTime } });
    using _timers = clock.install();
    server.stop();
    const credit = { age: bot.time.age, steps: 20 };
    let ended = false;
    const pending = waitForBoatStep(bot, credit, () => false).then((answer) => { ended = true; return answer; });
    await clock.advance(19_975, 25);
    assert.equal(ended, false);
    assert.equal(await clock.settle(pending, 25, 25), false);
    server.resume();
    assert.equal(await clock.settle(waitForBoatStep(bot, credit, () => false), 2_050), true);
  });
}

test("a stopped boat-step wait responds to cancellation without waiting for server time", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, server } = createFakeBot({ clock });
  using _timers = clock.install();
  server.stop();
  let stopped = false;
  clock.after(500, () => { stopped = true; });
  const credit = { age: bot.time.age, steps: 20 };
  assert.equal(await clock.settle(waitForBoatStep(bot, credit, () => stopped), 550), false);
  assert.equal(credit.steps, 20, "cancellation grants no further rowing steps");
});
