import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createNavigationRuntime, createMovements, exactBlockGoal } from "../../navigation/index.js";
import { EMPTY_OVERLAY_IDENTITY } from "../../navigation/search/planning-overlay.js";
import type { NavigationRuntime } from "../../navigation/index.js";
import { combatTestContext } from "../../test-support/combat.js";
import { createFakeBot, createFakeClock, itemOf, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { observation } from "../../test-support/navigation.js";
import { completeResponse, describeResponse } from "../control/combat/settlement.js";
import { DEFAULT_COMBAT_POLICY } from "../policy/combat/contract.js";
import { evade } from "./evade.js";
import { EvadeObservation } from "./evade-observation.js";
import { EvadeClock } from "./evade-clock.js";
import { FIRE_LINE_PRICE_TICKS } from "./evade-fire-line.js";
import type { PolicyDecision } from "../../navigation/movements/policy.js";
import { CombatPerception } from "../perception/combat/observations.js";
import { arrowImpact, incomingShieldProjectiles } from "../perception/combat/shield-projectiles.js";
import { projectileContact } from "../positioning/combat/exposure.js";
import { RETREAT_PROJECTILE_ALLOWANCE, retreatGuardLimit } from "../weapons/projectile-guard.js";
import { swingReadiness } from "../weapons/swing-readiness.js";
import { ACROSS_THE_LINE, EVADE_BUDGET_MS, evadeWallMs, fireVerdict, firstRouteAnswers, judgements, leavesNothing, reachFixture, ROUTE_MS, SLANT_OFF_SECOND, STRAIGHT_AWAY, walkAnswer, ZOMBIE } from "./evade-fixture.test.js";

for (const ticksPerSecond of [20, 10]) {
  test(`a hidden shooter under the cover range does not hold the body at ${ticksPerSecond} tps`, async () => {
    const fixture = reachFixture({ shooter: true, distance: 6.7, cover: true, ticksPerSecond });
    using _timers = fixture.clock.install();
    const nothingLeft = leavesNothing(fixture);
    let routes = 0;
    let refreshedAt = Infinity;
    const age = fixture.bot.time.age;
    fixture.navigation.navigate = async () => {
      if (++routes === 2) {
        refreshedAt = fixture.bot.time.age - age;
        fixture.bot.entities[7]!.position.x = 80;
      }
      return { status: "completed", elapsedMs: 0 };
    };
    const result = await fixture.run();
    assert.ok(result.goalRefreshes >= 1, "the under-range cover stop refreshes its goal");
    assert.ok(refreshedAt < 60, `refreshed at ${refreshedAt} world ticks`);
    assert.ok(result.elapsedTicks! < 300, `elapsed ${result.elapsedTicks} ticks`);
    await nothingLeft();
  });

  for (const change of ["none", "visible", "joined"] as const)
  test(`${change === "none" ? "a hidden still shooter at 9 blocks holds until cover" : change === "visible" ? "a shooter becoming visible leaves the wait" : "a joined visible shooter ends the wait"} at ${ticksPerSecond} tps`, async () => {
    const fixture = reachFixture({ shooter: true, distance: 9, cover: true, ticksPerSecond });
    using _timers = fixture.clock.install();
    const nothingLeft = leavesNothing(fixture);
    const start = fixture.server.gameTime;
    let routes = 0;
    let released = Infinity;
    fixture.navigation.navigate = async () => {
      if (++routes === 2) {
        released = fixture.server.gameTime - start;
        fixture.bot.entity.position.x = -40.5;
      }
      return { status: "completed", elapsedMs: 0 };
    };
    const stopChanging = fixture.server.onTick(() => {
      if (fixture.server.gameTime - start !== 10) return;
      if (change === "visible") fixture.wall(false);
      if (change === "joined") {
        const shooter = fixture.entities.spawn({ id: 9, name: "skeleton", position: new Vec3(0.5, 64, 6.5) });
        shooter.equipment[0] = itemOf(fixture.bot.registry, "bow");
      }
    });
    const result = await fixture.run();
    stopChanging();
    assert.equal(result.result.kind, "separated");
    if (change === "none") {
      assert.equal(routes, 1, "no arrow: the wait holds without another route");
      assert.equal(result.goalRefreshes, 0);
      assert.equal(result.ends[0]?.basis, "cover");
      assert.equal(result.elapsedTicks, 40);
    } else assert.ok(released >= 10 && released <= 30, `wait released at ${released} ticks`);
    await nothingLeft();
    if (change === "none") {
      fixture.navigation.navigate = async () => {
        fixture.bot.entity.position.x = -30.5;
        return { status: "completed", elapsedMs: 0 };
      };
      assert.equal((await fixture.run()).result.kind, "separated", "the next escape must be able to leave the held cover");
      assert.equal(fixture.bot.entity.position.x, -30.5);
    }
  });
}

type ArrowEscapeMode = "arrival" | "mid-wait" | "limited" | "shield" | "cancel" | "reached";

/** All unshielded stops must refuse contact and move before impact; cancellation must hand back. */
function assertEscapeResult(result: Awaited<ReturnType<typeof evade>>, mode: ArrowEscapeMode,
  danger: { refused: boolean; movedAt: number; impactAt: number }, signal: AbortSignal) {
  if (mode === "cancel") {
    assert.equal(result.result.kind, "failed");
    assert.equal(completeResponse(result, signal).kind, "cancelled");
    return;
  }
  if (mode === "shield") {
    assert.equal(result.result.kind, "separated", JSON.stringify(result.result));
    assert.equal(result.projectileGuards, 1);
    return;
  }
  assert.equal(danger.refused, true, "the next goal refuses the arrow's contact cell");
  assert.ok(danger.movedAt < danger.impactAt, `moved at ${danger.movedAt}, predicted impact at ${danger.impactAt}`);
  assert.equal(result.projectileGuards, 0);
  assert.equal(result.result.kind, "separated", JSON.stringify(result.result));
}

/** Real movement after a one-step cover arrival, with an arrow passing the wall's edge along z. */
async function settledArrowEscape(ticksPerSecond: number, mode: ArrowEscapeMode) {
  const harness = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), simulatePhysics: true,
    server: { ticksPerSecond }, position: new Vec3(0.5, 64, -0.5), groundY: 63,
    slots: mode === "limited" || mode === "shield" ? { 45: { name: "shield" } } : undefined,
    entities: { 7: { name: "skeleton", position: new Vec3(9.5, 64, 0.5) } } });
  using _timers = harness.clock.install();
  const { bot, clock, server, entities, world } = harness;
  bot.entities[7]!.equipment[0] = itemOf(bot.registry, "bow");
  for (let y = 64; y <= 67; y++) for (let z = -2; z <= 2; z++) world.setCell(new Vec3(4, y, z), "stone");
  using perception = new CombatPerception(bot);
  swingReadiness(bot);
  const added = listenersAddedSince(bot), packets = listenersAddedSince(bot._client);
  const globalTimers = clock.pendingGlobalTimers();
  const context = { ...combatTestContext(bot), perception, policy: { ...DEFAULT_COMBAT_POLICY, melee: false } };
  const navigation = createNavigationRuntime(bot);
  const cancel = new AbortController();
  const navigate = navigation.navigate.bind(navigation);
  let routes = 0, refused = false, movedAt = Infinity, impactAt = Infinity, spawnAt = Infinity;
  let arrival = bot.entity.position.clone();
  let arrow: typeof bot.entity | undefined;
  const spawn = () => {
    spawnAt = server.gameTime;
    arrow = entities.spawn({ id: 8, name: "arrow", position: arrival.offset(0, 6, 8), velocity: new Vec3(0, 0, -0.5) });
    assert.equal(projectileContact(bot.world, arrow, bot.entity), null, "the raw ray misses above the body");
    const impact = arrowImpact(bot, arrow)!;
    assert.ok(impact, "the retained curved flight hits the body");
    impactAt = spawnAt + impact.ticks;
    assert.ok(incomingShieldProjectiles(bot, RETREAT_PROJECTILE_ALLOWANCE).includes(arrow));
    if (mode === "limited") {
      bot.health = context.policy.critical_health - 1;
      assert.ok(retreatGuardLimit(bot, context.policy));
    }
  };
  const stopWatching = server.onTick(() => {
    if (movedAt === Infinity && arrow && bot.entity.position.distanceTo(arrival) >= 1) movedAt = server.gameTime;
    if (mode === "shield" && arrow?.isValid && server.gameTime >= spawnAt + 10) entities.remove(arrow.id);
  });
  const routed: NavigationRuntime = { ...navigation, navigate: async (options) => {
    // The evade clock already owns stopSignal; omit navigation's independent, uncancellable timeoutSignal timer.
    const { timeoutMs: _timeout, ...routeOptions } = options;
    if (++routes === 1) {
      const route = await navigate({ ...routeOptions, goal: exactBlockGoal({ x: mode === "reached" ? -30 : 0, y: 64, z: 0 }) });
      assert.equal(route.status, mode === "reached" ? "stopped" : "completed", JSON.stringify(route));
      if (mode === "reached") assert.ok(options.stopSignal?.aborted, "reach settled the ongoing route");
      arrival = bot.entity.position.clone();
      if (mode === "mid-wait") clock.after(5_000 / ticksPerSecond, spawn);
      else if (mode === "cancel") clock.after(5_000 / ticksPerSecond, () => cancel.abort(new Error("cancel cover wait")));
      else if (mode !== "shield") spawn();
      return route;
    }
    const resolved = options.goal.resolve({ ...observation(), position: bot.entity.position });
    assert.equal(resolved.kind, "active");
    if (resolved.kind === "active") refused = !resolved.isSatisfied({ feet: arrival.floored(),
      remainingScaffolds: 0, overlayId: EMPTY_OVERLAY_IDENTITY }, navigation.world);
    return navigate(routeOptions);
  } };
  if (mode === "shield") spawn();
  try {
    const result = await clock.settle(evade(bot, routed, { kind: "evade", safeRange: 36, reason: "hurt",
      threats: [{ id: 7, name: "skeleton", position: { x: 9.5, y: 64, z: 0.5 }, distance: 9 }] }, context, 20,
    cancel.signal), evadeWallMs(15_000) + 1_000);
    assertEscapeResult(result, mode, { refused, movedAt, impactAt }, cancel.signal);
    if (arrow?.isValid) entities.remove(arrow.id);
    const next = await clock.settle(navigate({ movements: createMovements(bot),
      goal: exactBlockGoal({ x: -2, y: 64, z: 0 }) }), 10_000);
    assert.equal(next.status, "completed", JSON.stringify(next));
  } finally {
    stopWatching();
    if (arrow?.isValid) entities.remove(arrow.id);
    await clock.settle(navigation.close(), 5_000);
  }
  for (const event of ["time", "physicsTick", "entityDead"]) assert.equal(added(event), 0, event);
  assert.equal(packets("explosion"), 0);
  assert.equal(clock.pendingTimers(), 0);
  assert.equal(clock.pendingGlobalTimers(), globalTimers);
  await clock.advance(evadeWallMs(15_000) + 1_000);
  assert.equal(clock.pendingTimers(), 0);
  assert.equal(clock.pendingGlobalTimers(), globalTimers);
}

