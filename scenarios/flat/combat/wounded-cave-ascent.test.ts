// The cave ascent's driver reads declared vitals, the route and the mid-route zombie from the server, in server ticks.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { watch } from "../../../src/test-support/pending.ts";
import type { Encounter } from "./reflex.ts";
import { awaitLatch, confirmVitals, judgeAscent, routeFailure, watchRoute, watchZombie } from "./wounded-cave-ascent.ts";

const DECLARED = { hurtTo: 2, maxFood: 13 };
const RATES = [20, 10] as const;
/** The driver's stalled-clock bound (`DRIVER_CLOCK_STOPPED_MS`) minus a margin: a wait is still pending here. */
const JUST_UNDER_STALL_MS = 29_950;
/** `waitServerTicks(bot, 40)` ends within 60-79 server ticks of the first age, `(bot, 200)` within 220-239 (a packet's margin). */
const ANSWER_WINDOW_MAX_TICKS = 80;
const ROUTE_WINDOW_MAX_TICKS = 240;

/** A trial on one fake clock; `assertClean` checks every exit left no timer, bot listener or abort listener. */
function fixture(ticksPerSecond: number, options: { carried?: Record<string, number> } = {}) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, server: { startAge: 1_000, ticksPerSecond }, ...options });
  // The server's health packet carries the saturation the bot holds; the fake keeps it as plain state (fake-bot.ts `stateOf`).
  Object.assign(harness.bot, { foodSaturation: 0 });
  const controller = new AbortController();
  const added = listenersAddedSince(harness.bot);
  const context = { bot: harness.bot, signal: controller.signal };
  const assertClean = async () => {
    const check = () => {
      for (const event of harness.bot.eventNames()) assert.equal(added(String(event)), 0, String(event));
      assert.equal(getEventListeners(controller.signal, "abort").length, 0, "no abort listener");
      assert.equal(clock.pendingTimers(), 0, "no timer");
    };
    check();
    await clock.advance(100_000);
    check();
  };
  return { ...harness, controller, context, assertClean };
}

