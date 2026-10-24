import assert from "node:assert/strict";
import test from "node:test";
import { ZERO_ARENA, arenaFrame } from "../../arena/frame.ts";
import { fakeHarnessFor } from "../fake-harness.ts";
import { fakeContractSubject } from "../subject.ts";
import { attackCooldownDamage } from "./attack-cooldown-damage.ts";

const frame = arenaFrame(ZERO_ARENA);

test("a failure of attack-cooldown-damage names the server ticks of the acts, when the client acted and when it heard the mob hurt", async () => {
  const harness = fakeHarnessFor(attackCooldownDamage.fixture, frame);
  using _installed = harness.clock.install();
  // A client whose attacks reach nobody: the first hit costs nothing, so the check fails at its first assertion.
  Object.defineProperty(harness.bot, "attack", { value: () => undefined });
  await assert.rejects(
    attackCooldownDamage.run(fakeContractSubject(harness, frame)),
    /the first hit cost 0, not 9: server ticks at the acts \d+, \d+ \(1 from the first to the last, \+-2\); the client acted at \+0 ms, \+\d+ ms and heard the mob hurt at no time/,
  );
});

test("attack-cooldown-damage judges the second hit by the server ticks between the hits: a server that loses 3 ticks of every second still passes", async () => {
  const harness = fakeHarnessFor(attackCooldownDamage.fixture, frame);
  using _installed = harness.clock.install();
  // Every second the server stands still for 150 ms: a 1000 ms gap holds 17 ticks and the swing is that much less back.
  const stall = setInterval(() => {
    harness.server.stop();
    setTimeout(() => harness.server.resume(), 150);
  }, 1_000);
  try {
    await attackCooldownDamage.run(fakeContractSubject(harness, frame));
  } finally {
    clearInterval(stall);
  }
});

test("attack-cooldown-damage trusts the server's tick readings over the wall gap: readings 24 ticks apart for hits 50 ms apart fail it with the damage the rule wants", async () => {
  const harness = fakeHarnessFor(attackCooldownDamage.fixture, frame);
  using _installed = harness.clock.install();
  const subject = fakeContractSubject(harness, frame);
  // The fake's mob takes the damage of 20 ticks (the real gap); the readings say 24, so the full swing the rule expects is not what it lost.
  let reading = 0;
  const lying = { ...subject, serverGameTime: async () => (reading += 1) * 24 };
  await assert.rejects(attackCooldownDamage.run(lying), /a second hit 50 ms \(24 server ticks\) after the first cost 0, not 8\.95 to 9\.05/);
});

test("attack-cooldown-damage holds with the time packets at any point of the second", async () => {
  const harness = fakeHarnessFor(attackCooldownDamage.fixture, frame, { phaseMs: 500 });
  using _installed = harness.clock.install();
  await attackCooldownDamage.run(fakeContractSubject(harness, frame));
});