for (const ticksPerSecond of [20, 10]) for (const mode of ["arrival", "mid-wait", "limited", "shield", "cancel", "reached"] as const) {
  const name = { arrival: "an incoming arrow at route arrival with no shield moves and refuses its contact cell",
    "mid-wait": "an incoming arrow mid-wait with no shield moves", limited: "the guard limit reached behaves as no shield",
    shield: "an incoming arrow with a shield guards", cancel: "a cancel during the wait settles once and the next navigate runs",
    reached: "an incoming arrow after a reached stop refuses the settled cell" }[mode];
  test(`${name} at ${ticksPerSecond} tps`, () => settledArrowEscape(ticksPerSecond, mode));
}

for (const ticksPerSecond of [20, 10]) for (const end of ["passed", "removed"] as const)
test(`a ${end} arrow clears the veto at ${ticksPerSecond} tps`, async () => {
  const fixture = reachFixture({ shooter: true, distance: 9, cover: true, ticksPerSecond });
  using _timers = fixture.clock.install();
  for (let y = 64; y <= 67; y++) for (let z = -2; z <= 2; z++)
    fixture.navigation.world.load({ x: 4, y, z }, { stateId: 1 });
  using clock = new EvadeClock(fixture.bot, 300);
  const observed = new EvadeObservation(fixture.bot, fixture.context, fixture.request.threats, 36, clock);
  const arrow = fixture.entities.spawn({ id: 8, name: "arrow", position: new Vec3(0.5, 70, 8.5), velocity: new Vec3(0, 0, -0.5) });
  const resolve = () => {
    const goal = observed.goal.resolve({ ...observation(), position: fixture.bot.entity.position });
    assert.equal(goal.kind, "active");
    if (goal.kind !== "active") throw new Error("inactive evade goal");
    return goal;
  };
  const node = { feet: { x: 0, y: 64, z: 0 }, remainingScaffolds: 0, overlayId: EMPTY_OVERLAY_IDENTITY };
  assert.equal(resolve().isSatisfied(node, fixture.navigation.world), true);
  observed.refuseTrajectories([arrow]);
  const refused = resolve();
  assert.equal(refused.isSatisfied(node, fixture.navigation.world), false);
  observed.observe();
  assert.equal(resolve().revision, refused.revision, "an unchanged veto keeps its revision");
  if (end === "removed") fixture.entities.remove(arrow.id);
  else {
    arrow.position.set(0.5, 65, -3);
    arrow.velocity.set(0, 0, -0.5);
    fixture.bot._client.emit("sync_entity_position", { entityId: arrow.id });
  }
  observed.observe();
  const cleared = resolve();
  assert.notEqual(cleared.revision, refused.revision);
  assert.equal(cleared.isSatisfied(node, fixture.navigation.world), true);
});

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
    // A stopped server's age is unknown 30 ticks of its own cadence after the last packet (1 500 ms at 20 tps, 3 000 at 10): look 500 ms past it.
    }), fixture.clock.after((mode === "stale" ? 40 * tickMs + 100 + 30 * tickMs + 500 : 100 * tickMs + 100), capture)];
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
  const nothingLeft = leavesNothing(fixture);
  const result = await fixture.run();
  assert.equal(result.result.kind, "separated");
  assert.equal(result.ends[0]?.basis, "disengaged");
  const receipt = describeResponse(completeResponse(result, new AbortController().signal)) as Record<string, unknown>;
  assert.equal(receipt.elapsedMs, 2_000);
  assert.equal(receipt.elapsedTicks, 40, "the receipt of the on-foot evade carries the ticks it spent");
  assert.equal(result.elapsedTicks, 40);
  console.log("T6 sample receipt", JSON.stringify(receipt));
  // The early stop must release its listeners and the clock's wall timer so the next escape can own the body.
  await nothingLeft();
  fixture.bot.entities[7]!.position.x = 40.5;
  assert.equal((await fixture.run()).result.kind, "separated");
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