for (const rate of RATES) {
  test(`vitals prepared 20 server ticks late are confirmed at ${rate} tps`, async () => {
    const { context, bot, clock, combat, assertClean } = fixture(rate);
    using _timers = clock.install();
    combat.setHealth(2, 20);
    const origin = bot.time.age!;
    const pending = confirmVitals(context, DECLARED);
    const state = watch(pending);
    await clock.advance(20_000 / rate);
    assert.equal(bot.time.age! - origin, 20, "one time packet of world age passed");
    assert.equal(state.over, false, "the old food is not the declared food");
    combat.setHealth(2, 13);
    assert.equal(await clock.settle(pending, 60_000), null);
    assert.ok(bot.time.age! - origin >= 20, `confirmed at +${bot.time.age! - origin} ticks, after the late packet`);
    await assertClean();
  });

  // Each row is one side of one bound of the declared vitals: the 2026-11-17 incident, food 14 and 15 above the
  // declared 13, saturation 5 above 0, health 3 above the band and health 0 under it, and a food item.
  const refused = [
    { label: "the full-food vitals of the 2026-11-17 incident", health: 2, food: 20, saturation: 20, text: "health 2, food 20, saturation 20" },
    { label: "food 14, one above the declared 13", health: 2, food: 14, saturation: 0, text: "health 2, food 14, saturation 0" },
    { label: "food 15", health: 2, food: 15, saturation: 0, text: "health 2, food 15, saturation 0" },
    { label: "saturation left above zero", health: 2, food: 13, saturation: 5, text: "health 2, food 13, saturation 5" },
    { label: "health above the wounded bar", health: 3, food: 13, saturation: 0, text: "health 3, food 13, saturation 0" },
    { label: "health 0, under the band", health: 0, food: 13, saturation: 0, text: "health 0, food 13, saturation 0" },
    { label: "a food item in the inventory", health: 2, food: 13, saturation: 0, carried: { bread: 1, cobblestone: 8 }, text: "health 2, food 13, saturation 0, carrying bread" },
  ];
  for (const row of refused) {
    test(`${row.label} is refused with its values after one answer window at ${rate} tps`, async () => {
      const { context, bot, clock, combat, assertClean } = fixture(rate, { carried: row.carried });
      using _timers = clock.install();
      // `setHealth(0)` runs the fake's death flow and respawns at 20; the read under test is the packet's 0 before the respawn.
      combat.setHealth(Math.max(row.health, 1), row.food);
      Object.assign(bot, { foodSaturation: row.saturation, health: row.health });
      const origin = bot.time.age!;
      assert.equal(await clock.settle(confirmVitals(context, DECLARED), 60_000), `Declared vitals not seen: ${row.text}`);
      const waited = bot.time.age! - origin;
      assert.ok(waited >= 40 && waited <= ANSWER_WINDOW_MAX_TICKS, `waited ${waited} server ticks, the 40-tick answer window and one packet's margin`);
      await assertClean();
    });
  }

  // The accepted side of the same bounds: the declared food and one under it, health 1 and 2, blocks and tools are not food.
  const accepted = [
    { label: "health 2, food 13", health: 2, food: 13, carried: undefined },
    { label: "health 1, food 12", health: 1, food: 12, carried: undefined },
    { label: "blocks and tools alone", health: 2, food: 13, carried: { iron_pickaxe: 1, cobblestone: 40, dirt: 11 } },
  ];
  for (const row of accepted) {
    test(`${row.label} are accepted at once at ${rate} tps`, async () => {
      const { context, clock, combat, assertClean } = fixture(rate, { carried: row.carried });
      using _timers = clock.install();
      combat.setHealth(row.health, row.food);
      assert.equal(await clock.settle(confirmVitals(context, DECLARED), 5_000), null);
      await assertClean();
    });
  }

  test(`an aborted confirmation rejects with its reason and leaves nothing at ${rate} tps`, async () => {
    const { context, controller, clock, combat, assertClean } = fixture(rate);
    using _timers = clock.install();
    combat.setHealth(2, 20);
    const reason = new Error("cancelled vitals");
    const rejected = assert.rejects(confirmVitals(context, DECLARED), (error) => error === reason);
    await clock.advance(2_000);
    controller.abort(reason);
    await clock.settle(rejected, 5_000);
    await assertClean();
  });
}

test("a stopped server fails the confirmation at the stall bound, not before, and says so", async () => {
  const { context, clock, server, combat, assertClean } = fixture(20);
  using _timers = clock.install();
  combat.setHealth(2, 20);
  server.stop();
  const pending = confirmVitals(context, DECLARED);
  const state = watch(pending);
  await clock.advance(JUST_UNDER_STALL_MS);
  assert.equal(state.over, false, "still waiting just under the 30 s stall bound");
  const detail = await clock.settle(pending, 5_000);
  assert.equal(detail, "Declared vitals not seen: health 2, food 20, saturation 0; the server's world age stood still");
  await assertClean();
});

test("the route latch holds a move of one block made while navigate owned the body, after the bot stood back", () => {
  const { bot, assertClean } = fixture(20);
  const origin = bot.entity.position.clone();
  let active: string | undefined;
  const route = watchRoute(bot, () => active, origin);
  try {
    active = "navigate";
    bot.entity.position = origin.offset(0.9, 0, 0);
    bot.emit("move", bot.entity.position.clone());
    assert.equal(route.latched(), false, "0.9 block is under the bar");
    bot.entity.position = origin.offset(0, 0, 1);
    bot.emit("move", bot.entity.position.clone());
    assert.equal(route.latched(), true, "exactly one block from the origin");
    bot.entity.position = origin.clone();
    bot.emit("move", bot.entity.position.clone());
    assert.equal(route.latched(), true, "a latch stays");
  } finally {
    route.close();
  }
  return assertClean();
});

