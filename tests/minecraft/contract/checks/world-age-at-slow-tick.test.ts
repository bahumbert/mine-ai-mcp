import assert from "node:assert/strict";
import test from "node:test";
import { runOnFake, withShiftedReads, withSteppingAges } from "./run-on-fake.ts";
import { worldAgeAtSlowTick } from "./world-age-at-slow-tick.ts";

test("world-age-at-slow-tick fails, with the packets heard and the ticks run, on a server whose time packets step by more than 20", async () => {
  await assert.rejects(
    runOnFake(worldAgeAtSlowTick, {}, (subject) => withSteppingAges(subject, 20)),
    /ages step by 20 at tick rate 8; server ticks run in the watch: 80; packets heard \(age@ms into the watch\): \d+@\d+ms/,
  );
});

test("world-age-at-slow-tick fails when the server ran at another rate than the one set", async () => {
  await assert.rejects(runOnFake(worldAgeAtSlowTick, { ticksPerSecond: 20 }), /ran 199 ticks in 10000 ms: 80 within 20 at tick rate 8/);
});

test("world-age-at-slow-tick fails, saying so, when the server answers no game time (it is stopped)", async () => {
  await assert.rejects(runOnFake(worldAgeAtSlowTick, {}, (subject, harness) => {
    harness.server.stop();
    return subject;
  }), /answered no game time/);
});

test("world-age-at-slow-tick fails, with the counts, when more packets came than the ticks run allow", async () => {
  // A server at 20 ticks a second sends 10 packets in 10 s; the second tick reading is told 120 ticks short, so 79 ticks "ran" and the rate looks right.
  await assert.rejects(runOnFake(worldAgeAtSlowTick, { ticksPerSecond: 20 }, (subject) => withShiftedReads(subject, (index) => (index === 1 ? -120 : 0))), /10 time packets for 79 server ticks: one per 20 ticks, 3 within 1/);
});
