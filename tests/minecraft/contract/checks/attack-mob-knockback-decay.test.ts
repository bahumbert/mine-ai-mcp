import assert from "node:assert/strict";
import test from "node:test";
import { attackMobKnockback } from "./attack-mob-knockback.ts";
import { attackMobKnockbackDecay } from "./attack-mob-knockback-decay.ts";
import { attackMobKnockbackSprint } from "./attack-mob-knockback-sprint.ts";
import { runOnFake, withShiftedReads } from "./run-on-fake.ts";

test("attack-mob-knockback-decay judges the decay and the rest by the server's ticks: a server at 14 and at 11 ticks a second passes (the rest comes 17 and 22 s on)", async () => {
  for (const ticksPerSecond of [14, 11]) await runOnFake(attackMobKnockbackDecay, { ticksPerSecond });
});

test("attack-mob-knockback-decay holds when the server stalls for under 2 s and catches up, in the swing's rest and in the decay", async () => {
  for (const atMs of [200, 1_700, 2_500, 9_000]) await runOnFake(attackMobKnockbackDecay, {}, undefined, [{ atMs, ms: 700 }]);
});

test("attack-mob-knockback-decay holds when the server stalls over 2 s and the game drops the stall", async () => {
  for (const atMs of [1_700, 9_000]) await runOnFake(attackMobKnockbackDecay, {}, undefined, [{ atMs, ms: 2_500 }]);
});

test("attack-mob-knockback-decay fails, naming the ticks read, when the mob rested far sooner than its push decays", async () => {
  // Every read after the hit is 150 ticks behind the server's: the mob seems to have rested 93 ticks after it.
  await assert.rejects(
    runOnFake(attackMobKnockbackDecay, {}, (subject) => {
      let hit = false;
      const attack = subject.bot.attack.bind(subject.bot);
      subject.bot.attack = (target) => (hit = true, attack(target));
      return withShiftedReads(subject, () => (hit ? -150 : 0));
    }),
    /by hand in the open: the mob rested \d+ server ticks after the hit \(the readings \+-2\), not 238 to \d+/,
  );
});

test("the knockback checks rest the swing by server ticks: at 14 ticks a second and over a stall that catches up, the sprinting hit is still a rested one", async () => {
  for (const check of [attackMobKnockback, attackMobKnockbackSprint]) {
    await runOnFake(check, { ticksPerSecond: 14 });
    for (const atMs of [100, 900]) await runOnFake(check, {}, undefined, [{ atMs, ms: 700 }]);
  }
});