// The shot window counts world ticks of the age the bot heard (40 of them), not client ticks: at 10 tps 40 client ticks
// are 20 server ticks, so a shooter between two shots read "no shot in the window" a second too early.
for (const ticksPerSecond of [20, 10]) {
  test(`a still shooter between shots keeps its window for 40 world ticks at ${ticksPerSecond} tps`, async () => {
    const fixture = reachFixture({ shooter: true, distance: 17, ticksPerSecond });
    using _installed = fixture.clock.install();
    fixture.clock.after(1_000, () => fixture.combat.shootBot("arrow", 7, 1));
    let shotAge: number | null = null;
    // The arrow has landed by 2.5 s: its hit is the last shot, at the age heard then.
    fixture.clock.after(2_500, () => { shotAge = fixture.context.perception.read().find((threat) => threat.id === 7)?.lastShotAge ?? null; });
    const { value: result, judged } = await judgements(fixture, () => fixture.run());
    assert.equal(fixture.bot.health, 19, "the attributed shot landed");
    assert.ok(shotAge !== null, "the shot has an age");
    const afterShot = judged.filter(({ at }) => at >= 2_500);
    const inWindow = afterShot.filter(({ age }) => age <= shotAge! + 40);
    assert.ok(inWindow.length > 0, "looks inside the window");
    assert.deepEqual(inWindow.filter(({ basis }) => basis !== null), [], "no basis up to 40 world ticks after the shot");
    const first = afterShot.find(({ basis }) => basis !== null)!;
    assert.equal(first.basis, "disengaged");
    assert.ok(first.age > shotAge! + 40 && first.age <= shotAge! + 40 + 20, `first basis at age ${first.age}, shot at ${shotAge}`);
    assert.equal(result.result.kind, "separated");
  });
}

