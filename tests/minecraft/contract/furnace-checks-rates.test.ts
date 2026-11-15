/** Furnace contract checks at normal and slowed server rates. */
import test from "node:test";
import { ZERO_ARENA, arenaFrame } from "../arena/frame.ts";
import { furnaceOutputTake } from "./checks/furnace-output-take.ts";
import { fakeHarnessFor } from "./fake-harness.ts";
import { fakeContractSubject } from "./subject.ts";

for (const ticksPerSecond of [20, 5]) {
  test(`furnace output takes match the server at ${ticksPerSecond} tps`, async () => {
    const frame = arenaFrame(ZERO_ARENA);
    const harness = fakeHarnessFor(furnaceOutputTake.fixture, frame, { ticksPerSecond });
    using _installed = harness.clock.install();
    await furnaceOutputTake.run(fakeContractSubject(harness, frame));
  });
}
