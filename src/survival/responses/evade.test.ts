import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { combatTestContext } from "../../test-support/combat.js";
import { createFakeBot, createFakeClock, itemOf, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { observation } from "../../test-support/navigation.js";
import type { Goal } from "../../navigation/index.js";
import { completeResponse, describeResponse } from "../control/combat/settlement.js";
import { CombatPerception } from "../perception/combat/observations.js";
import { DEFAULT_COMBAT_POLICY } from "../policy/combat/contract.js";
import { evade } from "./evade.js";
import { EvadeObservation } from "./evade-observation.js";

const EVADE_BUDGET_MS = 3_000;
const ROUTE_MS = 1_000;
const ZOMBIE = 7;

/** Shared game clock and body, with navigation stopping only at its signal or timeout. */
function reachFixture({ shooter = false, distance = 17, budget = 15_000, cover = false, ticksPerSecond = 20 } = {}) {
  const harness = createFakeBot({ clock: createFakeClock({ mode: "mocked" }),
    server: { ticksPerSecond },
    position: new Vec3(0.5, 64, 0.5), groundY: 63,
    entities: { 7: { name: shooter ? "skeleton" : "zombie", position: new Vec3(distance + 0.5, 64, 0.5) } } });
  if (shooter) harness.bot.entities[7]!.equipment[0] = itemOf(harness.bot.registry, "bow", 1);
  const world = new MemoryWorld();
  for (let x = -40; x <= 80; x++) for (let z = -2; z <= 2; z++)
    for (let y = 63; y <= 66; y++) world.load({ x, y, z }, { stateId: y === 63 ? 1 : 0 });
  const wall = (present: boolean) => {
    for (let y = 64; y <= 67; y++) for (let z = -2; z <= 2; z++)
      harness.world.setCell(new Vec3(4, y, z), present ? "stone" : "air");
  };
  wall(cover);
  const stops: string[] = [];
  let routes = 0;
  let goal: Goal | undefined;
  const navigation: { world: MemoryWorld; navigate: NavigationRuntime["navigate"] } = { world, navigate: async ({ goal: received, signal, stopSignal, timeoutMs }) => {
    goal = received;
    routes++;
    return await new Promise<{ status: "stopped"; reason: string; elapsedMs: number }>((resolve) => {
      const started = harness.clock.now();
      const finish = () => {
        cancel();
        stopSignal?.removeEventListener("abort", finish);
        signal?.removeEventListener("abort", finish);
        const reason = stopSignal?.aborted ? String(stopSignal.reason) : signal?.aborted ? String(signal.reason) : "navigation timeout";
        stops.push(reason);
        resolve({ status: "stopped", reason, elapsedMs: harness.clock.now() - started });
      };
      const cancel = harness.clock.after(timeoutMs ?? budget, finish);
      stopSignal?.addEventListener("abort", finish, { once: true });
      signal?.addEventListener("abort", finish, { once: true });
      if (stopSignal?.aborted || signal?.aborted) finish();
    });
  } };
  const perception = new CombatPerception(harness.bot);
  after(() => perception[Symbol.dispose]());
  const context = { ...combatTestContext(harness.bot), perception, policy: { ...DEFAULT_COMBAT_POLICY, evade_timeout_ms: budget } };
  const request = { kind: "evade" as const, threats: [{ id: 7, name: shooter ? "skeleton" : "zombie",
    position: { x: distance + 0.5, y: 64, z: 0.5 }, distance }], safeRange: 36, reason: "hurt" as const };
  const run = (signal = new AbortController().signal) => harness.clock.settle(
    evade(harness.bot, navigation as unknown as NavigationRuntime, request, context, harness.bot.health, signal), budget + 1_000);
  const revision = () => {
    assert.ok(goal);
    const resolved = goal.resolve({ ...observation(), position: harness.bot.entity.position });
    assert.equal(resolved.kind, "active");
    return resolved.kind === "active" ? resolved.revision : "";
  };
  return { ...harness, navigation, context, request, stops, routes: () => routes, wall, run, revision };
}

for (const ticksPerSecond of [20, 10]) for (const mode of ["sub-block", "stops", "stale", "melee"] as const) {
  test(`${mode} threat updates cover at ${ticksPerSecond} tps`, async () => {
    const fixture = reachFixture({ shooter: mode !== "melee", distance: 9, cover: true, ticksPerSecond });
    using _installed = fixture.clock.install();
    const snapshots: { age: number; time: number; revision: string; x: number; refreshes: number }[] = [];
    const initialAge = fixture.bot.time.age;
    let moving = true;
    const cancel = new AbortController();
    let observed: EvadeObservation | undefined;
    const transitions: { before: boolean; after: boolean; delta: number; age: number; time: number }[] = [];
    const originalRefresh = EvadeObservation.prototype.refreshGoal;
    EvadeObservation.prototype.refreshGoal = function (...args) {
      const hasCover = () => {
        const resolved = this.goal?.resolve(observation());
        return resolved?.kind === "active" && resolved.revision.includes(":8,");
      };
      const before = hasCover();
      const count = this.goalRefreshes;
      originalRefresh.apply(this, args);
      if (this.goalRefreshes > count) transitions.push({ before, after: hasCover(), delta: this.goalRefreshes - count,
        age: fixture.bot.time.age, time: fixture.clock.now() });
      observed = this;
    };
    const step = (mode === "sub-block" ? 0.03 : 0.15) * ticksPerSecond / 20;
    const move = () => { if (moving) fixture.bot.entities[7]!.position.x -= step; };
    fixture.bot.on("physicsTick", move);
    fixture.context.policy.melee = false;
    const botAdded = listenersAddedSince(fixture.bot);
    const clientAdded = listenersAddedSince(fixture.bot._client);
    const capture = () => snapshots.push({ age: fixture.bot.time.age, time: fixture.clock.now(),
      revision: fixture.revision(), x: fixture.bot.entities[7]!.position.x, refreshes: observed!.goalRefreshes });
    const tickMs = 1_000 / ticksPerSecond;
    let beforeFlip = "";
    let refreshesBeforeFlip = 0;
    const timers = [fixture.clock.after(20 * tickMs + 100, capture),
    fixture.clock.after(40 * tickMs - 100, () => { beforeFlip = fixture.revision(); refreshesBeforeFlip = observed!.goalRefreshes; }),
    fixture.clock.after(40 * tickMs + 100, () => {
      capture();
      if (mode === "stops" || mode === "stale") moving = false;
      if (mode === "stale") fixture.server.stop();
      if (mode === "sub-block") cancel.abort();
    }), fixture.clock.after((mode === "stale" ? 40 * tickMs + 2_100 : 100 * tickMs + 100), capture)];
    let settlements = 0;
    let result: Awaited<ReturnType<typeof fixture.run>>;
    try { result = await fixture.run(cancel.signal).then((value) => { settlements++; return value; }); }
    finally { EvadeObservation.prototype.refreshGoal = originalRefresh; }
    for (const cancelTimer of timers) cancelTimer();
    await fixture.clock.advance(16_000);
    assert.equal(settlements, 1);
    assert.equal(fixture.stops.length, 1, "navigation settles once, including past its old deadline");
    for (const event of ["physicsTick", "entityDead"]) assert.equal(botAdded(event), 0, event);
    assert.equal(clientAdded("explosion"), 0);
    fixture.bot.off("physicsTick", move);
    const hasCover = (i: number) => snapshots[i]!.revision.includes(":8,");
    const where = (i: number) => `time ${snapshots[i]!.time} ms, age ${snapshots[i]!.age}`;
    assert.equal(snapshots[0]!.age - initialAge, 20, where(0));
    assert.equal(hasCover(0), mode !== "melee", where(0));
    assert.equal(snapshots[1]!.age - initialAge, 40, where(1));
    assert.equal(hasCover(1), false, where(1));
    if (mode === "sub-block") {
      assert.ok(9.5 - snapshots[1]!.x > 1, where(1));
      const snapshotX = Number(beforeFlip.match(/7@([^,]+)/)?.[1]);
      assert.ok(Math.abs(snapshotX - snapshots[1]!.x) < 1, where(1));
      assert.equal(snapshots[1]!.refreshes - refreshesBeforeFlip, 1, where(1));
    }
    if (mode === "stops" || mode === "stale") assert.equal(hasCover(2), true, where(2));
    if (mode === "stops") {
      assert.equal(snapshots[2]!.age - initialAge, 100, where(2));
      const flip = transitions.find((entry) => !entry.before && entry.after);
      assert.ok(flip, "cover returns after stopping");
      assert.equal(flip.delta, 1, `time ${flip.time} ms, age ${flip.age}`);
    }
    if (mode === "stale") {
      assert.equal(snapshots[2]!.age, snapshots[1]!.age, where(2));
      assert.equal(result.ends[0]?.advancing, null);
      assert.notEqual(result.result.kind, "separated");
    }
    if (mode === "melee") assert.equal(hasCover(2), false, where(2));
  });
}

test("a shooter out of sight at the cover range ends the evade separated before the budget", async () => {
  const fixture = reachFixture({ shooter: true, distance: 9, cover: true });
  using _installed = fixture.clock.install();
  const result = await fixture.run();
  assert.equal(result.result.kind, "separated");
  assert.equal(result.ends[0]?.basis, "cover");
  assert.ok(result.elapsedMs < 15_000);
  assert.deepEqual(fixture.stops, ["Threats can no longer reach the bot."]);
});

test("a melee threat that stops following ends the evade separated", async () => {
  const fixture = reachFixture();
  using _installed = fixture.clock.install();
  const result = await fixture.run();
  assert.equal(result.result.kind, "separated");
  assert.equal(result.ends[0]?.basis, "disengaged");
  const receipt = describeResponse(completeResponse(result, new AbortController().signal));
  assert.equal((receipt as Record<string, unknown>).elapsedMs, 2_000);
  console.log("T6 sample receipt", JSON.stringify(receipt));
  // The early stop must release its listeners so the next escape can own the body.
  fixture.bot.entities[7]!.position.x = 40.5;
  assert.equal((await fixture.run()).result.kind, "separated");
});

test("an equal-speed pursuer at the budget's end is exhausted with the numbers", async () => {
  const fixture = reachFixture({ distance: 10, budget: 2_000 });
  using _installed = fixture.clock.install();
  fixture.bot.on("physicsTick", () => {
    fixture.bot.entity.position.x += 0.2;
    fixture.bot.entities[7]!.position.x = fixture.bot.entity.position.x - 10;
  });
  fixture.bot.entities[7]!.position.x = -9.5;
  const result = await fixture.run();
  assert.deepEqual(result.result, { kind: "exhausted", reason: "Emergency evade stopped without settled safe separation: navigation timeout; after 2.0 s zombie#7 is 10.0 blocks away (gained 0.0), still following." });
});

test("an arrow in flight keeps the evade going", async () => {
  const fixture = reachFixture();
  using _installed = fixture.clock.install();
  fixture.entities.spawn({ id: 8, name: "arrow", position: new Vec3(4, 65, 0.5), velocity: new Vec3(-0.5, 0, 0) });
  fixture.clock.after(2_100, () => {
    assert.deepEqual(fixture.stops, []);
    fixture.entities.remove(8);
  });
  const result = await fixture.run();
  assert.equal(result.result.kind, "separated");
  assert.ok(result.elapsedMs >= 2_100);
});

test("a shooter that hit the bot inside the closing window is not disengaged", async () => {
  const fixture = reachFixture({ shooter: true, distance: 17, budget: 2_000 });
  using _installed = fixture.clock.install();
  fixture.clock.after(1_000, () => fixture.combat.shootBot("arrow", 7, 1));
  const result = await fixture.run();
  assert.equal(fixture.bot.health, 19, "the attributed shot must actually land before judging");
  assert.equal(result.result.kind, "exhausted");
  assert.equal(result.ends[0]?.basis, null);
  assert.notEqual(fixture.context.perception.read().find((threat) => threat.id === 7)?.lastShotTick, null);
});

test("the budget ends the evade when the world age stands still", async () => {
  const fixture = reachFixture({ budget: 2_000 });
  using _installed = fixture.clock.install();
  fixture.server.stop();
  const result = await fixture.run();
  assert.equal(result.result.kind, "exhausted");
  assert.equal(result.elapsedMs, 2_000);
  assert.equal(result.ends[0]?.basis, null);
});

test("the evade waits in cover for a hidden shooter", async () => {
  const fixture = reachFixture({ shooter: true, distance: 9, cover: true });
  using _installed = fixture.clock.install();
  let routes = 0;
  fixture.navigation.navigate = async () => { routes++; return { status: "completed", elapsedMs: 0 }; };
  const result = await fixture.run();
  assert.equal(result.result.kind, "separated");
  assert.equal(result.ends[0]?.basis, "cover");
  assert.equal(routes, 1);
  fixture.navigation.navigate = async () => {
    fixture.bot.entity.position.x = -30.5;
    return { status: "completed", elapsedMs: 0 };
  };
  assert.equal((await fixture.run()).result.kind, "separated", "the next escape must be able to leave the held cover");
  assert.equal(fixture.bot.entity.position.x, -30.5);
});

for (const abort of [false, true]) test(`a cover wait releases its listeners when ${abort ? "cancelled" : "physics stops until its budget"}`, async () => {
  const fixture = reachFixture({ shooter: true, distance: 9, cover: true, budget: 3_000 });
  using _installed = fixture.clock.install();
  fixture.navigation.navigate = async () => ({ status: "completed", elapsedMs: 0 });
  const listeners = fixture.bot.listenerCount("physicsTick");
  const cancel = new AbortController();
  fixture.clock.after(500, () => {
    fixture.server.stop();
    fixture.bot.physicsEnabled = false;
    if (abort) cancel.abort(new Error("cancel cover wait"));
  });
  const result = await fixture.run(cancel.signal);
  assert.equal(result.result.kind, abort ? "failed" : "exhausted");
  if (!abort && result.result.kind === "exhausted")
    assert.ok(result.result.reason.startsWith("Emergency evade stopped without settled safe separation: navigation timeout;"));
  assert.equal(result.elapsedMs, abort ? 500 : 3_000);
  assert.equal(fixture.bot.listenerCount("physicsTick"), listeners);
  assert.equal(fixture.clock.pendingTimers(), 0);
});

test("a completed route cannot certify footing lost during its cover wait", async () => {
  const fixture = reachFixture({ shooter: true, distance: 9, cover: true, budget: 3_000 });
  using _installed = fixture.clock.install();
  fixture.navigation.navigate = async () => ({ status: "completed", elapsedMs: 0 });
  fixture.clock.after(500, () => {
    fixture.bot.entity.onGround = false;
    fixture.bot.entity.position.y = 63.5;
  });
  const result = await fixture.run();
  assert.equal(result.elapsedMs, 3_000);
  assert.equal(result.ends[0]?.basis, "cover");
  assert.equal(result.result.kind, "exhausted");
});

test("a cover cell the live world no longer covers is not separated", async () => {
  const fixture = reachFixture({ shooter: true, distance: 9, cover: true, budget: 3_000 });
  using _installed = fixture.clock.install();
  const navigate = fixture.navigation.navigate;
  let routes = 0;
  fixture.navigation.navigate = async (options) => {
    if (++routes === 1) { fixture.wall(false); return { status: "completed", elapsedMs: 0 }; }
    return navigate(options);
  };
  const result = await fixture.run();
  assert.equal(result.result.kind, "exhausted");
  assert.equal(result.ends[0]?.basis, null);
  assert.equal(routes, 2);
});

test("a stop that lands during a step re-judges with the same budget", async () => {
  const fixture = reachFixture({ budget: 3_000 });
  fixture.context.policy.melee = false;
  using _installed = fixture.clock.install();
  const navigate = fixture.navigation.navigate;
  let routes = 0;
  fixture.navigation.navigate = async (options) => {
    const route = await navigate(options);
    if (++routes === 1) {
      fixture.entities.spawn({ id: 9, name: "zombie", position: new Vec3(3.5, 64, 0.5) });
      await fixture.clock.sleep(300);
    }
    return route;
  };
  const result = await fixture.run();
  assert.equal(result.result.kind, "exhausted");
  assert.equal(routes, 2);
  assert.ok(result.elapsedMs <= 3_000);
  assert.equal(result.ends.find((end) => end.id === 9)?.firstSeen, "joined");
  assert.ok(Number.isFinite(result.ends.find((end) => end.id === 9)?.gained));
});

for (const shooter of [false, true]) test(shooter ? "a shooter's goal is remade after one block" : "the goal is remade only when a threat moved four blocks", async () => {
  const fixture = reachFixture({ shooter, distance: 9, budget: 1_000 });
  using _installed = fixture.clock.install();
  let ticks = 0;
  fixture.bot.on("physicsTick", () => {
    ticks++;
    if (shooter) { if (ticks === 6) fixture.bot.entities[7]!.position.x += 1; }
    else if (ticks <= 6) fixture.bot.entities[7]!.position.x += 0.5;
    else if (ticks === 7) fixture.bot.entities[7]!.position.x += 1;
  });
  assert.equal((await fixture.run()).goalRefreshes, 1);
});

test("the entry snapshot is taken before the loadout", async () => {
  const fixture = reachFixture({ budget: 3_000 });
  fixture.inventory.updateSlot(37, itemOf(fixture.bot.registry, "iron_sword", 1));
  fixture.server.onPacket("held_item_slot", () => { fixture.bot.entity.position.x = -2.5; });
  using _installed = fixture.clock.install();
  const result = await fixture.run();
  assert.deepEqual(result.startPosition, { x: 0.5, y: 64, z: 0.5 });
  assert.equal(result.ends[0]?.firstDistance, 17);
  assert.equal(result.ends[0]?.gained, 3);
});

/**
 * An evade of a `EVADE_BUDGET_MS` budget whose first route takes `ROUTE_MS` of the installed clock, steps the wall clock
 * by `wallStepMs` meanwhile and ends one cell further with the zombie still in contact. Returns the navigation
 * timeout the second route was given: what the budget still had left.
 */
async function secondRouteTimeoutAcrossWallStep(wallStepMs: number): Promise<number | undefined> {
  const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
  const { bot } = createFakeBot({ clock, entities: { [ZOMBIE]: { name: "zombie", position: new Vec3(2.5, 64, 0.5) } } });
  using _installed = clock.install();
  // Live the two clocks read unrelated values (uptime vs epoch): a budget started on the wrong one cannot pass.
  clock.stepWallClock(5_000);
  const timeouts: number[] = [];
  const navigation = {
    navigate: async ({ timeoutMs }: { timeoutMs?: number }) => {
      timeouts.push(timeoutMs ?? NaN);
      await clock.sleep(ROUTE_MS);
      if (timeouts.length === 1) clock.stepWallClock(wallStepMs);
      bot.entity.position.x -= 1;
      return { status: "completed" as const, elapsedMs: ROUTE_MS };
    },
  } as unknown as NavigationRuntime;
  const context = { ...combatTestContext(bot), policy: { ...DEFAULT_COMBAT_POLICY, evade_timeout_ms: EVADE_BUDGET_MS } };
  const threat = { id: ZOMBIE, name: "zombie", position: { x: 2.5, y: 64, z: 0.5 }, distance: 2 };
  await clock.settle(
    evade(bot, navigation, { kind: "evade", threats: [threat], safeRange: 36, reason: "hurt" }, context, bot.health, new AbortController().signal),
    EVADE_BUDGET_MS + 5_000,
  );
  return timeouts[1];
}

for (const wallStepMs of [-800, 1_200]) {
  test(`the evade budget counts monotonic time: a ${wallStepMs} ms wall step during the first route leaves 2000 ms`, async () => {
    assert.equal(await secondRouteTimeoutAcrossWallStep(wallStepMs), EVADE_BUDGET_MS - ROUTE_MS);
  });
}

/**
 * An evade whose settled body holds its shield against a fireball that never clears: the projectile guard ends at the
 * evade budget, though the wall clock steps by `wallStepMs` a second in. Returns the clock the evade ran.
 */
async function evadeGuardedUntilBudgetAcrossWallStep(wallStepMs: number): Promise<number> {
  const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
  const { bot, entities } = createFakeBot({
    clock,
    slots: { 45: { name: "shield" } },
    entities: { [ZOMBIE]: { name: "zombie", position: new Vec3(2.5, 64, 0.5) } },
  });
  using _installed = clock.install();
  clock.stepWallClock(5_000);
  entities.spawn({ id: 8, name: "small_fireball", width: 0.3125, position: new Vec3(4, 64.9, 0.5), velocity: new Vec3(-0.5, 0, 0) });
  clock.after(1_000, () => clock.stepWallClock(wallStepMs));
  const world = new MemoryWorld();
  for (let x = -6; x <= 6; x++)
    for (let z = -6; z <= 6; z++) {
      world.load({ x, y: 63, z }, { stateId: 1 });
      world.load({ x, y: 64, z }, { stateId: 0 });
      world.load({ x, y: 65, z }, { stateId: 0 });
    }
  const navigation = {
    world,
    navigate: async () => assert.fail("a settled body under fire guards before it routes"),
  } as unknown as NavigationRuntime;
  const context = { ...combatTestContext(bot), policy: { ...DEFAULT_COMBAT_POLICY, evade_timeout_ms: EVADE_BUDGET_MS } };
  const threat = { id: ZOMBIE, name: "zombie", position: { x: 2.5, y: 64, z: 0.5 }, distance: 2 };
  const started = clock.now();
  await clock.settle(
    evade(bot, navigation, { kind: "evade", threats: [threat], safeRange: 36, reason: "hurt" }, context, bot.health, new AbortController().signal),
    20_000,
  );
  return clock.now() - started;
}

for (const wallStepMs of [-800, 1_200]) {
  test(`the retreat guard ends at the evade budget: a ${wallStepMs} ms wall step during the guard leaves it at 3 s`, async () => {
    const ranMs = await evadeGuardedUntilBudgetAcrossWallStep(wallStepMs);
    assert.ok(ranMs >= EVADE_BUDGET_MS && ranMs < EVADE_BUDGET_MS + 200, `the evade ran ${ranMs} ms of clock, not its ${EVADE_BUDGET_MS} ms budget`);
  });
}
