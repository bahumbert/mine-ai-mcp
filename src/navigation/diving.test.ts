import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { type FakeBotOptions, createFakeBot, createFakeClock, listenersAddedSince } from "../test-support/fake-bot/index.js";
import { movementStep } from "../test-support/navigation.js";
import { Diving } from "./diving.js";
import { MemoryWorld } from "./world/memory-world.js";
import { createMovementPolicy } from "./movements/policy.js";
import { exactBlockGoal } from "./goals/index.js";
import { DIVE_BACKSTOP_TICKS, admitsDive } from "./world/swimming.js";
import { attachBreathReflex } from "../survival/reflexes/breath.js";
import type { NavigateOptions, NavigationResult } from "./navigate.js";

type Kind = "stone" | "air" | "water";

/**
 * The navigation world a dive plans on and the fake bot's own, with every cell loaded into both. A flowing cell is
 * a `level` above 0; `mocked` puts the fake clock on the global timers for a dive that waits.
 */
function pond(position: Vec3, onGround: boolean, options: Pick<FakeBotOptions, "lagMs" | "server"> & { readonly mocked?: boolean } = {}) {
  const world = new MemoryWorld();
  const { mocked, ...fake } = options;
  const harness = createFakeBot({ position, groundY: null, ...fake, ...(mocked ? { clock: createFakeClock({ mode: "mocked" }) } : {}) });
  const { bot } = harness;
  Object.assign(bot.entity, { onGround });
  /** Listeners of `event` the dive left on the bot, beyond the fake's own (a `death` handler of its dig, its physics). */
  const left = listenersAddedSince(bot);
  const load = (cell: { x: number; y: number; z: number }, kind: Kind, level = 0) => {
    world.load(cell, kind === "stone" ? { stateId: 1 } : kind === "air" ? { stateId: 0 }
      : { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: level === 0 } });
    harness.world.setCell(new Vec3(cell.x, cell.y, cell.z), kind === "water" && level > 0 ? { name: "water", properties: { level } } : kind);
  };
  return { world, harness, bot, breath: harness.breath, clock: harness.clock, load, left };
}

/** A pond column at x 0 (stone floor y 59, water y 60-63, air above), the bot floating in it with full air heard. */
function fixture(options: Parameters<typeof pond>[2] = {}) {
  const column = pond(new Vec3(0.5, 61.2, 0.5), false, options);
  for (let y = 59; y <= 65; y++) column.load({ x: 0, y, z: 0 }, y === 59 ? "stone" : y <= 63 ? "water" : "air");
  column.breath.setAirSupply(300);
  return column;
}

test("a dive declaration and its watcher end on success, cancellation, and exceptions", async () => {
  const { world, bot, left } = fixture();
  const diving = new Diving(bot, world);
  const options = { movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 61, z: 0 }) };
  await assert.rejects(diving.run(options, async () => {
    assert.equal(diving.owned, true);
    assert.ok(diving.backstop()! > 25);
    throw new Error("failed physical route");
  }), /failed physical route/);
  assert.equal(diving.owned, false);
  assert.equal(left("physicsTick"), 0);
  const result = await diving.run(options, async (request) => {
    diving.cancel("takeover");
    assert.equal(request.stopSignal?.aborted, true);
    return { status: "stopped", reason: "takeover", elapsedMs: 0 };
  });
  assert.equal(result.status, "stopped");
  assert.equal(diving.active, false);
  assert.equal(diving.backstop(), null);
  assert.equal(left("physicsTick"), 0);
});

/** The return-to-air admission a request carries: from where the body is, with the air it has left (T6 2026-10-21). */
function returnAdmission(request: Parameters<Parameters<Diving["run"]>[1]>[0]) {
  const dive = request.movements.dive;
  return dive && { origin: { x: dive.origin.x, y: dive.origin.y, z: dive.origin.z }, airTicks: dive.airTicks, toAir: dive.toAir };
}

// T5 probe 2026-10-21: a roof laid over the pond mid-dive fired the stop at air 228, and the return planned with the
// dive's own admission (origin where the dive began, the 65-tick reserve) refused every cell: "shut in at the start".
test("a breathing stop returns to air planning from where the body is with the air it has left", async () => {
  const { world, bot, breath, clock, left } = fixture({ mocked: true });
  using _timers = clock.install();
  const states: string[] = [];
  const diving = new Diving(bot, world, (state) => states.push(state));
  const goal = exactBlockGoal({ x: 0, y: 60, z: 0 });
  let calls = 0;
  let admission: ReturnType<typeof returnAdmission>;
  const result = await diving.run({ movements: createMovementPolicy(), goal }, async (request) => {
    calls++;
    if (calls === 1) {
      bot.entity.position.y = 60;
      breath.setAirSupply(60);
      bot.emit("physicsTick");
      assert.equal(request.stopSignal?.aborted, true);
      return { status: "stopped", reason: String(request.stopSignal?.reason), elapsedMs: 0 };
    }
    if (calls === 2) {
      assert.notEqual(request.goal, goal);
      admission = returnAdmission(request);
      bot.entity.position.y = 63.5;
      breath.setAirSupply(300);
    } else assert.equal(request.goal, goal);
    return { status: "completed", elapsedMs: 0 };
  });
  assert.equal(result.status, "completed");
  assert.equal(calls, 3);
  assert.deepEqual(admission, { origin: { x: 0.5, y: 60, z: 0.5 }, airTicks: 60, toAir: true });
  assert.deepEqual(states, ["breathing", "resumed", "released"]);
  // The next request starts clean from the state the stop left.
  assert.equal(diving.active, false);
  assert.equal(left("physicsTick"), 0);
  assert.equal((await diving.run({ movements: createMovementPolicy(), goal }, async () => ({ status: "completed", elapsedMs: 0 }))).status, "completed");
  assert.equal(clock.pendingGlobalTimers(), 0);
  await clock.advance(60_000);
  assert.deepEqual(states, ["breathing", "resumed", "released"]);
});

