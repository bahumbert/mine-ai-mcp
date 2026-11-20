import { exactBlockGoal } from "./goals/index.js";
import { excavateGoal } from "./goals/excavate.js";
import type { Goal } from "./goals/goal.js";
import type { BlockPosition } from "./world/world.js";
import { createMovementPolicy } from "./movements/policy.js";
import { RouteOutcomes } from "./route-outcomes.js";
import { createNavigationRuntime } from "./runtime.js";
import { installNativeDigClock } from "./mineflayer/native-dig-clock.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeClock, createFakeBot, createFakeClock } from "../test-support/fake-bot/index.js";
import { useNativeDigging } from "../test-support/fake-bot/native-digging.js";
import { DEFAULT_NAVIGATION_POLICY } from "../survival/policy/contract.js";
import { setNavigationPolicyProvider } from "../survival/state/navigation-policy.js";

/** Finish the navigation request when excavation has actually cleared its target. */
function clearedTargetGoal(target: BlockPosition): Goal {
  return { resolve: (observation) => {
    const goal = excavateGoal(target).resolve(observation);
    return goal.kind === "invalid" ? goal : { ...goal, isSatisfied: (_node, world) => {
      const block = world.blockAt(target.x, target.y, target.z);
      return block.kind === "loaded" && block.traits.empty;
    } };
  } };
}

test("stationary non-floor excavation leaves an edge pose from which the next safe navigate completes", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot } = createFakeBot({ clock, simulatePhysics: true, position: new Vec3(0.85, 63, 0.5),
    groundY: 62, cells: { "0,62,0": "air", "2,64,0": "dirt" } });
  const navigation = createNavigationRuntime(bot);
  const trace: string[] = [];
  navigation.onEvent((event) => trace.push(`${event.kind} ${bot.entity.position}`));
  try {
    const result = await clock.settle(navigation.navigate({ movements: createMovementPolicy({
      decideStep: () => ({ kind: "prohibited", reason: "exercise stationary completion" }),
    }), goal: clearedTargetGoal({ x: 2, y: 64, z: 0 }) }), 20_000)
      .catch((error) => { throw new Error(`${error}\n${trace.join("\n")}`); });
    assert.equal(result.status, "completed", `${JSON.stringify(result)}\n${trace.join("\n")}`);
    assert.equal(bot.blockAt(new Vec3(2, 64, 0))?.name, "air");
    assert.ok(bot.entity.position.x > 0.7 && bot.entity.position.x < 1, `${bot.entity.position}\n${trace.join("\n")}`);
    assert.equal(bot.entity.position.y, 63);
    const next = await tickUntilSettled(clock, navigation.navigate({ movements: createMovementPolicy(),
      goal: exactBlockGoal({ x: 2, y: 63, z: 0 }) }));
    assert.equal(next.status, "completed", JSON.stringify(next));
  } finally { await tickUntilSettled(clock, navigation.close()); }
});

test("same-node change in priced reach uses live aim before crediting a break", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot } = createFakeBot({ clock, simulatePhysics: true, position: new Vec3(0.85, 63, 0.5),
    groundY: 62, cells: { "5,63,0": "dirt" } });
  const navigation = createNavigationRuntime(bot);
  let moved = false;
  const swingAt: number[] = [];
  const dig = bot.dig.bind(bot);
  bot.dig = (block, ...rest) => { swingAt.push(bot.entity.position.x); return dig(block, ...rest); };
  navigation.onEvent((event) => {
    if (event.kind === "search_slice" && !moved) { moved = true; bot.entity.position.x = 0.5; }
  });
  try {
    const result = await tickUntilSettled(clock, navigation.navigate({ movements: createMovementPolicy({
      digTimeEstimator: { estimate: () => 1 },
    }), goal: clearedTargetGoal({ x: 5, y: 63, z: 0 }) }));
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(swingAt.length, 1);
    assert.equal(swingAt[0], 0.5, "the live target face is still reachable from the moved body");
    assert.equal(bot.blockAt(new Vec3(5, 63, 0))?.name, "air");
  } finally { bot.dig = dig; await tickUntilSettled(clock, navigation.close()); }
});

