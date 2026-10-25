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
import { DIVE_BACKSTOP_TICKS } from "./world/swimming.js";

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

test("planned breathing returns to the original goal after observing full air", async () => {
  const { world, bot, breath, left } = fixture();
  const states: string[] = [];
  const diving = new Diving(bot, world, (state) => states.push(state));
  const goal = exactBlockGoal({ x: 0, y: 60, z: 0 });
  let calls = 0;
  const result = await diving.run({ movements: createMovementPolicy(), goal }, async (request) => {
    calls++;
    if (calls === 1) {
      breath.setAirSupply(60);
      bot.emit("physicsTick");
      assert.equal(request.stopSignal?.aborted, true);
      return { status: "stopped", reason: String(request.stopSignal?.reason), elapsedMs: 0 };
    }
    if (calls === 2) {
      assert.notEqual(request.goal, goal);
      bot.entity.position.y = 63.5;
      breath.setAirSupply(300);
    } else assert.equal(request.goal, goal);
    return { status: "completed", elapsedMs: 0 };
  });
  assert.equal(result.status, "completed");
  assert.equal(calls, 3);
  assert.deepEqual(states, ["breathing", "resumed", "released"]);
  assert.equal(diving.active, false);
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
  const { world, bot, breath, left } = fixture();
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
      return { status: "stopped", reason: String(request.stopSignal?.reason), elapsedMs: 0 };
    }
    if (calls === 2) {
      admission = returnAdmission(request);
      bot.entity.position.y = 63.5;
      breath.setAirSupply(300);
    }
    return { status: "completed", elapsedMs: 0 };
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(admission, { origin: { x: 0.5, y: 60, z: 0.5 }, airTicks: 60, toAir: true });
  assert.deepEqual(states, ["breathing", "resumed", "released"]);
  // The next request starts clean from the state the stop left.
  assert.equal(diving.active, false);
  assert.equal(left("physicsTick"), 0);
  assert.equal((await diving.run({ movements: createMovementPolicy(), goal }, async () => ({ status: "completed", elapsedMs: 0 }))).status, "completed");
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

test("roofed and with no air metadata, a submerged start takes its air as unchanged and plans a dive", async () => {
  const { world, bot, harness, clock, load } = pond(new Vec3(0.5, 60.2, 0.5), true, { mocked: true });
  using _timers = clock.install();
  for (let x = -3; x <= 3; x++)
    for (let y = 59; y <= 66; y++) load({ x, y, z: 0 }, y === 59 || (y === 62 && x >= -1 && x <= 1) ? "stone" : y <= 63 ? "water" : "air");
  // The premise of the live case (2026-10-10): the server sends no air for the head under water, so a silent server.
  harness.server.stop();
  const diving = new Diving(bot, world);
  let dive: unknown;
  const run = diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 3, y: 60, z: 0 }) }, async (request) => {
    dive = request.movements.dive;
    return { status: "completed", elapsedMs: 0 };
  });
  await clock.settle(run, 10_000);
  assert.deepEqual(Object.keys(dive as object), ["origin", "airTicks"]);
  assert.equal((dive as { airTicks: number }).airTicks, 300);
});

// ── A run that ends under a roof swims back to the last air it passed (run 15, Sana) ───────────────

/** An air pocket at x -2..0 and a water tunnel x 1..8 (y 60-61), roofed (y 62) and floored (y 59), z 0 only. */
function tunnelFixture() {
  const tunnel = pond(new Vec3(0.5, 60, 0.5), true);
  for (let x = -2; x <= 8; x++)
    for (let y = 59; y <= 62; y++) tunnel.load({ x, y, z: 0 }, y === 59 || y === 62 ? "stone" : x <= 0 ? "air" : "water");
  tunnel.breath.setAirSupply(300);
  return tunnel;
}

test("a dive that fails five blocks into a roofed tunnel swims back to the air pocket before it releases", async () => {
  const { world, bot, left } = tunnelFixture();
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
});

test("a takeover cancel leaves the swim back to the reflex that took the body", async () => {
  const { world, bot } = tunnelFixture();
  const diving = new Diving(bot, world);
  let calls = 0;
  await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 8, y: 60, z: 0 }) }, async () => {
    calls++;
    bot.emit("physicsTick");
    diving.committed({ steps: [movementStep("swim", { x: 4, y: 60, z: 0 }, { x: 5, y: 60, z: 0 })] });
    bot.entity.position.x = 5.5;
    diving.cancel("takeover");
    return { status: "stopped", reason: "takeover", elapsedMs: 0 };
  });
  assert.equal(calls, 1);
});