test("a breathing stop whose return finds no way keeps the route's failure and says what to do next", async () => {
  const { world, bot, breath } = fixture();
  const diving = new Diving(bot, world);
  let calls = 0;
  let swimBack: ReturnType<typeof returnAdmission>;
  const result = await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }) }, async (request) => {
    calls++;
    if (calls === 1) {
      bot.entity.position.y = 62.5; // Eyes in the air: the last breathable cell, where the swim back goes.
      bot.emit("physicsTick");
      bot.entity.position.y = 60;
      breath.setAirSupply(60);
      bot.emit("physicsTick");
      return { status: "stopped", reason: String(request.stopSignal?.reason), elapsedMs: 0 };
    }
    if (calls === 3) swimBack = returnAdmission(request);
    breath.setAirSupply(40);
    return { status: "stopped", reason: "no path", routeFailed: true, elapsedMs: 0 };
  });
  assert.ok(result.status === "stopped" && result.routeFailed, "the pinned watch still sees the route failure");
  assert.match(result.status === "stopped" ? result.reason : "", /Planned breathing stop: the swim back to air did not get there \(no path\); breathe at the surface/u);
  // The swim back after the failed run plans the same way: from the body, with the air it has left.
  assert.deepEqual(swimBack, { origin: { x: 0.5, y: 60, z: 0.5 }, airTicks: 40, toAir: true });
});

test("a death during the breathing stop's return ends it: no resume, no listener left", async () => {
  const { world, bot, breath, left } = fixture();
  const states: string[] = [];
  const diving = new Diving(bot, world, (state) => states.push(state));
  let calls = 0;
  const result = await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }) }, async (request) => {
    calls++;
    if (calls === 1) {
      breath.setAirSupply(60);
      bot.emit("physicsTick");
      return { status: "stopped", reason: String(request.stopSignal?.reason), elapsedMs: 0 };
    }
    bot.emit("death");
    assert.equal(request.stopSignal?.aborted, true, "the return ends on the death");
    return { status: "stopped", reason: String(request.stopSignal?.reason), elapsedMs: 0 };
  });
  assert.equal(result.status, "stopped");
  assert.equal(result.status === "stopped" ? result.reason : "", "died during the return to air", "a dead bot is not told to go and breathe");
  assert.equal(states.includes("resumed"), false);
  assert.equal(left("death") + left("respawn") + left("physicsTick"), 0);
});

test("floating work with dry eyes keeps the existing surface-mining contract", () => {
  const { world, bot } = fixture();
  bot.entity.position.y = 62.5; // The floored head cell is water, but the actual eyes are above it.
  Reflect.set(bot.entity, "metadata", []);
  assert.equal(new Diving(bot, world).beforeWork(400), null);
});

test("quantity completion still returns a mining process to air, while takeover cancels refill without another tick", async () => {
  const { world, bot, breath, left } = fixture();
  const diving = new Diving(bot, world);
  const quantity = new AbortController();
  let breathing!: () => void;
  const startedBreathing = new Promise<void>((resolve) => { breathing = resolve; });
  bot.setControlState = (control, active) => { if (control === "jump" && active) breathing(); };
  let calls = 0;
  const options = { movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 61, z: 0 }),
    onArrival: () => ({ kind: "completed" as const }), stopSignal: quantity.signal };
  const pending = diving.run(options, async (request) => {
    calls++;
    if (calls === 1) {
      quantity.abort("quantity collected");
      return { status: "stopped", reason: "quantity collected", elapsedMs: 0 };
    }
    assert.equal(request.stopSignal?.aborted, false, "the process still owes its surface handoff");
    bot.entity.position.y = 63.5;
    breath.setAirSupply(200);
    return { status: "completed", elapsedMs: 0 };
  });
  await startedBreathing;
  diving.cancel("connection ended during refill");
  const result = await pending;
  assert.equal(result.status, "stopped");
  assert.ok(result.status === "stopped" && result.reason === "connection ended during refill");
  assert.equal(calls, 2);
  assert.equal(diving.active, false);
  assert.equal(left("physicsTick"), 0);
});

// ── A run that ends under a roof swims back to the last air it passed (run 15, Sana) ───────────────

/** An air pocket at x -2..0 and a water tunnel x 1..8 (y 60-61), roofed (y 62) and floored (y 59), z 0 only. */
function tunnelFixture(options: Parameters<typeof pond>[2] = {}) {
  const tunnel = pond(new Vec3(0.5, 60, 0.5), true, options);
  for (let x = -2; x <= 8; x++)
    for (let y = 59; y <= 62; y++) tunnel.load({ x, y, z: 0 }, y === 59 || y === 62 ? "stone" : x <= 0 ? "air" : "water");
  tunnel.breath.setAirSupply(300);
  return tunnel;
}

