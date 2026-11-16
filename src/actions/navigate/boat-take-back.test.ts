// The take-back keeps hitting until the boat is gone or 200 server ticks pass (or the world age stands still for 10 s of wall); its report says what happened.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { attackedIds } from "../../test-support/combat.js";
import { watch } from "../../test-support/pending.js";
import type { FakeHarness } from "../../test-support/fake-bot/index.js";
import { boatsCarried, makeHitsMiss, settled, shoreSea, stallServerAtFirstHit } from "./boat-fixtures.test.js";
import { TAKE_BACK_WALL_MS, takeBoatBack, takeBoatBackReport } from "./boat-take-back.js";
import { ActionRunner } from "../../session/action-runner.js";
import { createNavigateAction } from "./navigate.js";

const navigation = { cancel: () => undefined, onEvent: () => () => {} } as unknown as NavigationRuntime;
/** Standing on boat 7 over water two deep by the shore (the feet the server sets her at on top of it). */
const STANDING = { feet: new Vec3(20.5, 63.05, 0.5), boat: new Vec3(20.5, 62.49, 0.5), mocked: true, physics: true, waterDepth: 2 } as const;
/** The bot stands on a boat (physics off keeps her there: the fake sinks her, the server would hold her) and the server stalls at the first hit, for `afterMs` or for good; install the clock first. */
function standingOnBoatWithServerStalledAtFirstHit(afterMs?: number, physics = true): FakeHarness {
  const world = shoreSea({ ...STANDING, physics });
  stallServerAtFirstHit(world, afterMs);
  return world;
}
const hitsSent = (world: FakeHarness) => attackedIds(world.server).length;

// The short stop catches up owed ticks; vanilla drops a first stall over 2 s (fake-server.ts, T15, 2026-11-09).
for (const stallMs of [1_500, 6_000]) test(`a ${stallMs} ms stall cannot spend another swing before its server cooldown; recovery permits the next navigate`, async () => {
  const world = standingOnBoatWithServerStalledAtFirstHit(stallMs);
  using _timers = world.clock.install();
  const attackTicks: number[] = [];
  world.server.onPacket("use_entity", (data) => {
    if ((data as { mouse: number }).mouse === 1) world.server.answer(() => attackTicks.push(world.server.gameTime));
  });
  const report = await settled(world, takeBoatBackReport(world.bot, world.bot.entities[7]!, undefined, { settleMs: 0 }));
  assert.equal(report.carried, true);
  assert.equal(boatsCarried(world), 1);
  assert.ok(attackTicks.slice(1).every((tick, index) => tick - attackTicks[index]! >= 5), `server attack ticks: ${attackTicks}`);
  assert.equal(report.hits, hitsSent(world), "the report counts the hits sent");
  assert.equal(report.goneAfterHit, report.hits, "the boat left her client at the last hit");
  assert.ok(report.elapsedMs >= stallMs && report.elapsedMs < TAKE_BACK_WALL_MS, `${report.elapsedMs} ms`);
  let routed = false;
  const action = createNavigateAction(world.bot, navigation, {
    createMovements: (() => ({ name: "standard" })) as never,
    navigate: async () => {
      routed = true;
      world.bot.entity.position.set(45.5, 63, 0.5);
      return { status: "completed", elapsedMs: 1 };
    },
  });
  const next = await settled(world, new ActionRunner().run(action, { x: 45, y: 63, z: 0, range: 2 }));
  assert.equal(next.result.status, "succeeded", JSON.stringify(next.result));
  assert.equal(routed, true);
});

