import assert from "node:assert/strict";
import test from "node:test";
import type { FakeServerOptions } from "../../../../src/test-support/fake-bot/index.ts";
import { boatBrokenByAttack, damageBounds } from "./boat-broken-by-attack.ts";
import { runOnFake } from "./run-on-fake.ts";

/** Run the check on the fake (`run-on-fake.ts`): `change` rewrites the subject before it runs, `stalls` stop the server. */
const runCheck = (server: FakeServerOptions, change?: Parameters<typeof runOnFake>[2], stalls?: Parameters<typeof runOnFake>[3]) => runOnFake(boatBrokenByAttack, server, change, stalls);

test("boat-broken-by-attack judges the hits by the server's ticks: a server at 14 ticks a second breaks the boats at the hit the ticks say", async () => {
  await runCheck({ ticksPerSecond: 14 });
});

test("boat-broken-by-attack holds when the server stalls for under 2 s between the hits and catches up (at any hit)", async () => {
  for (const atMs of [300, 2_400, 5_000]) await runCheck({}, undefined, [{ atMs, ms: 700 }]);
});

test("boat-broken-by-attack holds when the server stalls for under 2 s at 14 ticks a second (nothing caught up)", async () => {
  for (const atMs of [900, 2_400, 5_000]) await runCheck({ ticksPerSecond: 14 }, undefined, [{ atMs, ms: 700 }]);
});

test("boat-broken-by-attack holds when the server stalls over 2 s and the game drops the stall", async () => {
  for (const atMs of [900, 2_400, 5_000]) await runCheck({}, undefined, [{ atMs, ms: 2_500 }]);
});

test("boat-broken-by-attack fails, naming the ticks read, when the boat broke at hits the ticks say are too few", async () => {
  // Every hit lands six times (an artificial fault: the five after the first weigh 2.08 each in one tick, 20.4 a hit with the first): the boat is gone after 3 hits, and the ticks between them leave at most 20 damage.
  await assert.rejects(
    runCheck({}, (subject) => {
      const hit = subject.bot.attack.bind(subject.bot);
      subject.bot.attack = (target) => {
        for (let landing = 0; landing < 6; landing += 1) hit(target);
      };
      return subject;
    }),
    /the boat broke by hit 3 though no hit left more than 20\.0 damage, 40 breaks it: server ticks read before the hits \d+, \d+, \d+; the client hit at \+0 ms, \+\d+ ms/,
  );
});

test("boat-broken-by-attack fails, naming the ticks read, when the boat held for more hits than the ticks say", async () => {
  // Two hits never arrive: the readings, 6 ticks apart, say the boat is broken at hit 11, and the client goes on to hit 13.
  await assert.rejects(
    runCheck({}, (subject) => {
      const hit = subject.bot.attack.bind(subject.bot);
      let sent = 0;
      subject.bot.attack = (target) => {
        sent += 1;
        if (sent !== 3 && sent !== 4) hit(target);
      };
      return subject;
    }),
    /hit 11 left at least 41\.9 damage, more than the 40 that breaks a boat, yet the client hit 2 more times, up to 12 ticks later, before the boat was gone \(at most 9\): server ticks read before the hits 24000, 24006/,
  );
});

test("boat-broken-by-attack fails, naming the ticks read, when the ticks say every hit found the damage gone", async () => {
  // Readings 200 ticks apart (the rests read too): the damage decays to nothing between the hits, so no hit leaves more than 10.
  let reading = 0;
  await assert.rejects(
    runCheck({}, (subject) => ({ ...subject, serverGameTime: async () => (reading += 1) * 100 })),
    /the boat broke by hit 9 though no hit left more than 10\.0 damage, 40 breaks it: server ticks read before the hits 100, 300/,
  );
});

test("boat-broken-by-attack fails when the drop is picked up before its 10 ticks are over", async () => {
  // The check reads the server's tick last when the client hears the pickup: that read says 11 ticks less than the server's, so the item
  // would have been picked up 5 ticks after the hit before the last, which may be the one that broke the boat.
  let reads = 0;
  await runCheck({}, (subject) => ({ ...subject, serverGameTime: () => (reads += 1, subject.serverGameTime()) }));
  const pickupRead = reads;
  reads = 0;
  await assert.rejects(
    runCheck({}, (subject) => ({ ...subject, serverGameTime: async () => (reads += 1) === pickupRead ? (await subject.serverGameTime()) - 11 : subject.serverGameTime() })),
    /picked up at server tick -?\d+, -?\d+ ticks after the boat could have broken \(hit \d+, tick \d+, \d+ ms before by the client\): the item waits 10 ticks, not less than 8 \(readings \+-2\)/,
  );
});

test("damageBounds: hits bunched in one tick weigh a fifth of a full hit, hits 5 ticks apart break a boat in 7 to 13 hits", () => {
  // Ten reads of one tick: each hit after the first weighs 2 to 4 (a swing 0 to 2 ticks old), the boat never holds 40.
  const bunched = damageBounds(Array.from({ length: 10 }, () => 100));
  assert.ok(Math.max(...bunched.high) < 40, `bunched hits left ${Math.max(...bunched.high)}`);
  const spaced = damageBounds(Array.from({ length: 20 }, (_, hit) => 100 + 5 * hit));
  const mayBreak = spaced.high.findIndex((held) => held > 40) + 1;
  const mustBreak = spaced.low.findIndex((held) => held > 40) + 1;
  assert.ok(mayBreak >= 7 && mayBreak <= 8 && mustBreak >= mayBreak && mustBreak <= 13, `hits 5 ticks apart: may break at hit ${mayBreak}, must at hit ${mustBreak}`);
});
