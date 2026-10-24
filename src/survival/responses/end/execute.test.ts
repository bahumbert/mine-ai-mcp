import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../../navigation/index.js";
import { TestEndCombat as EndCombat, attackedIds, onAttack } from "../../../test-support/combat.js";
import {
  type FakeBotOptions,
  type FakeEntitySpec,
  createFakeBot,
  createFakeClock,
} from "../../../test-support/fake-bot/index.js";
import type { FootingRecovery } from "../footing.js";

import { PerchObservation } from "../../perception/combat/perch.js";

/**
 * A bot in the End on a mocked clock: the code under test reads `Date.now` and sets timers, so each test installs the
 * clock (`using _timers = clock.install()`) before it builds a `PerchObservation`.
 */
function endScene(options: FakeBotOptions = {}) {
  return createFakeBot({
    dimension: "the_end",
    clock: createFakeClock({ mode: "mocked" }),
    ...options,
  });
}

/** The ender dragon: metadata 9 is its health, 16 its native phase. */
function dragonAt(position: Vec3, phase: number, extra: { yaw?: number; health?: number } = {}): FakeEntitySpec {
  return { name: "ender_dragon", position, ...(extra.yaw === undefined ? {} : { yaw: extra.yaw }),
    metadata: { 9: extra.health ?? 200, 16: phase } };
}

/** A dragon breath cloud of `radius`. */
function breathCloud(position: Vec3, radius: number): FakeEntitySpec {
  return { name: "area_effect_cloud", position, metadata: { 8: radius, 10: { type: "dragon_breath" } } };
}

/** One breath cloud per height in `ys`, at x 0 and z 6.5, with the entity id equal to the height. */
function cloudColumn(ys: number[], radius: number): Record<number, FakeEntitySpec> {
  return Object.fromEntries(ys.map(y => [y, breathCloud(new Vec3(0, y, 6.5), radius)]));
}

/** The clock an End response may take before the test calls it stuck. */
const SETTLE_LIMIT_MS = 10_000;

test("perch diagnostics explain cloud-rejected endpoints without attempting navigation", async () => {
  const { bot, clock } = endScene({ position: new Vec3(30.5, 63, 0.5), entities: {
    42: dragonAt(new Vec3(0, 68, 0), 6), ...cloudColumn([61, 63, 65, 67], 20) } });
  using _timers = clock.install();
  const caller = new AbortController();
  let reported = false;
  const listeners = bot.listenerCount("physicsTick");
  using observation = new PerchObservation(bot, 42);
  const navigation = { navigate: () => assert.fail("geometry rejected all endpoints") } as unknown as NavigationRuntime;
  await assert.rejects(clock.settle(new EndCombat(bot, navigation, { needed: false } as FootingRecovery, facts => {
    const event = JSON.parse(JSON.stringify(facts));
    if (event.reason !== "no_safe_striking_position") return;
    reported = true;
    assert.equal(event.digPermitted, true);
    assert.equal(event.nativePhase, 6);
    assert.equal(event.details.candidates.usable, 0);
    assert.ok(event.details.candidates.cloudBlocked > 0);
    assert.equal(event.currentCloudExposure, 0, "the bot is safe but all strike endpoints are clouded");
    caller.abort(new Error("diagnosis captured"));
  }).perch(42, caller.signal, observation), SETTLE_LIMIT_MS), /diagnosis captured/);
  assert.equal(reported, true);
  assert.equal(bot.listenerCount("physicsTick"), listeners + 1, "only the still-owned observation listener remains");
});

test("perch diagnostics retain a cached route failure and explain its retry condition", async () => {
  const { bot, clock } = endScene({ position: new Vec3(12.5, 64, 0.5), entities: { 42: dragonAt(new Vec3(0, 68, 0), 6) } });
  using _timers = clock.install();
  const caller = new AbortController();
  let routes = 0, cached = false;
  const navigation = { navigate: async () => { routes++; return { status: "failed", reason: "no path fixture" }; } } as unknown as NavigationRuntime;
  using observation = new PerchObservation(bot, 42);
  await assert.rejects(clock.settle(new EndCombat(bot, navigation, { needed: false } as FootingRecovery, facts => {
    const event = JSON.parse(JSON.stringify(facts));
    if (event.reason !== "cached_route_failure") return;
    cached = true;
    assert.match(event.details.failure, /no path fixture/);
    assert.match(event.details.retryWhen, /head moves/);
    caller.abort(new Error("cached diagnosis captured"));
  }).perch(42, caller.signal, observation), SETTLE_LIMIT_MS), /cached diagnosis captured/);
  assert.equal(cached, true);
  assert.equal(routes, 2, "try the head, then the body union once before waiting");
});