for (const ticksPerSecond of [20, 10]) for (const abort of [false, true]) test(`a cover wait releases its listeners when ${abort ? "cancelled" : "physics and the server stop until the 3x wall"} at ${ticksPerSecond} tps`, async () => {
  const fixture = reachFixture({ shooter: true, distance: 9, cover: true, budget: 3_000, ticksPerSecond });
  using _installed = fixture.clock.install();
  const nothingLeft = leavesNothing(fixture);
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
  assert.equal(result.elapsedMs, abort ? 500 : evadeWallMs(3_000));
  assert.equal(fixture.bot.listenerCount("physicsTick"), listeners);
  assert.equal(fixture.clock.pendingTimers(), 0);
  assert.equal(result.elapsedTicks, 0);
  await nothingLeft();
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
    evadeWallMs(EVADE_BUDGET_MS) + 1_000,
  );
  return timeouts[1];
}

// The route's timeout is the evade clock's wall left (3x the budget's game time), read on the monotonic clock.
for (const wallStepMs of [-800, 1_200]) {
  test(`the evade wall counts monotonic time: a ${wallStepMs} ms wall step during the first route leaves 8000 ms of the 9000 ms wall`, async () => {
    assert.equal(await secondRouteTimeoutAcrossWallStep(wallStepMs), evadeWallMs(EVADE_BUDGET_MS) - ROUTE_MS);
  });
}

