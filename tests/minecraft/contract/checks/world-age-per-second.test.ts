import assert from "node:assert/strict";
import test from "node:test";
import type { FakeServerOptions } from "../../../../src/test-support/fake-bot/index.ts";
import { runOnFake, withSteppingAges } from "./run-on-fake.ts";
import { worldAgePerSecond } from "./world-age-per-second.ts";

const runCheck = (server: FakeServerOptions, change?: Parameters<typeof runOnFake>[2]) => runOnFake(worldAgePerSecond, server, change);

test("world-age-per-second takes an extra packet off the cadence for the answer to the time set", async () => {
  await runCheck({});
});

test("world-age-per-second takes the repeated age of a time set in the tick of a regular packet for the extra", async () => {
  await runCheck({}, (subject, harness) => ({ ...subject, resendTime: async () => harness.server.resendTime() }));
});

test("world-age-per-second holds with another lane's time set inside the watch as well", async () => {
  await runCheck({}, (subject, harness) => {
    harness.clock.after(2_300, () => harness.server.resendTime());
    return subject;
  });
});

test("world-age-per-second holds when the watch starts at any point of the second", async () => {
  for (const phaseMs of [1, 250, 500, 999]) await runCheck({ phaseMs });
});

test("world-age-per-second fails, with the packets heard, when the time set is answered with no extra packet", async () => {
  await assert.rejects(runCheck({}, (subject) => ({ ...subject, resendTime: async () => undefined })), /was not answered with an extra time packet; packets heard \(age@ms into the watch\): \d+@\d+ms/);
});

test("world-age-per-second fails when the regular packets step by more than 20 ticks", async () => {
  await assert.rejects(runCheck({}, (subject) => withSteppingAges(subject, 20)), /ages step by 20/);
});

test("world-age-per-second judges the packets by the server's ticks, not the wall: at 8, 14 and 40 ticks a second there is still one regular packet per 20 ticks", async () => {
  for (const ticksPerSecond of [8, 14, 40]) await runCheck({ ticksPerSecond });
});

test("world-age-per-second fails, saying the server answered no game time, when the server does not tick at all", async () => {
  await assert.rejects(runCheck({}, (subject, harness) => {
    harness.server.stop();
    return subject;
  }), /the server answered no game time/);
});

test("world-age-per-second fails, saying so, when the server stops ticking inside the watch", async () => {
  await assert.rejects(runCheck({}, (subject, harness) => {
    harness.clock.after(500, () => harness.server.stop());
    return subject;
  }), /rested \d+ of \d+ server ticks read, and no read moved for \d+ ms \(the bound is 10000\): the server is stalled/);
});