test("a dive that fails five blocks into a roofed tunnel swims back to the air pocket before it releases", async () => {
  const { world, bot, clock, left } = tunnelFixture({ mocked: true });
  using _timers = clock.install();
  const states: string[] = [];
  const diving = new Diving(bot, world, (state) => states.push(state));
  const calls: { goal: unknown; air: unknown }[] = [];
  await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 8, y: 60, z: 0 }) }, async (request) => {
    calls.push({ goal: request.goal, air: request.movements.dive });
    if (calls.length === 1) {
      bot.emit("physicsTick");
      diving.committed({ steps: [movementStep("swim", { x: 4, y: 60, z: 0 }, { x: 5, y: 60, z: 0 })] });
      bot.entity.position.x = 5.5;
      bot.emit("physicsTick");
      return { status: "failed", elapsedMs: 0 } as never;
    }
    bot.entity.position.x = 0.5;
    return { status: "completed", elapsedMs: 0 };
  });
  assert.equal(calls.length, 2, "one swim back");
  const back = calls[1]!.goal as { resolve(observation: unknown): { kind: string } };
  assert.ok(back !== calls[0]!.goal);
  assert.equal(bot.entity.position.x, 0.5, "she ends in the air pocket, not inside");
  assert.deepEqual(states, ["released"]);
  assert.equal(left("physicsTick"), 0);
  assert.equal(left("death"), 0);
  assert.equal(left("respawn"), 0);
  assert.equal(clock.pendingGlobalTimers(), 0);
  await clock.advance(60_000);
  assert.deepEqual(states, ["released"]);
});

// Review 2026-10-18 (run 15 fixes), blocking 3: the swim back ran after successful arrivals and ignored the action's cancel.

/** The first navigate of a run into the tunnel: the pocket passed with the head in air, then the dive owned, five blocks in. */
function intoTheTunnel(bot: Bot, diving: Diving): void {
  bot.emit("physicsTick");
  diving.committed({ steps: [movementStep("swim", { x: 4, y: 60, z: 0 }, { x: 5, y: 60, z: 0 })] });
  bot.entity.position.x = 5.5;
}

test("arrival, takeover and action cancellation under a roof leave the body without an unwanted swim back", async () => {
  for (const end of ["arrival", "takeover", "action"] as const) {
    const { world, bot } = tunnelFixture();
    const diving = new Diving(bot, world);
    const cancel = new AbortController();
    let calls = 0;
    const run = diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: end === "arrival" ? 5 : 8, y: 60, z: 0 }),
      signal: cancel.signal }, async () => {
      calls++;
      intoTheTunnel(bot, diving);
      if (end === "action") {
        cancel.abort("cancelled by the model");
        throw cancel.signal.reason;
      }
      if (end === "takeover") diving.cancel("takeover");
      return end === "arrival" ? { status: "completed", elapsedMs: 0 }
        : { status: "stopped", reason: "takeover", elapsedMs: 0 };
    });
    if (end === "action") await assert.rejects(run, /cancelled by the model/);
    else assert.equal((await run).status, end === "arrival" ? "completed" : "stopped");
    assert.equal(calls, 1, `${end} never starts a swim back`);
    assert.equal(bot.entity.position.x, 5.5);
    assert.equal(diving.active, false);
  }
});

/** A dive owned in open water, then roofed in the middle of the route: the admission premise (an ascent) is gone. */
async function backstopUnderRoof(eyeCellLevel: number) {
  const { world, bot, load } = fixture();
  // Feet at y 60 on the floor: the eye cell is y 61, which holds water for the whole dive.
  bot.entity.position.set(0.5, 60, 0.5);
  const diving = new Diving(bot, world);
  let backstop: number | null = null;
  await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }) }, async () => {
    assert.equal(diving.owned, true);
    load({ x: 0, y: 61, z: 0 }, "water", eyeCellLevel);
    for (let y = 62; y <= 65; y++) load({ x: 0, y, z: 0 }, "stone");
    backstop = diving.backstop();
    return { status: "completed", elapsedMs: 0 };
  });
  return backstop;
}

for (const { level, expected } of [{ level: 4, expected: DIVE_BACKSTOP_TICKS }, { level: 0, expected: 300 }])
  test(`a roofed dive asks for rescue only with submerged eyes (water level ${level})`, async () => {
    assert.equal(await backstopUnderRoof(level), expected);
  });

// NAVP-13 (run 15: the server 2.5-4.6 s behind): the breathing stop counted 100 client ticks for full air. The fake
// server on 14 ticks a second (30 % behind) moves the world age 20 ticks a packet, one packet per 1.43 s (the game
// sends one per 20 ticks at any rate, contract check world-age-at-slow-tick), so the bound of 100 ticks is 7.1 s; its air
// packets come 2.5 s late and its air ticks 14 a second like everything the server counts: the full air (60 refill ticks,
// 4.3 s, then 2.5 s late) is heard at about 6.8 s, past the 100 client ticks (5 s) and inside the age bound. The bound's
// margin is the 40 answer ticks, 2.9 s of this server, less the age's staleness (facts live-testing.md "The fake").
test("a server behind the client still completes the breathing stop: full air reported late is waited for", async () => {
  const { world, bot, breath, clock } = fixture({ mocked: true, lagMs: 2_500, server: { ticksPerSecond: 14 } });
  using _timers = clock.install();
  const diving = new Diving(bot, world);
  const goal = exactBlockGoal({ x: 0, y: 60, z: 0 });
  let calls = 0;
  const run = diving.run({ movements: createMovementPolicy(), goal }, async (request) => {
    calls++;
    if (calls === 1) {
      breath.setAirSupply(60);
      bot.emit("physicsTick");
      return { status: "stopped", reason: String(request.stopSignal?.reason), elapsedMs: 0 };
    }
    // At the surface the server refills 4 a tick, and says so 2.5 s late.
    if (calls === 2) bot.entity.position.y = 63.5;
    return { status: "completed", elapsedMs: 0 };
  });
  const result = await clock.settle(run, 30_000);
  assert.equal(result.status, "completed");
  assert.equal(calls, 3);
});