test("a server stopped for good: the take-back gives up after the wall bound of the wall clock, with no tick needed", async () => {
  const world = standingOnBoatWithServerStalledAtFirstHit(undefined, false);
  using _timers = world.clock.install();
  const startedAt = performance.now();
  const report = await settled(world, takeBoatBackReport(world.bot, world.bot.entities[7]!, undefined, { settleMs: 0 }));
  assert.equal(report.carried, false);
  assert.equal(report.goneAfterHit, null);
  assert.ok(report.elapsedMs >= TAKE_BACK_WALL_MS && report.elapsedMs < TAKE_BACK_WALL_MS + 400, `${report.elapsedMs} ms`);
  assert.ok(report.elapsedTicks < TAKE_BACK_WALL_MS / 50, `${report.elapsedTicks} ticks: the world age stood still, so the wall ended it`);
  assert.ok(performance.now() - startedAt < TAKE_BACK_WALL_MS + 400);
  assert.equal(report.hits, hitsSent(world));
  assert.equal(report.hits, 1, "a server that has not handled the first swing cannot receive queued swings");
  assert.equal(world.bot.entities[7] !== undefined, true, "the boat is still there: she is still on it");
});

test("cancelling a stalled swing releases its observation and the next take-back recovers the surviving boat", async () => {
  const world = standingOnBoatWithServerStalledAtFirstHit(undefined, false);
  using _timers = world.clock.install();
  const controller = new AbortController();
  const listeners = world.bot.listenerCount("entityUpdate");
  setTimeout(() => controller.abort(), 1_000);
  const report = await settled(world, takeBoatBackReport(world.bot, world.bot.entities[7]!, controller.signal, { settleMs: 0 }));
  assert.equal(report.carried, false);
  assert.equal(report.hits, 1);
  assert.equal(world.bot.listenerCount("entityUpdate"), listeners);
  world.server.resume();
  assert.equal(await settled(world, takeBoatBack(world.bot, world.bot.entities[7]!, undefined, { settleMs: 0 })), true);
  assert.equal(world.bot.listenerCount("entityUpdate"), listeners);
});

test("a boat that is not in her view is not hit: no hits, nothing carried", async () => {
  const world = shoreSea({ ...STANDING, boat: undefined });
  using _timers = world.clock.install();
  const report = await settled(world, takeBoatBackReport(world.bot, null, undefined, { settleMs: 0 }));
  assert.deepEqual(report, { carried: false, hits: 0, elapsedMs: 0, elapsedTicks: 0, goneAfterHit: null });
  assert.equal(await settled(world, takeBoatBack(world.bot, null, undefined, { settleMs: 0 })), false);
});

test("the preparation of a movement passes the hostile reflex's cap of hits to the take-back", async () => {
  const world = shoreSea({ ...STANDING, physics: false });
  const landAgain = makeHitsMiss(world);
  using _timers = world.clock.install();
  await assert.rejects(settled(world, prepareBotForMovement(world.bot, navigation, undefined, { takeBackHits: 2 })), /\[BOAT_TAKE_BACK_FAILED\]/u);
  assert.equal(hitsSent(world), 2, "capped: a mob attacks meanwhile");
  assert.equal(world.bot.entities[7] !== undefined, true);
  let routed = false;
  const action = createNavigateAction(world.bot, navigation, {
    createMovements: (() => ({ name: "standard" })) as never,
    navigate: async () => {
      routed = true;
      world.bot.entity.position.set(45.5, 63, 0.5);
      return { status: "completed", elapsedMs: 1 };
    },
  });
  const next = await settled(world, new ActionRunner().run(action, { x: 45, y: 63, z: 0, range: 2 }));
  assert.equal(next.result.status, "failed");
  assert.match("error" in next.result ? next.result.error ?? "" : "", /\[BOAT_TAKE_BACK_FAILED\]/u);
  assert.equal(routed, false, "a failed take-back cannot start the next route");
  assert.ok(hitsSent(world) > 2, "the next movement retries within its time bound");
  landAgain();
  const recovered = await settled(world, new ActionRunner().run(action, { x: 45, y: 63, z: 0, range: 2 }));
  assert.equal(recovered.result.status, "succeeded", JSON.stringify(recovered.result));
  assert.equal(routed, true);
});

