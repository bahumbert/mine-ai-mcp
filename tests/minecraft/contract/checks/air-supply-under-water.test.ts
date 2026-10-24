import assert from "node:assert/strict";
import test from "node:test";
import { ZERO_ARENA, arenaFrame } from "../../arena/frame.ts";
import { fakeHarnessFor } from "../fake-harness.ts";
import { fakeContractSubject } from "../subject.ts";
import { airSupplyUnderWater } from "./air-supply-under-water.ts";

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
