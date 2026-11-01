import assert from "node:assert/strict";
import test from "node:test";
import { consumeFood } from "./consume-food.ts";
import { runOnFake, withShiftedReads } from "./run-on-fake.ts";

test("consume-food judges the bite by the server's 32 ticks: servers at 20, 14 and 8 ticks a second pass, the last past Mineflayer's 2500 ms consume timeout", async () => {
  for (const ticksPerSecond of [20, 14, 8]) await runOnFake(consumeFood, { ticksPerSecond });
});

test("consume-food holds when the server stalls for 1 s and catches up, in the bite", async () => {
  for (const atMs of [200, 900]) await runOnFake(consumeFood, {}, undefined, [{ atMs, ms: 1_000 }]);
});

test("consume-food fails, naming the ticks read, when the bite took fewer ticks than the game's 32", async () => {
  // The read at the end of the bite is 10 ticks after the one before it.
  await assert.rejects(
    runOnFake(consumeFood, {}, (subject) => withShiftedReads(subject, (index) => (index === 1 ? -22 : 0))),
    /eating took \d+ server ticks \(tick \d+ to \d+\), not 30 to \d+/,
  );
});

test("consume-food fails, naming the ticks read, the round trip and the bound, when the bite ended 30 ticks late and the end's reading came back at once", async () => {
  await assert.rejects(
    runOnFake(consumeFood, {}, (subject) => withShiftedReads(subject, (index) => (index === 1 ? 30 : 0))),
    /eating took 6\d server ticks \(tick \d+ to \d+\), not 30 to \d{2} \(the end's reading came back in \d+ ms: \d+ ticks of lateness, 18 of them a stall's catch-up\)/,
  );
});

test("consume-food fails when a consume is rejected for any other reason than the timeout", async () => {
  await assert.rejects(
    runOnFake(consumeFood, {}, (subject) => {
      subject.bot.consume = () => Promise.reject(new Error("Consuming cancelled due to calling bot.consume() again"));
      return subject;
    }),
    /Consuming cancelled/,
  );
});

test("consume-food returns the lateness it allowed for the end's reading, for the trial's completion detail", async () => {
  const note = await runOnFake(consumeFood);
  assert.match(String(note), /^late-reading: tookTicks=\d+ roundTripMs=\d+ lateTicks=\d+ catchUpUsed=-?\d+$/u);
});