test("same-node motion during a search refuses an unsafe swing then replans to safe mining", async () => {
  for (const towardEdge of [true, false]) {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot } = createFakeBot({ clock, simulatePhysics: true,
      position: new Vec3(0.85, 63, towardEdge ? 0.85 : 0.5), groundY: 62,
      cells: { "0,62,0": "air", "0,62,1": "air", "1,62,0": "dirt" } });
    const navigation = createNavigationRuntime(bot);
    let moved = false;
    let refused = false;
    const trace: string[] = [];
    const swingAt: Vec3[] = [];
    const dig = bot.dig.bind(bot);
    bot.dig = async (block, ...rest) => {
      if (block.position.equals(new Vec3(1, 62, 0))) {
        const at = bot.entity.position.clone();
        assert.ok(at.y !== 63 || Math.floor(at.x) === 1 || bot.blockAt(new Vec3(Math.floor(at.x), 62, Math.floor(at.z)))?.name !== "air",
          `unsafe target swing from ${at}`);
        swingAt.push(at);
      }
      return dig(block, ...rest);
    };
    navigation.onEvent((event) => {
      trace.push(`${event.kind} ${bot.entity.position}${event.kind === "step_failed" ? ` ${event.observation}` : ""}`);
      if (event.kind === "search_slice" && !moved) {
        moved = true;
        bot.entity.position.z = towardEdge ? 0.5 : 0.85;
      }
      if (event.kind === "search_started" && event.reason === "world_changed") refused = true;
    });
    try {
      const result = await tickUntilSettled(clock, navigation.navigate({ movements: createMovementPolicy({ maximumDrop: 0,
        digTimeEstimator: { estimate: () => 1 },
      }),
        goal: clearedTargetGoal({ x: 1, y: 62, z: 0 }) }));
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.equal(moved, true);
      assert.equal(swingAt.length, 1);
      assert.equal(bot.blockAt(new Vec3(1, 62, 0))?.name, "air");
      if (towardEdge) assert.equal(refused, true, `the previously admitted terminal must be invalidated live\n${trace.join("\n")}`);
    } finally { bot.dig = dig; await tickUntilSettled(clock, navigation.close()); }
  }
});

test("a foreground cover report leaves the tunnel route unchanged, tracks its step after policy disable, and excludes policy-off/reflex runs", async () => {
  const runs: { steps: unknown[]; at: Vec3 }[] = [];
  for (const [enabled, foreground, disableAfterCommit] of [[false, true], [true, true], [true, false], [true, true, true]]) {
    const clock = createFakeClock({ mode: "manual" });
    // Full-cube stone and fake physics use the shared registry; the real tunnel is also run in report-open-sky.yaml.
    const cells = Object.fromEntries(Array.from({ length: 4 }, (_, x) => [`${x},66,0`, "stone"]));
    const { bot } = createFakeBot({ clock, cells, groundY: 63, simulatePhysics: true });
    let reportEnabled = enabled!;
    setNavigationPolicyProvider(bot, () => ({ ...DEFAULT_NAVIGATION_POLICY, report_open_sky: reportEnabled }));
    const navigation = createNavigationRuntime(bot, { foreground: () => foreground! });
    const steps: unknown[] = [];
    navigation.onEvent((event) => {
      if (event.kind === "route_committed") {
        steps.push(...event.plan.steps.map(({ to }) => to));
        assert.deepEqual(navigation.coverExit()?.at ?? null, enabled && foreground ? { x: 4, y: 64, z: 0 } : null);
        if (enabled && foreground) assert.equal(navigation.coverExit()?.reached, false);
        if (disableAfterCommit) reportEnabled = false;
      }
      if (event.kind === "step_started" && enabled && foreground && navigation.coverExit()?.reached) {
        assert.deepEqual(navigation.coverExit()?.at, { x: 4, y: 64, z: 0 });
      }
    });
    try {
      const result = await tickUntilSettled(clock, navigation.navigate({
        movements: createMovementPolicy({ allowDigging: false, allowParkour: false }),
        goal: exactBlockGoal({ x: 6, y: 64, z: 0 }),
      }));
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.equal(navigation.coverExit()?.reached ?? null, enabled && foreground ? true : null);
      runs.push({ steps, at: bot.entity.position.clone() });
      navigation.clearCoverExit();
      assert.equal(navigation.coverExit(), null, "a new foreground action clears the previous report");
    } finally { await navigation.close(); }
  }
  assert.deepEqual(runs[1], runs[0]);
  assert.deepEqual(runs[2], runs[0]);
  assert.deepEqual(runs[3], runs[0]);
});