test("the breathing stop ends once the server's clock has moved the refill time with no full air", async () => {
  const { world, bot, breath, clock } = fixture({ mocked: true });
  using _timers = clock.install();
  const diving = new Diving(bot, world);
  let calls = 0;
  // The return completes with the head still under water: the air runs down, never up, while the world age moves on.
  const run = diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }) }, async (request) => {
    calls++;
    if (calls === 1) {
      breath.setAirSupply(60);
      bot.emit("physicsTick");
      return { status: "stopped", reason: String(request.stopSignal?.reason), elapsedMs: 0 };
    }
    return { status: "completed", elapsedMs: 0 };
  });
  const result = await clock.settle(run, 30_000);
  assert.equal(result.status, "stopped");
  assert.match(result.status === "stopped" ? result.reason : "", /Full air was not observed at the breathing stop/u);
  assert.equal(calls, 2);
});

// ── Durations read the monotonic clock: WSL steps its wall clock back about 2 s every 30 s (plan 2026-10-27-p1-monotonic-clock T4) ──
test("a dive cancelled 200 ms in, after the wall clock stepped back 0.8 s, reports 200 ms and never a negative duration", async () => {
  const { world, bot, clock } = fixture({ mocked: true });
  using _timers = clock.install();
  const diving = new Diving(bot, world);
  const startedAt = clock.now();
  let cancelledAt = 0;
  const run = diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }) }, async () => {
    await clock.advance(200);
    clock.stepWallClock(-800);
    cancelledAt = clock.now();
    diving.cancel("takeover");
    throw new Error("engine fault");
  });
  const result = await clock.settle(run, 1_000);
  assert.equal(result.status, "stopped");
  assert.equal(result.elapsedMs, cancelledAt - startedAt);
});

test("the time left of a dive's timeout counts monotonic time across a wall-clock step in either direction", async () => {
  for (const step of [-800, 1_200]) {
    const { world, bot, breath, clock } = fixture({ mocked: true });
    using _timers = clock.install();
    const diving = new Diving(bot, world);
    let calls = 0;
    let resumedTimeout: number | undefined;
    const run = diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }), timeoutMs: 3_000 }, async (request) => {
      calls++;
      if (calls === 1) {
        await clock.advance(1_000);
        clock.stepWallClock(step);
        breath.setAirSupply(60);
        bot.emit("physicsTick");
        return { status: "stopped", reason: String(request.stopSignal?.reason), elapsedMs: 0 };
      }
      if (calls === 2) {
        bot.entity.position.y = 63.5;
        breath.setAirSupply(300);
      } else resumedTimeout = request.timeoutMs;
      return { status: "completed", elapsedMs: 0 };
    });
    await clock.settle(run, 30_000);
    assert.equal(calls, 3, `step ${step}`);
    assert.ok(resumedTimeout !== undefined && resumedTimeout <= 2_000 && resumedTimeout > 1_000, `step ${step}: ${resumedTimeout} ms left, wanted 2000 less the breathing stop`);
  }
});

/** A navigation leg which cannot arrive; it releases its abort listener as soon as the caller stops it. */
function returnWhenStopped(request: NavigateOptions, stopped: () => void): Promise<NavigationResult> {
  return new Promise((resolve) => {
    const finish = () => {
      request.stopSignal?.removeEventListener("abort", finish);
      stopped();
      resolve({ status: "stopped", reason: String(request.stopSignal?.reason), elapsedMs: 0 });
    };
    if (request.stopSignal?.aborted) finish();
    else request.stopSignal?.addEventListener("abort", finish, { once: true });
  });
}

/** Start a failed tunnel route and leave its return awaiting the dive's stop signal. */
function pendingSwimBack(scene: ReturnType<typeof tunnelFixture>, air: number | null, signal?: AbortSignal) {
  const { bot, world } = scene;
  const diving = new Diving(bot, world);
  let request: NavigateOptions | undefined;
  let stops = 0;
  const run = diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 8, y: 60, z: 0 }), signal }, async (next) => {
    if (!request) {
      intoTheTunnel(bot, diving);
      if (air === null) Reflect.set(bot.entity, "metadata", []);
      request = next;
      return { status: "stopped", reason: "no route", elapsedMs: 0 };
    }
    request = next;
    return returnWhenStopped(next, () => { stops++; });
  });
  return { diving, run, request: () => request!, stops: () => stops };
}

