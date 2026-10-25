/**
 * The checks of a use, a placement, a seat and a pickup judge what the server did by its ticks and its answers (`server-answer.ts`), never by
 * a wall time that stands for ticks: they hold on a server behind its schedule and on one that stalls and catches up, and a server that does
 * not tick or does not answer fails them naming the wait (plan 2026-10-25-review-fixes R8). `item-pickup-after-delay` measures the pickup delay in
 * wall milliseconds on a server of its own (tag `exclusive`), so a server behind its schedule or a stall is not asked of it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ContractCheck } from "../checks.ts";
import { boatDismountIgnored } from "./boat-dismount-ignored.ts";
import { boatMountRefused } from "./boat-mount-refused.ts";
import { boatPlacedByUse } from "./boat-placed-by-use.ts";
import { bucketPourAndFill } from "./bucket-pour-and-fill.ts";
import { itemPickupAfterDelay } from "./item-pickup-after-delay.ts";
import { placementBlockUpdate } from "./placement-block-update.ts";
import { runOnFake } from "./run-on-fake.ts";

const CHECKS_ON_ANY_SERVER: readonly ContractCheck[] = [boatDismountIgnored, boatMountRefused, boatPlacedByUse, bucketPourAndFill, placementBlockUpdate];
const STALL_STARTS_MS = [200, 2_500];
/** The slowest server the waits are proven on: 40 ticks take 5.7 s of wall, past the 4-5 s bounds the checks had (14 ticks a second, 2.9 s, fits them). */
const TICKS_PER_SECOND = [14, 7] as const;
const LATE_CLIENT_MS = 2_000;

for (const check of CHECKS_ON_ANY_SERVER) {
  test(`${check.name} holds on a server at 14 and at 7 ticks a second`, async () => {
    for (const ticksPerSecond of TICKS_PER_SECOND) await runOnFake(check, { ticksPerSecond });
  });

  test(`${check.name} holds when the server stalls for 1 s and catches up, at any point of the run`, async () => {
    for (const atMs of STALL_STARTS_MS) await runOnFake(check, {}, undefined, [{ atMs, ms: 1_000 }]);
  });
}

test("item-pickup-after-delay holds when the server stalls for 1 s in its first absence and catches up", async () => {
  await runOnFake(itemPickupAfterDelay, {}, undefined, [{ atMs: 120, ms: 1_000 }]);
});

for (const check of [boatDismountIgnored, boatMountRefused, boatPlacedByUse, bucketPourAndFill, itemPickupAfterDelay]) {
  test(`${check.name} fails on a server that stops ticking in its first absence: a silence of wall time proves nothing`, async () => {
    await assert.rejects(runOnFake(check, {}, undefined, [{ atMs: 60, ms: 60_000 }]), /the server is stalled/);
  });
}

test("bucket-pour-and-fill fails naming the shared answer bound when a pour is never answered", async () => {
  await assert.rejects(
    runOnFake(bucketPourAndFill, {}, (subject) => {
      const used = subject.bot.activateItem.bind(subject.bot);
      let uses = 0;
      // The first three uses (the dry floor, the sky, ground past the reach) are sent; the pour at the floor goes nowhere.
      subject.bot.activateItem = (...args: Parameters<typeof used>) => (uses++ < 3 ? used(...args) : undefined);
      return subject;
    }),
    /floor pour: the use: no answer within 10000 ms \(heard nothing; floor pour: before the use/,
  );
});

test("boat-placed-by-use reads where the boat was put when the client heard it, not where it is when a late client looks: the fake sinks a boat 1.5 s after it is put", async () => {
  // Every wait of the check runs 2 s late, as on a lane client whose event loop is busy: the boat has sunk when the check first looks for it.
  await runOnFake(boatPlacedByUse, {}, (subject) => ({ ...subject, wait: (ms) => subject.wait(ms + LATE_CLIENT_MS) }));
});
