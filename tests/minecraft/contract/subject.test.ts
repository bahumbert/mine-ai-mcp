import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import type { FakeServerOptions } from "../../../src/test-support/fake-bot/fake-server.ts";
import { ZERO_ARENA, arenaFrame } from "../arena/frame.ts";
import { fakeContractSubject } from "./subject.ts";

function subjectOn(server: FakeServerOptions = {}) {
  const harness = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), server });
  const subject = fakeContractSubject(harness, arenaFrame(ZERO_ARENA));
  return { harness, subject };
}

test("serverTicks resolves true once the age moved by the ticks asked since the call", async () => {
  const { harness, subject } = subjectOn({ startAge: 1_000 });
  using _installed = harness.clock.install();
  const age = harness.bot.time.age;
  assert.equal(await subject.serverTicks(40, 5_000), true);
  assert.ok(harness.bot.time.age - age >= 40, `age moved ${harness.bot.time.age - age}`);
});

test("serverTicks counts from the call, not from the server's start", async () => {
  const { harness, subject } = subjectOn({ startAge: 1_000 });
  using _installed = harness.clock.install();
  await subject.wait(2_500);
  const calledAt = subject.now();
  const age = harness.bot.time.age;
  assert.equal(await subject.serverTicks(40, 5_000), true);
  assert.ok(harness.bot.time.age - age >= 40, "the packets before the call do not count");
  assert.ok(subject.now() - calledAt >= 1_000, "40 ticks at 20 a packet need at least two packets after the call");
});

test("serverTicks gives up at the wall bound on a frozen server, whatever the ticks asked", async () => {
  const { harness, subject } = subjectOn();
  using _installed = harness.clock.install();
  await subject.wait(1_500);
  harness.server.stop();
  const calledAt = subject.now();
  assert.equal(await subject.serverTicks(20, 2_000), false);
  const waited = subject.now() - calledAt;
  assert.ok(waited >= 2_000 && waited < 2_100, `waited ${waited} ms for a 2000 ms bound`);
});

test("serverTicks on a server behind its schedule is bound by the wall: 5 ticks a second never reach 40 in 3 s", async () => {
  const { harness, subject } = subjectOn({ ticksPerSecond: 5 });
  using _installed = harness.clock.install();
  assert.equal(await subject.serverTicks(40, 3_000), false);
  assert.equal(await subject.serverTicks(40, 10_000), true);
});

test("serverTicks before the first time packet counts from the first age the client holds", async () => {
  const { harness, subject } = subjectOn({ timePacketYet: false });
  using _installed = harness.clock.install();
  assert.equal(harness.bot.time.age, null);
  assert.equal(await subject.serverTicks(40, 5_000), true);
});

test("serverTicks of zero ticks resolves true at once", async () => {
  const { harness, subject } = subjectOn();
  using _installed = harness.clock.install();
  const calledAt = subject.now();
  assert.equal(await subject.serverTicks(0, 1_000), true);
  assert.equal(subject.now(), calledAt);
});