test("a later committed segment reports its own exit, and starting the exit step marks it reached", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const cells = Object.fromEntries(Array.from({ length: 4 }, (_, x) => [`${x},66,0`, "stone"]));
  const { bot } = createFakeBot({ clock, cells, groundY: 63, simulatePhysics: true });
  setNavigationPolicyProvider(bot, () => ({ ...DEFAULT_NAVIGATION_POLICY, report_open_sky: true }));
  const navigation = createNavigationRuntime(bot, { foreground: () => true });
  let goal = exactBlockGoal({ x: 2, y: 64, z: 0 });
  let commits = 0;
  let exitId: string | undefined;
  let reachedExit = false;
  navigation.onEvent((event) => {
    if (event.kind === "route_committed") {
      commits++;
      if (commits === 1) assert.equal(navigation.coverExit(), null);
      else {
        exitId = event.plan.steps.find(({ to }) => to.x === 4)?.id;
        assert.deepEqual(navigation.coverExit()?.at, { x: 4, y: 64, z: 0 });
        assert.equal(navigation.coverExit()?.reached, false);
      }
    } else if (event.kind === "step_started" && event.stepId === exitId) {
      reachedExit = true;
      assert.equal(navigation.coverExit()?.reached, true);
    }
  });
  try {
    const result = await tickUntilSettled(clock, navigation.navigate({
      movements: createMovementPolicy({ allowDigging: false, allowParkour: false }),
      goal: { resolve: (observation) => goal.resolve(observation) },
      onArrival: () => {
        if (commits > 1) return { kind: "completed" };
        goal = exactBlockGoal({ x: 6, y: 64, z: 0 });
        return { kind: "continue" };
      },
    }));
    assert.equal(result.status, "completed");
    assert.equal(commits, 2);
    assert.equal(reachedExit, true);
  } finally { await navigation.close(); }
});

test("a verified underwater dive never reports its open-sky destinations", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const cells: Record<string, string> = {};
  for (let x = -2; x <= 8; x++) for (let z = -2; z <= 2; z++)
    for (let y = 64; y <= 67; y++) cells[`${x},${y},${z}`] = "water";
  // Air metadata mirrors contract air-supply-under-water; the existing dive fixture uses the same shared breath API.
  const { bot, breath } = createFakeBot({ clock, cells, groundY: 63 });
  breath.setAirSupply(300);
  setNavigationPolicyProvider(bot, () => ({ ...DEFAULT_NAVIGATION_POLICY, report_open_sky: true }));
  const navigation = createNavigationRuntime(bot, { foreground: () => true });
  const stop = new AbortController();
  let committed = false;
  navigation.onEvent((event) => {
    if (event.kind !== "route_committed") return;
    committed = true;
    assert.notEqual(navigation.diveBackstop?.(), null);
    assert.equal(navigation.coverExit(), null);
    stop.abort("dive observed; execution covered by dive scenarios");
  });
  try {
    await tickUntilSettled(clock, navigation.navigate({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 3, y: 64, z: 0 }), stopSignal: stop.signal }));
    assert.equal(committed, true);
  } finally { await tickUntilSettled(clock, navigation.close()); }
});

/** Moves the clock, and with it the fake physics ticks, until `work` settles. */
async function tickUntilSettled<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
  let settled = false;
  work.then(() => { settled = true; }, () => { settled = true; });
  for (let slice = 0; slice < 400 && !settled; slice += 1) await clock.advance(50);
  return work;
}

test("builds and closes one navigation runtime for a bot", async () => {
  const { bot } = createFakeBot();
  // The fake bot's own plugins listen too: the runtime is counted against what was there.
  const [deaths, ends, physicsListeners] = (["death", "end", "physicsTick"] as const).map((event) => bot.listenerCount(event));

  const navigation = createNavigationRuntime(bot);
  assert.equal(navigation.active, false);
  assert.equal(bot.listenerCount("death"), deaths! + 1);
  assert.equal(bot.listenerCount("end"), ends! + 1);
  assert.equal(bot.listenerCount("physicsTick"), physicsListeners! + 1);

  await navigation.close();
  assert.equal(bot.listenerCount("death"), deaths);
  assert.equal(bot.listenerCount("end"), ends);
  assert.equal(bot.listenerCount("physicsTick"), physicsListeners);
  // A closed runtime is spent: there is no registry to look a live one up in.
  await assert.rejects(navigation.navigate({} as never), /closed/);
});

