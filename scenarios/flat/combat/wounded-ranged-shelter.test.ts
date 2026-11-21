/** The wounded shelter driver judges a recovered shelter, not a health bar that rose on its own (plan 2026-11-18-scenario-reds-part2-a3 T13i, D35). */
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import type { SurvivalReceipt } from "../../../src/survival/evidence/contract.js";
import { DEFAULT_SURVIVAL_POLICY } from "../../../src/survival/policy/contract.js";
import type { Runtime } from "../../src/runtime.ts";
import { type Encounter, type ReflexOutcome } from "./reflex.ts";
import {
  declareRecoveryHighs, judgeShelter, phaseWaiter, readShelterReads, stageWound, watchDamage,
  type DamageLatch, type ShelterEvidence, type ShelterRead,
} from "./wounded-ranged-shelter.ts";

/** One published encounter outcome; only the fields the judge reads vary. */
function encounter(response: Encounter["response"], outcome: string, healthAfter: number): ReflexOutcome {
  return {
    kind: "encounter", response, outcome, reason: "test", interrupted: null, healthBefore: 10, healthAfter, attacks: 0,
    combatStyles: [], weaponsUsed: [], shieldRaisedSwings: 0, projectileGuards: 0, explosions: 0,
    finalPosition: { x: 0, y: -60, z: 0 }, finalDistances: [],
  };
}
const limit = (): ReflexOutcome => ({ kind: "limit", response: "hide", limit: "no_progress", elapsedMs: 1, lastProgress: null });
const failure = (): ReflexOutcome => ({ kind: "failed", response: "hide", failure: "execution_failed", why: "x" });

/** One read of the three streams, in the order the events were recorded (what `readReflexOutcomes` returns). */
function read(...ordered: ReflexOutcome[]): ShelterRead {
  const encounters = ordered.flatMap(({ kind, ...rest }) => (kind === "encounter" ? [rest as Encounter] : []));
  return {
    encounters, ordered,
    limits: ordered.filter((o): o is Extract<ReflexOutcome, { kind: "limit" }> => o.kind === "limit"),
    failures: ordered.filter((o): o is Extract<ReflexOutcome, { kind: "failed" }> => o.kind === "failed"),
  };
}
const evidence = (reads: ShelterRead[], extra: Partial<ShelterEvidence> = {}): ShelterEvidence =>
  ({ protection: "buildable", shots: 3, health: 18.7, minimumHealth: 7, reads, ...extra });
const judged = (reads: ShelterRead[], extra: Partial<ShelterEvidence> = {}) => judgeShelter(evidence(reads, extra));

// t00631 (10 tps): the hide ended `hidden` with no error; t00638 (20 tps): `capability_limit`, "Emergency hide failed ... (projectile)".
test("a qualifying hide is found, wherever it sits among the reads and earlier outcomes", () => {
  const hidden = encounter("hide", "hidden", 18);
  for (const [name, reads] of [
    ["alone", [read(hidden)]],
    ["behind an earlier evade receipt (t00631)", [read(encounter("evade", "safe_separation", 9), hidden)]],
    ["in a later read (a receipt after the health)", [read(), read(), read(hidden)]],
    ["after an earlier failure, limit and failed encounter", [read(failure(), limit(), encounter("evade", "failed", 9)), read(hidden)]],
    ["after an earlier failure in the same read", [read(failure(), hidden)]],
  ] as const) assert.equal(judged([...reads]).status, "succeeded", name);
});

test("no recovered shelter fails: a failed hide that healed outside (t00638), a hold below the line, no outcome at all", () => {
  for (const [name, reads] of [
    ["t00638", [read(encounter("hide", "capability_limit", 12))]],
    ["hidden at 12", [read(encounter("hide", "hidden", 12))]],
    ["hidden at 17.9", [read(encounter("hide", "hidden", 17.9))]],
    ["no outcome read", [read(), read()]],
    ["no read", []],
  ] as const) {
    const verdict = judged([...reads]);
    assert.equal(verdict.status, "failed", name);
    assert.match(verdict.why, /no recovered shelter/, name);
  }
});