for (const ticksPerSecond of [20, 10]) for (const { air, ticks } of [
    { air: 100, ticks: 120 }, { air: null, ticks: 320 }, { air: 10, ticks: 60 },
    { air: 40, ticks: 60 }, { air: 300, ticks: 320 }, { air: 400, ticks: 320 },
  ]) test(`swim-back budgets preserve server ticks at ${ticksPerSecond} tps with air ${air}`, async () => {
    const scene = tunnelFixture({ mocked: true, server: { ticksPerSecond } });
    const { bot, breath, clock, left } = scene;
    using _timers = clock.install();
    breath.hold(air ?? 300);
    await clock.advance(50);
    const startAge = bot.time.age;
    const pending = pendingSwimBack(scene, air);
    await clock.advance(0);
    const endAt = ticks * 1_000 / ticksPerSecond;
    await clock.advance(endAt - 50);
    assert.equal(pending.stops(), 0, `${ticksPerSecond} tps air ${air}: still returning before age +${ticks}`);
    await clock.settle(pending.run, 100);
    assert.equal(bot.time.age - startAge, ticks);
    assert.equal(clock.now(), endAt + 50);
    assert.equal(pending.stops(), 1);
    assert.equal(pending.request().timeoutMs, air === 100 ? 18_000 : ticks === 60 ? 9_000 : 48_000);
    assert.equal(left("death") + left("respawn") + left("physicsTick"), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
    await clock.advance(60_000);
    assert.equal(pending.stops(), 1);
});

test("a stopped server ends the 100-tick swim back at the 18 s wall, with no timer left", async () => {
  const scene = tunnelFixture({ mocked: true });
  const { bot, breath, clock, harness } = scene;
  using _timers = clock.install();
  breath.hold(100);
  await clock.advance(50);
  harness.server.stop();
  const startAge = bot.time.age;
  const pending = pendingSwimBack(scene, 100);
  await clock.advance(17_999);
  assert.equal(pending.stops(), 0);
  await clock.settle(pending.run, 1, 1);
  assert.equal(clock.now(), 18_050);
  assert.equal(bot.time.age, startAge);
  assert.equal(pending.stops(), 1);
  assert.equal(clock.pendingGlobalTimers(), 0);
});

test("takeover, action cancellation, death and respawn stop an active return immediately and permit the next navigate", async () => {
  for (const end of ["takeover", "action", "death", "respawn"] as const) {
    const scene = tunnelFixture({ mocked: true });
    const { bot, breath, clock, left } = scene;
    using _timers = clock.install();
    breath.hold(100);
    await clock.advance(50);
    const action = new AbortController();
    const pending = pendingSwimBack(scene, 100, action.signal);
    await clock.advance(0);
    const reflexJump = end === "takeover";
    bot.setControlState("jump", reflexJump); // The old return must preserve the next owner's controls.
    if (end === "takeover") pending.diving.cancel("reflex owns the body");
    else if (end === "action") action.abort("action cancelled");
    else bot.emit(end);
    assert.equal(pending.request().stopSignal?.aborted, true, end);
    const result = await clock.settle(pending.run, 0);
    assert.ok(result.status === "stopped" && result.reason === "no route");
    assert.equal(bot.getControlState("jump"), reflexJump);
    assert.equal(clock.pendingGlobalTimers(), 0);
    assert.equal(left("death") + left("respawn") + left("physicsTick"), 0);
    bot.setControlState("jump", false);
    const next = pending.diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }) }, async () => {
      bot.entity.position.x = 0.5;
      return { status: "completed", elapsedMs: 0 };
    });
    assert.equal((await clock.settle(next, 0)).status, "completed");
    await clock.advance(60_000);
    assert.equal(pending.stops(), 1);
  }
});

for (const end of [20, 10, "stopped", "takeover"] as const)
  test(`a planned breathing return gets 300 server ticks or ends on ${end}`, async () => {
    const { bot, world, breath, clock, harness, left } = fixture({ mocked: true, server: { ticksPerSecond: end === 10 ? 10 : 20 } });
    using _timers = clock.install();
    breath.hold(60);
    await clock.advance(50);
    if (end === "stopped") harness.server.stop();
    const diving = new Diving(bot, world);
    let calls = 0;
    let stops = 0;
    const startAge = bot.time.age;
    const run = diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }) }, async (request) => {
      if (++calls === 1) {
        bot.emit("physicsTick");
        return { status: "stopped", reason: "planned breathing", elapsedMs: 0 };
      }
      return returnWhenStopped(request, () => { stops++; });
    });
    await clock.advance(0);
    const endAt = end === "stopped" ? 20_000 : end === "takeover" ? 0 : 320_000 / end - 50;
    if (end === "takeover") {
      bot.setControlState("jump", true);
      diving.cancel("reflex owns the body");
    } else {
      await clock.advance(endAt - 1);
      assert.equal(stops, 0);
    }
    assert.equal((await clock.settle(run, end === "takeover" ? 0 : 51)).status, "stopped");
    assert.equal(stops, 1);
    assert.equal(bot.time.age - startAge, typeof end === "number" ? 320 : 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
    assert.equal(left("death") + left("respawn") + left("physicsTick"), 0);
    if (end === "takeover") assert.equal(bot.getControlState("jump"), true);
    await clock.advance(60_000);
    assert.equal(stops, 1);
});