test("the route latch ignores a move made while another action, or none, owned the body", () => {
  const { bot, assertClean } = fixture(20);
  const origin = bot.entity.position.clone();
  let active: string | undefined;
  const route = watchRoute(bot, () => active, origin);
  try {
    for (const owner of [undefined, "collect"]) {
      active = owner;
      bot.entity.position = origin.offset(3, 0, 0);
      bot.emit("move", bot.entity.position.clone());
      assert.equal(route.latched(), false, `owner ${owner}`);
    }
  } finally {
    route.close();
  }
  return assertClean();
});

test("the zombie latch holds the first zombie's id and ignores other creatures", () => {
  const { bot, entities, assertClean } = fixture(20);
  const zombie = watchZombie(bot);
  try {
    entities.spawn({ name: "cow", position: bot.entity.position.offset(2, 0, 0) });
    assert.equal(zombie.seen(), false);
    assert.equal(zombie.id(), undefined);
    const first = entities.spawn({ name: "zombie", position: bot.entity.position.offset(3, 0, 0) });
    entities.spawn({ name: "zombie", position: bot.entity.position.offset(4, 0, 0) });
    assert.equal(zombie.seen(), true);
    assert.equal(zombie.id(), first.id);
  } finally {
    zombie.close();
  }
  return assertClean();
});

for (const rate of RATES) {
  test(`a latch set at +40 ticks is seen by the 40-tick window at ${rate} tps`, async () => {
    const { context, bot, clock, entities, assertClean } = fixture(rate);
    using _timers = clock.install();
    const zombie = watchZombie(bot);
    try {
      const pending = awaitLatch(context, 40, zombie.seen);
      await clock.advance(40_000 / rate - 1_000 / rate);
      entities.spawn({ name: "zombie", position: bot.entity.position.offset(3, 0, 0) });
      assert.equal(await clock.settle(pending, 60_000), "latched");
    } finally {
      zombie.close();
    }
    await assertClean();
  });

  test(`a latch that never sets ends "never" after the window at ${rate} tps`, async () => {
    const { context, bot, clock, assertClean } = fixture(rate);
    using _timers = clock.install();
    const origin = bot.time.age!;
    assert.equal(await clock.settle(awaitLatch(context, 200, () => false), 60_000), "never");
    const waited = bot.time.age! - origin;
    assert.ok(waited >= 200 && waited <= ROUTE_WINDOW_MAX_TICKS, `waited ${waited} server ticks, the 200-tick window and one packet's margin`);
    await assertClean();
  });

  test(`a route that ends before its latch abandons the wait at ${rate} tps`, async () => {
    const { context, clock, assertClean } = fixture(rate);
    using _timers = clock.install();
    let ended = false;
    const pending = awaitLatch(context, 200, () => false, () => ended);
    await clock.advance(1_000);
    ended = true;
    assert.equal(await clock.settle(pending, 5_000), "abandoned");
    await assertClean();
  });

  test(`an aborted latch wait rejects with its reason at ${rate} tps`, async () => {
    const { context, controller, clock, assertClean } = fixture(rate);
    using _timers = clock.install();
    const reason = new Error("cancelled latch");
    const rejected = assert.rejects(awaitLatch(context, 200, () => false), (error) => error === reason);
    await clock.advance(1_000);
    controller.abort(reason);
    await clock.settle(rejected, 5_000);
    await assertClean();
  });
}

test("a stopped server ends the latch wait as stalled at the stall bound, not before", async () => {
  const { context, clock, server, assertClean } = fixture(20);
  using _timers = clock.install();
  server.stop();
  const pending = awaitLatch(context, 200, () => false);
  const state = watch(pending);
  await clock.advance(JUST_UNDER_STALL_MS);
  assert.equal(state.over, false, "still waiting just under the 30 s stall bound");
  assert.equal(await clock.settle(pending, 5_000), "stalled");
  await assertClean();
});

/** A navigate the test controls: its return, and the cancels it was asked for. */
function routeRun(result: unknown) {
  const calls: string[] = [];
  return {
    calls,
    run: {
      pending: Promise.resolve({ result }),
      cancel: async (reason: string) => void calls.push(`cancel: ${reason}`),
    },
  };
}

