import assert from "node:assert/strict";
import test from "node:test";
import type { FakeServerOptions } from "../../../../src/test-support/fake-bot/index.ts";
import { ZERO_ARENA, arenaFrame } from "../../arena/frame.ts";
import { fakeHarnessFor } from "../fake-harness.ts";
import { type ContractSubject, fakeContractSubject } from "../subject.ts";
import { worldAgePerSecond } from "./world-age-per-second.ts";

/** Run the check on the fake; `change` rewrites the subject before it runs (the server's side of a `/time set`). */
function runCheck(server: FakeServerOptions, change: (subject: ContractSubject, harness: ReturnType<typeof fakeHarnessFor>) => ContractSubject = (subject) => subject): Promise<void> {
  const frame = arenaFrame(ZERO_ARENA);
  const harness = fakeHarnessFor(worldAgePerSecond.fixture, frame, server);
  const installed = harness.clock.install();
  return worldAgePerSecond.run(change(fakeContractSubject(harness, frame), harness)).finally(() => installed[Symbol.dispose]());
}

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
  await assert.rejects(runCheck({ ticksPerSecond: 40 }), /ages step by 20/);
});

test("world-age-per-second fails, saying so, when the server sends no time packet at all", async () => {
  await assert.rejects(runCheck({}, (subject, harness) => {
    harness.server.stop();
    return subject;
  }), /no time packet/);
});