test("a failure of any kind after the qualifying hide fails, in the same read or a later one", () => {
  const hidden = encounter("hide", "hidden", 18);
  for (const [kind, after] of [
    ["capability_limit", encounter("evade", "capability_limit", 18)],
    ["failed encounter", encounter("fight", "failed", 18)],
    ["limit", limit()],
    ["reflex failure", failure()],
  ] as const) {
    for (const [where, reads] of [["same read", [read(hidden, after)]], ["later read", [read(hidden), read(after)]]] as const) {
      const verdict = judged([...reads]);
      assert.equal(verdict.status, "failed", `${kind}, ${where}`);
      assert.match(verdict.why, /after the shelter/, `${kind}, ${where}`);
    }
  }
});

test("unbuildable protection needs no hide", () => {
  assert.equal(judged([read()], { protection: "unbuildable" }).status, "succeeded");
});

for (const [name, extra] of [
  ["a death", { minimumHealth: 0 }],
  ["no projectile shot", { shots: 0 }],
  ["health below 18", { health: 17.999998092651367 }],
] as const) {
  test(`${name} fails even with a recovered hide`, () => {
    assert.equal(judged([read(encounter("hide", "hidden", 18))], extra).status, "failed");
    assert.equal(judged([read()], { ...extra, protection: "unbuildable" }).status, "failed");
  });
}

test("the healthy line is the policy's own recovery target, 18 included, 17.9 excluded", () => {
  assert.equal(DEFAULT_SURVIVAL_POLICY.combat.recover_to_health, 18, "the fixture assumes the default recovery target");
  assert.equal(judged([read(encounter("hide", "hidden", 18))], { health: 18 }).status, "succeeded");
  assert.equal(judged([read(encounter("hide", "hidden", 18))], { health: 17.9 }).status, "failed");
});

/**
 * A shared-fake trial: the server answers `/damage @s N minecraft:magic` one tick later through its hurt window
 * (`fake-bot-combat.ts`: a hurt inside the window costs only the excess, as the game does, t00631), and `landing`
 * lets a test change what the game does with the amount.
 */
const latches: DamageLatch[] = [];
const track = (latch: DamageLatch): DamageLatch => (latches.push(latch), latch);

function arena(rate: number, landing: (amount: number) => number = (amount) => amount, drop = false) {
  const clock = createFakeClock({ mode: "mocked" });
  const sent: { text: string; serverTick: number }[] = [];
  const harness = createFakeBot({
    clock,
    server: { startAge: 1_000, ticksPerSecond: rate },
    overrides: {
      chat: (text: string) => {
        const wound = /^\/damage @s (\d+) minecraft:magic$/.exec(text);
        sent.push({ text, serverTick: harness.server.gameTime });
        if (wound && !drop) harness.server.answer(() => harness.combat.hurtBot(landing(Number(wound[1])), null));
      },
    },
  });
  const controller = new AbortController();
  const added = listenersAddedSince(harness.bot);
  const clientAdded = listenersAddedSince(harness.bot._client);
  const assertClean = () => {
    // The latch owns the pace observer's `time` listener: a trial ends by releasing it, as the driver's `using` does.
    for (const latch of latches.splice(0)) latch[Symbol.dispose]();
    for (const event of ["health", "time", "physicsTick"]) assert.equal(added(event), 0, event);
    assert.equal(clientAdded("damage_event"), 0, "damage_event");
    assert.equal(clock.pendingTimers(), 0);
  };
  const tick = (ticks = 1) => clock.advance((ticks * 1_000) / rate);
  return { ...harness, sent, controller, context: { bot: harness.bot, signal: controller.signal }, assertClean, tick };
}