for (const shallow of [false, true]) for (const rate of [20, 10, "stopped", "unobserved"] as const)
  test(`${shallow ? "shallow" : "roofed"} unknown air requires observed server ticks at ${rate} tps`, async () => {
    const options = { mocked: true, server: { ticksPerSecond: rate === 10 ? 10 : 20, timePacketYet: rate !== "unobserved" } };
    const { bot, world, breath, clock, harness, left } = shallow ? fixture(options) : tunnelFixture(options);
    using _timers = clock.install();
    breath.hold(300);
    await clock.advance(50);
    Reflect.set(bot.entity, "metadata", []);
    if (shallow) bot.entity.position.y = 63.5;
    else bot.entity.position.x = 5.5;
    if (typeof rate === "string") harness.server.stop();
    const diving = new Diving(bot, world);
    let admission: NavigateOptions["movements"]["dive"];
    let calls = 0;
    const run = diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }) }, async (request) => {
      calls++;
      admission = request.movements.dive;
      return { status: "completed", elapsedMs: 0 };
    });
    const ticks = shallow ? 100 : 60;
    const elapsed = rate === "stopped" ? (shallow ? 15_000 : 9_000) : rate === "unobserved" ? (shallow ? 4_000 : 2_000) : ticks * 1_000 / rate;
    await clock.advance(elapsed - (typeof rate === "number" ? 50 : 1));
    assert.equal(calls, 0, `no admission before the observed window (${rate})`);
    await clock.settle(run, 51, 1);
    assert.equal(admission?.airTicks, shallow || typeof rate === "string" ? undefined : 300);
    assert.equal(bot.time.age, rate === "unobserved" ? null : rate === "stopped" ? 24_000 : 24_000 + ticks);
    assert.equal(clock.now(), elapsed + 50);
    assert.equal(bot.getControlState("jump"), false);
    assert.equal(clock.pendingGlobalTimers(), 0);
    assert.equal(left("physicsTick"), 0);
    await clock.advance(60_000);
    assert.equal(calls, 1);
});

test("every observation stop settles without client physics, preserves takeover controls and permits the next navigate", async () => {
  for (const shallow of [false, true]) for (const end of ["action", "request", "takeover"] as const) {
    const scene = shallow ? fixture({ mocked: true }) : tunnelFixture({ mocked: true });
    const { bot, world, breath, clock, left } = scene;
    using _timers = clock.install();
    breath.hold(300);
    await clock.advance(50);
    Reflect.set(bot.entity, "metadata", []);
    if (shallow) bot.entity.position.y = 63.5;
    else bot.entity.position.x = 5.5;
    const diving = new Diving(bot, world);
    const action = new AbortController();
    const request = new AbortController();
    let routes = 0;
    const run = diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }),
      signal: action.signal, stopSignal: request.signal }, async () => {
      routes++;
      return { status: "completed", elapsedMs: 0 };
    });
    const result = end === "action" ? assert.rejects(run, reason => reason === "action cancelled") : run;
    await clock.advance(0);
    bot.physicsEnabled = false;
    if (end === "action") action.abort("action cancelled");
    else if (end === "request") request.abort("request stopped");
    else {
      bot.setControlState("jump", true);
      diving.cancel("reflex owns the body");
    }
    const outcome = await clock.settle<NavigationResult | void>(result, 0);
    if (outcome !== undefined) assert.equal(outcome.status, "stopped");
    assert.equal(routes, 0);
    assert.equal(diving.active, false);
    assert.equal(bot.getControlState("jump"), end === "takeover");
    assert.equal(left("physicsTick"), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
    await clock.advance(60_000);
    const next = diving.run({ movements: createMovementPolicy({ allowSwimming: false }), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }) },
      async () => ({ status: "completed", elapsedMs: 0 }));
    assert.equal((await clock.settle(next, 0)).status, "completed");
  }
});

for (const planned of [false, true]) test(`a rejecting ${planned ? "planned" : "final"} return disposes its budget and preserves the primary outcome`, async () => {
  const { bot, world, breath, clock, left } = planned ? fixture({ mocked: true }) : tunnelFixture({ mocked: true });
  using _timers = clock.install();
  const diving = new Diving(bot, world);
  const fault = new Error("return navigation rejected");
  let calls = 0;
  const run = diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }) }, async () => {
    if (++calls === 1) {
      if (planned) {
        breath.setAirSupply(60);
        bot.emit("physicsTick");
      } else intoTheTunnel(bot, diving);
      return { status: "stopped", reason: "original route ended", elapsedMs: 0 };
    }
    throw fault;
  });
  if (planned) await assert.rejects(run, error => error === fault);
  else {
    const result = await run;
    assert.ok(result.status === "stopped" && result.reason === "original route ended");
  }
  assert.equal(diving.active, false);
  assert.equal(left("death") + left("respawn") + left("physicsTick"), 0);
  assert.equal(clock.pendingGlobalTimers(), 0);
  await clock.advance(60_000);
  assert.equal(calls, 2);
});

test("shallow air observation sees metadata after 60 server ticks at both rates", async () => {
  for (const ticksPerSecond of [10, 20]) {
    const { bot, world, breath, clock, left } = fixture({ mocked: true, server: { ticksPerSecond } });
    using _timers = clock.install();
    bot.entity.position.y = 63.5;
    breath.hold(300);
    await clock.advance(50);
    Reflect.set(bot.entity, "metadata", []);
    const tellAir = clock.after(60_000 / ticksPerSecond, () => breath.setAirSupply(200));
    const diving = new Diving(bot, world);
    let admission: NavigateOptions["movements"]["dive"];
    const run = diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }) }, async (request) => {
      admission = request.movements.dive;
      return { status: "completed", elapsedMs: 0 };
    });
    await clock.settle(run, 60_000 / ticksPerSecond);
    tellAir();
    assert.equal(admission?.airTicks, 200);
    assert.equal(bot.time.age, 24_060);
    assert.equal(clock.now(), 60_000 / ticksPerSecond + 50);
    assert.equal(bot.getControlState("jump"), false);
    assert.equal(clock.pendingGlobalTimers(), 0);
    assert.equal(left("physicsTick"), 0);
  }
});