test("a death during the swim back ends it cleanly", async () => {
  const { world, bot, left } = tunnelFixture();
  const diving = new Diving(bot, world);
  let calls = 0;
  const result = await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 8, y: 60, z: 0 }) }, async (request) => {
    calls++;
    if (calls === 1) {
      bot.emit("physicsTick");
      diving.committed({ steps: [movementStep("swim", { x: 4, y: 60, z: 0 }, { x: 5, y: 60, z: 0 })] });
      bot.entity.position.x = 5.5;
      return { status: "failed", elapsedMs: 0 } as never;
    }
    bot.emit("death");
    assert.equal(request.stopSignal?.aborted, true, "the swim back is told to stop");
    return { status: "stopped", reason: "died", elapsedMs: 0 };
  });
  assert.equal(result.status, "failed");
  assert.equal(calls, 2);
  assert.equal(diving.active, false);
  assert.equal(left("death"), 0);
  assert.equal(left("respawn"), 0);
});

// Review 2026-10-18 (run 15 fixes), blocking 3: the swim back ran after successful arrivals and ignored the action's cancel.

/** The first navigate of a run into the tunnel: the pocket passed with the head in air, then the dive owned, five blocks in. */
function intoTheTunnel(bot: Bot, diving: Diving): void {
  bot.emit("physicsTick");
  diving.committed({ steps: [movementStep("swim", { x: 4, y: 60, z: 0 }, { x: 5, y: 60, z: 0 })] });
  bot.entity.position.x = 5.5;
}

test("a goal under water that was reached is where the run ends: no swim back undoes the arrival", async () => {
  const { world, bot } = tunnelFixture();
  const diving = new Diving(bot, world);
  let calls = 0;
  const result = await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 5, y: 60, z: 0 }) }, async () => {
    calls++;
    intoTheTunnel(bot, diving);
    return { status: "completed", elapsedMs: 0 };
  });
  assert.equal(result.status, "completed");
  assert.equal(calls, 1, "the arrival is not swum back from");
  assert.equal(bot.entity.position.x, 5.5);
});

test("the action cancelled during the swim back stops it at once, with no control held", async () => {
  const { world, bot, left } = tunnelFixture();
  const held = new Set<string>();
  bot.setControlState = (control, active) => void (active ? held.add(control) : held.delete(control));
  const diving = new Diving(bot, world);
  const cancel = new AbortController();
  let calls = 0;
  let stoppedAtOnce = false;
  await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 8, y: 60, z: 0 }), signal: cancel.signal }, async (request) => {
    calls++;
    if (calls === 1) {
      intoTheTunnel(bot, diving);
      return { status: "stopped", reason: "no route", elapsedMs: 0 };
    }
    cancel.abort("cancelled by the model");
    stoppedAtOnce = request.stopSignal?.aborted === true;
    return { status: "stopped", reason: "cancelled", elapsedMs: 0 };
  });
  assert.equal(calls, 2);
  assert.equal(stoppedAtOnce, true, "the swim back is told to stop when the action is cancelled");
  assert.equal(held.size, 0);
  assert.equal(diving.active, false);
  assert.equal(left("death") + left("respawn") + left("physicsTick"), 0);
});

test("an action already cancelled when its run ends does not start a swim back", async () => {
  const { world, bot } = tunnelFixture();
  const diving = new Diving(bot, world);
  const cancel = new AbortController();
  let calls = 0;
  await assert.rejects(diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 8, y: 60, z: 0 }), signal: cancel.signal }, async () => {
    calls++;
    intoTheTunnel(bot, diving);
    cancel.abort("cancelled by the model");
    throw cancel.signal.reason;
  }), /cancelled by the model/);
  assert.equal(calls, 1);
  assert.equal(diving.active, false);
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

test("the backstop of a roofed dive does not ask a rescue while the eyes are in the air above flowing water of level 4", async () => {
  assert.equal(await backstopUnderRoof(4), DIVE_BACKSTOP_TICKS);
});

test("the backstop of a roofed dive still asks an immediate rescue with the eyes under a source and no ascent", async () => {
  assert.equal(await backstopUnderRoof(0), 300);
});

// NAVP-13 (run 15: the server 2.5-4.6 s behind): the breathing stop counted 100 client ticks for full air. The fake
// server on 14 ticks a second (30 % behind) moves the world age so the bound is about 7-8 s (time packets come each
// second); its air packets come 3 s late and its air ticks 14 a second like everything the server counts: the
// full air (60 refill ticks, 4.3 s, then 3 s late) is heard at about 7.3 s, past the 100 client ticks (5 s) and inside the age bound.
test("a server behind the client still completes the breathing stop: full air reported late is waited for", async () => {
  const { world, bot, breath, clock } = fixture({ mocked: true, lagMs: 3_000, server: { ticksPerSecond: 14 } });
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
    // At the surface the server refills 4 a tick, and says so 3 s late.
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
