import { exactBlockGoal } from "./goals/index.js";
import { createMovementPolicy } from "./movements/policy.js";
import { RouteOutcomes } from "./route-outcomes.js";
import { createNavigationRuntime } from "./runtime.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeClock, createFakeBot, createFakeClock } from "../test-support/fake-bot/index.js";

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
