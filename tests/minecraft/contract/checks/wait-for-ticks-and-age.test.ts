/**
 * `wait-for-ticks-and-age` on the fake at the server rates and stalls a lane's server has (plan 2026-10-30-contract-batch-timing T7h): the world
 * age is judged against the server ticks run in the wait, not the client's 40, and a frozen age or one counting the client's ticks still fails.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ZERO_ARENA, arenaFrame } from "../../arena/frame.ts";
import { fakeHarnessFor } from "../fake-harness.ts";
import { type FakeHarness, runOnFake } from "./run-on-fake.ts";
import { type ContractSubject, fakeContractSubject } from "../subject.ts";
import { waitForTicksAndAge } from "./wait-for-ticks-and-age.ts";

const FRAME = arenaFrame(ZERO_ARENA);

/** A subject whose client holds the age `ageOf` says (its argument: the subject's clock in ms). */
function withAge(subject: ContractSubject, ageOf: (nowMs: number) => number): ContractSubject {
  const bot = new Proxy(subject.bot, {
    get: (target, property) => (property === "time" ? { ...target.time, age: ageOf(subject.now()) } : Reflect.get(target, property, target)),
  });
  return { ...subject, bot };
}

test("wait-for-ticks-and-age holds when the server runs the 38 ticks a stall owed inside the wait, started 6 ticks into a time packet's 20 (the age moved 80 against the client's 40)", async () => {
  const harness: FakeHarness = fakeHarnessFor(waitForTicksAndAge.fixture, FRAME);
  using _installed = harness.clock.install();
  const subject = fakeContractSubject(harness, FRAME);
  await subject.wait(1_300);
  harness.server.stop();
  await subject.wait(1_800);
  harness.clock.after(100, () => harness.server.resume());
  await waitForTicksAndAge.run(subject);
});

test("wait-for-ticks-and-age holds on a server at 8 ticks a second: 40 client ticks take 2 s, the server runs 16 and a time packet comes each 2.5 s", async () => {
  await runOnFake(waitForTicksAndAge, { ticksPerSecond: 8 });
});

test("wait-for-ticks-and-age fails, saying so, when the age does not move while the server ticks", async () => {
  await assert.rejects(runOnFake(waitForTicksAndAge, {}, (subject) => withAge(subject, () => 24_000)), /world age moved 0 while the server ran \d+ ticks/);
});

test("wait-for-ticks-and-age fails when the age counts the client's ticks on a server at 8 ticks a second", async () => {
  await assert.rejects(runOnFake(waitForTicksAndAge, { ticksPerSecond: 8 }, (subject) => withAge(subject, (nowMs) => 24_000 + Math.floor(nowMs / 50))), /world age moved \d+ while the server ran \d+ ticks/);
});
