/** Furnace contract checks at normal and slowed server rates. */
import test from "node:test";
import { ZERO_ARENA, arenaFrame } from "../arena/frame.ts";
import { furnaceOutputTake } from "./checks/furnace-output-take.ts";
import { furnaceTakeCorrected } from "./checks/furnace-take-corrected.ts";
import { fakeHarnessFor } from "./fake-harness.ts";
import { fakeContractSubject } from "./subject.ts";

for (const ticksPerSecond of [20, 5]) {
  for (const check of [furnaceOutputTake, furnaceTakeCorrected]) {
    test(`${check.name} matches the server at ${ticksPerSecond} tps`, async () => {
      const frame = arenaFrame(ZERO_ARENA);
      const harness = fakeHarnessFor(check.fixture, frame, { ticksPerSecond });
      using _installed = harness.clock.install();
      await check.run(fakeContractSubject(harness, frame));
    });
  }
}