test("a cloud-blocked head searches safe body reach and swings the reached native part", async () => {
  const caller = new AbortController();
  let routes = 0, swings = 0;
  const { bot, clock, server } = endScene({ position: new Vec3(12.5, 64, 0.5), carried: { diamond_sword: 1 },
    entities: { 42: dragonAt(new Vec3(0, 68, 0), 6), ...cloudColumn([62, 64, 66], 5) } });
  // The dragon's parts are ids only the server holds: the hit at one is the packet the client writes.
  onAttack(server, part => {
    assert.equal(part, 45, "body is parent + 3, not the head or root");
    swings++;
    caller.abort(new Error("body swing observed"));
  });
  using _timers = clock.install();
  const navigation = { navigate: async ({ goal }: Parameters<NavigationRuntime["navigate"]>[0]) => {
    routes++;
    const resolved = goal.resolve({} as never);
    assert.equal(resolved.kind, "active");
    if (resolved.kind === "active") {
      assert.match(resolved.revision, /^dragon-body:/);
      assert.equal(resolved.isSatisfied({ feet: { x: 0, y: 64, z: -2 } } as never, {} as never), true);
      assert.equal(resolved.isSatisfied({ feet: { x: 0, y: 64, z: 6 } } as never, {} as never), false);
    }
    bot.entity.position.set(0.5, 64, -1.5);
    return { status: "completed", elapsedMs: 1 };
  } } as unknown as NavigationRuntime;
  using observation = new PerchObservation(bot, 42);
  await assert.rejects(clock.settle(new EndCombat(bot, navigation, { needed: false } as FootingRecovery)
    .perch(42, caller.signal, observation), SETTLE_LIMIT_MS), /body swing observed/);
  assert.equal(routes, 1, "do not restart head pursuit after reaching the body");
  assert.equal(swings, 1);
});

test("a late scanning request still pursues the head rather than preparing a tunnel", async () => {
  const { bot, clock } = endScene({ position: new Vec3(12.5, 64, 0.5), entities: { 42: dragonAt(new Vec3(0, 68, 0), 6) } });
  using _timers = clock.install();
  using observation = new PerchObservation(bot, 42);
  await clock.advance(75 * 50); // 75 physics ticks
  const caller = new AbortController();
  const navigation = { navigate: async ({ goal }: Parameters<NavigationRuntime["navigate"]>[0]) => {
    const resolved = goal.resolve({} as never);
    assert.equal(resolved.kind, "active");
    if (resolved.kind === "active") assert.match(resolved.revision, /^dragon-head:/);
    caller.abort(new Error("head pursuit observed"));
    caller.signal.throwIfAborted();
  } } as unknown as NavigationRuntime;
  await assert.rejects(clock.settle(new EndCombat(bot, navigation, { needed: false } as FootingRecovery)
    .perch(42, caller.signal, observation), SETTLE_LIMIT_MS), /head pursuit observed/);
});

test("head approach can walk below breath while a jump into the same cloud is refused", async () => {
  const { bot, clock } = endScene({ position: new Vec3(12.5, 63, 0.5), entities: {
    42: dragonAt(new Vec3(0, 68, 0), 6, { yaw: Math.PI / 2 }), 43: breathCloud(new Vec3(9.5, 65, 0.5), 5) } });
  using _timers = clock.install();
  const caller = new AbortController();
  const navigation = { navigate: async ({ goal, movements }: Parameters<NavigationRuntime["navigate"]>[0]) => {
    const resolved = goal.resolve({} as never);
    assert.equal(resolved.kind, "active");
    if (resolved.kind === "active") {
      assert.equal(resolved.isSatisfied({ feet: { x: 7, y: 63, z: 0 } } as never, {} as never), true);
      assert.equal(resolved.isSatisfied({ feet: { x: 7, y: 69, z: 0 } } as never, {} as never), false);
    }
    assert.equal(movements.decideMovement!("walk", { x: 10, y: 63, z: 0 }, { x: 9, y: 63, z: 0 }).kind, "allowed");
    assert.equal(movements.decideMovement!("drop", { x: 7, y: 69, z: 0 }, { x: 7, y: 63, z: 0 }).kind, "prohibited",
      "safe endpoints do not permit falling through the intervening breath layer");
    assert.equal(movements.decideMovement!("drop", { x: 30, y: 69, z: 0 }, { x: 30, y: 63, z: 0 }).kind, "allowed");
    assert.equal(movements.decideMovement!("step_up", { x: 10, y: 63, z: 0 }, { x: 9, y: 64, z: 0 }).kind, "prohibited");
    assert.equal(movements.decideMovement!("step_up", { x: 20, y: 64, z: 0 }, { x: 19, y: 65, z: 0 }).kind, "prohibited",
      "a route must not climb above its low strike height even outside current contact boxes");
    caller.abort(new Error("cloud route checked"));
    caller.signal.throwIfAborted();
  } } as unknown as NavigationRuntime;
  using observation = new PerchObservation(bot, 42);
  await assert.rejects(clock.settle(new EndCombat(bot, navigation, { needed: false } as FootingRecovery)
    .perch(42, caller.signal, observation), SETTLE_LIMIT_MS), /cloud route checked/);
});

