// The registry test covers 20 tps; this exercises the slower server too.
import test from "node:test";
import assert from "node:assert/strict";
import { listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { arenaFrame, ZERO_ARENA } from "../arena/frame.ts";
import { heldShooter } from "./checks/held-shooter.ts";
import { fakeHarnessFor } from "./fake-harness.ts";
import { fakeContractSubject } from "./subject.ts";
import { createMeasureReader } from "./checks/combat-data-measure.ts";

test("held shooter readback follows the server at 10 tps", async () => {
  const frame = arenaFrame(ZERO_ARENA);
  const harness = fakeHarnessFor(heldShooter.fixture, frame, { ticksPerSecond: 10 });
  using _installed = harness.clock.install();
  await heldShooter.run(fakeContractSubject(harness, frame));
});

test("held contract and default reader release listeners when the server stops", async () => {
  const frame = arenaFrame(ZERO_ARENA);
  const h = fakeHarnessFor(heldShooter.fixture, frame, { ticksPerSecond: 20 });
  using _installed = h.clock.install();
  const subject = { ...fakeContractSubject(h, frame), wait: (ms: number) => h.clock.sleep(ms) };
  const added = listenersAddedSince(h.bot);
  h.server.stop();
  const age = h.bot.time.age;
  await assert.rejects(h.clock.settle(heldShooter.run(subject), 31_000), /stalled/);
  assert.equal(h.bot.time.age, age);
  assert.equal(added("messagestr"), 0);
  await h.clock.advance(31_000);
  assert.equal(added("messagestr"), 0);
  await assert.rejects(h.clock.settle(createMeasureReader(subject).read(["run test"]), 31_000), /stalled/);
  assert.equal(h.bot.time.age, age);
  assert.equal(added("messagestr"), 0);
  await h.clock.advance(31_000);
  assert.equal(added("messagestr"), 0);
});

for (const ticksPerSecond of [20, 10]) {
  test(`silent held contract and default reader expire on server time at ${ticksPerSecond} tps`, async () => {
    const frame = arenaFrame(ZERO_ARENA);
    const h = fakeHarnessFor(heldShooter.fixture, frame, { ticksPerSecond });
    using _installed = h.clock.install();
    const subject = { ...fakeContractSubject(h, frame), wait: (ms: number) => h.clock.sleep(ms) };
    const added = listenersAddedSince(h.bot);
    h.bot.chat = () => {};
    const startAge = h.bot.time.age;
    await assert.rejects(h.clock.settle(heldShooter.run(subject), 4_500), /reply missing/);
    assert.ok(h.bot.time.age - startAge >= 40);
    assert.equal(added("messagestr"), 0);
    await h.clock.advance(31_000);
    assert.equal(added("messagestr"), 0);
    const age = h.bot.time.age;
    await assert.rejects(h.clock.settle(createMeasureReader(subject).read(["run test"]), 4_500), /reply missing/);
    assert.ok(h.bot.time.age - age >= 40);
    assert.equal(added("messagestr"), 0);
    await h.clock.advance(31_000);
    assert.equal(added("messagestr"), 0);
  });
}
