// Driver waits count whole server time packets, with a packet of margin for the age already heard.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { watch } from "../../../src/test-support/pending.ts";
import { waitServerTicks } from "./server-ticks.ts";

// Packet cadence measured by contract/checks/world-age-at-slow-tick.ts; the shared server sends +20 per packet.
for (const { ticks, phaseMs, firstPacketMs, finishMs, rate } of [
  { ticks: 20, phaseMs: 0, firstPacketMs: 1_000, finishMs: 2_000, rate: 20 },
  { ticks: 20, phaseMs: 50, firstPacketMs: 50, finishMs: 1_050, rate: 20 },
  { ticks: 10, phaseMs: 0, firstPacketMs: 1_000, finishMs: 2_000, rate: 20 },
  { ticks: 20, phaseMs: 0, firstPacketMs: 2_000, finishMs: 4_000, rate: 10 },
]) {
  test(`${ticks} ticks with a packet after ${firstPacketMs} ms waits for the second +20 jump`, async () => {
    const { bot, clock } = createFakeBot({ server: { phaseMs, ticksPerSecond: rate } });
    const startAge = bot.time.age;
    const pending = waitServerTicks(bot, ticks, { now: clock.now, sleep: clock.sleep });
    const wait = watch(pending);
    await clock.advance(firstPacketMs);
    assert.equal(wait.over, false);
    assert.equal(bot.time.age - startAge, 20);
    await clock.advance(finishMs - firstPacketMs);
    assert.equal(wait.over, true, "the second packet completes the wait");
    assert.equal(await pending, "moved");
    assert.equal(bot.time.age - startAge, 40);
  });
}

test("a stopped clock stalls at 30 seconds, and a slow moving clock keeps waiting", async () => {
  const { bot, clock, server } = createFakeBot({ server: { ticksPerSecond: 2 } });
  const pending = waitServerTicks(bot, 80, { now: clock.now, sleep: clock.sleep });
  const wait = watch(pending);
  await clock.advance(30_000);
  assert.equal(wait.over, false, "three slow packets renewed the stall bound");
  server.stop();
  await clock.advance(29_950);
  assert.equal(wait.over, false);
  await clock.advance(50);
  assert.equal(await pending, "stalled");
});

test("abort rejects a wait in progress", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, server } = createFakeBot({ clock });
  server.stop();
  const controller = new AbortController();
  const pending = waitServerTicks(bot, 20, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled wait/);
  controller.abort(new Error("cancelled wait"));
  await rejected;
});