// The breathing stop's return ends with the body held at its jump peak, 1.4 blocks over the pond's surface (y 64); the
// resumed leg is planned from there. Priced from the surface it is 298.3 ticks to the goal (admitted at 300); from the
// peak 359.9 (refused). The server's rate is part of the stop, so both rates run the whole stop.
for (const ticksPerSecond of [20, 10]) test(`a breathing stop's resumed leg from the jump peak is admitted as one from the surface, at ${ticksPerSecond} tps`, async () => {
  const { world, bot, breath, clock } = fixture({ mocked: true, server: { ticksPerSecond } });
  using _timers = clock.install();
  const diving = new Diving(bot, world);
  const goal = exactBlockGoal({ x: 0, y: 60, z: 0 });
  let calls = 0;
  let resumedAdmitted: boolean | undefined;
  const result = await diving.run({ movements: createMovementPolicy(), goal }, async (request) => {
    calls++;
    if (calls === 1) {
      bot.entity.position.y = 60;
      breath.setAirSupply(60);
      bot.emit("physicsTick");
      assert.equal(request.stopSignal?.aborted, true);
      return { status: "stopped", reason: String(request.stopSignal?.reason), elapsedMs: 0 };
    }
    if (calls === 2) {
      // The return to air ends at the jump peak; the air refills during the breath wait before the resumed leg.
      bot.entity.position.y = 65.4;
      breath.setAirSupply(300);
      return { status: "completed", elapsedMs: 0 };
    }
    assert.ok(request.movements.dive, "the resumed leg carries the dive policy");
    resumedAdmitted = admitsDive((x, y, z) => world.blockAt(x, y, z), { x: 0, y: 60, z: 0 }, request.movements.dive);
    return { status: "completed", elapsedMs: 0 };
  });
  assert.equal(result.status, "completed");
  assert.equal(calls, 3);
  assert.equal(resumedAdmitted, true, "the resumed leg from the jump peak is priced from the surface (y 64) and admitted");
});

/** A submerged westward stroke, optionally followed by a northward turn into an air pocket. */
function strokeFixture(ticksPerSecond: number, turn = false) {
  const scene = pond(new Vec3(1.5, 60.5, 0.5), false, { mocked: true, server: { ticksPerSecond } });
  for (const [x, z, kind] of [[1, 0, "water"], [0, 0, turn ? "water" : "air"], [0, -1, "air"]] as const)
    for (let y = 59; y <= 63; y++) scene.load({ x, y, z }, y === 59 || y === 63 ? "stone" : kind);
  scene.breath.hold(300);
  Reflect.set(scene.bot.entity, "isInWater", true);
  return scene;
}

for (const rate of [20, 10, "stopped"] as const) for (const direction of ["toward", "away", "sideways", "turn"] as const)
  test(`the backstop prices only the current ${direction} stroke at ${rate} tps`, async () => {
    const { bot, world, clock, harness, breath, left } = strokeFixture(rate === 10 ? 10 : 20, direction === "turn");
    using _timers = clock.install();
    await clock.advance(50);
    if (rate === "stopped") harness.server.stop();
    const age = bot.time.age;
    const diving = new Diving(bot, world);
    const result = await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }) }, async () => {
      const start = direction === "turn" ? 65 : 49; // 8 start + one/two 16-tick strokes + 25 reserve.
      assert.equal(diving.backstop(), start);
      bot.entity.position.x = direction === "away" ? 1.999 : 1;
      bot.entity.velocity.set(direction === "away" ? 0.1 : -0.1, 0, 0);
      if (direction === "sideways") bot.entity.position.z = 0.75;
      const expected = direction === "away" ? start + 7.984 : direction === "sideways" ? start + 4 : start - 8;
      const floor = diving.backstop();
      assert.ok(floor !== null && Math.abs(floor - expected) < 0.001, `mid-stroke floor ${floor}, wanted ${expected}`);
      if (direction === "toward") {
        bot.entity.velocity.x = 0;
        assert.equal(diving.backstop(), 49, "a stationary body earns no progress credit");
        bot.entity.velocity.x = -0.1;
        if (rate !== "stopped") {
          let sense!: () => unknown;
          // Only registration is stubbed; the production sense reads the shared fake's air metadata packet.
          const driver = { register(definition: { sense: () => unknown }) {
            sense = definition.sense;
            return { [Symbol.asyncDispose]: async () => {} };
          } };
          await using _reflex = attachBreathReflex(bot, driver as never, () => diving.backstop());
          breath.setAirSupply(42); // New floor 41, old 49.
          assert.equal(sense(), null, "42 air is above the mid-stroke floor of 41");
          for (const air of [40, 41]) {
            breath.setAirSupply(air);
            assert.equal((sense() as { kind: string }).kind, "observed", `${air} air is at or below the floor`);
          }
        }
      }
      assert.equal(clock.now(), 50, "both reads use the same first packet, cached age 0, fake time 50 ms");
      assert.equal(bot.time.age, age);
      return { status: "completed", elapsedMs: 0 };
    });
    assert.equal(result.status, "completed");
    assert.equal(left("physicsTick") + left("death") + left("respawn"), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
    await clock.advance(60_000);
    assert.equal(diving.backstop(), null);
  });