// T16b: the evade's route pays the line-of-fire price on the steps that run straight away from a bow shooter (the shooter
// is the observation's `attack: "projectile"`; the walks and the answer helpers are in `evade-fixture.test.ts`).
test("a bow skeleton prices a walk straight away from it and leaves a walk across its line unpriced", async () => {
  const fixture = reachFixture({ shooter: true, distance: 9 });
  using _installed = fixture.clock.install();
  const nothingLeft = leavesNothing(fixture);
  const [away, across] = await firstRouteAnswers(fixture, [STRAIGHT_AWAY, ACROSS_THE_LINE]);
  assert.equal(fireVerdict(away!), "line_of_fire");
  assert.equal(away!.kind === "penalized" ? away!.cost : 0, FIRE_LINE_PRICE_TICKS);
  assert.equal(fireVerdict(across!), "allowed");
  await nothingLeft();
});

for (const exit of [
  { how: "dies", leave: (fixture: ReturnType<typeof reachFixture>) => fixture.bot.emit("entityDead", fixture.bot.entities[7]!) },
  { how: "is out of view", leave: (fixture: ReturnType<typeof reachFixture>) => fixture.entities.remove(7) },
]) test(`a bow skeleton that ${exit.how} mid-route stops pricing at the next answer`, async () => {
  const fixture = reachFixture({ shooter: true, distance: 9 });
  using _installed = fixture.clock.install();
  const nothingLeft = leavesNothing(fixture);
  const navigate = fixture.navigation.navigate;
  const answers: string[] = [];
  fixture.navigation.navigate = async (options) => {
    answers.push(fireVerdict(walkAnswer(options.movements, STRAIGHT_AWAY)));
    // The next answer is asked in the same turn as the event: a death ends the route as separated at once.
    fixture.clock.after(500, () => {
      exit.leave(fixture);
      answers.push(fireVerdict(walkAnswer(options.movements, STRAIGHT_AWAY)));
    });
    return navigate(options);
  };
  await fixture.run();
  assert.deepEqual(answers, ["line_of_fire", "allowed"]);
  await nothingLeft();
});

