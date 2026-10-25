import assert from "node:assert/strict";
import test from "node:test";
import { projectileHitBot } from "./projectile-hit-bot.ts";
import { runOnFake, withShiftedReads } from "./run-on-fake.ts";

test("projectile-hit-bot judges the burns by the server's ticks: a server at 14 ticks a second (1.4 s of wall a burn) passes", async () => {
  await runOnFake(projectileHitBot, { ticksPerSecond: 14 });
});

test("projectile-hit-bot holds when the server stalls for under 2 s and catches up, at the shot, between the burns and after them", async () => {
  for (const atMs of [0, 300, 1_200, 2_500, 4_100]) await runOnFake(projectileHitBot, {}, undefined, [{ atMs, ms: 700 }]);
});

test("projectile-hit-bot holds when the server stalls over 2 s and the game drops the stall", async () => {
  for (const atMs of [300, 1_200, 3_000]) await runOnFake(projectileHitBot, {}, undefined, [{ atMs, ms: 2_500 }]);
});

test("projectile-hit-bot fails, naming the ticks read, when the first burn came before the ticks it needs after the shot", async () => {
  // Every read after the fireball is shot is 15 ticks behind the server: the burn that follows the hit by 20 ticks reads 8 ticks after the shot.
  let shots = 0;
  await assert.rejects(
    runOnFake(projectileHitBot, {}, (subject) => ({
      ...withShiftedReads(subject, () => (shots >= 2 ? -15 : 0)),
      shootBot: (projectile, shooterId) => (shots += 1, subject.shootBot(projectile, shooterId)),
    })),
    /small_fireball: burn 1 heard at server tick \d+, \d+ ticks after the shot at tick \d+: the burn is 20 ticks after the hit, so not less than 19 \(readings \+-2\)/,
  );
});

/** The reads after a fireball's shot: its spawn, the hit, the removal and the push, then one per burn. */
const FIRST_BURN_READ = 4;
/** Ticks each burn's read is late by more than the one before. */
const EXTRA_PER_BURN = 7;

test("projectile-hit-bot fails, naming the reads, when a burn came 27 ticks after the one before it, which the fire's 20 ticks never are", async () => {
  // The reads of burns 2 to 4 are late by 7 more each (the fake burns every 20 ticks): consecutive burns read 27 ticks apart, outside 20 +- 6, while every burn is still inside its window from the shot.
  let shots = 0;
  let firstReadAfterShot = -1;
  await assert.rejects(
    runOnFake(projectileHitBot, {}, (subject) => ({
      ...withShiftedReads(subject, (index) => {
        if (shots >= 2 && firstReadAfterShot < 0) firstReadAfterShot = index;
        return shots >= 2 && index >= firstReadAfterShot + FIRST_BURN_READ ? EXTRA_PER_BURN * (index - firstReadAfterShot - FIRST_BURN_READ) : 0;
      }),
      shootBot: (projectile, shooterId) => (shots += 1, subject.shootBot(projectile, shooterId)),
    })),
    /small_fireball: burn 2 heard at server tick \d+, 27 ticks after burn 1 at tick \d+: the fire burns every 20 ticks, so not less than 14 and not more than 26/,
  );
});