test("a latched wait is no route failure and cancels nothing", async () => {
  const { calls, run } = routeRun({ status: "succeeded" });
  assert.equal(await routeFailure("latched", "the bot moving", run), null);
  assert.deepEqual(calls, []);
});

test("a route that returned before the latch reports its own result and is not cancelled", async () => {
  const { calls, run } = routeRun({ status: "failed", error: "no route" });
  assert.equal(
    await routeFailure("abandoned", "the bot moving", run),
    `The withdraw navigate returned before the bot moving: {"status":"failed","error":"no route"}`,
  );
  assert.deepEqual(calls, []);
});

test("a route that never reached the latch is cancelled once, then awaited, and fails with what was not seen", async () => {
  const { calls, run } = routeRun({ status: "cancelled" });
  assert.equal(await routeFailure("never", "the bot moving", run), "Not seen: the bot moving");
  assert.deepEqual(calls, ["cancel: The route never reached: the bot moving."]);
});

test("a stalled server cancels the route and says the world age stood still", async () => {
  const { calls, run } = routeRun({ status: "cancelled" });
  assert.equal(await routeFailure("stalled", "a zombie", run), "Not seen: a zombie; the server's world age stood still");
  assert.equal(calls.length, 1);
});

function encounter(overrides: Partial<Encounter> = {}): Encounter {
  return {
    response: "evade", outcome: "safe_separation", reason: "the zombie was in sight", interrupted: { action: "navigate", startedAt: "t" },
    healthBefore: 2, healthAfter: 2, attacks: 0, combatStyles: [], weaponsUsed: [], shieldRaisedSwings: 0, projectileGuards: 0,
    explosions: 0, finalPosition: { x: 0, y: -50, z: 12 }, finalDistances: [{ id: 41, distance: 12 }], ...overrides,
  };
}

const ARRIVED = { health: 2, remaining: 1.2, zombieId: 41, output: { result: { status: "succeeded" } }, encounters: [encounter()] };

test("an ascent that arrived alive after the zombie's evade interrupted the navigate passes", () => {
  assert.equal(judgeAscent(ARRIVED).status, "succeeded");
  assert.equal(judgeAscent({ ...ARRIVED, remaining: 2 }).status, "succeeded", "exactly two blocks is arrived");
});

test("an ascent fails on each missing fact and names it", () => {
  const failed = (overrides: object, text: RegExp) => {
    const verdict = judgeAscent({ ...ARRIVED, ...overrides });
    assert.equal(verdict.status, "failed", String(text));
    assert.match(verdict.detail, text);
  };
  failed({ remaining: 2.01 }, /did not arrive/u);
  failed({ health: 0 }, /died/u);
  failed({ output: { result: { status: "failed", error: "no route" } } }, /navigate .*failed.*no route/u);
  failed({ encounters: [] }, /interrupt/u);
  failed({ encounters: [encounter({ interrupted: null })] }, /interrupt/u);
  failed({ encounters: [encounter({ interrupted: { action: "collect", startedAt: "t" } })] }, /interrupt/u);
  failed({ encounters: [encounter({ finalDistances: [{ id: 99, distance: 12 }] })] }, /zombie 41/u);
});

test("a stalled navigate return fails with its status and its own text", () => {
  // The runtime's stalled return: status cancelled, text `N evades from <name>#<id> over <n> server ticks without progress on navigate`
  // (src/survival/reflexes/hostile.test.ts:143, src/survival/evidence/format.test.ts:32).
  const verdict = judgeAscent({
    ...ARRIVED,
    output: { result: { status: "cancelled", error: "[HOSTILE_STALLED] 8 evades from zombie#41 over 160 server ticks without progress on navigate" } },
  });
  assert.equal(verdict.status, "failed");
  assert.match(verdict.detail, /navigate returned cancelled: \[HOSTILE_STALLED\] 8 evades from zombie#41/u);
});