test("a fireball dodge clears the growing cloud horizontally rather than dropping into a nearby shaft", async () => {
  const { bot, clock, entities } = endScene({ position: new Vec3(0.5, 64, 0.5), entities: {
    7: { name: "dragon_fireball", position: new Vec3(0.5, 65, 30), velocity: new Vec3(0, 0, -1) } } });
  using _timers = clock.install();
  const navigation = { navigate: async ({ goal }: Parameters<NavigationRuntime["navigate"]>[0]) => {
    const resolved = goal.resolve({} as never);
    assert.equal(resolved.kind, "active");
    if (resolved.kind === "active") {
      assert.equal(resolved.isSatisfied({ feet: { x: 8, y: 64, z: 0 } } as never, {} as never), false);
      assert.equal(resolved.isSatisfied({ feet: { x: 0, y: 54, z: 0 } } as never, {} as never), false);
      assert.equal(resolved.isSatisfied({ feet: { x: 10, y: 64, z: 0 } } as never, {} as never), true);
    }
    entities.remove(7);
    return { status: "completed", elapsedMs: 1 };
  } } as unknown as NavigationRuntime;
  const result = await clock.settle(new EndCombat(bot, navigation, { needed: false } as FootingRecovery)
    .evade(new AbortController().signal), SETTLE_LIMIT_MS);
  assert.equal(result.outcome, "evaded");
});

test("an ordinary scaffold blocking a resistant shelter sends retreat directly to escape", async () => {
  const { bot, clock } = endScene({ position: new Vec3(6.5, 63, 1.5),
    cells: { "6,62,1": "end_stone", "7,63,1": "cobbled_deepslate" },
    carried: { end_stone: 20 },
    entities: { 42: dragonAt(new Vec3(0, 67, 0), 4) },
    overrides: {
      // A guard, not a server answer: the test fails if the shelter starts placing (`placement.ts` calls `_placeBlockWithOptions`, a direct caller `placeBlock`).
      placeBlock: () => assert.fail("Do not start a shelter whose required wall cannot be placed"),
      _placeBlockWithOptions: () => assert.fail("Do not start a shelter whose required wall cannot be placed"),
    } });
  using _timers = clock.install();
  let moved = false;
  const navigation = { navigate: async () => {
    moved = true;
    bot.entity.position.set(20.5, 63, 1.5);
    return { status: "completed", elapsedMs: 1 };
  } } as unknown as NavigationRuntime;
  const result = await clock.settle(new EndCombat(bot, navigation, { needed: false } as FootingRecovery)
    .evade(new AbortController().signal), SETTLE_LIMIT_MS);
  assert.equal(result.outcome, "evaded");
  assert.equal(moved, true);
});

test("takeoff observed during suspension still owes retreat, and failed retreat retains damage", async () => {
  const { bot, clock } = endScene({ position: new Vec3(6.5, 64, 0.5), entities: {
    42: dragonAt(new Vec3(0, 68, 0), 6, { yaw: Math.PI / 2 }) } });
  using _timers = clock.install();
  const dragon = bot.entities[42]!;
  using observation = new PerchObservation(bot, 42);
  observation.swung(13);
  Object.assign(dragon.metadata, { 9: 193, 16: 4 });
  await clock.advance(50);
  const navigation = { navigate: async () => ({ status: "failed", reason: "blocked return" }) } as unknown as NavigationRuntime;
  const result = await clock.settle(new EndCombat(bot, navigation, { needed: false } as FootingRecovery)
    .perch(42, new AbortController().signal, observation), SETTLE_LIMIT_MS);
  assert.equal(result.outcome, "stopped");
  assert.match(result.reason!, /PERCH_RETREAT_INCOMPLETE.*blocked return/);
  assert.equal(result.attacks, 1);
  assert.equal(result.healthAfter, 193);
  assert.equal(result.perch?.timing?.confirmedDamage, 7);
});

