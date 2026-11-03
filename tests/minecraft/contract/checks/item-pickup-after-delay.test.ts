import assert from "node:assert/strict";
import test from "node:test";
import { itemPickupAfterDelay } from "./item-pickup-after-delay.ts";
import { runOnFake, withShiftedReads } from "./run-on-fake.ts";

test("item-pickup-after-delay judges the 20-tick delay by the server's ticks: servers at 20, 14 and 8 ticks a second (the last takes 2.5 s of wall) pass", async () => {
  for (const ticksPerSecond of [20, 14, 8]) await runOnFake(itemPickupAfterDelay, { ticksPerSecond });
});

test("item-pickup-after-delay holds when the server stalls for 1 s and catches up, in the delay", async () => {
  for (const atMs of [120, 200, 700]) await runOnFake(itemPickupAfterDelay, {}, undefined, [{ atMs, ms: 1_000 }]);
});

test("item-pickup-after-delay holds when a 1 s stall hits a summon before its answer (0-50 ms, 2025 ms: the second, 2100 ms: the third)", async () => {
  for (const atMs of [0, 50, 2_025, 2_100]) await runOnFake(itemPickupAfterDelay, {}, undefined, [{ atMs, ms: 1_000 }]);
});

test("item-pickup-after-delay fails, naming the ticks read, when the stack was picked up before its 20 ticks", async () => {
  // Of the readings (the delay-0 stack's collect, the spawn of the delayed stack, its collect) the last is far behind the server: the stack seems taken before its delay.
  await assert.rejects(
    runOnFake(itemPickupAfterDelay, {}, (subject) => withShiftedReads(subject, (index) => (index === 2 ? -1_000 : 0))),
    /the pickup came -?\d+ server ticks after the spawn \(tick \d+ to \d+\), delay 20 ticks: not within 18 to /,
  );
});

test("item-pickup-after-delay fails, naming the round trip and the bound, when the stack was picked up 30 ticks late and the collect's reading came back at once", async () => {
  await assert.rejects(
    runOnFake(itemPickupAfterDelay, {}, (subject) => withShiftedReads(subject, (index) => (index === 2 ? 30 : 0))),
    /the pickup came 5\d server ticks after the spawn \(tick \d+ to \d+\), delay 20 ticks: not within 18 to \d{2} \(the collect's reading came back in \d+ ms: \d+ ticks of lateness, 18 of them a stall's catch-up\)/,
  );
});

test("item-pickup-after-delay holds when the client hears the spawn 300 ms late: the delay runs from the spawn, not from the client hearing it", async () => {
  await runOnFake(itemPickupAfterDelay, {}, (subject) => ({
    ...subject,
    summonItem: async (...args) => {
      const entity = await subject.summonItem(...args);
      await subject.wait(300);
      return entity;
    },
  }));
});

test("item-pickup-after-delay returns the lateness it allowed for the collect's reading, for the trial's completion detail", async () => {
  const note = await runOnFake(itemPickupAfterDelay);
  assert.match(String(note), /^late-reading: tookTicks=\d+ roundTripMs=\d+ lateTicks=\d+ catchUpUsed=-?\d+$/u);
});
