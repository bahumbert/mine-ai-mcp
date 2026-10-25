import assert from "node:assert/strict";
import test from "node:test";
import { ZERO_ARENA, arenaFrame } from "../../arena/frame.ts";
import { fakeHarnessFor } from "../fake-harness.ts";
import { fakeContractSubject } from "../subject.ts";
import { airSupplyUnderWater } from "./air-supply-under-water.ts";
import { runOnFake, withShiftedReads } from "./run-on-fake.ts";

test("air-supply-under-water names every air reading with its wall time and world age when the first one skips a tick", async () => {
  const frame = arenaFrame(ZERO_ARENA);
  const harness = fakeHarnessFor(airSupplyUnderWater.fixture, frame);
  using _installed = harness.clock.install();
  // The client never hears the first air packet: the first reading it files is the second tick's.
  const emit = harness.bot.emit.bind(harness.bot) as (event: string, ...args: unknown[]) => boolean;
  let breaths = 0;
  harness.bot.emit = ((event: string, ...args: unknown[]) => (event === "breath" && (breaths += 1) === 1 ? false : emit(event, ...args))) as unknown as typeof harness.bot.emit;
  await assert.rejects(
    airSupplyUnderWater.run(fakeContractSubject(harness, frame)),
    /the first tick under water takes 1 from the full meter.*; water seen at \d+ms\/age \d+; air readings \(air@ms\/age\): 298@\d+ms\/age \d+$/s,
  );
});

test("air-supply-under-water starts the dive at the first air packet when several arrive before the check looks (a late event loop)", async () => {
  const frame = arenaFrame(ZERO_ARENA);
  const harness = fakeHarnessFor(airSupplyUnderWater.fixture, frame);
  using _installed = harness.clock.install();
  const subject = fakeContractSubject(harness, frame);
  // The check looks every 25 ms; a client busy for 300 ms looks late, with 6 ticks of air packets filed since the first.
  await airSupplyUnderWater.run({ ...subject, wait: (ms) => subject.wait(ms === 25 ? 300 : ms) });
});

test("air-supply-under-water judges the dive and the refill by the server's ticks: a server at 14 ticks a second (a dive of 4.3 s of wall) passes", async () => {
  await runOnFake(airSupplyUnderWater, { ticksPerSecond: 14 });
});

test("air-supply-under-water holds when the server stalls for under 2 s and catches up, in the dive, in the refill and in the quiet", async () => {
  for (const atMs of [0, 1_500, 3_000, 4_500, 5_200]) await runOnFake(airSupplyUnderWater, {}, undefined, [{ atMs, ms: 700 }]);
});

test("air-supply-under-water holds when the server stalls over 2 s and the game drops the stall", async () => {
  for (const atMs of [1_500, 3_000]) await runOnFake(airSupplyUnderWater, {}, undefined, [{ atMs, ms: 2_500 }]);
});

test("air-supply-under-water fails, naming the ticks read, when the air fell far fewer times than the server ticked in the dive", async () => {
  // Every read after the water is placed is 40 ticks ahead of the server's, the rest of the dive's ticks included: the dive ends early with fewer packets than the ticks the two reads say it held.
  let watered = false;
  await assert.rejects(
    runOnFake(airSupplyUnderWater, {}, (subject) => ({
      ...withShiftedReads(subject, () => (watered ? 40 : 0)),
      setBlock: async (cell, block) => (await subject.setBlock(cell, block), (watered = true), undefined),
    })),
    /\d+ air lost in \d+ server ticks, read right before the water and after the dive: one air a tick, within 6; water seen at/,
  );
});