/** One `stageWound` row: what the game does with the 6 points sent after the lava's 4, and the status that follows. */
const STAGING_ROWS: readonly { name: string; landing: (amount: number) => number; status: string; healthAfter: number }[] = [
  { name: "whole amount", landing: (a) => a, status: "wounded", healthAfter: 10 },
  { name: "lands 2 past the target (band edge, in)", landing: (a) => a + 2, status: "wounded", healthAfter: 8 },
  { name: "lands 2.01 past the target (band edge, out)", landing: (a) => a + 2.01, status: "off_band", healthAfter: 7.99 },
  { name: "lands 0.005 short (float noise, whole)", landing: (a) => a - 0.005, status: "wounded", healthAfter: 10.005 },
  { name: "lands 0.02 short (partial)", landing: (a) => a - 0.02, status: "partial", healthAfter: 10.02 },
  { name: "kills", landing: () => 50, status: "died", healthAfter: 0 },
];

for (const rate of [20, 10]) {
  for (const row of STAGING_ROWS) {
    test(`a wound sent after the lava's hurt window: ${row.name}, at ${rate} tps`, async () => {
      const { clock, combat, bot, server, context, sent, assertClean } = arena(rate, row.landing);
      using _timers = clock.install();
      const latch = track(watchDamage(bot));
      combat.hurtBot(4, null); // the lava touch: 20 -> 16, opening a window of ten ticks
      const lavaTick = server.gameTime;
      assert.notEqual(latch.creditedTicks(), null, "the latch heard the lava touch");
      const staged = await clock.settle(stageWound(context, 10, latch), 10_000);
      assert.equal(staged.status, row.status);
      assert.equal(staged.sent, 6);
      assert.equal(staged.healthBefore, 16);
      assert.ok(Math.abs(staged.healthAfter - row.healthAfter) < 1e-6, `health after ${staged.healthAfter}`);
      assert.deepEqual(sent.map((s) => s.text), ["/damage @s 6 minecraft:magic"]);
      assert.ok(sent[0]!.serverTick - lavaTick >= 10, `sent ${sent[0]!.serverTick - lavaTick} server ticks after the lava touch`);
      assertClean();
    });
  }

  test(`a wound sent inside the window is partial, as t00631 at ${rate} tps (16 -> 14, 6 sent)`, async () => {
    const { clock, combat, context, sent, tick, assertClean } = arena(rate);
    using _timers = clock.install();
    combat.hurtBot(4, null);
    await tick();
    // No latch armed before the lava: the staging cannot know the window is open and sends at once.
    const staged = await clock.settle(stageWound(context, 10, { creditedTicks: () => null, [Symbol.dispose]() {} }), 10_000);
    assert.deepEqual(staged, { status: "partial", sent: 6, healthBefore: 16, healthAfter: 14 });
    assert.equal(sent.length, 1);
    assertClean();
  });

  test(`a command the server never answers is unanswered after 40 server ticks of world age at ${rate} tps`, async () => {
    const { clock, combat, bot, context, tick, assertClean } = arena(rate, undefined, true);
    using _timers = clock.install();
    const latch = track(watchDamage(bot));
    combat.hurtBot(4, null);
    await tick();
    const start = bot.time.age!;
    const staged = await clock.settle(stageWound(context, 10, latch), 20_000);
    assert.equal(staged.status, "unanswered");
    assert.ok(bot.time.age! - start >= 40, `waited ${bot.time.age! - start} ticks`);
    assertClean();
  });

  test(`a window that never closes ends as no_window after its bound, no command sent, at ${rate} tps`, async () => {
    const { clock, bot, context, sent, assertClean } = arena(rate);
    using _timers = clock.install();
    const start = bot.time.age!;
    const stuck: DamageLatch = { creditedTicks: () => 0, [Symbol.dispose]() {} };
    const staged = await clock.settle(stageWound(context, 10, stuck), 20_000);
    assert.equal(staged.status, "no_window");
    assert.equal(sent.length, 0);
    assert.ok(bot.time.age! - start >= 50, `waited ${bot.time.age! - start} ticks`);
    assertClean();
  });

  test(`a burn that hurts every 20 ticks leaves a window ten ticks into each gap, and the wound lands whole, at ${rate} tps`, async () => {
    const { clock, combat, bot, server, context, sent, tick, assertClean } = arena(rate);
    using _timers = clock.install();
    const latch = track(watchDamage(bot));
    combat.hurtBot(4, null);
    for (let burn = 0; burn < 3; burn++) {
      await tick(20);
      combat.hurtBot(1, null); // the on_fire tick of the burning fixture (trace: damage events 20 ticks apart)
    }
    const lastHurt = server.gameTime;
    const staged = await clock.settle(stageWound(context, 10, latch), 10_000);
    assert.equal(staged.status, "wounded");
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.serverTick - lastHurt >= 10, `sent ${sent[0]!.serverTick - lastHurt} server ticks after the last burn tick`);
    assertClean();
  });
}