test("navigation uses observed perched-cloud clearance", async () => {
  const { registry } = createFakeBot().bot;
  const metadata: unknown[] = [];
  const keys = registry.entitiesByName.area_effect_cloud!.metadataKeys;
  assert.ok(keys);
  metadata[keys.indexOf("particle")] = { type: "dragon_breath" };
  metadata[keys.indexOf("radius")] = 5;
  // Stone at and below y 61 stands for the island's end stone: both are full cubes.
  const { bot } = createFakeBot({
    position: new Vec3(-2.5, 62, 1.5),
    groundY: 61,
    entities: { 564: { name: "area_effect_cloud", position: new Vec3(-0.8084108410180761, 63, 8.551320364546644), metadata } },
  });
  const navigation = createNavigationRuntime(bot);
  const stop = new AbortController();
  let plans = 0;
  navigation.onEvent((event) => {
    if (event.kind === "route_committed") {
      plans++;
      stop.abort("Route observed; execution is covered by the native scenario");
    }
  });
  try {
    await navigation.navigate({
      movements: createMovementPolicy({ allowDigging: false, allowParkour: false }),
      goal: exactBlockGoal({ x: -3, y: 62, z: 3 }),
      stopSignal: stop.signal,
    });
    assert.equal(plans, 1, "The goal is outside the native radius and has an unobstructed approach");
  } finally {
    await navigation.close();
  }
});

/** A flat stone floor at y 63 and a route along it that waits on physics ticks the test does not send. */
function waitingRoute(releaseWaitMs?: number, clock?: FakeClock) {
  const { bot } = createFakeBot({ groundY: 63, clock });
  const navigation = createNavigationRuntime(bot, releaseWaitMs === undefined ? {} : { releaseWaitMs });
  const committed = new Promise<void>((resolve) => {
    const stop = navigation.onEvent((event) => {
      if (event.kind === "route_committed") {
        stop();
        resolve();
      }
    });
  });
  const movements = createMovementPolicy({ allowDigging: false, allowParkour: false });
  const goal = exactBlockGoal({ x: 6, y: 64, z: 0 });
  return { bot, clock: clock ?? createFakeClock({ mode: "manual" }), navigation, committed, movements, goal };
}

// Run 14b: a stalled navigate waited for a tick for good and kept the one navigation slot: every later route was
// refused "Navigation is busy with another request" (172 times) until the run ended.
test("a navigate cancelled while it waits for a tick that never comes frees the navigation for the next one within a bound", async () => {
  // The release bound runs on the global setTimeout and the bound below on performance.now: both on the mocked clock.
  const { bot, clock, navigation, movements, goal } = waitingRoute(300, createFakeClock({ mode: "mocked" }));
  using _timers = clock.install();
  let routes = 0;
  let secondCommitted!: () => void;
  const second = new Promise<void>((resolve) => { secondCommitted = resolve; });
  let firstCommitted!: () => void;
  const first = new Promise<void>((resolve) => { firstCommitted = resolve; });
  navigation.onEvent((event) => {
    if (event.kind !== "route_committed") return;
    routes += 1;
    (routes === 1 ? firstCommitted : secondCommitted)();
  });
  const owner = new AbortController();
  navigation.navigate({ movements, goal, signal: owner.signal }).catch(() => undefined);
  await first;
  // The stall stops the owning action; the next action's preparation cancels the route.
  owner.abort(new Error("[RUNTIME_PHYSICS_STALLED] navigate owned the body for 30 s with no physics tick"));
  navigation.cancel("foreground action preparation");
  const stop = new AbortController();
  // No physics tick comes: only the release bound can free the navigation for the next route.
  bot.physicsEnabled = false;
  const started = performance.now();
  const next = navigation.navigate({ movements, goal: exactBlockGoal({ x: -6, y: 64, z: 0 }), stopSignal: stop.signal });
  const freed = Promise.race([second, next.then(() => undefined)]);
  await clock.advance(400);
  await freed;
  assert.equal(routes, 2, "the next route was planned and committed, not refused busy");
  assert.ok(performance.now() - started < 2_000, "within the bounded wait");
  // Physics back: the new route ends at its stop, and the abandoned one, aborted, settles too.
  bot.physicsEnabled = true;
  stop.abort("test over");
  assert.equal((await tickUntilSettled(clock, next)).status, "stopped");
  await tickUntilSettled(clock, navigation.close());
});