for (const ticksPerSecond of [20, 10]) test(`a vertical stroke spends only its remaining rise at ${ticksPerSecond} tps`, async () => {
  const { bot, world, clock, left } = fixture({ mocked: true, server: { ticksPerSecond } });
  using _timers = clock.install();
  await clock.advance(50);
  const diving = new Diving(bot, world);
  bot.entity.position.y = 61.5;
  await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 61, z: 0 }) }, async () => {
    assert.equal(diving.backstop(), 53); // 8 start + two rises of 10 + 25 reserve.
    bot.entity.position.y = 61.999;
    bot.entity.velocity.set(0, 0.1, 0);
    assert.ok(Math.abs(diving.backstop()! - 48.01) < 0.001);
    return { status: "completed", elapsedMs: 0 };
  });
  assert.equal(left("physicsTick") + left("death") + left("respawn"), 0);
  assert.equal(clock.pendingGlobalTimers(), 0);
});

for (const ticksPerSecond of [20, 10]) test(`a changed ascent and a cancelled dive never carry a stroke at ${ticksPerSecond} tps`, async () => {
  const { bot, world, clock, load, left } = strokeFixture(ticksPerSecond);
  using _timers = clock.install();
  await clock.advance(50);
  const diving = new Diving(bot, world);
  const options = { movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }) };
  bot.entity.position.x = 1;
  bot.entity.velocity.set(-0.1, 0, 0);
  await diving.run(options, async () => {
    assert.equal(diving.backstop(), 49, "the first mid-stroke read keeps the full cell price");
    assert.equal(diving.backstop(), 41);
    for (let y = 60; y <= 62; y++) load({ x: 0, y, z: 0 }, "stone");
    assert.equal(diving.backstop(), 300, "a lost ascent requests rescue and forgets the stroke");
    for (let y = 60; y <= 62; y++) load({ x: 0, y, z: 0 }, "air");
    assert.equal(diving.backstop(), 49, "a reappearing ascent starts uncredited");
    assert.equal(diving.backstop(), 41);
    diving.cancel("reflex takeover");
    assert.equal(diving.backstop(), 49, "cancel forgets the stroke immediately");
    return { status: "stopped", reason: "reflex takeover", elapsedMs: 0 };
  });
  await diving.run(options, async () => {
    assert.equal(diving.backstop(), 49, "the next dive at the same mid-stroke body starts fresh");
    assert.equal(diving.backstop(), 41);
    for (let y = 60; y <= 62; y++) {
      load({ x: 0, y, z: 0 }, "stone");
      load({ x: 2, y, z: 0 }, "air");
    }
    bot.entity.position.x = 1.999;
    bot.entity.velocity.x = 0.1;
    assert.equal(diving.backstop(), 49, "a changed next cell gets no reduction on its first read");
    assert.ok(Math.abs(diving.backstop()! - 41.016) < 0.001);
    return { status: "completed", elapsedMs: 0 };
  });
  assert.equal(left("physicsTick") + left("death") + left("respawn"), 0);
  assert.equal(clock.pendingGlobalTimers(), 0);
  await clock.advance(60_000);
  assert.equal(diving.backstop(), null);
});

for (const ticksPerSecond of [20, 10]) test(`dry eyes, death, respawn, breathing return and resume forget the stroke at ${ticksPerSecond} tps`, async () => {
  const { bot, world, clock, breath, left } = strokeFixture(ticksPerSecond);
  using _timers = clock.install();
  await clock.advance(50);
  const diving = new Diving(bot, world);
  const options = { movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }) };
  bot.entity.position.x = 1;
  bot.entity.velocity.set(-0.1, 0, 0);
  let calls = 0;
  const result = await diving.run(options, async request => {
    calls++;
    assert.equal(diving.backstop(), 49, "every leg, return and resume begins without credit");
    assert.equal(diving.backstop(), 41);
    if (calls === 1) {
      for (const event of ["death", "respawn"] as const) {
        bot.emit(event);
        assert.equal(diving.backstop(), 49, `${event} forgets the remembered cell`);
        assert.equal(diving.backstop(), 41);
      }
      bot.entity.position.x = 0.5;
      assert.equal(diving.backstop(), DIVE_BACKSTOP_TICKS);
      bot.entity.position.x = 1;
      assert.equal(diving.backstop(), 49, "dry eyes forget the stroke");
      assert.equal(diving.backstop(), 41);
      breath.setAirSupply(60);
      bot.emit("physicsTick");
      assert.equal(request.stopSignal?.aborted, true);
      return { status: "stopped", reason: String(request.stopSignal?.reason), elapsedMs: 0 };
    }
    breath.setAirSupply(300);
    return { status: "completed", elapsedMs: 0 };
  });
  assert.equal(result.status, "completed");
  assert.equal(calls, 3);
  assert.equal(left("physicsTick") + left("death") + left("respawn"), 0);
  assert.equal(clock.pendingGlobalTimers(), 0);
  await clock.advance(60_000);
  assert.equal(diving.backstop(), null);
});
