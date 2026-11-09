// The take-back keeps hitting until the boat is gone or the wall bound passes, whatever the server's ticks do; its report says what happened.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { attackedIds } from "../../test-support/combat.js";
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
  assert.deepEqual(report, { carried: false, hits: 0, elapsedMs: 0, goneAfterHit: null });
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