test("breath interrupts a local bite and reaches evasion without swallowing caller cancellation", async () => {
  const { bot, clock, server, entities } = endScene({ food: 17, carried: { cooked_beef: 1 }, entities: {
    42: dragonAt(new Vec3(0, 95, 0), 0),
  } });
  // The breath cloud comes over the bot as the bite starts: the server receives the item use.
  server.onPacket("use_item", () => void entities.spawn({ id: 7, ...breathCloud(new Vec3(0.5, 64, 0.5), 5) }));
  using _timers = clock.install();
  const listeners = bot.listenerCount("physicsTick");
  const caller = new AbortController();
  let escapes = 0;
  const navigation = {
    navigate: async () => {
      escapes++;
      assert.equal(bot.usingHeldItem, false);
      caller.abort(new Error("caller cancelled after escape admission"));
      caller.signal.throwIfAborted();
    },
  } as unknown as NavigationRuntime;
  const observation = new PerchObservation(bot, 42);
  await assert.rejects(
    clock.settle(new EndCombat(bot, navigation, { needed: false } as FootingRecovery).perch(42, caller.signal, observation), SETTLE_LIMIT_MS),
    /caller cancelled after escape admission/,
  );
  assert.equal(escapes, 1);
  observation[Symbol.dispose]();
  assert.equal(bot.listenerCount("physicsTick"), listeners);
});

test("waiting for a perch is cancellable and releases entity listeners and controls", async () => {
  const controller = new AbortController();
  const { bot, clock, server } = endScene({ position: new Vec3(0, 60, 6), entities: { 42: dragonAt(new Vec3(0, 90, 0), 0) } });
  using _timers = clock.install();
  let cleared = 0;
  const clearControlStates = bot.clearControlStates.bind(bot);
  bot.clearControlStates = () => {
    cleared++;
    clearControlStates();
  };
  const navigation = {
    navigate: async () => {
      throw new Error("A flying dragon has no melee approach");
    },
  } as unknown as NavigationRuntime;
  const footing = { needed: false } as FootingRecovery;
  const observation = new PerchObservation(bot, 42);
  observation.preparationTarget = new Vec3(0, 60, 6);
  observation.preparedPosition = observation.preparationTarget.clone();
  const pending = new EndCombat(bot, navigation, footing).perch(42, controller.signal, observation);
  const rejected = assert.rejects(pending, /caller cancelled/);
  await clock.advance(50);
  controller.abort(new Error("caller cancelled"));
  await rejected;
  observation[Symbol.dispose]();
  assert.deepEqual(attackedIds(server), []);
  assert.equal(cleared, 1);
  assert.equal(bot.listenerCount("entityDead"), 0);
});

test("a newly observed breath cloud aborts perch sightline digging before any swing", async () => {
  let escapes = 0,
    digAborted = false;
  const { bot, clock, server, entities } = endScene({ position: new Vec3(2, 64, 5), cells: { "2,66,4": "end_stone" },
    entities: {
      42: dragonAt(new Vec3(0, 68, 0), 6, { health: 190 }),
    } });
  using _timers = clock.install();
  const obstruction = bot.blockAt(new Vec3(2, 66, 4))!;
  const obstructionHit = Object.assign(obstruction, { x: 2, y: 66, z: 4, face: 1, intersect: new Vec3(2.25, 66, 4.9) });
  // Scripted: the ray the sightline check casts meets the end_stone at the point the dig will remove (x, y, z are
  // the fields the typings' `RaycastResult` names).
  bot.world.raycast = () => obstructionHit;
  const caller = new AbortController();
  const navigation = {
    breakBlockInPlace: async ({ signal }: { signal: AbortSignal }) => {
      entities.spawn({ id: 7, ...breathCloud(new Vec3(2, 64, 5), 5) }); // the breath cloud at the bot, seen as the dig starts
      await bot.waitForTicks(1);
      digAborted = signal.aborted;
      signal.throwIfAborted();
      return { status: "broken" };
    },
    navigate: async () => {
      escapes++;
      assert.equal(digAborted, true);
      assert.deepEqual(attackedIds(server), []);
      caller.abort(new Error("stop after danger handling"));
      caller.signal.throwIfAborted();
    },
  } as unknown as NavigationRuntime;
  const observation = new PerchObservation(bot, 42);
  try {
    await assert.rejects(
      clock.settle(new EndCombat(bot, navigation, { needed: false } as FootingRecovery).perch(42, caller.signal, observation), SETTLE_LIMIT_MS),
      /stop after danger handling/,
    );
    assert.equal(digAborted, true);
    assert.equal(escapes, 1);
    assert.deepEqual(attackedIds(server), []);
  } finally {
    observation[Symbol.dispose]();
  }
});

