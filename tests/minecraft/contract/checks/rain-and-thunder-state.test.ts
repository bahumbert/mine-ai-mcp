import assert from "node:assert/strict";
import test from "node:test";
import { rainAndThunderState } from "./rain-and-thunder-state.ts";
import { runOnFake, withShiftedReads } from "./run-on-fake.ts";

test("rain-and-thunder-state judges the ramp by the server's 100 ticks, not 5 s of wall: a server at 8 ticks a second (12.5 s) and one at 14 pass", async () => {
  for (const ticksPerSecond of [8, 14]) await runOnFake(rainAndThunderState, { ticksPerSecond });
});

test("rain-and-thunder-state fails, naming the ticks read, when the rain ramp took 150 server ticks (the read at its full level is 50 ticks late)", async () => {
  let reads = 0;
  await assert.rejects(
    // The reads come in the order the check asks for them: the ramp's two marks are the first two (its first update, its full level).
    runOnFake(rainAndThunderState, {}, (subject) => withShiftedReads(subject, () => ((reads += 1) === 2 ? 50 : 0))),
    /rain ramp took 1[45]\d server ticks \(the readings \+-2\): 100/,
  );
});

test("rain-and-thunder-state holds over a server stall of 2 s inside the ramp: the ticks catch up or are dropped, the level still reaches full", async () => {
  await runOnFake(rainAndThunderState, {}, undefined, [{ atMs: 1_500, ms: 2_000 }]);
});

test("rain-and-thunder-state fails, saying the level stood still, when the server stops ticking in the middle of the ramp", async () => {
  await assert.rejects(runOnFake(rainAndThunderState, {}, undefined, [{ atMs: 2_000, ms: 60_000 }]), /no change for 10000 ms|stalled/);
});