for (const melee of [{ threat: "a skeleton with a sword", shooter: true }, { threat: "a zombie", shooter: false }]) test(`${melee.threat} is melee to the price: no walk is priced`, async () => {
  const fixture = reachFixture({ shooter: melee.shooter, distance: 9 });
  if (melee.shooter) fixture.bot.entities[7]!.equipment[0] = itemOf(fixture.bot.registry, "iron_sword", 1);
  using _installed = fixture.clock.install();
  const [away, across] = await firstRouteAnswers(fixture, [STRAIGHT_AWAY, ACROSS_THE_LINE]);
  assert.equal(fireVerdict(away!), "allowed");
  assert.equal(fireVerdict(across!), "allowed");
});

test("two bow skeletons price a walk straight away from each one, and a walk off both lines once", async () => {
  const fixture = reachFixture({ shooter: true, distance: 9 });
  const second = fixture.entities.spawn({ id: 9, name: "skeleton", position: new Vec3(9.5, 64, 2.5) });
  second.equipment[0] = itemOf(fixture.bot.registry, "bow", 1);
  fixture.request.threats.push({ id: 9, name: "skeleton", position: { x: 9.5, y: 64, z: 2.5 }, distance: 9.2 });
  using _installed = fixture.clock.install();
  const [both, slant] = await firstRouteAnswers(fixture, [STRAIGHT_AWAY, SLANT_OFF_SECOND]);
  assert.equal(both!.kind === "penalized" ? both!.cost : 0, FIRE_LINE_PRICE_TICKS, "priced once, not once per shooter");
  assert.equal(fireVerdict(both!), "line_of_fire");
  assert.equal(fireVerdict(slant!), "line_of_fire", "the second skeleton's line prices a walk the first does not");
});

for (const ticksPerSecond of [20, 10]) test(`a priced evade route ends separated or exhausted at ${ticksPerSecond} tps`, async () => {
  const fixture = reachFixture({ shooter: true, distance: 9, budget: 3_000, ticksPerSecond });
  using _installed = fixture.clock.install();
  const nothingLeft = leavesNothing(fixture);
  const navigate = fixture.navigation.navigate;
  let away: PolicyDecision | undefined;
  fixture.navigation.navigate = async (options) => {
    away ??= walkAnswer(options.movements, STRAIGHT_AWAY);
    fixture.bot.entity.position.x = -40.5;
    return navigate(options);
  };
  const result = await fixture.run();
  assert.equal(fireVerdict(away!), "line_of_fire");
  assert.ok(["separated", "exhausted"].includes(result.result.kind), JSON.stringify(result.result));
  await nothingLeft();
});