test("End escape waits for the observed landing before asking navigation for a route", async () => {
  const { bot, clock } = endScene({ entities: { 7: breathCloud(new Vec3(0.5, 64, 0.5), 5) } });
  using _timers = clock.install();
  bot.entity.onGround = false;
  let ticks = 0,
    calls = 0;
  const listeners = bot.listenerCount("physicsTick");
  // The landing, observed from the next tick on.
  clock.every(() => {
    ticks++;
    bot.entity.onGround = true;
  }, 50);
  const navigation = {
    navigate: async () => {
      assert.equal(bot.entity.onGround, true);
      assert.ok(ticks > 0);
      calls++;
      bot.entity.position.set(10, 64, 0);
      return { status: "completed", elapsedMs: 1 };
    },
  } as unknown as NavigationRuntime;
  const result = await clock.settle(new EndCombat(bot, navigation, { needed: false } as FootingRecovery).evade(
    new AbortController().signal,
  ), SETTLE_LIMIT_MS);
  assert.equal(result.outcome, "evaded");
  assert.equal(calls, 1);
  assert.equal(bot.listenerCount("physicsTick"), listeners);
});

test("a landing escape releases a safe bot when the dragon settles instead of finishing the obsolete route", async () => {
  const { bot, clock } = endScene({ position: new Vec3(0.5, 64, 0.5),
    cells: { "0,63,0": "end_stone" },
    // Only the chunk the bot stands in is loaded: the landing search for the exit portal's bedrock (128 blocks) reads it alone.
    loadedColumns: [[0, 0]],
    carried: { end_stone: 10 },
    entities: { 42: dragonAt(new Vec3(0, 68, 0), 3, { health: 190 }) },
    overrides: {
      // A guard, not a server answer: the test fails if the escape places a block (`placement.ts` calls `_placeBlockWithOptions`, a direct caller `placeBlock`).
      placeBlock: () => assert.fail("Landing must preserve the prepared head sightline, even with shelter supplies."),
      _placeBlockWithOptions: () => assert.fail("Landing must preserve the prepared head sightline, even with shelter supplies."),
    } });
  using _timers = clock.install();
  const dragon = bot.entities[42]!;
  let moves = 0;
  const navigation = {
    navigate: async ({ stopSignal }: { stopSignal: AbortSignal }) => {
      moves++;
      Object.assign(dragon.metadata, { 16: 6 });
      bot.emit("physicsTick"); // the dragon's settling is seen at once, while the route is being asked for
      assert.equal(stopSignal.aborted, true, "the now-safe approach must not be carried away from the head");
      return { status: "cancelled", reason: "landing ended" };
    },
  } as unknown as NavigationRuntime;
  const result = await clock.settle(new EndCombat(bot, navigation, { needed: false } as FootingRecovery)
    .evade(new AbortController().signal), SETTLE_LIMIT_MS);
  assert.equal(result.outcome, "evaded");
  assert.equal(moves, 1);
});

test("damage-interrupted breath excavation gives the next escape a route without digging", async () => {
  const { bot, clock, entities } = endScene({ entities: { 7: breathCloud(new Vec3(0.5, 64, 0.5), 5) } });
  using _timers = clock.install();
  const footing = {
    needed: false,
    async recover() {
      Object.assign(footing, { needed: false });
      return "landed";
    },
  } as unknown as FootingRecovery;
  let attempts = 0;
  const navigation = {
    async navigate(options: Parameters<NavigationRuntime["navigate"]>[0]) {
      attempts++;
      assert.equal(
        options.movements.allowPlacing,
        false,
        "escape must not extend an aerial bridge under dragon contact",
      );
      assert.equal(options.movements.scaffold, null);
      if (attempts === 1) {
        assert.equal(options.movements.allowDigging, true);
        bot.health = 17;
        Object.assign(footing, { needed: true });
        bot.emit("physicsTick"); // the damage is seen at once, while the route is being asked for
        assert.equal(options.stopSignal?.aborted, true);
        return { status: "stopped", reason: "knockback", elapsedMs: 500 } as const;
      }
      assert.equal(options.movements.allowDigging, false, "do not restart the same vulnerable excavation");
      assert.equal(footing.needed, false, "the next route still waits for physical recovery");
      entities.remove(7);
      return { status: "completed", elapsedMs: 500 } as const;
    },
  } as unknown as NavigationRuntime;
  const result = await clock.settle(new EndCombat(bot, navigation, footing).evade(new AbortController().signal), SETTLE_LIMIT_MS);
  assert.equal(result.outcome, "evaded");
  assert.equal(attempts, 2);
});