test("the window threshold has a case on each side: 9.9 credited ticks wait, 10 send", async () => {
  for (const [credited, commands] of [[9.9, 0], [10, 1]] as const) {
    const { clock, combat, context, sent, assertClean } = arena(20);
    using _timers = clock.install();
    combat.hurtBot(4, null);
    const staged = await clock.settle(stageWound(context, 10, { creditedTicks: () => credited, [Symbol.dispose]() {} }), 20_000);
    assert.equal(sent.length, commands, `${credited} credited ticks: ${staged.status}`);
    assert.equal(staged.status === "no_window", commands === 0, `${credited} credited ticks`);
    assertClean();
  }
});

test("a health already at the target needs no command (each side of the rounding bound)", async () => {
  for (const [health, command] of [[10.4, false], [10.5, true], [9.5, false]] as const) {
    const { clock, combat, bot, context, sent, assertClean } = arena(20);
    using _timers = clock.install();
    const latch = track(watchDamage(bot));
    combat.setHealth(health);
    const staged = await clock.settle(stageWound(context, 10, latch), 10_000);
    assert.equal(sent.length, command ? 1 : 0, `health ${health}`);
    assert.equal(staged.status, "wounded", `health ${health}`);
    assert.equal(staged.sent, command ? 1 : 0);
    assertClean();
  }
});

test("a stopped server ends the wait by its stall bound with a bounded failure", async () => {
  const { clock, server, bot, context, assertClean } = arena(20);
  using _timers = clock.install();
  const latch = track(watchDamage(bot));
  server.stop();
  const staged = await clock.settle(stageWound(context, 10, latch), 120_000);
  assert.equal(staged.status, "unanswered", "no damage heard: the window wait ends at once, the answer wait ends by its stall bound");
  assertClean();
});

test("an abort during the window wait rejects and leaves no listener", async () => {
  const { clock, combat, bot, context, controller, assertClean } = arena(20);
  using _timers = clock.install();
  const latch = track(watchDamage(bot));
  combat.hurtBot(4, null);
  const settled = assert.rejects(stageWound(context, 10, latch), /abort/i);
  controller.abort(new Error("aborted by the test"));
  await clock.settle(settled, 10_000);
  assertClean();
});

test("the damage latch keeps the time of the bot's own damage events only and releases its listener", async () => {
  const { clock, combat, bot, entities, assertClean } = arena(20);
  using _timers = clock.install();
  const latch = track(watchDamage(bot));
  assert.equal(latch.creditedTicks(), null);
  const other = entities.spawn({ name: "zombie", position: bot.entity.position.offset(3, 0, 0) });
  combat.hurt(other.id, null, 1);
  assert.equal(latch.creditedTicks(), null, "another entity's hurt is not the bot's");
  await clock.advance(100);
  combat.hurtBot(2, null);
  assert.notEqual(latch.creditedTicks(), null);
  assertClean();
});