// Spec 2026-11-15-scenario-disk-stalls section 5, lag-triage E2: the bound is 200 ticks of world age (TAKE_BACK_WALL_MS / 50), so a
// server at 5 ticks a second keeps being hit for 40 s of wall, not 10; one whose age stands still is still left after TAKE_BACK_WALL_MS.
/** The boat of the shore is out of reach from the first hit on (the hits arrive and do nothing), so only the bound ends the loop. */
function boatOutOfReachOnServerAt(ticksPerSecond: number): FakeHarness {
  const world = shoreSea({ ...STANDING, physics: false, server: { ticksPerSecond } });
  makeHitsMiss(world);
  return world;
}
const BOUND_TICKS = TAKE_BACK_WALL_MS / 50;
/** The world age comes in time packets of 20 ticks, so the loop sees the bound at most one packet late. */
const PACKET_TICKS = 20;

/** Ticks a second, and the wall time 200 ticks take there: the hits end at the same world age at any rate. */
const RATES: readonly (readonly [ticksPerSecond: number, wallMs: number])[] = [[5, TAKE_BACK_WALL_MS * 4], [10, TAKE_BACK_WALL_MS * 2], [20, TAKE_BACK_WALL_MS]];
for (const [ticksPerSecond, wallMs] of RATES) {
  test(`at ${ticksPerSecond} ticks a second the hits go on until 200 ticks of world age passed (${wallMs / 1000} s of wall)`, async () => {
    const world = boatOutOfReachOnServerAt(ticksPerSecond);
    using _timers = world.clock.install();
    const startAge = world.bot.time.age;
    const pending = takeBoatBackReport(world.bot, world.bot.entities[7]!, undefined, { settleMs: 0 });
    const state = watch(pending);
    await world.clock.advance(wallMs * 0.9 + 300);
    assert.equal(world.bot.time.age - startAge, 180);
    assert.equal(state.over, false, "still hitting below the tick bound");
    const report = await settled(world, pending);
    assert.equal(report.elapsedTicks, BOUND_TICKS);
    assert.ok(Math.abs(report.elapsedMs - wallMs) <= 1_400 + PACKET_TICKS * 1000 / ticksPerSecond, `${report.elapsedMs} ms`);
  });
}

test("a bot that has heard no world age yet is left after TAKE_BACK_WALL_MS of wall", async () => {
  const world = shoreSea({ ...STANDING, physics: false, server: { timePacketYet: false, ticksPerSecond: 5 } });
  makeHitsMiss(world);
  using _timers = world.clock.install();
  world.server.stop();
  const report = await settled(world, takeBoatBackReport(world.bot, world.bot.entities[7]!, undefined, { settleMs: 0 }));
  assert.equal(report.elapsedTicks, 0);
  assert.ok(report.elapsedMs >= TAKE_BACK_WALL_MS && report.elapsedMs < TAKE_BACK_WALL_MS + 400, `${report.elapsedMs} ms`);
});

test("a world age first heard after the first hit still bounds the loop, counted from that age", async () => {
  const world = shoreSea({ ...STANDING, physics: false, server: { timePacketYet: false, ticksPerSecond: 20 } });
  makeHitsMiss(world);
  using _timers = world.clock.install();
  const report = await settled(world, takeBoatBackReport(world.bot, world.bot.entities[7]!, undefined, { settleMs: 0 }));
  assert.ok(report.elapsedTicks >= BOUND_TICKS - PACKET_TICKS && report.elapsedTicks <= BOUND_TICKS, `${report.elapsedTicks} ticks`);
  assert.ok(report.elapsedMs >= TAKE_BACK_WALL_MS && report.elapsedMs < TAKE_BACK_WALL_MS + 2_400, `${report.elapsedMs} ms`);
});

test("an abort ends the hits at once, at any tick rate", async () => {
  const world = boatOutOfReachOnServerAt(5);
  using _timers = world.clock.install();
  const abort = new AbortController();
  world.clock.after(1_000, () => abort.abort());
  const report = await settled(world, takeBoatBackReport(world.bot, world.bot.entities[7]!, abort.signal, { settleMs: 0 }));
  assert.ok(report.elapsedMs < 1_400, `${report.elapsedMs} ms`);
});
