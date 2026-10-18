import { exactBlockGoal } from "./goals/index.js";
import { createMovementPolicy } from "./movements/policy.js";
import { createNavigationRuntime } from "./runtime.js";
import assert from "node:assert/strict";
import test from "node:test";
import { botFixture } from "../test-support/bot.js";

test("builds and closes one navigation runtime for a bot", async () => {
  const bot = botFixture();
  const physicsListeners = bot.listenerCount("physicsTick");

  const navigation = createNavigationRuntime(bot);
  assert.equal(navigation.active, false);
  assert.equal(bot.listenerCount("death"), 1);
  assert.equal(bot.listenerCount("end"), 1);
  assert.equal(bot.listenerCount("physicsTick"), physicsListeners + 1);

  await navigation.close();
  assert.equal(bot.listenerCount("death"), 0);
  assert.equal(bot.listenerCount("end"), 0);
  assert.equal(bot.listenerCount("physicsTick"), physicsListeners);
  // A closed runtime is spent: there is no registry to look a live one up in.
  await assert.rejects(navigation.navigate({} as never), /closed/);
});

test("navigation uses observed perched-cloud clearance", async () => {
  const bot = botFixture();
  bot.entity.position.set(-2.5, 62, 1.5);
  bot.entity.velocity = bot.entity.position.scaled(0);
  bot.world.getBlockStateId = (p) => (p.y < 62 ? bot.registry.blocksByName.end_stone.defaultState : 0);
  Object.assign(bot.world, {
    getColumn: () => ({ minY: -64, worldHeight: 384, getBlockStateId: bot.world.getBlockStateId }),
  });
  const metadata: unknown[] = [];
  const keys = bot.registry.entitiesByName.area_effect_cloud.metadataKeys;
  assert.ok(keys);
  metadata[keys.indexOf("particle")] = { type: "dragon_breath" };
  metadata[keys.indexOf("radius")] = 5;
  bot.entities[564] = {
    id: 564,
    name: "area_effect_cloud",
    isValid: true,
    position: bot.entity.position.clone().set(-0.8084108410180761, 63, 8.551320364546644),
    metadata,
  } as typeof bot.entity;
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
function waitingRoute(releaseWaitMs?: number) {
  const bot = botFixture({ groundY: 63 });
  bot.world.getBlockStateId = (p) => (p.y <= 63 ? bot.registry.blocksByName.stone.defaultState : 0);
  Object.assign(bot.world, { getColumn: () => ({ minY: -64, worldHeight: 384, getBlockStateId: bot.world.getBlockStateId }) });
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
  return { bot, navigation, committed, movements, goal };
}

// Run 14b: a stalled navigate waited for a tick for good and kept the one navigation slot: every later route was
// refused "Navigation is busy with another request" (172 times) until the run ended.
test("a navigate cancelled while it waits for a tick that never comes frees the navigation for the next one within a bound", async () => {
  const { bot, navigation, movements, goal } = waitingRoute(300);
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
  const started = performance.now();
  const next = navigation.navigate({ movements, goal: exactBlockGoal({ x: -6, y: 64, z: 0 }), stopSignal: stop.signal });
  await Promise.race([second, next.then(() => undefined)]);
  assert.equal(routes, 2, "the next route was planned and committed, not refused busy");
  assert.ok(performance.now() - started < 2_000, "within the bounded wait");
  // Physics back: the new route ends at its stop, and the abandoned one, aborted, settles too.
  stop.abort("test over");
  const ticking = setInterval(() => bot.emit("physicsTick"), 5);
  try {
    assert.equal((await next).status, "stopped");
    await navigation.close();
  } finally {
    clearInterval(ticking);
  }
});

test("a navigate that is not cancelled still refuses a second one at once", async () => {
  const { bot, navigation, committed, movements, goal } = waitingRoute(300);
  const owner = new AbortController();
  const first = navigation.navigate({ movements, goal, signal: owner.signal });
  first.catch(() => undefined);
  await committed;
  await assert.rejects(navigation.navigate({ movements, goal }), /Navigation is busy with another request/);
  owner.abort(new Error("test over"));
  const ticking = setInterval(() => bot.emit("physicsTick"), 5);
  try {
    await navigation.close();
  } finally {
    clearInterval(ticking);
  }
});

/** Plans one route on the waiting floor, stops it at its commit, and returns the events it raised before. */
async function eventsOfOneRoute(open: (navigation: ReturnType<typeof createNavigationRuntime>) => Disposable | undefined) {
  const { navigation, movements, goal } = waitingRoute();
  const kinds: string[] = [];
  const stop = new AbortController();
  navigation.onEvent((event) => {
    kinds.push(event.kind);
    if (event.kind === "route_committed") stop.abort("route observed");
  });
  const held = open(navigation);
  try {
    await navigation.navigate({ movements, goal, stopSignal: stop.signal });
  } finally {
    held?.[Symbol.dispose]();
    await navigation.close();
  }
  return kinds;
}

// Run 15: a pinned bot's next movement action routes as an escape without every action passing a flag down.
test("while routesAsEscape is open every route starts as an escape, and the next one after it does not", async () => {
  const escaping = await eventsOfOneRoute((navigation) => navigation.routesAsEscape());
  assert.ok(escaping.includes("escape_relaxed"), "the route set its style rules aside");
  assert.equal((await eventsOfOneRoute(() => undefined)).includes("escape_relaxed"), false);
});