test("recovery highs report only a new health high, never an oscillation or a still world age", async () => {
  const { clock, combat, bot, server, assertClean } = arena(20);
  using _timers = clock.install();
  combat.setHealth(10);
  const reasons: string[] = [];
  {
    using _highs = declareRecoveryHighs(bot, (reason) => void reasons.push(reason));
    for (const health of [10, 9, 11, 10, 12]) {
      await clock.advance(1_000); // 20 server ticks at 20 tps: the next time packet, so the world age moved
      combat.setHealth(health);
    }
    assert.deepEqual(reasons, ["health high 11", "health high 12"]);
    server.stop();
    combat.setHealth(15); // a health packet while the world age stands still is no progress
    await clock.advance(500);
    assert.deepEqual(reasons, ["health high 11", "health high 12"]);
  }
  combat.setHealth(19);
  assert.equal(reasons.length, 2, "disposed highs report nothing");
  assertClean();
});

/** The goal budget shared by every phase: `timeout` game seconds from the first age, minus the terminal read's ticks. */
for (const rate of [20, 10]) {
  const waiter = (timeout: number) => {
    const arenaForRate = arena(rate);
    const scenario = { goal: { timeout } } as unknown as Parameters<typeof phaseWaiter>[0]["scenario"];
    return { ...arenaForRate, wait: phaseWaiter({ bot: arenaForRate.bot, scenario }, arenaForRate.controller.signal) };
  };

  test(`a phase wait ends when its condition holds, at ${rate} tps`, async () => {
    const { clock, bot, wait, assertClean } = waiter(30);
    using _timers = clock.install();
    const target = bot.time.age! + 100;
    await clock.settle(wait("recovery", () => bot.time.age! >= target), 60_000);
    assert.ok(bot.time.age! >= target);
    assertClean();
  });

  test(`a phase wait throws, naming the phase, when the goal budget runs out at ${rate} tps (3 s = 60 ticks, 40 kept for the terminal read)`, async () => {
    const { clock, bot, wait, assertClean } = waiter(3);
    using _timers = clock.install();
    const start = bot.time.age!;
    await clock.settle(assert.rejects(wait("first shot", () => false), /first shot: the goal budget ran out/), 60_000);
    assert.ok(bot.time.age! - start >= 20 && bot.time.age! - start < 60 + 40, `spent ${bot.time.age! - start} ticks`);
    assertClean();
  });

  test(`a phase wait throws when the world age stands still, at ${rate} tps`, async () => {
    const { clock, server, wait, assertClean } = waiter(90);
    using _timers = clock.install();
    server.stop();
    await clock.settle(assert.rejects(wait("lava", () => false), /lava: the server's world age stood still/), 120_000);
    assertClean();
  });

  test(`the budget is shared: a later phase gets what the earlier ones left, at ${rate} tps`, async () => {
    const { clock, bot, wait, assertClean } = waiter(4); // 80 ticks, 40 kept: 40 for all phases
    using _timers = clock.install();
    const first = bot.time.age! + 30;
    await clock.settle(wait("lava", () => bot.time.age! >= first), 60_000);
    await clock.settle(assert.rejects(wait("recovery", () => false), /recovery: the goal budget ran out/), 60_000);
    assert.ok(bot.time.age! - (first - 30) < 80, "the second wait did not get a fresh budget");
    assertClean();
  });
}

/** The survival status a receipt carries (the shape of `reflex.test.ts` `encounterRuntime`). */
const idleStatus: SurvivalReceipt["status"] = {
  summary: "safe", request: null,
  owner: { current: null, reserved: null, connected: true, transfer: null },
  dangers: [], response: null, decisions: [], budgets: [], answered: [],
  observations: { missing: [], stale: [] },
  policy: { revision: "test", defaults: DEFAULT_SURVIVAL_POLICY, effective: DEFAULT_SURVIVAL_POLICY,
    overrides: [], encounter: null, response: null, settling: false, lastChange: "Default policy.", constraint: null },
  vitals: { health: 20, food: 20, air: null, inWater: false },
  runtime: { liveness: "observed_in_process", observedAt: 1, physicsObservedAt: 1 },
};

/** A runtime whose one `hide hidden` receipt is published once `arrives()` holds (`reflex.test.ts` `encounterRuntime` shape). */
function hideRuntime(arrives: () => boolean, busy: () => boolean = () => false): Runtime {
  const outcome = {
    response: "hide", outcome: "hidden", reason: "hurt", interrupted: null, healthBefore: 10, healthAfter: 18.5,
    attacks: 0, combatStyles: [], weaponsUsed: [], shieldRaisedSwings: 0, projectileGuards: 0, explosions: 0,
    finalPosition: { x: 0, y: -60, z: 0 }, finalDistances: [],
  };
  let delivered = false;
  return {
    status: () => ({ busy: busy() }),
    close: async () => {},
    actions: [{ name: "read_recent_events" }],
    run: async () => {
      const events = delivered || !arrives() ? [] : [{
        type: "survival_outcome", eventId: 1, botId: "TestBot", observedAt: "now", summary: "hide finished",
        payload: { kind: "outcome", source: "hostile_reflex", evidence: { outcome, interrupted: null }, status: idleStatus },
      }];
      delivered ||= events.length > 0;
      return { result: { status: "succeeded", source: { queryIds: ["test"] }, readThroughEventId: delivered ? 1 : 0, remainingEventCount: 0, events } };
    },
  } as unknown as Runtime;
}

for (const rate of [20, 10]) {
  test(`a hide receipt published during the terminal window is read at ${rate} tps (t00657: one poll read, 40 ticks of waiting, no read after)`, async () => {
    const { clock, server, context, assertClean } = arena(rate);
    using _timers = clock.install();
    const startAge = server.age;
    const reads = await clock.settle(readShelterReads(context, hideRuntime(() => server.age >= startAge + 30), true, 400), 60_000);
    assert.equal(judged(reads).status, "succeeded");
    assertClean();
  });

  test(`a hide receipt that never comes ends the terminal read with the window, not a hang, at ${rate} tps`, async () => {
    const { clock, server, bot, context, assertClean } = arena(rate);
    using _timers = clock.install();
    const startAge = server.age;
    const reads = await clock.settle(readShelterReads(context, hideRuntime(() => false), true, 400), 60_000);
    assert.equal(judged(reads).status, "failed");
    const waited = bot.time.age! - startAge;
    assert.ok(waited >= 40 && waited < 200, `an idle body ends the read ${waited} ticks in: 40 after it was seen idle, not the 400 of the budget`);
    assertClean();
  });

  test(`a hide still running when the health is back is waited for until its receipt, at ${rate} tps (t00769: the runtime was closed under it)`, async () => {
    const { clock, server, context, assertClean } = arena(rate);
    using _timers = clock.install();
    const startAge = server.age;
    const hold = () => server.age < startAge + 150;
    const reads = await clock.settle(readShelterReads(context, hideRuntime(() => !hold(), hold), true, 400), 120_000);
    assert.equal(judged(reads).status, "succeeded");
    assertClean();
  });

  test(`a hide that never ends is waited for to the budget and fails there, at ${rate} tps`, async () => {
    const { clock, server, bot, context, assertClean } = arena(rate);
    using _timers = clock.install();
    const startAge = server.age;
    const reads = await clock.settle(readShelterReads(context, hideRuntime(() => false, () => true), true, 100), 120_000);
    assert.equal(judged(reads).status, "failed");
    assert.ok(bot.time.age! - startAge >= 100, `waited ${bot.time.age! - startAge} ticks`);
    assertClean();
  });

  test(`the terminal read stops at the window on a stopped server instead of waiting for ever, at ${rate} tps`, async () => {
    const { clock, server, context, assertClean } = arena(rate);
    using _timers = clock.install();
    server.stop();
    await clock.settle(assert.rejects(readShelterReads(context, hideRuntime(() => false), true, 400), /stood still/), 120_000);
    assertClean();
  });
}

test("an unbuildable shelter, or one found by the first read, reads once", async () => {
  const { clock, context } = arena(20);
  using _timers = clock.install();
  assert.equal((await clock.settle(readShelterReads(context, hideRuntime(() => false), false, 400), 60_000)).length, 1);
  assert.equal((await clock.settle(readShelterReads(context, hideRuntime(() => true), true, 400), 60_000)).length, 1);
});
