import assert from "node:assert/strict";
import test from "node:test";
import { bedSleepAndWake } from "./bed-sleep-and-wake.ts";
import { runOnFake, withShiftedReads } from "./run-on-fake.ts";

test("bed-sleep-and-wake judges the skip by the server's 100 ticks: a server at 14 ticks a second (7.1 s of wall) passes", async () => {
  await runOnFake(bedSleepAndWake, { ticksPerSecond: 14 });
});

test("bed-sleep-and-wake holds when the server stalls for under 2 s and catches up, in the sleep", async () => {
  for (const atMs of [0, 400, 2_000, 4_000]) await runOnFake(bedSleepAndWake, {}, undefined, [{ atMs, ms: 700 }]);
});

test("bed-sleep-and-wake holds when the server stalls over 2 s and the game drops the stall", async () => {
  for (const atMs of [400, 2_000]) await runOnFake(bedSleepAndWake, {}, undefined, [{ atMs, ms: 2_500 }]);
});

test("bed-sleep-and-wake fails, naming the ticks read, when the sleep ended before the 100 ticks the server needs, and leaves no time listener on the bot", async () => {
  // The read at the wake is 60 ticks behind the server's: the sleep seems to have ended 40 ticks after it began.
  let reads = 0;
  let timeListenersAtStart = -1;
  let bot: { listenerCount(event: string): number } | undefined;
  await assert.rejects(
    runOnFake(bedSleepAndWake, {}, (subject, harness) => {
      bot = harness.bot;
      timeListenersAtStart = harness.bot.listenerCount("time");
      return withShiftedReads(subject, () => ((reads += 1) === 2 ? -60 : 0));
    }),
    /woke at server tick \d+, \d+ ticks after the sleep began at tick \d+: the server skips the night after 100 ticks, not less than 98 \(readings \+-2\)/,
  );
  assert.equal(bot!.listenerCount("time"), timeListenersAtStart, "the time listener of the second sleep stayed on the bot");
});

test("bed-sleep-and-wake waits for the wake while the server keeps ticking: at 8 ticks a second the 100 ticks of the sleep take 12.5 s, past a total wall bound of 12 s", async () => {
  await runOnFake(bedSleepAndWake, { ticksPerSecond: 8 });
});

test("bed-sleep-and-wake fails, saying the wake never came, when the server stops ticking during the sleep", async () => {
  await assert.rejects(runOnFake(bedSleepAndWake, {}, undefined, [{ atMs: 2_000, ms: 60_000 }]), /no wake for the sleep left alone: no change for 10000 ms/);
});

test("bed-sleep-and-wake fails after the latest wake it accepts, not never, when the server ticks and no wake comes", async () => {
  // The second wake is never heard by the check, as when another player stays awake and the night is not skipped.
  await assert.rejects(
    runOnFake(bedSleepAndWake, {}, (subject) => {
      let wakes = 0;
      const bot = new Proxy(subject.bot, {
        get: (target, property) =>
          property === "on" ? (event: string, listener: (...args: unknown[]) => void) => target.on(event as "wake", event === "wake" ? (...args: unknown[]) => void ((wakes += 1) < 2 && listener(...args)) : (listener as () => void)) : Reflect.get(target, property, target),
      });
      return { ...subject, bot };
    }),
    /no wake for the sleep left alone within 202 server ticks: sleep,wake,sleep/,
  );
});

test("bed-sleep-and-wake passes at 11 ticks a second: the 100 ticks of the sleep take 9.1 s of wall, past what a wall window of 5 s plus 3 s allowed", async () => {
  await runOnFake(bedSleepAndWake, { ticksPerSecond: 11 });
});