test("a navigate that is not cancelled still refuses a second one at once", async () => {
  const { clock, navigation, committed, movements, goal } = waitingRoute(300);
  const owner = new AbortController();
  const first = navigation.navigate({ movements, goal, signal: owner.signal });
  first.catch(() => undefined);
  await committed;
  await assert.rejects(navigation.navigate({ movements, goal }), /Navigation is busy with another request/);
  owner.abort(new Error("test over"));
  await tickUntilSettled(clock, navigation.close());
});

/** Plans one route on the waiting floor, stops it at its commit, and returns the events it raised before. */
async function eventsOfOneRoute(open: (navigation: ReturnType<typeof createNavigationRuntime>) => Disposable | undefined) {
  const { clock, navigation, movements, goal } = waitingRoute();
  const kinds: string[] = [];
  const stop = new AbortController();
  navigation.onEvent((event) => {
    kinds.push(event.kind);
    if (event.kind === "route_committed") stop.abort("route observed");
  });
  const held = open(navigation);
  try {
    await tickUntilSettled(clock, navigation.navigate({ movements, goal, stopSignal: stop.signal }));
  } finally {
    held?.[Symbol.dispose]();
    await tickUntilSettled(clock, navigation.close());
  }
  return kinds;
}

// Run 15: a pinned bot's next movement action routes as an escape without every action passing a flag down.
test("while routesAsEscape is open every route starts as an escape, and the next one after it does not", async () => {
  const escaping = await eventsOfOneRoute((navigation) => navigation.routesAsEscape());
  assert.ok(escaping.includes("escape_relaxed"), "the route set its style rules aside");
  assert.equal((await eventsOfOneRoute(() => undefined)).includes("escape_relaxed"), false);
});

/** A 5x5 room (stone floor, walls and ceiling) with the bot in it: a goal outside it has no path, and the search ends fast. */
function enclosedRoom(routes: RouteOutcomes) {
  // Stone around the room as far as the goal and the roof: y 64 to 67 over x and z -8 to 8, but the room's own cells.
  const cells: Record<string, string> = {};
  for (let x = -8; x <= 8; x++)
    for (let z = -8; z <= 8; z++)
      for (let y = 64; y <= 67; y++) if (!(Math.abs(x) <= 2 && Math.abs(z) <= 2 && y <= 65)) cells[`${x},${y},${z}`] = "stone";
  const { bot, clock } = createFakeBot({ groundY: 63, cells });
  return { bot, clock, navigation: createNavigationRuntime(bot, { routes }), movements: createMovementPolicy({ allowDigging: false, allowParkour: false }) };
}

// Run 15 review: the pinned watch counts a movement action's failure only when its route or movement failed.
test("the routes of a navigation runtime are recorded: an exhausted search is a failed route, a route stopped by its caller is not", async () => {
  const routes = new RouteOutcomes();
  const { clock, navigation, movements } = enclosedRoom(routes);
  try {
    const exhausted = routes.mark();
    const noPath = await tickUntilSettled(clock, navigation.navigate({ movements, goal: exactBlockGoal({ x: 6, y: 64, z: 0 }) }));
    assert.equal(noPath.status, "stopped", JSON.stringify(noPath));
    assert.equal(routes.failedSince(exhausted), true);
    const stopped = routes.mark();
    const stop = AbortSignal.abort("the pickaxe broke");
    await tickUntilSettled(clock, navigation.navigate({ movements, goal: exactBlockGoal({ x: 1, y: 64, z: 0 }), stopSignal: stop }));
    assert.equal(routes.failedSince(stopped), false);
  } finally {
    await tickUntilSettled(clock, navigation.close());
  }
});

test("an in-place break asked of a closed runtime is refused as closed (review 2026-10-19 #7)", async () => {
  const navigation = createNavigationRuntime(createFakeBot().bot);
  await navigation.close();
  await assert.rejects(
    navigation.breakBlockInPlace({ position: { x: 1, y: 64, z: 0 }, movements: createMovementPolicy() } as never),
    /closed/,
  );
});

test("the live break estimate reads submergedAtEyes on either side of a source surface", async () => {
  const position = new Vec3(1, 64, 0);
  const { bot } = createFakeBot({ position: new Vec3(0.5, 64.356, 0.5), cells: { "0,65,0": "water", "1,64,0": "stone" } });
  const navigation = createNavigationRuntime(bot);
  const submerged: boolean[] = [];
  const movements = createMovementPolicy({
    digTimeEstimator: { estimate: (_block, _tool, context) => { submerged.push(context.submergedAtEyes); return 1; } },
  });
  try {
    const stop = AbortSignal.abort(new Error("stop after pricing the break"));
    await assert.rejects(navigation.breakBlockInPlace({ position, movements, signal: stop }), /stop after pricing the break/);
    bot.entity.position.y = 64.24;
    const wet = await navigation.breakBlockInPlace({ position, movements });
    assert.equal(wet.status, "failed");
    assert.match(wet.reason, /Underwater stance unavailable.*owned=false/);
    assert.equal(bot.blockAt(position)?.name, "stone");
    assert.deepEqual(submerged, [false, true]);
  } finally {
    await navigation.close();
  }
});

