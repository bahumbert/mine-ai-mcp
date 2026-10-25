// The take-back keeps hitting until the boat is gone or the wall bound passes, whatever the server's ticks do; its report says what happened.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { attackedIds } from "../../test-support/combat.js";
import type { FakeHarness } from "../../test-support/fake-bot/index.js";
import { boatsCarried, settled, shoreSea, stallServerAtFirstHit } from "./boat-fixtures.test.js";
import { TAKE_BACK_WALL_MS, takeBoatBack, takeBoatBackReport } from "./boat-take-back.js";

const navigation = { cancel: () => undefined } as unknown as NavigationRuntime;
/** Standing on boat 7 over water two deep by the shore (the feet the server sets her at on top of it). */
const STANDING = { feet: new Vec3(20.5, 63.05, 0.5), boat: new Vec3(20.5, 62.49, 0.5), mocked: true, physics: true, waterDepth: 2 } as const;
/** The bot stands on a boat (physics off keeps her there: the fake sinks her, the server would hold her) and the server stalls at the first hit, for `afterMs` or for good; install the clock first. */
function standingOnBoatWithServerStalledAtFirstHit(afterMs?: number, physics = true): FakeHarness {
  const world = shoreSea({ ...STANDING, physics });
  stallServerAtFirstHit(world, afterMs);
  return world;
}
const hitsSent = (world: FakeHarness) => attackedIds(world.server).length;

// Run 20 hardening: a boat breaks above 40 damage and a hit weighs 10 only 5 ticks after the last (contract boat-broken-by-attack),
// so 15 hits 300 ms apart (4.5 s) end inside a longer stall and nothing breaks; the hits owed are counted in time.
/** A stall past the 4.5 s the old 15 hits lasted (the fake: the hits break the boat soon after the resume, `fake-bot-boat-damage.ts`). */
const STALL_MS = 6_000;
test("a server stalled for 6 s after the first hit: the hits go on until the boat breaks, past the old 15", async () => {
  const world = standingOnBoatWithServerStalledAtFirstHit(STALL_MS);
  using _timers = world.clock.install();
  const report = await settled(world, takeBoatBackReport(world.bot, world.bot.entities[7]!, undefined, { settleMs: 0 }));
  assert.equal(report.carried, true);
  assert.equal(boatsCarried(world), 1);
  assert.ok(report.hits > 15, `${report.hits} hits sent`);
  assert.equal(report.hits, hitsSent(world), "the report counts the hits sent");
  assert.equal(report.goneAfterHit, report.hits, "the boat left her client at the last hit");
  assert.ok(report.elapsedMs >= STALL_MS && report.elapsedMs < TAKE_BACK_WALL_MS, `${report.elapsedMs} ms`);
});

test("a server stopped for good: the take-back gives up after the wall bound of the wall clock, with no tick needed", async () => {
  const world = standingOnBoatWithServerStalledAtFirstHit(undefined, false);
  using _timers = world.clock.install();
  const startedAt = performance.now();
  const report = await settled(world, takeBoatBackReport(world.bot, world.bot.entities[7]!, undefined, { settleMs: 0 }));
  assert.equal(report.carried, false);
  assert.equal(report.goneAfterHit, null);
  assert.ok(report.elapsedMs >= TAKE_BACK_WALL_MS && report.elapsedMs < TAKE_BACK_WALL_MS + 400, `${report.elapsedMs} ms`);
  assert.ok(performance.now() - startedAt < TAKE_BACK_WALL_MS + 400);
  assert.equal(report.hits, hitsSent(world));
  assert.ok(report.hits >= 30 && report.hits <= 35, `${report.hits} hits in 10 s, 300 ms apart`);
  assert.equal(world.bot.entities[7] !== undefined, true, "the boat is still there: she is still on it");
});

test("a boat that is not in her view is not hit: no hits, nothing carried", async () => {
  const world = shoreSea({ ...STANDING, boat: undefined });
  using _timers = world.clock.install();
  const report = await settled(world, takeBoatBackReport(world.bot, null, undefined, { settleMs: 0 }));
  assert.deepEqual(report, { carried: false, hits: 0, elapsedMs: 0, goneAfterHit: null });
  assert.equal(await settled(world, takeBoatBack(world.bot, null, undefined, { settleMs: 0 })), false);
});

test("the preparation of a movement passes the hostile reflex's cap of hits to the take-back", async () => {
  const world = standingOnBoatWithServerStalledAtFirstHit(undefined, false);
  using _timers = world.clock.install();
  await settled(world, prepareBotForMovement(world.bot, navigation, undefined, { takeBackHits: 15 }));
  assert.equal(hitsSent(world), 15, "capped: a mob attacks meanwhile");
  assert.equal(world.bot.entities[7] !== undefined, true);
  await settled(world, prepareBotForMovement(world.bot, navigation));
  assert.ok(hitsSent(world) > 15 + 30, `${hitsSent(world)} hits: the next movement, with no cap, hits for the whole time bound`);
});