test("a grounded dive's arrival can swing only with enough air for the work and verified ascent", async () => {
  for (const air of [90, 250]) {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const feet = new Vec3(0.5, 64, 0.5);
    const target = new Vec3(1, 64, 0);
    const harness = createFakeBot({ clock, position: feet, groundY: 63,
      cells: { "0,64,0": "water", "0,65,0": "water", "1,64,0": "dirt" } });
    const { bot, breath, server } = harness;
    useNativeDigging(harness);
    installNativeDigClock(bot);
    const navigation = createNavigationRuntime(bot);
    // Admit the route first, then spend air before its first piece of work.
    breath.setAirSupply(280);
    // Bare-handed dirt in the submerged fixture takes 75 ticks in the native dig clock.
    const movements = createMovementPolicy({ digTimeEstimator: { estimate: () => 75 } });
    const stop = new AbortController();
    let receipt: Awaited<ReturnType<typeof navigation.breakBlockInPlace>> | undefined;
    let refusal: unknown;
    const trace: string[] = [];
    navigation.onEvent(({ kind }) => trace.push(kind));
    try {
      const run = navigation.navigate({ movements, goal: exactBlockGoal(feet.floored()), signal: stop.signal,
        async onArrival({ signal }) {
          trace.push(`arrival with ${air} air at ${bot.entity.position}, onGround=${bot.entity.onGround}`);
          assert.deepEqual(bot.entity.position, feet);
          const backstop = navigation.diveBackstop?.();
          assert.ok(typeof backstop === "number" && backstop < 300, "the stance has a verified ascent");
          breath.setAirSupply(air);
          try {
            receipt = await navigation.breakBlockInPlace({ position: target, movements, signal });
          } catch (error) {
            refusal = error;
          } finally {
            stop.abort(new Error("arrival proof complete"));
          }
          return { kind: "completed" };
        },
      });
      await clock.settle(run.catch((error) => { if (error !== stop.signal.reason) throw error; }), 6_000)
        .catch((error) => { throw new Error(`${error}\n${trace.join("\n")}`); });
      const swings = server.packets.flatMap(({ name, data }) => {
        if (name !== "block_dig") return [];
        const { status, location } = data as { status: number; location: Vec3 };
        return status === 0 ? [location] : [];
      });
      if (air === 90) {
        assert.equal(refusal, "Planned breathing stop");
        assert.equal(receipt, undefined);
        assert.deepEqual(swings, []);
        assert.equal(bot.blockAt(target)?.name, "dirt");
      } else {
        assert.equal(refusal, undefined);
        assert.deepEqual(receipt, { status: "broken" });
        assert.deepEqual(swings, [target]);
        assert.equal(bot.blockAt(target)?.name, "air");
      }
    } finally {
      await clock.settle(navigation.close(), 5_000);
    }
  }
});

// Plan 2026-10-27-p1-monotonic-clock T4: the runtime's route-level `elapsedMs` (navigateAroundDragonBreath) was a wall difference.
test("a route stopped 200 ms after it commits, with the wall clock stepped back 0.8 s, reports 200 ms and never a negative elapsedMs", async () => {
  const { clock, navigation, committed, movements, goal } = waitingRoute(undefined, createFakeClock({ mode: "mocked" }));
  using _timers = clock.install();
  const stop = new AbortController();
  const startedAt = clock.now();
  const run = navigation.navigate({ movements, goal, stopSignal: stop.signal });
  await committed;
  await clock.advance(200);
  clock.stepWallClock(-800);
  stop.abort("test over");
  const result = await tickUntilSettled(clock, run);
  assert.equal(result.status, "stopped");
  const sinceStart = clock.now() - startedAt;
  assert.ok(result.elapsedMs >= 200 && result.elapsedMs <= sinceStart, `elapsedMs ${result.elapsedMs} ms after ${sinceStart} ms of clock`);
  await tickUntilSettled(clock, navigation.close());
});
