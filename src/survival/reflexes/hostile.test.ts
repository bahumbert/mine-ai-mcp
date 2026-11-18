import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { z } from "zod";
import { defineAction, actionResultSchema } from "../../actions/action.js";
import { readNotificationSummary, SqlBotData } from "../../bot-data/index.js";
import type { NavigationRuntime } from "../../navigation/index.js";
import { ActionRunner, type ActionRunnerOptions } from "../../session/action-runner.js";
import { BodyAbort } from "../../session/abort.js";
import { attackedIds, createTestCombatController, engagingCombat } from "../../test-support/combat.js";
import { type FakeBot, type FakeBotOptions, type FakeCell, type FakeEntitySpec, createFakeBot, createFakeClock, flush, itemOf, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { watch } from "../../test-support/pending.js";
import { observation } from "../../test-support/navigation.js";
import { exactBlockGoal } from "../../navigation/goals/index.js";
import { createMovementPolicy } from "../../navigation/movements/policy.js";
import type { CombatController, CombatOutcome } from "../control/combat/contract.js";
import { ReflexDriver } from "../control/driver.js";
import { attachSurvivalReceipts } from "../evidence/receipts.js";
import { SurvivalObserver } from "../evidence/status.js";
import type { HostileResponse } from "../policy/combat/response.js";

import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { MineflayerWorldView } from "../../navigation/mineflayer/world.js";
import { observeCombatDecision, observeHostileResponse } from "../control/combat/observation.js";
import { CONTACT_GRACE_TICKS, executeHostileResponse } from "../control/combat/respond.js";
import { completeResponse, encounterReceipt } from "../control/combat/settlement.js";
import { CombatPerception } from "../perception/combat/observations.js";
import { responseScope } from "../control/combat/scopes/response.js";
import { isIncomingArrow } from "../perception/combat/shield-projectiles.js";
import { attachHostileReflex } from "./hostile.js";
import { swingReadiness } from "../weapons/swing-readiness.js";
import { heldThreatEnded, senseHostile } from "./hostile-sense.js";
import type { HostileScene } from "./hostile-scene.js";
import { ThreatChains } from "../state/threat-chains.js";
import { RequestStalls } from "../state/request-stall.js";
import { COMBAT_LIMITS } from "../control/combat/limits.js";
import { evadeBudgetTicks, EVADE_WALL_FACTOR } from "../responses/evade-clock.js";
import { MS_PER_ON_TIME_TICK, serverPacedWallMs } from "../../world/world-age.js";

/** Check response resources before fixture disposal, then outlive every retired response/claim deadline. */
function watchStalledCleanup(fixture: ReflexFixture): () => Promise<void> {
  const assertListeners = watchJourneyListeners(fixture);
  const timers = fixture.clock.pendingTimers();
  const globals = fixture.clock.pendingGlobalTimers();
  let transitions = 0;
  const stop = fixture.driver.onTransition((event) => {
    if (event.kind === "outcome" || event.kind === "phase") transitions++;
  });
  return async () => {
    if (fixture.bot.entities[7]) fixture.entities.remove(7);
    assertListeners();
    assert.equal(fixture.clock.pendingTimers(), timers);
    assert.equal(fixture.clock.pendingGlobalTimers(), globals);
    const outcomes = fixture.recorded().length;
    const before = transitions;
    const evadeWall = evadeBudgetTicks(fixture.controller.policy.combat) * MS_PER_ON_TIME_TICK * EVADE_WALL_FACTOR;
    const claimWall = serverPacedWallMs(COMBAT_LIMITS.ceilingTicks);
    await fixture.clock.advance(Math.max(evadeWall, claimWall) + 1, 1_000);
    assert.equal(fixture.recorded().length, outcomes, "retired responses cannot settle again");
    assert.equal(transitions, before, "retired deadlines cannot publish another outcome or hold");
    assert.equal(fixture.runner.status().busy, false);
    assert.equal(fixture.clock.pendingTimers(), timers);
    assert.equal(fixture.clock.pendingGlobalTimers(), globals);
    assertListeners();
    stop();
  };
}

/** A stationary objective whose physical attempts yield to the real hostile reflex. */
function stalledJourney(ticksPerSecond: number, exhausted = false) {
  let finishRoute: (() => void) | null = null;
  let attempts = 0;
  let routes = 0;
  const fixture = reflexFixture(async () => assert.fail("withdrawal must not fight"), async () => {
    routes++;
    await new Promise<void>((resolve) => { finishRoute = resolve; });
    finishRoute = null;
    if (!exhausted || routes < 8) fixture.bot.entities[7]!.position.x = 100;
    return exhausted && routes === 8
      ? { status: "stopped", reason: "no path", elapsedMs: 0 }
      : { status: "completed", elapsedMs: 0 };
  }, { clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond, startAge: 1_000 },
    entities: { 7: hostile("skeleton", 100) }, health: 11 });
  const input = z.strictObject({});
  const action = defineAction({ name: "navigate", description: "A journey without objective progress",
    inputSchema: input, resultSchema: actionResultSchema({}), parse: (value) => input.parse(value),
    formatResult: (result) => result.status, execution: { kind: "resumable_task" }, begin: (_request, _lifetime, observe) => {
      observe(() => ({ baseline: null, checkpoint: null, objective: { remaining: 100, tolerance: 1 },
        completion: { kind: "current", observed: false, owes: "reach the destination" } }));
      return async ({ signal }) => {
        attempts++;
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
        signal!.throwIfAborted();
        return { status: "succeeded" };
      };
    } });
  return { ...fixture, action, attempts: () => attempts, routes: () => routes,
    finishRoute: () => { assert.ok(finishRoute, "evade entered navigation"); finishRoute(); },
    async [Symbol.asyncDispose]() {
      fixture.runner.cancelActive("End stalled journey test");
      finishRoute?.();
      await fixture.observer.close();
      fixture.data.close();
    } };
}

for (const ticksPerSecond of [20, 10]) for (const exhausted of [false, true]) {
  test(`${exhausted ? "a stall at an exhausted evade returns instead of holding" : "eight separated evades on one navigate return HOSTILE_STALLED; a new navigate finishes"} (${ticksPerSecond} tps)`, async () => {
    await using fixture = stalledJourney(ticksPerSecond, exhausted);
    using _clock = fixture.clock.install();
    const assertClean = watchStalledCleanup(fixture);
    await fixture.controller.policy.edit({ operation: "set", expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { combat: { hide: "never" } }, lifetime: { kind: "session" }, reason: "Exercise stalled withdrawal" });
    const pending = fixture.runner.run(fixture.action, {});
    const state = watch(pending);
    await flush();
    for (let evade = 1; evade <= 8; evade++) {
      fixture.bot.entities[7]!.position.x = 5;
      await fixture.clock.advance(50);
      assert.equal(fixture.observer.activeResponse(), "evade");
      fixture.finishRoute();
      assert.ok(await until(() => fixture.recorded().length === evade));
      await flush();
      if (evade < 8) {
        assert.equal(state.over, false);
        assert.equal(fixture.attempts(), evade + 1);
      }
    }
    assert.equal(fixture.attempts(), 8, "the stalled request must return instead of a ninth resume");
    assert.equal(state.over, true, "the eighth evade returns the request");
    assert.equal(fixture.runner.status().busy, false, "a stalled exhausted evade must release the request");
    const output = await pending;
    assert.equal(output.result.status, "cancelled");
    assert.match(output.result.status === "cancelled" ? output.result.error : "", /\[HOSTILE_STALLED\].*skeleton#7/);
    assert.ok(output.interruptions?.some((reason) => reason.includes("[HOSTILE_STALLED]") && reason.includes("skeleton#7")));
    assert.equal(output.request?.state.kind, "returned");
    assert.ok(fixture.bot.time.age >= 1_000 && fixture.bot.time.age < 2_680);
    fixture.entities.remove(7);
    const next = defineAction({ name: "navigate", description: "Next journey", inputSchema: z.strictObject({}),
      resultSchema: actionResultSchema({}), parse: () => ({}), formatResult: (result) => result.status,
      execution: { kind: "resumable_task" }, begin: () => async () => ({ status: "succeeded" as const }) });
    assert.equal((await fixture.clock.settle(fixture.runner.run(next, {}), 1_000)).result.status, "succeeded");
    await assertClean();
  });
}

for (const during of [false, true]) test(during ? "a late finalize after death is ignored"
  : "death clears the stall count", async () => {
  await using fixture = stalledJourney(20);
  using _clock = fixture.clock.install();
  const assertClean = watchStalledCleanup(fixture);
  const outcomes = () => fixture.data.read(
    "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id",
  ).map((row) => JSON.parse(String(row.payload_json)));
  const pending = fixture.runner.run(fixture.action, {});
  await flush();
  fixture.bot.entities[7]!.position.x = 5;
  await fixture.clock.advance(50);
  if (!during) {
    fixture.finishRoute();
    assert.ok(await until(() => outcomes().length === 1));
    assert.equal(outcomes()[0]?.stall?.evades, 1);
  }
  fixture.bot.entities[7]!.position.x = 100;
  fixture.combat.setHealth(0);
  await fixture.clock.advance(150);
  if (during) {
    fixture.finishRoute();
    assert.ok(await until(() => outcomes().length === 1));
    assert.equal(outcomes()[0]?.stall, null, "old-life finalization must leave stalls empty");
  }
  fixture.runner.cancelActive("Retire the old-life request");
  await fixture.clock.settle(pending, 1_000);
  fixture.driver.answered.clear();
  fixture.combat.setHealth(11);
  await fixture.controller.policy.edit({ operation: "set", expected_revision: fixture.controller.policy.snapshot().revision,
    changes: { combat: { hide: "never" } }, lifetime: { kind: "session" }, reason: "Exercise the new life" });
  const next = fixture.runner.run(fixture.action, {});
  await flush();
  fixture.bot.entities[7]!.position.x = 5;
  fixture.tick();
  await fixture.clock.advance(50);
  assert.equal(fixture.observer.activeResponse(), "evade", JSON.stringify({ health: fixture.bot.health,
    snapshot: fixture.driver.snapshot(), status: fixture.runner.status(), records: fixture.recorded() }));
  fixture.finishRoute();
  assert.ok(await until(() => outcomes().length === 2));
  assert.equal(outcomes()[1]?.stall?.evades, 1, "the next request starts with no old evades");
  fixture.runner.cancelActive("Finish death control");
  await fixture.clock.settle(next, 1_000);
  fixture.entities.remove(7);
  // Mineflayer resumes physics 1.5 s after a respawn position (fake-bot-physics.ts); await that answer timer.
  await fixture.clock.settle(new Promise<void>((resolve) => fixture.bot.once("physicsTick", resolve)), 2_000);
  await assertClean();
});

for (const rate of [20, 10, "stopped"] as const) test(`two evades return at the no-progress ${rate === "stopped" ? "wall backstop" : `tick bound (${rate} tps)`}`, async () => {
  await using fixture = stalledJourney(rate === "stopped" ? 20 : rate);
  using _clock = fixture.clock.install();
  const assertClean = watchStalledCleanup(fixture);
  const pending = fixture.runner.run(fixture.action, {});
  const state = watch(pending);
  await flush();
  fixture.bot.entities[7]!.position.x = 5;
  await fixture.clock.advance(50);
  fixture.finishRoute();
  assert.ok(await until(() => fixture.recorded().length === 1));
  await flush();
  if (rate === "stopped") fixture.server.stop();
  const firstAge = fixture.bot.time.age;
  await fixture.clock.advance(rate === "stopped" ? 255_000 : 1_680 * 1_000 / rate, 1_000);
  assert.equal(fixture.bot.time.age - firstAge, rate === "stopped" ? 0 : 1_680);
  fixture.bot.entities[7]!.position.x = 5;
  fixture.tick();
  await flush();
  fixture.finishRoute();
  assert.ok(await until(() => fixture.recorded().length === 2));
  await flush();
  assert.equal(state.over, true, "the no-progress limit must return instead of resume");
  const result = await fixture.clock.settle(pending, 1_000);
  assert.equal(result.result.status, "cancelled");
  assert.match(result.result.status === "cancelled" ? result.result.error : "", /\[HOSTILE_STALLED\] 2 evades/);
  await assertClean();
});

// The unreachable premise counts world ticks (plan 2026-11-16-reflex-limits-ticks T3): 600 ticks from the age cached when the
// failure was remembered plus one packet, the packet of age A + 620 (31 s in at 20 tps, 62 s at 10 tps; old code: 30 s after it).
for (const ticksPerSecond of [20, 10]) for (const quarry of [true, false])
test(`${quarry ? "a reachable quarry with no confirmed damage retains its time-only answer" : "an unreachable fight is not chosen again until the packet of age A + 620 when bot and target step a block"} (${ticksPerSecond} tps)`, async () => {
  const fixture = reflexFixture(async id => ({ ...died(id), kind: "unreachable",
    ...(quarry ? { premise: "no_confirmed_damage" as const } : {}),
    observation: quarry ? "No confirmed damage to zombie#7 during 600 server ticks of fighting or 93 s." : "No route onto the pillar." }),
    async () => ({ status: "stopped", reason: "no path", elapsedMs: 0 }),
    { entities: { 7: quarry ? hostile("zombie", 2) : { ...hostile("skeleton", 6), position: new Vec3(6, 68, 0) } },
      cells: { "6,67,0": "obsidian" }, server: { ticksPerSecond } });
  try {
    await fixture.controller.policy.edit({ operation: "set", expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { combat: { hide: "never" } }, lifetime: { kind: "session" }, reason: "Exercise the fight retry without a cornered hide." });
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 1));
    const remembered = fixture.driver.answered.snapshot().find((entry) => entry.response === "fight");
    assert.ok(remembered);
    assert.equal(remembered.temporal?.premise, "unreachable");
    const fights = () => fixture.recorded().filter(outcome => outcome.startsWith("fight ->")).length;
    if (quarry) {
      assert.equal(remembered.failure.kind, "no_confirmed_damage");
      assert.equal(remembered.temporal && (remembered.temporal.expiresAt - remembered.since) / 50, 600);
      assert.notEqual(observeHostileResponse(fixture.bot, fixture.observer.threats).kind, "fight", `reachable at age ${fixture.bot.time.age}`);
      const age = fixture.bot.time.age;
      await fixture.clock.advance(599 * 1000 / ticksPerSecond);
      assert.equal(fights(), 1, `age ${fixture.bot.time.age}, before ${age + 620}`);
      await fixture.clock.advance(41 * 1000 / ticksPerSecond);
      assert.ok(fights() >= 2, `answer expires at age ${fixture.bot.time.age}`);
      return;
    }
    fixture.bot.entity.position.x++;
    fixture.bot.entities[7]!.position.x++;
    const decision = observeHostileResponse(fixture.bot, fixture.observer.threats);
    assert.equal(decision.kind === "evade" ? decision.reason : decision.kind, "unreachable");
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 2));
    assert.deepEqual(fixture.recorded(), ["fight -> target_unreachable", "evade -> capability_limit"]);
    const readAge = fixture.bot.time.age; // the pause was remembered a few ticks ago, at this cached age or the packet before
    while (fixture.bot.time.age < readAge + 600) {
      assert.equal(fights(), 1, `age ${fixture.bot.time.age}, short of A + 600`);
      await fixture.clock.advance(50);
    }
    await fixture.clock.advance(50);
    assert.equal(fights(), 1, `age ${fixture.bot.time.age}: the packet of A + 620 has not come yet`);
    while (fixture.bot.time.age < readAge + 620) await fixture.clock.advance(50);
    await fixture.clock.advance(50);
    assert.equal(fights(), 2,
      JSON.stringify({ records: fixture.recorded(), snapshots: fixture.driver.snapshot(), answered: fixture.driver.answered.snapshot() }));
  } finally {
    await fixture.observer.close();
    fixture.data.close();
  }
});

for (const { description, targetId, distance } of [
  { description: "a formerly unreachable attacker in reach is fought by a healthy defender with a sword above fight_margin", targetId: 7, distance: 2 },
  { description: "a remembered unreachable fight against target 7 does not prevent fighting target 8", targetId: 8, distance: 6 },
]) {
  test(description, async () => {
    const fixture = reflexFixture(async (id) => { fixture.entities.remove(id); return died(id); }, undefined,
      { entities: { [targetId]: hostile("blaze", distance) } });
    try {
      fixture.driver.answered.remember(responseScope(fixture.bot, () => fixture.controller.policy.effective, "fight", 7),
        { kind: "unreachable", why: "Earlier approach stopped." },
        { premise: "unreachable", ticks: 600, why: "Earlier approach stopped." });
      fixture.tick();
      await fixture.clock.advance(50);
      assert.deepEqual(fixture.recorded(), ["fight -> target_died"]);
    } finally {
      await fixture.observer.close();
      fixture.data.close();
    }
  });
}

test("a cancel or a death mid-fight remembers nothing", async () => {
  for (const stop of ["cancel", "death"] as const) {
    const fixture = standoffScene(7);
    try {
      await fixture.pass(50);
      assert.equal(fixture.active(), true);
      if (stop === "death") fixture.combat.setHealth(0);
      else await fixture.driver.cancel("hostile_reflex", new BodyAbort({ kind: "cancelled", by: "model" }, "Stop fighting."));
      assert.ok(await until(() => !fixture.active()));
      assert.deepEqual(fixture.driver.answered.snapshot(), []);
      assert.equal(fixture.active(), false);
    } finally {
      await fixture.close();
    }
  }
});

for (const escapes of [true, false]) {
  test(`withdrawal ${escapes ? "resumes its request after safe separation" : "returns when escape has no path"}`, async () => {
    const fixture = reflexFixture(
      async () => {
        throw new Error("Withdrawal must not engage");
      },
      async () => {
        if (!escapes) return { status: "stopped", reason: "no path", elapsedMs: 1 };
        fixture.bot.entity.position.x = 60;
        return { status: "completed", elapsedMs: 1 };
      },
      { entities: { 7: hostile("blaze", 5) } },
    );
    let attempts = 0;
    const input = z.object({ destination: z.number() });
    const action = defineAction({
      name: "withdraw_test",
      description: "withdraw",
      inputSchema: input,
      resultSchema: actionResultSchema({}),
      formatResult: (result) => result.status,
      parse: (value: unknown) => input.parse(value),
      execution: { kind: "resumable_task" },
      begin: (request) => async (context) => {
        attempts++;
        if (attempts === 1) {
          const stopped = new Promise<void>((resolve) =>
            context.signal!.addEventListener("abort", () => resolve(), { once: true }),
          );
          fixture.tick();
          await stopped;
          return { status: "failed", error: "interrupted" };
        }
        assert.equal(request.destination, 70);
        return { status: "succeeded" };
      },
    });
    try {
      await fixture.controller.policy.edit({
        operation: "set",
        expected_revision: fixture.controller.policy.snapshot().revision,
        changes: { combat: { engagement: "defend_only" } },
        lifetime: { kind: "session" },
        reason: "test",
      });
      const output = await fixture.clock.settle(fixture.runner.run(action, { destination: 70 }), 1_000);
      assert.equal(output.result.status, escapes ? "succeeded" : "failed");
      assert.equal(attempts, escapes ? 2 : 1);
      assert.ok(await until(() => fixture.recorded().length > 0));
      assert.deepEqual(fixture.recorded(), escapes ? ["evade -> safe_separation"]
        : ["evade -> capability_limit", "hide -> capability_limit"]);
    } finally {
      await fixture.observer[Symbol.asyncDispose]();
      fixture.data.close();
    }
  });
}

/** What a skeleton's arrow costs the bot (`projectile-hit-bot`: 3 on easy) and the most clock its flight takes in these scenes (48 blocks at 1.6 a tick: 30 server ticks). */
const ARROW_DAMAGE = 3;
const ARROW_FLIGHT_MS = 2_000;
/** A health that leaves the bot between the engage bar (12) and the critical one (8) after one arrow, and after two. */
const HEALTH_BEFORE_ARROWS = 14.5;

/** The clock runs a slice at a time until the shot has landed on the bot (her health fell), at most `limitMs`: the test then reads the state the hit left. */
async function landed(fixture: { readonly bot: FakeBot; readonly clock: { advance(ms: number): Promise<void> } }, limitMs: number): Promise<void> {
  const before = fixture.bot.health;
  for (let passed = 0; fixture.bot.health >= before && passed < limitMs; passed += 50) await fixture.clock.advance(50);
  assert.ok(fixture.bot.health < before, `the shot did not land within ${limitMs} ms of clock`);
}

/** A hostile the bot sees at the start, `x` blocks along the row the bot stands on (its size is the game's). */
function hostile(name: string, x: number): FakeEntitySpec {
  return { name, kind: "Hostile mobs", position: new Vec3(x, 64, 0) };
}

/** The ten cells of a closed shelter around the bot at (0, 64, 0): four sides at two levels, the cap and the floor. */
function sealedCells(): Record<string, FakeCell> {
  const cells: Record<string, FakeCell> = { "0,66,0": "stone", "0,63,0": "stone" };
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [64, 65]) cells[`${x},${y},${z}`] = "stone";
  return cells;
}

/**
 * The hostile stays in sight of a bot sealed in stone. The game would hide it behind the walls (the fake's raycast
 * stops at them), but these tests are about the reflex's answer to a hostile in sight under the hide bar, so the
 * ray is scripted clear: what the old fixture's world did for every ray.
 */
function seeThroughShelter(bot: FakeBot): void {
  bot.world.raycast = () => null;
}

test("an automatic target disappearing resumes the original request without claiming a kill", async () => {
  const fixture = reflexFixture(
    async (targetId) => {
      fixture.entities.remove(targetId);
      return { ...died(targetId), kind: "target_lost", attacks: 0 };
    },
    undefined,
    { entities: { 7: hostile("blaze", 5) } },
  );
  let attempts = 0;
  const input = z.object({ count: z.number() });
  const action = defineAction({
    name: "interrupted_collection",
    description: "preserve the requested collection",
    inputSchema: input,
    resultSchema: actionResultSchema({}),
    formatResult: (result) => result.status,
    parse: (value) => input.parse(value),
    execution: { kind: "resumable_task" },
    begin: (request) => async (context) => {
      if (++attempts === 1) {
        const stopped = new Promise<void>((resolve) =>
          context.signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        fixture.tick();
        await stopped;
        return { status: "failed", error: "interrupted" };
      }
      assert.equal(request.count, 12);
      return { status: "succeeded" };
    },
  });
  try {
    const result = await fixture.runner.run(action, { count: 12 });
    assert.equal(result.result.status, "succeeded");
    assert.equal(attempts, 2);
    assert.deepEqual(fixture.recorded(), ["fight -> target_lost"]);
    assert.equal(fixture.observer.threats.resolvedIds.has(7), false);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

/** What a test sets on the fake bot at the start, and how its runner is configured (its clock is the fake bot's). */
interface FixtureOptions extends Pick<FakeBotOptions, "clock" | "entities" | "carried" | "slots" | "cells" | "overrides" | "health" | "food" | "server"> {
  readonly runner?: Omit<ActionRunnerOptions, "clock">;
  readonly onHeldEnded?: () => void;
}

/** The recorded encounter receipts, oldest first. */
function encounterReceipts(data: SqlBotData) {
  return data
    .read(
      "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id",
    )
    .map(row => JSON.parse(String(row.payload_json)));
}

/** The recorded encounters, oldest first, as `response -> outcome`. */
function recordedEncounters(data: SqlBotData): string[] {
  return encounterReceipts(data).map(payload => `${payload.response} -> ${payload.outcome}`);
}

/** Observe the real callback without replacing its threat evidence or registration behavior. */
function watchHeldEnded(driver: ReflexDriver, onHeldEnded: () => void): void {
  const register = driver.register.bind(driver);
  driver.register = (definition) => {
    const heldEnded = definition.heldEnded;
    return register(heldEnded ? { ...definition, heldEnded: (held, observed, decision) => {
      onHeldEnded();
      return heldEnded(held, observed, decision);
    } } : definition);
  };
}

function reflexFixture(engage: CombatController["engage"], navigate: NavigationRuntime["navigate"] = async () => ({ status: "completed", elapsedMs: 0 }), options: FixtureOptions = {}) {
  const { bot, clock, combat, world, inventory, entities, server } = createFakeBot({
    clock: options.clock,
    server: options.server,
    username: "ReflexBot",
    position: new Vec3(0, 64, 0),
    // Open air without building material: hiding cannot dig or place here.
    // A diamond sword keeps lifecycle tests above fight_margin; explicit equipment replaces it.
    groundY: null,
    entities: options.entities,
    carried: options.carried ?? { diamond_sword: 1 },
    health: options.health,
    food: options.food,
    slots: options.slots,
    cells: options.cells,
    overrides: options.overrides,
  });
  swingReadiness(bot); // Installed before actions by the connected runtime.
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "reflex-test", scope: { kind: "bot", botId: "reflex-bot" } },
  });
  const runner = new ActionRunner({ clock, worldAge: () => bot.time.age, ...options.runner });
  const navigation = {
    world: new MineflayerWorldView(bot),
    onEvent: () => () => {},
    active: false,
    cancel: () => undefined,
    navigate,
  } as unknown as NavigationRuntime;
  const controller = engagingCombat(bot, engage);
  const driver = new ReflexDriver(bot, runner, { now: clock.now });
  const perception = new CombatPerception(bot);
  if (options.onHeldEnded) watchHeldEnded(driver, options.onHeldEnded);
  const attached = attachHostileReflex(bot, driver, navigation, controller, perception);
  const status = new SurvivalObserver(bot, runner, driver, controller);
  const receipts = attachSurvivalReceipts(bot, data, runner, driver, controller, status, navigation);
  // Connection services share the body pacer; capture their baseline before any response adds listeners.
  const deathListenersAtRest = bot.listenerCount("death");
  const observer = {
    ...attached,
    async close() {
      await attached[Symbol.asyncDispose]();
      await driver[Symbol.asyncDispose]();
      receipts[Symbol.dispose]();
      status[Symbol.dispose]();
      perception[Symbol.dispose]();
    },
  };
  return {
    bot,
    clock,
    /** What other actors do: hurt the bot, shoot her, kill a mob. */
    combat,
    world,
    inventory,
    /** The packets the client wrote, in order. */
    server,
    /** The server's entities after the start: `spawn` a mob the bot meets later, `remove` one. */
    entities,
    driver,
    runner,
    navigation,
    controller,
    observer,
    perception,
    data,
    summary: () => readNotificationSummary(data, bot.username),
    recorded: () => recordedEncounters(data),
    /** One client tick at once, with no time passing: a test reads the state the tick left before the promise queue runs. */
    tick: () => bot.emit("physicsTick"),
    /** The `death` listeners an idle bot has: the fake's own and the code under test's. */
    deathListenersAtRest,
  };
}

type ReflexFixture = ReturnType<typeof reflexFixture>;

/** A real failed shell around blaze #61, with navigation and combat answering at their runtime boundary. */
function occupiedHideJourney(ticksPerSecond: number, ending: "evade" | "fight" | "failed" | "deflect" | "death" | "no_floor",
  options: { navigate?: NavigationRuntime["navigate"]; atRefusal?: (fixture: ReflexFixture) => void;
    engage?: CombatController["engage"] } = {}) {
  const fixture = reflexFixture(async (id, signal, movement) => {
    if (options.engage) return options.engage(id, signal, movement);
    fixture.entities.remove(id);
    return died(id);
  }, async (input) => {
    if (fixture.observer.activeResponse() === "hide") {
      if (options.navigate) return options.navigate(input);
      if (ending === "failed") return { status: "stopped", reason: "withdrawal route unavailable", elapsedMs: 0 };
      fixture.bot.entities[61]!.position.x = 100;
    }
    return { status: "completed", elapsedMs: 0 };
  }, { clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond, startAge: 1_000 },
    health: 2, carried: { cobblestone: 32, diamond_sword: 1 },
    cells: { ...sealedCells(), "0,63,0": ending === "no_floor" ? "air" : "bedrock", "1,64,0": "air" },
    entities: { 61: { name: "blaze", kind: "Hostile mobs", position: new Vec3(ending === "no_floor" ? 8 : 1.5, 64, 0.5) } } });
  fixture.bot.entity.position.set(0.5, 64, 0.5);
  const raycast = fixture.bot.world.raycast;
  const remember = fixture.driver.answered.remember.bind(fixture.driver.answered);
  let refusalSeen = false;
  fixture.driver.answered.remember = (scope, failure, temporal) => {
    const entry = remember(scope, failure, temporal);
    if (scope.response === "hide" && !refusalSeen) {
      refusalSeen = true;
      seeThroughShelter(fixture.bot);
      // An external hit invalidates the perception cached behind the shell before the new decision.
      fixture.combat.hurt(61, null, 1);
      if (ending === "fight") fixture.bot.health = 20;
      if (ending === "death") fixture.combat.setHealth(0);
      if (ending === "deflect" && !fixture.bot.entities[62]) fixture.entities.spawn({ id: 62, name: "fireball",
        position: new Vec3(2, 65, 0.5), velocity: new Vec3(-1, 0, 0) });
      options.atRefusal?.(fixture);
    }
    return entry;
  };
  const navigations = { count: 0 };
  return { ...fixture, navigations,
    action: walkRequest(fixture.navigation, navigations, "navigate", () => {
      seeThroughShelter(fixture.bot);
      fixture.tick();
      fixture.bot.world.raycast = raycast;
    }),
    async [Symbol.asyncDispose]() { await fixture.observer.close(); fixture.data.close(); } };
}

for (const ticksPerSecond of [20, 10]) for (const ending of ["evade", "fight", "failed", "deflect", "death", "no_floor"] as const)
test(`occupied shelter follow-up ${ending} settles once and releases the next navigate (${ticksPerSecond} tps)`, async () => {
  await using fixture = occupiedHideJourney(ticksPerSecond, ending);
  using _clock = fixture.clock.install();
  const added = listenersAddedSince(fixture.bot);
  const pending = fixture.runner.run(fixture.action, {});
  const output = await fixture.clock.settle(pending, 15_000);
  const receipts = encounterReceipts(fixture.data);
  assert.equal(receipts.length, 1, "one outer response settles");
  const receipt = receipts[0]!;
  const succeeded = ending === "evade" || ending === "fight";
  assert.equal(output.result.status, succeeded ? "succeeded" : "cancelled", JSON.stringify(receipt));
  assert.equal(receipt.outcome, succeeded ? ending === "evade" ? "safe_separation" : "target_died"
    : ending === "death" ? "bot_died" : "capability_limit");
  if (ending !== "death") {
    assert.equal(receipt.hide.kind, "failed");
    assert.equal(receipt.hide.refusal.cause, ending === "no_floor" ? "no_floor" : "occupied");
    assert.equal(receipt.followUp?.response ?? null, ending === "failed" ? "evade" : succeeded ? ending : null);
    assert.ok(fixture.driver.answered.snapshot().some(entry => entry.failure.kind === "enclosure_failed"));
    if (ending === "failed") assert.ok(fixture.driver.answered.snapshot().some(entry => entry.response === "evade"));
  }
  if (fixture.bot.entities[61]) fixture.entities.remove(61);
  if (fixture.bot.entities[62]) fixture.entities.remove(62);
  if (ending === "death") fixture.combat.setHealth(20);
  assert.equal((await fixture.clock.settle(fixture.runner.run(walkRequest(fixture.navigation, { count: 0 }, "navigate"), {}), 1_000)).result.status, "succeeded");
  assert.ok(fixture.bot.time.age >= 1_000, "construction and follow-up use the server's world age");
  for (const event of ["physicsTick", "time", "entityGone", "death"]) assert.equal(added(event), 0, event);
});

for (const ticksPerSecond of [20, 10]) for (const exit of ["cancel", "preempt", "late", "stopped"] as const)
test(`occupied shelter follow-up ${exit} leaves no stale continuation (${ticksPerSecond} tps)`, async () => {
  let entered = false;
  let routeSignal: AbortSignal | undefined;
  let finishRoute: (() => void) | undefined;
  let removed = 0;
  await using fixture = occupiedHideJourney(ticksPerSecond, "evade", { navigate: async ({ signal, stopSignal }) => {
    entered = true;
    routeSignal = signal;
    const stop = exit === "stopped" ? AbortSignal.any([signal!, stopSignal!]) : signal;
    const pending = new Promise<void>(resolve => { finishRoute = resolve; });
    const finish = () => finishRoute!();
    if (exit !== "late") stop?.addEventListener("abort", finish, { once: true });
    try { await pending; return { status: "stopped", reason: "route released", elapsedMs: 0 }; }
    finally { stop?.removeEventListener("abort", finish); removed++; }
  } });
  using _clock = fixture.clock.install();
  const added = listenersAddedSince(fixture.bot);
  const clientAdded = listenersAddedSince(fixture.bot._client);
  const pending = fixture.runner.run(fixture.action, {});
  await fixture.clock.settle((async () => { while (!entered) await fixture.clock.sleep(50); })(), 15_000);
  const age = fixture.bot.time.age;
  let higher: ReturnType<ActionRunner["claim"]> | undefined;
  let releaseHigher: (() => void) | undefined;
  let higherSignal: AbortSignal | undefined;
  if (exit === "preempt") {
    higher = fixture.runner.claim("recover_footing", "Land before the old shelter response", async signal => {
      higherSignal = signal;
      await new Promise<void>(resolve => { releaseHigher = resolve; });
      return { value: null, continuation: { kind: "return", reason: "Footing owns the verdict" } };
    });
    assert.equal(higher.kind, "claimed");
  } else if (exit === "stopped") fixture.server.stop();
  else fixture.runner.cancelActive("Cancel the occupied-shelter request");
  if (exit !== "stopped") assert.equal(routeSignal?.aborted, true, "the follow-up borrows the outer signal");
  if (exit === "late") {
    await flush();
    assert.equal(fixture.recorded().length, 0, "a late route still owes its release");
    finishRoute!();
  }
  if (exit === "preempt") {
    await flush();
    assert.ok(higherSignal);
    assert.equal(higherSignal.aborted, false, "the higher reflex is untouched by the shelter cleanup");
    releaseHigher!();
    if (higher?.kind === "claimed") await fixture.clock.settle(higher.outcome, 1_000);
  }
  const output = await fixture.clock.settle(pending, exit === "stopped" ? serverPacedWallMs(COMBAT_LIMITS.ceilingTicks) : 1_000);
  assert.equal(output.result.status, "cancelled");
  assert.equal(removed, 1, "navigation cleanup runs once");
  assert.equal(fixture.recorded().length, 1, "one response settles");
  if (exit === "stopped") assert.equal(fixture.bot.time.age, age);
  fixture.entities.remove(61);
  assert.equal((await fixture.clock.settle(fixture.runner.run(walkRequest(fixture.navigation, { count: 0 }, "navigate"), {}), 1_000)).result.status, "succeeded");
  await fixture.clock.advance(serverPacedWallMs(COMBAT_LIMITS.noProgressTicks) + 1, 1_000);
  assert.equal(fixture.recorded().length, 1, "retired timers cannot settle the old response again");
  for (const event of ["physicsTick", "time", "entityGone", "death"]) assert.equal(added(event), 0, event);
  assert.equal(clientAdded("explosion"), 0);
  assert.equal(fixture.runner.status().busy, false);
});

for (const ticksPerSecond of [20, 10]) for (const change of ["policy", "stock"] as const)
test(`occupied shelter fight reads a ${change} change at execution (${ticksPerSecond} tps)`, async () => {
  let live: CombatController;
  await using fixture = occupiedHideJourney(ticksPerSecond, "fight", { engage: async (id, signal, movement) => {
    if (change === "policy") await live.policy.edit({ operation: "set", expected_revision: live.policy.snapshot().revision,
      changes: { combat: { melee: false, bow: false, retreat: false } }, lifetime: { kind: "session" },
      reason: "Permission withdrawn after selection" });
    else {
      fixture.inventory.clearAll();
    }
    return live.engage(id, signal, movement);
  } });
  using _clock = fixture.clock.install();
  live = createTestCombatController(fixture.bot, fixture.navigation, fixture.perception, undefined, fixture.driver);
  if (change === "stock") await live.policy.edit({ operation: "set", expected_revision: live.policy.snapshot().revision,
    changes: { combat: { melee: false, bow: true, retreat: false } }, lifetime: { kind: "session" }, reason: "Only carried ranged equipment is authorized" });
  if (change === "stock") {
    fixture.inventory.updateSlot(9, itemOf(fixture.bot.registry, "bow"));
    fixture.inventory.updateSlot(10, itemOf(fixture.bot.registry, "arrow", 8));
  }
  const output = await fixture.clock.settle(fixture.runner.run(fixture.action, {}), 15_000);
  assert.equal(output.result.status, "cancelled");
  const receipts = encounterReceipts(fixture.data);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.followUp.response, "fight");
  assert.equal(receipts[0]!.followUp.result.kind, "capability_blocked");
  assert.equal(receipts[0]!.followUp.result.reason, "policy");
  assert.equal(receipts[0]!.outcome, "capability_limit");
  fixture.entities.remove(61);
  assert.equal((await fixture.clock.settle(fixture.runner.run(walkRequest(fixture.navigation, { count: 0 }, "navigate"), {}), 1_000)).result.status, "succeeded");
});

for (const ticksPerSecond of [20, 10]) test(`occupied shelter follow-up keeps its one 300-world-tick evade budget (${ticksPerSecond} tps)`, async () => {
  let startedAt = 0;
  let startedAge = 0;
  await using fixture = occupiedHideJourney(ticksPerSecond, "evade", { atRefusal: scene => { scene.bot.entities[61]!.position.x = 5; },
    navigate: async ({ stopSignal }) => {
    startedAt = fixture.clock.now();
    startedAge = fixture.bot.time.age;
    await new Promise<void>(resolve => stopSignal!.addEventListener("abort", () => resolve(), { once: true }));
    return { status: "stopped", reason: "evade budget spent", elapsedMs: 0 };
  } });
  using _clock = fixture.clock.install();
  const pending = fixture.runner.run(fixture.action, {});
  const output = await fixture.clock.settle(pending, 15_000 + 320 * 1_000 / ticksPerSecond);
  const [receipt] = encounterReceipts(fixture.data);
  assert.equal(output.result.status, "cancelled", JSON.stringify(receipt));
  assert.equal(receipt.followUp.result.kind, "exhausted");
  assert.equal(receipt.followUp.elapsedTicks, 300);
  assert.equal(fixture.bot.time.age - startedAge, 300);
  assert.equal(fixture.clock.now(), (startedAge - 1_000 + 300) * 1_000 / ticksPerSecond,
    `the packet of age ${startedAge + 300} ends the budget that began at fake time ${startedAt}`);
  assert.equal(fixture.recorded().length, 1, "the budget cannot reopen another response");
  fixture.entities.remove(61);
  assert.equal((await fixture.clock.settle(fixture.runner.run(walkRequest(fixture.navigation, { count: 0 }, "navigate"), {}), 1_000)).result.status, "succeeded");
});

for (const ticksPerSecond of [20, 10]) for (const revoke of [true, false])
test(`occupied shelter evade reconciles its own permissions, revoked ${revoke} (${ticksPerSecond} tps)`, async () => {
  let entered = false;
  let routeSignal: AbortSignal | undefined;
  let finishRoute!: () => void;
  await using fixture = occupiedHideJourney(ticksPerSecond, "evade", { navigate: async ({ signal }) => {
    entered = true;
    routeSignal = signal;
    const pending = new Promise<void>(resolve => { finishRoute = resolve; });
    signal!.addEventListener("abort", finishRoute, { once: true });
    try {
      await pending;
      fixture.bot.entities[61]!.position.x = 100;
      return { status: "completed", elapsedMs: 0 };
    } finally { signal!.removeEventListener("abort", finishRoute); }
  } });
  using _clock = fixture.clock.install();
  const pending = fixture.runner.run(fixture.action, {});
  await fixture.clock.settle((async () => { while (!entered) await fixture.clock.sleep(50); })(), 15_000);
  await fixture.controller.policy.edit({ operation: "set", expected_revision: fixture.controller.policy.snapshot().revision,
    changes: { combat: revoke ? { retreat: false } : { bow: false } }, lifetime: { kind: "session" }, reason: "Change during nested evade" });
  try { assert.equal(routeSignal?.aborted, revoke, "the active evade consumes retreat but not bow permission"); }
  finally { finishRoute(); }
  const output = await fixture.clock.settle(pending, 1_000);
  assert.equal(output.result.status, revoke ? "cancelled" : "succeeded");
  fixture.entities.remove(61);
  assert.equal((await fixture.clock.settle(fixture.runner.run(walkRequest(fixture.navigation, { count: 0 }, "navigate"), {}), 1_000)).result.status, "succeeded");
});

for (const ticksPerSecond of [20, 10]) for (const stopped of [false, true])
test(`occupied shelter failed fight keeps its expiring answer, stopped ${stopped} (${ticksPerSecond} tps)`, async () => {
  await using fixture = occupiedHideJourney(ticksPerSecond, "fight", { engage: async id => ({ ...died(id),
    kind: "unreachable", premise: "no_confirmed_damage", observation: "No confirmed damage to blaze#61." }) });
  using _clock = fixture.clock.install();
  assert.equal((await fixture.clock.settle(fixture.runner.run(fixture.action, {}), 15_000)).result.status, "cancelled");
  const entry = fixture.driver.answered.snapshot().find(answer => answer.response === "fight");
  assert.ok(entry);
  assert.equal(entry.temporal?.premise, "unreachable");
  assert.equal(entry.failure.kind, "no_confirmed_damage");
  fixture.bot.entities[61]!.position.x = 100;
  const origin = fixture.bot.time.age;
  if (stopped) fixture.server.stop();
  const before = stopped ? serverPacedWallMs(600) - 1 : 599 * 1_000 / ticksPerSecond;
  await fixture.clock.advance(before, 1_000);
  assert.ok(fixture.driver.answered.find(entry.capability, entry.scope));
  await fixture.clock.advance(stopped ? 1 : 41 * 1_000 / ticksPerSecond, 1_000);
  assert.equal(fixture.driver.answered.find(entry.capability, entry.scope), null);
  assert.equal(fixture.bot.time.age - origin, stopped ? 0 : 640);
  fixture.entities.remove(61);
  assert.equal((await fixture.clock.settle(fixture.runner.run(walkRequest(fixture.navigation, { count: 0 }, "navigate"), {}), 1_000)).result.status, "succeeded");
});

/** A resumable journey around real hostile decisions; only its navigation and fight results are contract stubs. */
function heldJourney(ticksPerSecond: number, ending: "resume" | "return" | "removed" | "hide" | "hunger" | "deflect" | "deflect_passed" | "higher",
  entities: Record<number, FakeEntitySpec> = { 7: hostile("zombie", 3) }, onHeldEnded?: () => void,
  options: Pick<FixtureOptions, "carried" | "slots"> & { startAge?: number; holds?: number } = {}) {
  let finishEvade!: () => void;
  let reachedEvade!: () => void;
  const entered = new Promise<void>((resolve) => { reachedEvade = resolve; });
  const route = new Promise<void>((resolve) => { finishEvade = resolve; });
  const fixture = reflexFixture(async (id, signal) => {
    if (ending === "higher") {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { ...died(id), kind: "cancelled" };
    }
    if (ending === "return" || ending === "hunger")
      return { ...died(id), kind: "capability_blocked", reason: "policy", observation: "Pursuit prohibited" };
    fixture.entities.remove(id);
    return died(id);
  }, async () => { reachedEvade(); await route; return { status: "stopped", reason: "no path", elapsedMs: 0 }; },
  { clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond, startAge: options.startAge ?? 1_000 },
    ...options, entities, health: 11, food: ending === "hunger" ? 10 : 20, onHeldEnded });
  let attempts = 0;
  const phases: { phase: string; outcome: string; worldAge: number; generation: number; resumed: boolean; notEnded?: string }[] = [];
  fixture.driver.onTransition((event) => {
    if (event.kind === "phase" && event.reflex === "hostile_reflex")
      phases.push(event.evidence as typeof phases[number]);
  });
  const input = z.strictObject({});
  const action = defineAction({ name: "held_journey", description: "Journey interrupted by a hostile chain",
    inputSchema: input, resultSchema: actionResultSchema({}), parse: (value) => input.parse(value),
    formatResult: (result) => result.status, execution: { kind: "resumable_task" }, begin: () => async ({ signal }) => {
      if (++attempts <= (options.holds ?? 1)) {
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
        signal!.throwIfAborted();
      }
      return { status: "succeeded" };
    } });
  return { ...fixture, action, phases, finishEvade, attempts: () => attempts, async start() {
    await fixture.controller.policy.edit({ operation: "set", expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { combat: { hide: ending === "hide" ? "when_recovery_possible" : "never" } },
      lifetime: { kind: "session" }, reason: "Exercise the response chain" });
    const pending = fixture.runner.run(action, {});
    await flush();
    fixture.tick();
    if (ending === "deflect" || ending === "deflect_passed") {
      await flush();
      assert.equal(fixture.observer.activeResponse(), "deflect");
      if (ending === "deflect_passed") fixture.bot.entities[7]!.position.x = -12;
      else fixture.entities.remove(7);
      fixture.tick();
      await flush();
      assert.equal(phases.at(-1)?.outcome, "held");
    } else await fixture.clock.settle(entered, 1_000);
    return { pending, state: watch(pending) };
  }, async [Symbol.asyncDispose]() {
    fixture.runner.cancelActive("End chain test");
    finishEvade();
    await fixture.observer.close();
    fixture.data.close();
  } };
}

/** Request cleanup is checked before fixture disposal can retire any retained response listener. */
function watchJourneyListeners(fixture: ReflexFixture): () => void {
  const botAdded = listenersAddedSince(fixture.bot);
  const clientAdded = listenersAddedSince(fixture.bot._client);
  return () => {
    for (const event of ["physicsTick", "entityHurt", "entityDead", "entityGone", "time", "health", "death", "game", "mount", "dismount", "end"])
      assert.equal(botAdded(event), 0, `request retained bot ${event} listener`);
    for (const event of ["entity_status", "explosion"])
      assert.equal(clientAdded(event), 0, `request retained client ${event} listener`);
  };
}

/** A visible incoming fireball; its direction and size are read through the real projectile readers. */
function incomingBall(x: number): FakeEntitySpec {
  return { name: "fireball", kind: "Projectiles", position: new Vec3(x, 65, 0), velocity: new Vec3(-0.5, 0, 0) };
}

type HeldEvidenceCase = "deflect_gone" | "deflect_incoming" | "deflect_far_answered" | "arrow" | "arrow_gone"
  | "deflect_passed" | "deflect_passed_incoming" | "deflect_passed_far_incoming"
  | "alive" | "dead" | "mixed" | "all_dead" | "combat" | "policy_settlement" | "stand_down" | "cancel"
  | "at_range" | "outside_range" | "pursuer" | "live_arrow" | "live_arrow_gone"
  | "live_fireball" | "live_fireball_gone" | "live_far_fireball";

/** Change only server observations or existing controller contracts after the held response has ended. */
async function arrangeHeldEvidence(fixture: ReturnType<typeof heldJourney>, scenario: HeldEvidenceCase) {
  if (scenario.startsWith("deflect")) {
    fixture.entities.spawn({ id: 9, ...hostile("magma_cube", scenario.startsWith("deflect_passed") ? 9 : 12) });
    if (scenario === "deflect_passed_incoming") {
      fixture.bot.entities[7]!.position.x = 12;
      // Keep the deciding tick non-responsive so the hold must report why it returns.
      fixture.driver.answered.remember(responseScope(fixture.bot, () => fixture.controller.policy.effective, "deflect", 7),
        { kind: "execution_failed", why: "The still-incoming projectile's deflection was already answered" });
    }
    if (scenario === "deflect_incoming" || scenario === "deflect_far_answered" || scenario === "deflect_passed_far_incoming") {
      fixture.entities.spawn({ id: 8, ...incomingBall(scenario === "deflect_incoming" ? 12 : 20) });
      if (scenario === "deflect_far_answered") fixture.driver.answered.remember(
        responseScope(fixture.bot, () => fixture.controller.policy.effective, "deflect", 8),
        { kind: "execution_failed", why: "Already answered this incoming fireball" });
    }
    return;
  }
  fixture.finishEvade();
  await flush();
  assert.equal(fixture.phases.at(-1)?.outcome, "held");
  if (scenario === "alive" || scenario === "mixed") fixture.bot.entities[scenario === "mixed" ? 8 : 7]!.position.x = 12;
  if (["at_range", "outside_range", "pursuer"].includes(scenario)) {
    fixture.bot.entities[7]!.position.x = scenario === "at_range" ? 16 : scenario === "outside_range" ? 16.1 : 21.7;
    fixture.bot.entities[7]!.velocity.x = 0.2;
  }
  if (scenario.startsWith("live_")) {
    fixture.bot.entities[7]!.position.x = 6;
    const arrow = scenario.includes("arrow");
    fixture.entities.spawn({ id: 8, ...(arrow ? { name: "arrow", position: new Vec3(0, 67.3, 8), velocity: new Vec3(0, 0, -1) }
      : incomingBall(scenario === "live_far_fireball" ? 20 : 12)) });
    if (!arrow) fixture.driver.answered.remember(responseScope(fixture.bot, () => fixture.controller.policy.effective, "deflect", 8),
      { kind: "deflection_unobserved", why: "This shot's deflection was already answered" });
    if (scenario.endsWith("gone")) fixture.entities.remove(8);
  }
  if (scenario === "dead" || scenario === "mixed" || scenario === "all_dead") {
    fixture.combat.kill(7);
    if (scenario === "all_dead") fixture.combat.kill(8);
    fixture.entities.spawn({ id: 9, ...hostile("magma_cube", 12) });
  }
  if (scenario === "arrow" || scenario === "arrow_gone") {
    fixture.entities.remove(7);
    const arrow = fixture.entities.spawn({ id: 8, name: "arrow", position: new Vec3(0, 67.3, 8), velocity: new Vec3(0, 0, -1) });
    assert.equal(isIncomingArrow(fixture.bot, arrow), true);
    if (scenario === "arrow_gone") fixture.entities.remove(8);
  }
  if (scenario === "combat") {
    fixture.entities.remove(7);
    fixture.entities.spawn({ id: 9, ...hostile("magma_cube", 12) });
    fixture.controller.activeEngagement = () => ({ kind: "mob", targetId: 9 });
  }
  if (scenario === "policy_settlement") {
    const policy = fixture.controller.policy;
    const stop = policy.onChange(() => {
      fixture.tick();
      assert.deepEqual(fixture.driver.snapshot()[0]?.decision, { kind: "handled", by: "policy_settlement" });
    });
    try { await policy.edit({ operation: "set", expected_revision: policy.snapshot().revision,
      changes: { combat: { melee: false } }, lifetime: { kind: "session" }, reason: "Observe the admission barrier" }); }
    finally { stop(); }
  }
  if (scenario === "stand_down") await fixture.controller.policy.edit({ operation: "set",
    expected_revision: fixture.controller.policy.snapshot().revision,
    changes: { combat: { retreat: false, melee: false, bow: false } }, lifetime: { kind: "session" }, reason: "Stand down while a threat remains" });
  if (scenario === "cancel") {
    assert.equal(fixture.runner.cancelRequest(fixture.runner.request()!.id, "Cancel the held journey").kind, "cancellation_requested");
    fixture.entities.remove(7);
  }
}

for (const ticksPerSecond of [20, 10]) {
  for (const scenario of ["deflect_gone", "deflect_incoming", "deflect_far_answered", "arrow", "arrow_gone",
    "alive", "dead", "mixed", "all_dead", "combat", "policy_settlement", "stand_down", "cancel",
    "deflect_passed", "deflect_passed_incoming", "deflect_passed_far_incoming",
    "at_range", "outside_range", "pursuer", "live_arrow", "live_arrow_gone", "live_fireball",
    "live_fireball_gone", "live_far_fireball"] as const) {
    const label = scenario === "deflect_passed_far_incoming" ? "deflect_passed with a still incoming fireball beyond observation range" : scenario;
    test(`held threat evidence ${label} decides the walk at ${ticksPerSecond} tps`, async () => {
      const deflect = scenario.startsWith("deflect");
      const passedDeflect = scenario.startsWith("deflect_passed");
      const entities: Record<number, FakeEntitySpec> = { 7: deflect ? incomingBall(12) : hostile(scenario.startsWith("arrow") ? "skeleton" : "zombie", 3) };
      if (scenario === "mixed" || scenario === "all_dead") entities[8] = hostile("zombie", -3);
      await using fixture = heldJourney(ticksPerSecond, passedDeflect ? "deflect_passed" : deflect ? "deflect" : "removed", entities);
      using _clock = fixture.clock.install();
      const baseline = fixture.clock.pendingGlobalTimers();
      const assertListeners = watchJourneyListeners(fixture);
      const { pending, state } = await fixture.start();
      if (passedDeflect) {
        assert.deepEqual(fixture.recorded(), ["deflect -> capability_limit"]);
        assert.equal(fixture.bot.entities[7]!.isValid, true);
      }
      await arrangeHeldEvidence(fixture, scenario);
      let settlements = 0;
      void pending.then(() => settlements++);
      fixture.tick();
      await flush();
      if (scenario === "deflect_incoming") {
        assert.equal(state.over, false);
        assert.equal(fixture.phases.at(-1)?.outcome, "attached");
        assert.equal(fixture.observer.activeResponse(), "deflect");
        assert.equal(fixture.attempts(), 1);
        fixture.runner.cancelRequest(fixture.runner.request()!.id, "End the attached deflection");
        fixture.entities.remove(8);
        fixture.tick();
      }
      const output = await fixture.clock.settle(pending, 1_000);
      const resumes = ["deflect_gone", "deflect_passed", "arrow_gone", "dead", "all_dead", "alive", "mixed", "stand_down",
        "at_range", "outside_range", "pursuer", "live_arrow_gone", "live_fireball_gone"].includes(scenario);
      assert.equal(output.result.status, resumes ? "succeeded" : "cancelled");
      assert.equal(fixture.attempts(), resumes ? 2 : 1);
      assert.equal(fixture.clock.now(), 0, "the deciding body tick needs no grace period");
      assert.equal(fixture.bot.time.age, 1_000);
      assert.equal(fixture.phases.at(-1)?.resumed, resumes);
      const receipt = output.interruptions?.at(-1) ?? "";
      if (resumes) assert.match(receipt, /stood down \(no projectile in flight, (?:no hostile tracked|target .+)\): the walk resumes\.$/);
      if (scenario === "deflect_gone") assert.ok(receipt.endsWith("target fireball#7 gone): the walk resumes."));
      if (scenario === "deflect_passed") {
        assert.ok(receipt.endsWith("target fireball#7 passed): the walk resumes."));
        assert.equal(fixture.phases.at(-1)?.notEnded, undefined);
      }
      if (passedDeflect) assert.equal(fixture.phases.at(-1)?.outcome, "released");
      if (scenario === "deflect_passed_incoming") assert.equal(fixture.phases.at(-1)?.notEnded, "projectile fireball#7 incoming at 12.0");
      if (scenario === "deflect_passed_far_incoming") assert.equal(fixture.phases.at(-1)?.notEnded, "projectile fireball#8 incoming at 20.0");
      if (scenario === "dead") assert.ok(receipt.endsWith("target zombie#7 dead): the walk resumes."));
      if (scenario === "all_dead") assert.ok(receipt.endsWith("target zombie#7 dead, target zombie#8 dead): the walk resumes."));
      if (scenario === "combat" || scenario === "policy_settlement" || scenario === "deflect_far_answered")
        assert.match(receipt, /chose no further response \(handled\)\.$/);
      if (scenario === "arrow") assert.match(receipt, /chose no further response \(none_observed\)\.$/);
      if (scenario === "alive" || scenario === "mixed") assert.ok(receipt.includes(`target zombie#${scenario === "mixed" ? 8 : 7} alive at 12.0 blocks`));
      if (["at_range", "outside_range", "pursuer"].includes(scenario)) {
        assert.ok(receipt.includes(`target zombie#7 alive at ${fixture.bot.entities[7]!.position.distanceTo(fixture.bot.entity.position).toFixed(1)} blocks`));
        assert.equal(receipt.includes("no hostile tracked"), false);
      }
      if (scenario === "live_arrow") assert.equal(fixture.phases.at(-1)?.notEnded, "shield projectile arrow#8");
      if (scenario === "live_fireball" || scenario === "live_far_fireball")
        assert.equal(fixture.phases.at(-1)?.notEnded, `projectile fireball#8 incoming at ${scenario === "live_fireball" ? "12.0" : "20.0"}`);
      if (scenario === "arrow") assert.equal(fixture.phases.at(-1)?.notEnded, "shield projectile arrow#8");
      if (scenario === "stand_down") assert.ok(receipt.includes("target zombie#7 alive at 3.0 blocks"));
      assert.equal(settlements, 1);
      if (scenario === "policy_settlement") assert.equal(fixture.runner.releaseHold("hostile_reflex", "late", "late evidence"), false);
      for (const entity of Object.values(fixture.bot.entities)) if (entity.id !== fixture.bot.entity.id) fixture.entities.remove(entity.id);
      const next = await fixture.clock.settle(fixture.runner.run(fixture.action, {}), 1_000);
      assert.equal(next.result.status, "succeeded");
      const phases = fixture.phases.length;
      await fixture.clock.advance(100_000, 1_000);
      assert.equal(fixture.phases.length, phases);
      assert.equal(fixture.clock.pendingGlobalTimers(), baseline);
      assertListeners();
    });
  }
}

// Release-time inputs from a8 T4's four receipts, not the later idle-window observations (a8 T5, 2026-11-18).
for (const ticksPerSecond of [20, 10]) for (const capture of [
  { trial: "t00004", age: 420, id: 50, distance: 11.248794967740228, blaze: 69.64800147226045, contact: false },
  { trial: "t00007", age: 400, id: 50, distance: 6.7943847616726645, blaze: 55.12222432182629, contact: true },
  { trial: "t00009", age: 380, id: 46, distance: 5.982700363314753, blaze: 66.55278980762178, contact: true },
  { trial: "t00011", age: 440, id: 46, distance: 4.776674263424586, blaze: 71.74877596518783, contact: true },
]) test(`captured fortress ${capture.trial} resumes after its unchanged decision at ${ticksPerSecond} tps`, async () => {
  await using fixture = heldJourney(ticksPerSecond, "removed", {
    [capture.id]: hostile("wither_skeleton", 4), [capture.id + 1]: hostile("blaze", 10.44),
  }, undefined, { startAge: capture.age, carried: { iron_sword: 1, bow: 1, arrow: 32, cooked_beef: 16, cobblestone: 64 },
    slots: { 45: { name: "shield" } } });
  using _clock = fixture.clock.install();
  const baseline = fixture.clock.pendingGlobalTimers();
  const assertListeners = watchJourneyListeners(fixture);
  const { pending } = await fixture.start();
  fixture.bot.entities[capture.id]!.position.x = capture.distance;
  fixture.bot.entities[capture.id + 1]!.position.x = capture.blaze;
  fixture.finishEvade();
  await flush();
  assert.equal(fixture.phases.at(-1)?.outcome, "held");
  const facts = observeCombatDecision(fixture.bot, fixture.observer.threats);
  assert.deepEqual(facts.contacts.map(({ id, distance, inContact, inReach, defendsOnContact, ranged }) =>
    ({ id, distance, inContact, inReach, defendsOnContact, ranged })),
    [{ id: capture.id, distance: capture.distance, inContact: capture.contact, inReach: false, defendsOnContact: true, ranged: false }]);
  assert.equal(facts.health, 11);
  assert.equal(facts.hideAllowed, false);
  assert.equal(facts.answered.has("evade"), true);
  let settlements = 0;
  void pending.then(() => settlements++);
  fixture.tick();
  const output = await fixture.clock.settle(pending, 1_000);
  const decision = fixture.driver.snapshot().find(({ name }) => name === "hostile_reflex")?.decision;
  if (!capture.contact) assert.deepEqual(decision, { kind: "handled", by: "no_contact" });
  else assert.ok(decision && typeof decision === "object" && "kind" in decision && decision.kind === "stand_down");
  assert.equal(output.result.status, "succeeded");
  assert.equal(fixture.attempts(), 2);
  assert.equal(fixture.phases.filter(({ outcome }) => outcome === "released").length, 1);
  assert.equal(fixture.phases.at(-1)?.resumed, true);
  const receipt = output.interruptions!.at(-1)!;
  assert.ok(receipt.endsWith(`hostile_reflex stood down (no projectile in flight, target wither_skeleton#${capture.id} alive at ${capture.distance.toFixed(1)} blocks, target blaze#${capture.id + 1} alive at ${capture.blaze.toFixed(1)} blocks): the walk resumes.`));
  assert.equal(receipt.includes("no hostile tracked"), false);
  assert.equal(receipt.includes("saw the threat end"), false);
  assert.equal(fixture.clock.now(), 0);
  assert.equal(fixture.bot.time.age, capture.age);
  for (const id of [capture.id, capture.id + 1]) fixture.entities.remove(id);
  assert.equal((await fixture.clock.settle(fixture.runner.run(fixture.action, {}), 1_000)).result.status, "succeeded");
  const phases = fixture.phases.length;
  await fixture.clock.advance(100_000, 1_000);
  assert.equal(fixture.phases.length, phases);
  assert.equal(settlements, 1);
  assert.equal(fixture.clock.pendingGlobalTimers(), baseline);
  assertListeners();
});

for (const ticksPerSecond of [20, 10]) {
  test(`a held fight target walking away stays alive at ${ticksPerSecond} tps`, async () => {
    const fixture = reflexFixture(async (id) => died(id), undefined, {
      clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond, startAge: 1_000 },
      entities: { 7: { ...hostile("zombie", 12), velocity: new Vec3(0.5, 0, 0) } },
    });
    using _clock = fixture.clock.install();
    try {
      const policy = fixture.controller.policy;
      const scene: HostileScene = { ...fixture, policy, activeResponse: null, chains: new ThreatChains(), stalls: new RequestStalls(),
        encounterThreats: new Set(), transition: (pending) => { void pending; },
        context: { survival: fixture.driver, policy: policy.combat, food: policy.food, perception: fixture.perception,
          resolvedIds: fixture.perception.resolvedIds, attackerIds: fixture.perception.attackerIds } };
      const observed = senseHostile(scene);
      assert.equal(observed?.kind, "observed");
      assert.deepEqual(heldThreatEnded(scene, { kind: "fight", targetId: 7,
        threats: [{ id: 7, name: "zombie", position: { x: 12, y: 64, z: 0 }, distance: 12 }] }, observed!.danger),
      { ended: "no projectile in flight, target zombie#7 alive at 12.0 blocks" });
      assert.deepEqual(heldThreatEnded(scene, { kind: "evade", threats: [], safeRange: 36, reason: "hurt" }, observed!.danger),
        { ended: "no projectile in flight" });
      assert.deepEqual(heldThreatEnded(scene, { kind: "evade", threats: [], safeRange: 36, reason: "hurt" }, null),
        { ended: "no projectile in flight, no hostile tracked" });
      assert.equal(fixture.clock.now(), 0);
      assert.equal(fixture.bot.time.age, 1_000);
    } finally {
      await fixture.observer.close();
      fixture.data.close();
    }
  });

}

for (const ticksPerSecond of [20, 10]) {
  for (const ending of ["resume", "return"] as const)
    test(`a new deciding-tick contact attaches and its ${ending} verdict decides the held walk (${ticksPerSecond} tps)`, async () => {
      let evidenceCalls = 0;
      await using fixture = heldJourney(ticksPerSecond, ending, undefined, () => evidenceCalls++);
      using _clock = fixture.clock.install();
      const assertListeners = watchJourneyListeners(fixture);
      const { pending } = await fixture.start();
      fixture.finishEvade();
      await flush();
      fixture.entities.remove(7);
      fixture.entities.spawn({ id: 9, ...hostile("zombie", 3) });
      fixture.tick();
      const output = await fixture.clock.settle(pending, 1_000);
      assert.equal(output.result.status, ending === "resume" ? "succeeded" : "cancelled");
      assert.equal(fixture.attempts(), ending === "resume" ? 2 : 1);
      assert.deepEqual(fixture.phases.map(({ outcome }) => outcome), ["held", "attached", "released"]);
      assert.equal(evidenceCalls, 0, "a respond decision keeps its real verdict in charge");
      assert.ok(output.interruptions!.some(receipt => receipt.includes("fight response for zombie#9")));
      await flush();
      assert.ok(fixture.recorded().includes(ending === "resume" ? "fight -> target_died" : "fight -> capability_limit"));
      if (fixture.bot.entities[9]) fixture.entities.remove(9);
      assert.equal((await fixture.clock.settle(fixture.runner.run(fixture.action, {}), 1_000)).result.status, "succeeded");
      await fixture.clock.advance(100_000, 1_000);
      assertListeners();
    });

  test(`a resumed walk can be preempted into a fresh hostile hold (${ticksPerSecond} tps)`, async () => {
    await using fixture = heldJourney(ticksPerSecond, "removed", undefined, undefined, { holds: 2 });
    using _clock = fixture.clock.install();
    const assertListeners = watchJourneyListeners(fixture), timers = fixture.clock.pendingGlobalTimers();
    const { pending, state } = await fixture.start();
    fixture.finishEvade();
    await flush();
    fixture.bot.entities[7]!.position.x = 12;
    fixture.tick();
    await flush();
    assert.equal(fixture.attempts(), 2);
    assert.equal(state.over, false);
    assert.equal(fixture.phases.at(-1)?.resumed, true);
    fixture.entities.remove(7);
    fixture.bot.entity.position.x = 1; // A new cell is a real changed premise for the spent evade.
    fixture.entities.spawn({ id: 9, ...hostile("zombie", 4) });
    fixture.tick();
    await flush();
    assert.equal(fixture.phases.at(-1)?.outcome, "held");
    assert.equal(fixture.phases.at(-1)?.generation, 1);
    fixture.bot.entities[9]!.position.x = 13;
    fixture.tick();
    const output = await fixture.clock.settle(pending, 1_000);
    assert.equal(output.result.status, "succeeded");
    assert.equal(fixture.attempts(), 3);
    assert.deepEqual(fixture.phases.map(({ outcome }) => outcome), ["held", "released", "held", "released"]);
    assert.equal(output.interruptions!.filter(receipt => receipt.includes("stood down")).length, 2);
    assert.ok(output.interruptions![0]!.includes("zombie#7 alive at 12.0 blocks"));
    assert.ok(output.interruptions!.at(-1)!.includes("zombie#9 alive at 12.0 blocks"));
    assert.equal(fixture.clock.now(), 0);
    assert.equal(fixture.bot.time.age, 1_000);
    fixture.entities.remove(9);
    assert.equal((await fixture.clock.settle(fixture.runner.run(fixture.action, {}), 1_000)).result.status, "succeeded");
    await fixture.clock.advance(100_000, 1_000);
    assert.equal(fixture.clock.pendingGlobalTimers(), timers);
    assertListeners();
  });

  for (const ended of [true, false]) {
    test(`held threat evidence survives an attached fight yielding to footing, threat ended ${ended} (${ticksPerSecond} tps)`, async () => {
      let evidenceCalls = 0;
      await using fixture = heldJourney(ticksPerSecond, "higher", undefined, () => evidenceCalls++);
      using _clock = fixture.clock.install();
      const assertListeners = watchJourneyListeners(fixture);
      const { pending, state } = await fixture.start();
      fixture.finishEvade();
      await flush();
      fixture.tick();
      await flush();
      assert.equal(fixture.observer.activeResponse(), "fight");
      assert.equal(fixture.phases.at(-1)?.outcome, "attached");
      const higher = fixture.runner.claim("recover_footing", "Landing before combat continues",
        async () => ({ value: null, continuation: { kind: "resume" } }));
      assert.equal(higher.kind, "claimed");
      if (higher.kind === "claimed") await higher.outcome;
      await flush();
      assert.equal(state.over, false, "footing resume cannot itself decide the hostile hold");
      assert.equal(fixture.phases.at(-1)?.outcome, "held");
      assert.equal(fixture.phases.at(-1)?.generation, 2);
      if (ended) fixture.entities.remove(7);
      else fixture.bot.entities[7]!.position.x = 12;
      fixture.tick();
      const output = await fixture.clock.settle(pending, 1_000);
      assert.equal(output.result.status, "succeeded");
      assert.equal(fixture.attempts(), 2);
      assert.equal(evidenceCalls, 1);
      assert.equal(fixture.phases.at(-1)?.resumed, true);
      assert.equal(fixture.clock.now(), 0);
      assert.equal(fixture.bot.time.age, 1_000);
      assert.match(output.interruptions!.at(-1)!, ended
        ? /stood down \(no projectile in flight, no hostile tracked\): the walk resumes\.$/
        : /stood down \(no projectile in flight, target zombie#7 alive at 12.0 blocks\): the walk resumes\.$/);
      if (!ended) fixture.entities.remove(7);
      assert.equal((await fixture.clock.settle(fixture.runner.run(fixture.action, {}), 1_000)).result.status, "succeeded");
      await fixture.clock.advance(100_000, 1_000);
      assertListeners();
    });
  }
}

for (const ticksPerSecond of [20, 10]) {
  test(`a dimension change resumes a held journey when the driver observes game before the runner (${ticksPerSecond} tps)`, async () => {
    let evidenceChecks = 0;
    await using fixture = heldJourney(ticksPerSecond, "resume", undefined, () => evidenceChecks++);
    using _clock = fixture.clock.install();
    const assertListeners = watchJourneyListeners(fixture);
    const timers = fixture.clock.pendingGlobalTimers();
    const { pending, state } = await fixture.start();
    fixture.finishEvade();
    await flush();
    assert.equal(state.over, false);
    assert.equal(fixture.phases.at(-1)?.outcome, "held");
    const from = fixture.bot.game.dimension;
    // Runtime installs retireWorld after the driver; Mineflayer game.js:118-121 updates the dimension before game.
    const retireWorld = () => fixture.runner.dimensionChanged(from, fixture.bot.game.dimension);
    fixture.bot.on("game", retireWorld);
    try {
      fixture.bot.game.dimension = "the_nether";
      fixture.bot.emit("game");
      const output = await fixture.clock.settle(pending, 1_000);
      assert.equal(output.result.status, "succeeded");
      assert.equal(fixture.attempts(), 2);
      assert.equal(fixture.runner.request(), null);
      assert.equal(fixture.clock.pendingGlobalTimers(), timers);
      fixture.entities.remove(7);
      const next = await fixture.clock.settle(fixture.runner.run(fixture.action, {}), 1_000);
      assert.equal(next.result.status, "succeeded");
      const phases = fixture.phases.length;
      await fixture.clock.advance(100_000, 1_000);
      assert.equal(fixture.clock.pendingGlobalTimers(), timers);
      assert.equal(fixture.phases.length, phases, "the retired hold's backstop cannot publish later");
      assert.equal(evidenceChecks, 0, "a world change resumes through the runner without asking heldEnded");
    } finally {
      fixture.bot.off("game", retireWorld);
    }
    assertListeners();
  });
}

for (const ticksPerSecond of [20, 10]) {
  for (const ending of ["resume", "return", "removed", "hide", "hunger"] as const) {
    test(`an exhausted evade keeps its journey until ${ending} decides the chain (${ticksPerSecond} tps)`, async () => {
      await using fixture = heldJourney(ticksPerSecond, ending);
      using _clock = fixture.clock.install();
      const { pending, state } = await fixture.start();
      await fixture.clock.advance(20_000 / ticksPerSecond);
      assert.equal(fixture.bot.time.age, 1_020);
      let hungry = false;
      if (ending === "hunger") {
        fixture.driver.register({ name: "hunger_reflex", sense: () => fixture.bot.food < 18 && !hungry
          ? { kind: "observed", danger: true, evidence: { food: fixture.bot.food } } : null,
          decide: () => ({ kind: "respond", name: "eat", response: true, reason: "Hungry" }),
          facts: () => ({ capability: "hunger", response: "eat", scope: "meal", facts: () => null, permissions: () => null }),
          limits: () => ({ ceilingTicks: 400, noProgressTicks: 160, standDownTicks: 40 }),
          act: async () => { hungry = true; return null; }, continuation: () => ({ kind: "resume" }),
          failure: () => null, describe: () => null });
        fixture.runner.onOwnershipChange(() => {
          if (!hungry && fixture.runner.ownership().current === null && fixture.phases.at(-1)?.outcome === "held") fixture.tick();
        });
      }
      fixture.finishEvade();
      await flush();
      assert.equal(state.over, false, "the exhausted evade must not return the journey before the next decision");
      assert.equal(fixture.attempts(), 1, "a hunger resume cannot restart the held journey");
      if (ending === "hunger") assert.equal(hungry, true);
      if (ending === "removed") fixture.entities.remove(7);
      fixture.tick();
      const output = await fixture.clock.settle(pending, 1_000);
      assert.equal(output.result.status, ending === "resume" || ending === "removed" ? "succeeded" : "cancelled");
      assert.equal(fixture.attempts(), ending === "resume" || ending === "removed" ? 2 : 1);
      const interruptions = output.interruptions ?? [];
      assert.match(interruptions[0]!, /^\[HOSTILE_SETTLED\] evade ended with capability_limit at health 11:/);
      if (ending === "removed") {
        assert.match(interruptions.at(-1)!, /hostile_reflex stood down \(no projectile in flight, no hostile tracked\): the walk resumes\.$/);
        assert.equal(fixture.phases.at(-1)?.resumed, true);
        assert.equal(fixture.clock.now(), 20_000 / ticksPerSecond, "release needs no world-tick grace window");
      } else {
        assert.equal(interruptions.length, 3);
        assert.match(interruptions[1]!, ending === "hide" ? /^\[HOSTILE_CONTACT\] hide response/ : /^\[HOSTILE_CONTACT\] fight response/);
        assert.match(interruptions[2]!, ending === "resume" ? /fight ended with target_died at health 11; 2nd response to zombie#7/
          : ending === "hide" ? /hide ended with capability_limit.*2nd response to zombie#7/ : /fight ended with capability_limit.*2nd response to zombie#7/);
        if (output.result.status === "cancelled") {
          const positions = interruptions.map((receipt) => output.result.status === "cancelled" ? output.result.error.indexOf(receipt) : -1);
          assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!)));
        }
      }
      assert.deepEqual(fixture.phases.map(({ phase, outcome, worldAge, generation }) => ({ phase, outcome, worldAge, generation })), [
        { phase: "hold", outcome: "held", worldAge: 1_020, generation: 1 },
        { phase: "hold", outcome: ending === "removed" ? "released" : "attached", worldAge: 1_020, generation: 1 },
        ...(ending === "removed" ? [] : [{ phase: "hold", outcome: "released", worldAge: 1_020, generation: 1 }]),
      ]);
    });
  }
}

/** The response a bot at 11 health runs for `directive`, settled and read as its encounter receipt. */
async function evadeReceipt(fixture: ReflexFixture, directive: HostileResponse, signal = new AbortController().signal) {
  const response = await executeHostileResponse(fixture.bot, fixture.navigation, fixture.controller, directive, fixture.observer.threats, 11, signal);
  return encounterReceipt(completeResponse(response, signal));
}

function died(targetId: number): CombatOutcome {
  return {
    kind: "died",
    targetId,
    attacks: 1,
    stylesUsed: ["melee"],
    weaponsUsed: ["hand"],
    shieldRaisedSwings: 0,
    projectileGuards: 0,
    explosions: 0,
  };
}

test("a food-policy revocation cancels a protected automatic recovery bite", async () => {
  const fixture = reflexFixture(async () => { throw new Error("A hide must not engage"); }, undefined, {
    cells: sealedCells(),
    entities: { 7: hostile("zombie", 12) },
    carried: { beef: 2 },
    health: 2,
    food: 10,
  });
  seeThroughShelter(fixture.bot);
  try {
    fixture.tick();
    assert.ok(await until(() => fixture.bot.usingHeldItem));
    await fixture.controller.policy.edit({ operation: "set", expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { food: { raw: { allow: "never" } } }, lifetime: { kind: "session" }, reason: "keep raw meat" });
    assert.equal(fixture.bot.usingHeldItem, false);
    assert.equal(fixture.runner.status().busy, false);
    assert.equal(fixture.controller.policy.settling, false);
    assert.equal(fixture.bot.inventory.items()[0]?.count, 2);
  } finally {
    await fixture.observer.close();
    fixture.data.close();
  }
});

for (const kind of ["mob", "end"] as const) {
  test(`hostile takeover ${kind === "end" ? "awaits End cleanup" : "leaves an ordinary fight in charge"}`, async () => {
    let active: { kind: "mob" | "end"; targetId: number } | null = { kind, targetId: 42 };
    let defenses = 0,
      cleaning = false,
      started = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const fixture = reflexFixture(async (id) => {
      assert.equal(active, null, "the old combat owner must release before a new fight starts");
      defenses++;
      return died(id);
    }, undefined, { entities: { 7: hostile("zombie", 2) } });
    fixture.controller.activeEngagement = () => active;
    const request = z.strictObject({});
    const action = defineAction({
      name: "occupied_combat_test",
      description: "Exercise physical handoff",
      inputSchema: request,
      resultSchema: actionResultSchema({}),
      formatResult: (result) => result.status,
      parse: (input) => request.parse(input),
      execution: { kind: "task" },
      execute: async (_, { signal }) => {
        started = true;
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
        cleaning = true;
        await cleanup;
        active = null;
        signal!.throwIfAborted();
        return { status: "succeeded" };
      },
    });
    const pending = fixture.runner.run(action, {});
    try {
      assert.ok(await until(() => started));
      fixture.tick();
      if (kind === "end") {
        assert.ok(await until(() => cleaning));
        assert.equal(fixture.runner.status().owner, "yielding");
        assert.equal(defenses, 0);
        fixture.tick();
      } else {
        assert.equal(fixture.runner.status().owner, "foreground");
        assert.equal(cleaning, false);
        fixture.runner.cancelActive("Test completed ordinary fight observation");
      }
      releaseCleanup();
      const output = await pending;
      assert.equal(output.result.status, "cancelled");
      if (kind === "end") assert.ok(await until(() => fixture.recorded().length === 1));
      assert.equal(defenses, kind === "end" ? 1 : 0);
      assert.equal(fixture.runner.status().owner, "idle");
    } finally {
      releaseCleanup();
      fixture.runner.cancelActive("Test cleanup");
      await pending;
      await fixture.observer[Symbol.asyncDispose]();
      fixture.data.close();
    }
  });
}

test("an incoming blaze projectile starts combat before damage beyond observation range", async () => {
  const fixture = reflexFixture(async (id) => died(id), undefined, {
    entities: {
      7: hostile("blaze", 26),
      8: { name: "small_fireball", kind: "Projectiles", position: new Vec3(20, 65, 0), velocity: new Vec3(0, 0, 0) },
    },
  });
  try {
    fixture.bot._client.emit("spawn_entity", {
      entityId: 8,
      type: fixture.bot.registry.entitiesByName.small_fireball!.id,
      objectData: 7,
      velocity: { x: -4000, y: 0, z: 0 },
    });
    fixture.tick();
    assert.equal(fixture.runner.status().owner, "takeover");
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.deepEqual(fixture.recorded(), ["fight -> target_died"]);
    assert.equal(fixture.bot.health, 20);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("a blaze shot travelling away does not attribute another victim's combat to us", async () => {
  const fixture = reflexFixture(async (id) => died(id), undefined, {
    entities: {
      7: hostile("blaze", 26),
      8: { name: "small_fireball", kind: "Projectiles", position: new Vec3(20, 65, 0), velocity: new Vec3(0.5, 0, 0) },
    },
  });
  try {
    fixture.bot._client.emit("spawn_entity", {
      entityId: 8,
      type: fixture.bot.registry.entitiesByName.small_fireball!.id,
      objectData: 7,
      velocity: { x: 4000, y: 0, z: 0 },
    });
    fixture.tick();
    assert.equal(fixture.runner.status().busy, false);
    assert.equal(fixture.observer.threats.attackerIds.size, 0);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

/** Let the claimed response run to its recorded event, or give up after a bounded number of turns. */
async function until(condition: () => boolean, turns = 50): Promise<boolean> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (condition()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return condition();
}

/** Clock slices of 50 ms until the runner has released the body, at most `maxMs` of clock. */
async function advanceUntilIdle(fixture: ReflexFixture, maxMs: number): Promise<void> {
  for (let passed = 0; fixture.runner.status().busy && passed < maxMs; passed += 50) await fixture.clock.advance(50);
}

test("the automatic enderman response holds its stance across a teleport", async () => {
  const fixture = reflexFixture(
    async (targetId, signal, movement) => {
      assert.equal(movement, "hold");
      fixture.bot.entities[targetId]!.position.x = 8;
      fixture.tick();
      assert.equal(signal.aborted, false, "a teleport beyond melee reach does not cancel the guard");
      return died(targetId);
    },
    undefined,
    { entities: { 7: hostile("enderman", 3) } },
  );
  const enderman = fixture.bot.entities[7]!;
  Reflect.set(enderman.metadata, fixture.bot.registry.entitiesByName.enderman!.metadataKeys!.indexOf("creepy"), true);
  try {
    fixture.combat.hurtBot(1, 7);
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.deepEqual(fixture.recorded(), ["fight -> target_died"]);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("claims an idle body for a hostile in contact and records what happened", async () => {
  const fixture = reflexFixture(async (targetId) => died(targetId), undefined, { entities: { 7: hostile("zombie", 3) } });

  fixture.tick();
  assert.equal(fixture.runner.status().owner, "takeover");
  assert.ok(await until(() => fixture.recorded().length === 1));

  assert.deepEqual(fixture.recorded(), ["fight -> target_died"]);
  assert.equal(fixture.runner.status().busy, false);
  assert.ok(await until(() => fixture.bot.listenerCount("death") === fixture.deathListenersAtRest));
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("a denied reflex claim removes its death listener", async () => {
  const fixture = reflexFixture(async (targetId) => died(targetId), undefined, { entities: { 7: hostile("zombie", 3) } });
  Object.defineProperty(fixture.runner, "claim", {
    value: () => ({ kind: "busy", activeAction: { action: "other", startedAt: new Date().toISOString() } }),
  });
  fixture.tick();
  assert.equal(fixture.bot.listenerCount("death"), fixture.deathListenersAtRest);
  assert.deepEqual(fixture.recorded(), []);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("an emergency retreat excludes momentum-dependent parkour while preserving supported movement", async () => {
  let called = false;
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async ({ movements }) => {
      called = true;
      assert.equal(movements.allowParkour, false);
      assert.equal(movements.allowSprinting, true);
      assert.equal(movements.allowPlacing, true);
      fixture.bot.entity.position.x = -40;
      return { status: "completed", elapsedMs: 0 };
    },
    { entities: { 7: hostile("zombie", 3) } },
  );
  fixture.bot.health = 11;
  const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
  assert.equal(directive.kind, "evade");
  try {
    const result = await evadeReceipt(fixture, directive);
    assert.equal(called, true);
    assert.equal(result.outcome, "safe_separation");
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("an admitted low-health escape is not stopped for a stationary guard it cannot sustain", async () => {
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async ({ stopSignal }) => {
      assert.equal(stopSignal?.aborted, false);
      fixture.bot.entity.position.x = -40;
      fixture.entities.remove(8);
      return { status: "completed", elapsedMs: 0 };
    },
    { entities: { 7: hostile("blaze", 3) } },
  );
  fixture.bot.health = 11;
  const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
  assert.equal(directive.kind, "evade");
  fixture.bot.health = 7;
  fixture.inventory.updateSlot(45, itemOf(fixture.bot.registry, "shield", 1));
  fixture.entities.spawn({
    id: 8,
    ...hostile("small_fireball", 8),
    position: new Vec3(8, 65, 0),
    velocity: new Vec3(-0.5, 0, 0),
  });
  try {
    const result = await evadeReceipt(fixture, directive);
    assert.equal(result.outcome, "safe_separation");
    assert.equal(result.projectileGuards, 0);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("direct encounter cancellation cannot report safe separation after route cleanup", async () => {
  const cancellation = new AbortController();
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async () => {
      cancellation.abort("operator cancellation");
      fixture.bot.entity.position.x = -40;
      return { status: "completed", elapsedMs: 0 };
    },
    { entities: { 7: hostile("zombie", 3) } },
  );
  fixture.bot.health = 11;
  const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
  assert.equal(directive.kind, "evade");
  const result = await evadeReceipt(fixture, directive, cancellation.signal);
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.error, "operator cancellation");
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

for (const floor of ["safe", "damaging", "airborne"] as const) {
  test(`an evade timeout beyond required separation checks ${floor} footing before its verdict`, async () => {
    const fixture = reflexFixture(
      async (id) => died(id),
      async () => {
        fixture.bot.entity.position.x = -40;
        fixture.bot.entity.onGround = floor !== "airborne";
        return { status: "stopped", reason: "navigation timeout", elapsedMs: 15_000 };
      },
      { entities: { 7: hostile("zombie", 3) } },
    );
    const world = new MemoryWorld();
    world.load({ x: -40, y: 63, z: 0 }, { stateId: 1, traits: { damaging: floor === "damaging" } });
    world.load({ x: -40, y: 64, z: 0 }, { stateId: 0 });
    world.load({ x: -40, y: 65, z: 0 }, { stateId: 0 });
    Object.defineProperty(fixture.navigation, "world", { value: world });
    fixture.bot.health = 11;
    const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
    assert.equal(directive.kind, "evade");
    const result = await evadeReceipt(fixture, directive);
    assert.equal(result.outcome, floor === "safe" ? "safe_separation" : "capability_limit");
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  });
}

test("a controller cancellation after a policy edit preserves the cancellation receipt", async () => {
  const fixture = reflexFixture(async (targetId) => {
    await fixture.controller.policy.edit({
      operation: "set",
      expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { combat: { hide: "never" } },
      lifetime: { kind: "session" },
      reason: "test",
    });
    return { ...died(targetId), kind: "cancelled" };
  }, undefined, { entities: { 7: hostile("blaze", 3) } });
  try {
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.deepEqual(fixture.recorded(), ["fight -> cancelled"]);
    assert.equal(fixture.runner.status().busy, false);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("an unchanged out-of-reach failed fight stays suppressed when no alternate response is permitted", async () => {
  const fixture = reflexFixture(
    async () => {
      throw new Error("equipment unavailable");
    },
    undefined,
    { entities: { 7: hostile("blaze", 5) } },
  );
  await fixture.controller.policy.edit({
    operation: "set",
    expected_revision: fixture.controller.policy.snapshot().revision,
    changes: { combat: { retreat: false } },
    lifetime: { kind: "session" },
    reason: "test",
  });

  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 1));
  fixture.tick();

  assert.equal(fixture.runner.status().busy, false);
  assert.equal(await until(() => fixture.recorded().length > 1, 5), false);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("the reflex awaits combat recovery and records its capability limit", async () => {
  let engaging = false;
  let recoveryBlocked = () => {};
  const fixture = reflexFixture(
    (targetId) =>
      new Promise((resolve) => {
        engaging = true;
        recoveryBlocked = () =>
          resolve({
            ...died(targetId),
            kind: "capability_blocked",
            reason: "recovery",
            observation: "No food remains.",
            attacks: 2,
          });
      }), undefined, { entities: { 7: hostile("skeleton", 5) } },
  );
  fixture.tick();
  assert.ok(await until(() => engaging));
  fixture.combat.setHealth(7);
  assert.equal(fixture.runner.status().busy, true, "health alone does not settle the encounter");
  recoveryBlocked();
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["fight -> capability_limit"]);
  assert.equal(fixture.bot.listenerCount("health"), 0);

  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 2));
  assert.deepEqual(fixture.recorded(), ["fight -> capability_limit", "hide -> capability_limit"]);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("melee contact ending after 20 ticks out of reach releases the reflex without marking the target unreachable", async () => {
  let engaging = false;
  const fixture = reflexFixture(
    (targetId, signal, movement) =>
      new Promise((resolve) => {
        assert.equal(movement, "hold");
        engaging = true;
        signal.addEventListener("abort", () => resolve({ ...died(targetId), kind: "cancelled" }), { once: true });
      }), undefined, { entities: { 7: hostile("magma_cube", 3) } },
  );
  fixture.combat.hurtBot(1, 7);
  fixture.tick();
  assert.ok(await until(() => engaging));
  fixture.bot.entities[7]!.position.y = 58;
  for (let tick = 0; tick < CONTACT_GRACE_TICKS; tick += 1) fixture.tick();
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["fight -> contact_ended"]);
  assert.equal(fixture.driver.answered.snapshot().some((entry) => entry.response === "fight"), false);
  fixture.tick();
  assert.equal(fixture.runner.status().busy, false);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("ending the original melee contact cannot drop the owner while another fuse needs clearance", async () => {
  let engaging = false;
  const fixture = reflexFixture((targetId, signal) => new Promise(resolve => {
    engaging = true;
    signal.addEventListener("abort", () => resolve({ ...died(targetId), kind: "cancelled" }), { once: true });
  }), undefined, { entities: { 7: hostile("magma_cube", 3) } });
  fixture.combat.hurtBot(1, 7);
  fixture.tick();
  assert.ok(await until(() => engaging));
  const creeper = fixture.entities.spawn({ id: 8, ...hostile("creeper", 2) });
  const swell = fixture.bot.registry.entitiesByName.creeper!.metadataKeys!.indexOf("swell_dir");
  Reflect.set(creeper.metadata, swell, 1);
  fixture.perception.creeperClearance.require(fixture.perception.creeperClearance.observe(fixture.perception.tick, new Set()));
  fixture.bot.entities[7]!.position.y = 58;
  // The grace has run out while the fuse holds the owner: the contact ends the tick the clearance is discharged.
  for (let tick = 0; tick < CONTACT_GRACE_TICKS; tick += 1) fixture.tick();
  assert.equal(await until(() => !fixture.runner.status().busy, 5), false);
  fixture.entities.remove(8);
  fixture.tick();
  assert.equal(await until(() => !fixture.runner.status().busy, 5), false, "missing is not discharged");
  fixture.perception.creeperClearance.resolve(8);
  fixture.tick();
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["fight -> contact_ended"]);
  await fixture.observer.close();
  fixture.data.close();
});

/**
 * A bounded walk request: its result is what the route answered. With `startReflex` its first run starts the reflex's
 * fight and ends `cancelled` once the reflex has taken its body; a resumed run (or a run with none) navigates once.
 */
function walkRequest(navigation: NavigationRuntime, navigations: { count: number }, name: string, startReflex?: () => void) {
  const input = z.object({});
  let attempts = 0;
  return defineAction({
    name,
    description: "walk to a block",
    inputSchema: input,
    resultSchema: actionResultSchema({}),
    formatResult: (result) => result.status,
    parse: (value: unknown) => input.parse(value),
    execution: { kind: "resumable_task" },
    begin: () => async (context) => {
      if (++attempts === 1 && startReflex) {
        const preempted = new Promise<void>((resolve) => context.signal!.addEventListener("abort", () => resolve(), { once: true }));
        startReflex();
        await preempted;
        return { status: "cancelled" as const, error: "interrupted" };
      }
      const route = await navigation.navigate({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 60, y: 64, z: 0 }) });
      navigations.count += 1;
      return route.status === "completed" ? { status: "succeeded" as const } : { status: "failed" as const, error: `route ${route.status}` };
    },
  });
}

interface ContactSceneOptions {
  /**
   * A bow skeleton under defend-only instead of the zombie, the fight a walk meets on a bridge (P4-29 a5 C2): `retreat` says
   * whether withdrawal is open. Open, the decision admits the fight only because the skeleton is in reach and marks it
   * `endsOnContactLoss`; prohibited, it is plain shield-and-sword defence.
   */
  readonly shooter?: { readonly retreat: boolean };
  /** The fight suspends a resumable walk (the request a reflex interrupts) instead of an idle body. */
  readonly walk?: boolean;
  readonly server?: FakeBotOptions["server"];
}

/**
 * A mob in reach, a fight claimed that waits for its abort: `ticksOut` puts it out of reach for that many physics ticks,
 * `ticksIn` in reach (a knockback flight and its landing). The fight settles as `abortAs` and its abort reason is read
 * from `abortedBy()`. With `walk` the fight meets a walk that navigates once more when it resumes.
 */
async function contactScene(options: ContactSceneOptions = {}) {
  let engaged = false;
  let aborted = false;
  let abortedBy: unknown;
  let abortAs: "cancelled" | "bot_died" = "cancelled";
  const fixture = reflexFixture(
    (targetId, signal) =>
      new Promise((resolve) => {
        engaged = true;
        signal.addEventListener("abort", () => { aborted = true; abortedBy = signal.reason; resolve({ ...died(targetId), kind: abortAs }); }, { once: true });
      }), undefined, { entities: { 7: hostile(options.shooter ? "skeleton" : "zombie", 2) }, server: options.server },
  );
  const mob = fixture.bot.entities[7]!;
  if (options.shooter) {
    mob.equipment[0] = itemOf(fixture.bot.registry, "bow");
    await fixture.controller.policy.edit({
      operation: "set",
      expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { combat: { engagement: "defend_only", retreat: options.shooter.retreat } },
      lifetime: { kind: "session" },
      reason: "test",
    });
  }
  const added = listenersAddedSince(fixture.bot);
  const navigations = { count: 0 };
  const navigateAction = (name: string, startReflex?: () => void) => walkRequest(fixture.navigation, navigations, name, startReflex);
  let walking: Promise<Awaited<ReturnType<typeof fixture.runner.run>>> | undefined;
  if (options.walk) {
    walking = fixture.runner.run(navigateAction("walk_test", () => fixture.tick()), {});
  } else fixture.tick();
  assert.ok(await until(() => engaged), "the fight is claimed");
  const ticksOut = (count: number) => {
    mob.position.x = 12;
    for (let tick = 0; tick < count; tick += 1) fixture.tick();
  };
  const ticksIn = (count: number) => {
    mob.position.x = 2;
    for (let tick = 0; tick < count; tick += 1) fixture.tick();
  };
  const close = async () => {
    fixture.runner.cancelActive("Test completed");
    await fixture.observer.close();
    fixture.data.close();
  };
  /** The encounters recorded once the fight settled (or after the turns given: a fight that goes on records none). */
  const settled = async () => {
    await until(() => fixture.recorded().length > 0, 30);
    return fixture.recorded();
  };
  /** After the fight: the watcher left none of its listeners, and a later bounded navigation runs and answers. */
  const assertNothingLeftAndNextActionRuns = async () => {
    for (const event of ["physicsTick", "entityGone", "time"]) assert.equal(added(event), 0, `${event} listeners the fight added`);
    const before = navigations.count;
    const next = await fixture.runner.run(navigateAction("next_action_test"), {});
    assert.equal(next.result.status, "succeeded");
    assert.equal(navigations.count, before + 1, "the next request navigated once");
  };
  return {
    ...fixture, ticksOut, ticksIn, settled, close, assertNothingLeftAndNextActionRuns, navigations,
    fighting: () => !aborted && fixture.runner.status().busy,
    walking: () => walking!,
    abortedBy: () => abortedBy,
    abortAs: (kind: typeof abortAs) => { abortAs = kind; },
    age: () => fixture.bot.time.age,
  };
}

const MOBS = [
  { mob: "zombie (melee)", options: {} },
  { mob: "bow skeleton (withdrawal open, marked)", options: { shooter: { retreat: true } } },
] as const satisfies readonly { mob: string; options: ContactSceneOptions }[];

// The 20th tick ending a melee contact (`contact_ended`) is held by "melee contact ending after 20 ticks out of reach".
for (const { mob, options } of MOBS) {
  test(`${mob}: 12 or 19 ticks out of reach then back keeps fighting, and 19 + 1 in + 19 out is not 20 in a row, the next tick out ends it`, async () => {
    for (const ticks of [12, 19]) {
      const scene = await contactScene(options);
      try {
        scene.ticksOut(ticks);
        scene.ticksIn(1);
        assert.deepEqual(await scene.settled(), [], `${ticks} ticks out of reach does not end the fight`);
        assert.equal(scene.fighting(), true);
      } finally {
        await scene.close();
      }
    }
    const scene = await contactScene(options);
    try {
      scene.ticksOut(CONTACT_GRACE_TICKS - 1);
      scene.ticksIn(1);
      scene.ticksOut(CONTACT_GRACE_TICKS - 1);
      assert.deepEqual(await scene.settled(), [], "the count restarted at the tick in reach");
      assert.equal(scene.fighting(), true);
      scene.ticksOut(1);
      assert.deepEqual(await scene.settled(), ["fight -> contact_ended"], "the 20th read in a row ends it");
    } finally {
      await scene.close();
    }
  });
}

test("a defend-only fight on a shooter that steps out of reach ends contact_ended after 20 ticks and the reflex is free", async () => {
  const scene = await contactScene({ shooter: { retreat: true } });
  try {
    scene.ticksOut(CONTACT_GRACE_TICKS);
    assert.ok(await until(() => !scene.runner.status().busy));
    assert.deepEqual(scene.recorded(), ["fight -> contact_ended"]);
    assert.equal(scene.driver.answered.snapshot().some((entry) => entry.response === "fight"), false, "a lost contact is not an answered fight");
    await scene.assertNothingLeftAndNextActionRuns();
  } finally {
    await scene.close();
  }
});

test("without withdrawal open the same shooter keeps the shield fight past 30 ticks out of reach", async () => {
  const scene = await contactScene({ shooter: { retreat: false } });
  try {
    scene.ticksOut(CONTACT_GRACE_TICKS + 10);
    assert.deepEqual(await scene.settled(), [], "no end after 30 ticks out of reach");
    assert.equal(scene.fighting(), true);
  } finally {
    await scene.close();
  }
});

/** A walk the fight suspends, then one of three exits during the out-of-reach count: each settles the fight once with its own outcome. */
for (const exit of ["cancel", "death", "preemption"] as const) {
  test(`a ${exit} during the shooter fight's out-of-reach count settles it once, never resumes a cancelled walk, and leaves the body free`, async () => {
    const scene = await contactScene({ shooter: { retreat: true }, walk: true });
    try {
      scene.ticksOut(CONTACT_GRACE_TICKS - 8);
      if (exit === "cancel") {
        scene.runner.cancelActive("Caller cancelled the walk");
        const walked = (await scene.walking()).result;
        assert.equal(walked.status, "cancelled", JSON.stringify(walked));
      } else if (exit === "death") {
        scene.abortAs("bot_died");
        const cancelOnDeath = () => { scene.runner.cancelActive("bot died"); };
        scene.bot.on("death", cancelOnDeath);
        try {
          scene.combat.setHealth(0);
          await scene.clock.advance(150);
        } finally {
          scene.bot.off("death", cancelOnDeath);
        }
        assert.equal((await scene.walking()).result.status, "cancelled");
      } else {
        let release: () => void = () => assert.fail("the claim has not started");
        const held = new Promise<void>((resolve) => { release = resolve; });
        let successor: AbortSignal | undefined;
        const claim = scene.runner.claim("fire_reflex", "burning", async (signal) => {
          successor = signal;
          await held;
          return { value: "out", continuation: { kind: "resume" as const } };
        });
        assert.equal(claim.kind, "claimed");
        assert.ok(await until(() => successor !== undefined));
        const reason = scene.abortedBy();
        assert.ok(reason instanceof BodyAbort, "the fight was aborted with a body abort");
        assert.deepEqual(reason.detail, { kind: "preempted", by: "fire_reflex" });
        // The higher reflex keeps the body past the contact grace and the 600-tick limit: nothing of the old fight touches it.
        scene.ticksOut(CONTACT_GRACE_TICKS);
        await scene.clock.advance(35_000);
        assert.equal(successor!.aborted, false, "the higher reflex is untouched by the old fight's cleanup");
        release();
        if (claim.kind === "claimed") await claim.outcome;
        assert.equal((await scene.walking()).result.status, "succeeded", "the held reflex resumed the suspended walk");
        assert.equal(scene.navigations.count, 1, "the resumed walk navigated once");
      }
      assert.ok(await until(() => scene.recorded().length > 0));
      assert.deepEqual(scene.recorded(), [`fight -> ${exit === "death" ? "bot_died" : "cancelled"}`]);
      scene.ticksOut(CONTACT_GRACE_TICKS);
      await scene.clock.advance(35_000);
      assert.equal(scene.recorded().length, 1, "the old fight settled once");
      if (exit !== "preemption") assert.equal(scene.navigations.count, 0, "a cancelled walk is not resumed");
      await scene.assertNothingLeftAndNextActionRuns();
    } finally {
      await scene.close();
    }
  });
}

/** With the client's physics stopped the contact count never runs: the 600-tick no-progress limit ends the fight in world ticks, at any rate. */
for (const { mob, options } of MOBS) {
  for (const ticksPerSecond of [20, 10]) {
    test(`${mob}: with physics stopped the grace does not count and the 600-tick no-progress limit ends the fight (${ticksPerSecond} tps)`, async () => {
      const scene = await contactScene({ ...options, server: { ticksPerSecond } });
      const msPerTick = 1000 / ticksPerSecond;
      try {
        const start = scene.age();
        scene.bot.physicsEnabled = false; // a chunk unloaded under the bot: the client runs no tick
        scene.bot.entities[7]!.position.x = 12;
        await scene.clock.advance(500 * msPerTick);
        assert.ok(scene.age() - start >= 480 && scene.age() - start < 600, `${scene.age() - start} world ticks in`);
        assert.equal(scene.fighting(), true, "no tick, no grace: 500 world ticks later the fight is still held");
        await scene.clock.advance(140 * msPerTick); // the window is 600 world ticks and one packet: it ends at the packet of age A + 620
        await until(() => !scene.fighting());
        assert.ok(scene.age() - start >= 600, `${scene.age() - start} world ticks in`);
        assert.equal(scene.fighting(), false, "the 600-tick no-progress limit ended it");
        assert.equal(scene.driver.answered.snapshot()[0]?.failure.kind, "reflex_limit", "a limit, not contact_ended");
      } finally {
        await scene.close();
      }
    });
  }
}

test("a stopped server ends the shooter fight on the 20 s wall of its 600-tick no-progress window, the world age unmoved", async () => {
  const scene = await contactScene({ shooter: { retreat: true } });
  try {
    const start = scene.age();
    scene.server.stop();
    await scene.clock.advance(19_000);
    assert.equal(scene.fighting(), true, "19 s on a still clock: still held");
    await scene.clock.advance(2_000);
    await until(() => !scene.fighting());
    assert.equal(scene.fighting(), false, "20 s on a still clock ended it");
    assert.equal(scene.age(), start, "the age never moved");
    assert.equal(scene.driver.answered.snapshot()[0]?.failure.kind, "reflex_limit");
  } finally {
    await scene.close();
  }
});

test("damage below the hide threshold does not stop an already admitted escape", async () => {
  let escaping = false;
  let finish: () => void = () => assert.fail("escape has not started");
  const navigate: NavigationRuntime["navigate"] = async ({ signal, stopSignal, timeoutMs }) => {
    assert.equal(stopSignal?.aborted, false, "only an incoming projectile can pause this route");
    assert.ok(
      typeof timeoutMs === "number" && timeoutMs > 0 && timeoutMs <= 45_000,
      "the route shares the evade clock's wall (3x the 15 s of game time) with guards",
    );
    escaping = true;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    assert.equal(signal?.aborted, false);
    assert.equal(stopSignal?.aborted, false, "health loss must not interrupt the admitted route");
    return { status: "completed", elapsedMs: 1000 };
  };
  const fixture = reflexFixture(async (targetId) => died(targetId), navigate, { entities: { 7: hostile("zombie", 3) } });
  fixture.bot.health = 9;
  fixture.tick();
  assert.ok(await until(() => escaping));
  fixture.combat.setHealth(7);
  fixture.tick();
  assert.equal(fixture.runner.status().busy, true);
  assert.deepEqual(fixture.recorded(), []);
  fixture.bot.entity.position.x = -40;
  finish();
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["evade -> safe_separation"]);
  assert.equal(fixture.bot.listenerCount("health"), 0);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});
test("one evade retains its first threat and records a new contact encountered along its route", async () => {
  let attempts = 0;
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async ({ goal }) => {
      // The cover goal needs the body's actual position as well as the contacts (P4-29 a3 T1c, 2026-11-16).
      const snapshot = () => ({
        ...observation(),
        position: fixture.bot.entity.position,
        stance: fixture.bot.entity.onGround ? "supported" as const : "airborne" as const,
        entities: new Map(Object.values(fixture.bot.entities).map((entity) => [entity.id, entity])),
      });
      const initial = goal.resolve(snapshot());
      assert.equal(initial.kind, "active");
      if (initial.kind === "active" && attempts++ === 0) assert.doesNotMatch(initial.revision, /8@/);
      fixture.bot.entity.position = new Vec3(-12, 64, 0);
      fixture.tick();
      const revised = goal.resolve(snapshot());
      assert.equal(revised.kind, "active");
      if (revised.kind === "active") {
        assert.match(revised.revision, /7@/);
        assert.match(revised.revision, /8@/);
      }
      // With no standing cover, 14 blocks from threat 8 still owes separation: capability_limit, not safe_separation.
      fixture.bot.entity.position = new Vec3(-40, 64, 0);
      return { status: "completed", elapsedMs: 0 };
    },
    // A shield in the off hand admits guarded retreat; these assertions concern its contact bookkeeping.
    { entities: { 7: hostile("blaze", 4), 8: hostile("blaze", -26) }, slots: { 45: { name: "shield" } } },
  );
  fixture.bot.health = 11;
  const listeners = fixture.bot.listenerCount("physicsTick");
  fixture.tick();
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["evade -> capability_limit"]);
  const payload = JSON.parse(
    String(
      fixture.data.read(
        "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id",
      )[0]?.payload_json,
    ),
  );
  assert.deepEqual(
    payload.finalDistances.map((entry: { id: number }) => entry.id),
    [7, 8],
  );
  assert.equal(fixture.bot.listenerCount("physicsTick"), listeners);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("a hostile that has hurt the bot is in contact from beyond the contact range", async () => {
  const fixture = reflexFixture(async (targetId) => died(targetId), undefined, { entities: { 7: hostile("skeleton", 12) } });

  fixture.tick();
  assert.equal(fixture.runner.status().busy, false);
  fixture.combat.shootBot("arrow", 7, ARROW_DAMAGE);
  // The clock's slice that lands the arrow also runs the reflex's tick and the fight the stub ends at once: the body is idle again when the slice returns, so the takeover shows only in the record.
  await landed(fixture, ARROW_FLIGHT_MS);

  assert.ok(await until(() => fixture.recorded().length === 1));
  assert.deepEqual(fixture.recorded(), ["fight -> target_died"]);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

/**
 * The livelock of 2026-09-04, at the observer: a hide that could do nothing was
 * chosen again every second, and each choice claimed the body and cancelled
 * whatever the model had started. Eighty-four notifications in half a minute,
 * and a bot that did not move a block in a hundred and sixty ticks.
 */
test("a hide that could not be built is recorded once and then the reflex stands down", async () => {
  const fixture = reflexFixture(async (targetId) => died(targetId), undefined, { entities: { 7: hostile("zombie", 3) } });
  await fixture.controller.policy.edit({
    operation: "set",
    expected_revision: fixture.controller.policy.snapshot().revision,
    changes: { combat: { retreat: false, melee: false, shield: false } },
    lifetime: { kind: "session" },
    reason: "test",
  });
  fixture.bot.health = 7;

  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 1));

  assert.deepEqual(fixture.recorded(), ["hide -> capability_limit"]);
  // The memory is what stops the next decision, and it is keyed on the state
  // the hide failed in rather than on a cooldown that expires.
  fixture.tick();
  assert.equal(fixture.runner.status().busy, false, "the body stays with the model");
  assert.ok(fixture.observer.threats.blockedResponses?.has("hide"));
  assert.equal(await until(() => fixture.recorded().length > 1, 5), false);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("a changed shelter permission retries a failed hide while an unrelated bow edit does not", async () => {
  const fixture = reflexFixture(async (targetId) => died(targetId), undefined, { entities: { 7: hostile("zombie", 3) } });
  const edit = (bow: boolean, place: boolean) =>
    fixture.controller.policy.edit({
      operation: "set",
      expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { combat: { retreat: false, melee: false, shield: false, bow, terrain: { dig: false, place } } },
      lifetime: { kind: "session" },
      reason: "test",
    });
  try {
    await edit(false, false);
    fixture.bot.health = 7;
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 1 && !fixture.runner.status().busy));

    await edit(true, false);
    fixture.tick();
    assert.equal(await until(() => fixture.recorded().length > 1, 5), false);

    await edit(true, true);
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 2));
    assert.deepEqual(fixture.recorded(), ["hide -> capability_limit", "hide -> capability_limit"]);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("records a session teardown during a response as cancelled, not failed", async () => {
  const fixture = reflexFixture(
    (_targetId, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }), undefined, { entities: { 7: hostile("zombie", 3) } },
  );
  fixture.tick();
  fixture.runner.cancelActive("Minecraft runtime closed");

  assert.ok(await until(() => fixture.recorded().length === 1));
  assert.deepEqual(fixture.recorded(), ["fight -> cancelled"]);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("an admitted low-health escape still yields to session cancellation", async () => {
  let escaping = false;
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async ({ signal }) =>
      new Promise((resolve) => {
        escaping = true;
        signal!.addEventListener(
          "abort",
          () => resolve({ status: "stopped", reason: "session cancelled", elapsedMs: 0 }),
          { once: true },
        );
      }), { entities: { 7: hostile("zombie", 3) } },
  );
  fixture.bot.health = 9;
  fixture.tick();
  assert.ok(await until(() => escaping));
  fixture.combat.setHealth(7);
  fixture.runner.cancelActive("Minecraft runtime closed");
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["evade -> cancelled"]);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("cancellation does not conceal a different failure while combat releases the body", async () => {
  let engaged = false;
  const fixture = reflexFixture(
    (_targetId, signal) =>
      new Promise((_resolve, reject) => {
        engaged = true;
        signal.addEventListener("abort", () => reject(new Error("shield release failed")), { once: true });
      }), undefined, { entities: { 7: hostile("zombie", 3) } },
  );
  try {
    fixture.tick();
    assert.ok(await until(() => engaged));
    fixture.runner.cancelActive("operator cancellation");
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.deepEqual(fixture.recorded(), ["fight -> failed"]);
    const row = fixture.data.read(
      "SELECT payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id DESC LIMIT 1",
    )[0]!;
    assert.match(String(row.payload_json), /shield release failed/);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("a cancelled escape preserves its attack and kill evidence when navigation throws", async () => {
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async () => {
      fixture.tick();
      fixture.combat.kill(7);
      fixture.runner.cancelActive("footing recovery");
      throw new Error("navigation released during cancellation");
    },
    { carried: {}, entities: { 7: hostile("zombie", 2) } },
  );
  fixture.bot.health = 11;
  try {
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.equal(attackedIds(fixture.server).length, 1);
    const row = fixture.data.read(
      "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id",
    )[0]!;
    const evidence = JSON.parse(String(row.payload_json));
    assert.equal(evidence.outcome, "cancelled");
    assert.equal(evidence.attacks, 1);
    assert.deepEqual(evidence.weaponsUsed, ["hand"]);
    assert.deepEqual(evidence.killedTargetIds, [7]);
    assert.match(evidence.error, /footing recovery/);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

for (const reset of ["death", "dimension"] as const) {
  test(reset === "death" ? "a death during a response records no chain into the next life"
    : "a dimension change during a response starts a new chain", async () => {
    let calls = 0;
    let finish: () => void = () => assert.fail("response not started");
    const fixture = reflexFixture((targetId): Promise<CombatOutcome> => {
      calls++;
      if (calls === 1) return new Promise((resolve) => {
        finish = () => resolve({ ...died(targetId), kind: "target_lost" });
      });
      return Promise.resolve(died(targetId));
    }, undefined, { clock: createFakeClock({ mode: "mocked" }), entities: { 7: hostile("zombie", 2) } });
    using _clock = fixture.clock.install();
    const outcomes = () => fixture.data.read(
      "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id",
    ).map((row) => JSON.parse(String(row.payload_json)));
    try {
      fixture.tick();
      await fixture.clock.advance(50);
      assert.equal(calls, 1);
      if (reset === "death") {
        fixture.combat.setHealth(0);
        await fixture.clock.advance(150);
        assert.equal(fixture.bot.health, 20, "the shared fake respawn must precede response cleanup");
      } else {
        fixture.bot.game.dimension = "the_nether";
        fixture.bot.emit("game");
      }
      finish();
      await fixture.clock.advance(50);
      assert.equal(outcomes()[0]?.chain, null, "the old in-flight generation must not be recorded");
      // Admit the next response independently of the driver's retained target-lost answer.
      fixture.driver.answered.clear();
      fixture.tick();
      await fixture.clock.advance(50);
      assert.equal(outcomes()[1]?.chain, null, "the next response is the first in the new life or dimension");
    } finally {
      finish();
      await fixture.clock.settle(fixture.observer.close(), 2_000);
      fixture.data.close();
    }
  });
}

for (const cleanup of ["returns", "throws"] as const) {
  test(`encounter death evidence survives respawn before cleanup ${cleanup}`, async () => {
    let started = false;
    let finish: () => void = () => assert.fail("combat has not started");
    const fixture = reflexFixture(
      (targetId, signal) =>
        new Promise((resolve, reject) => {
          started = true;
          finish = () =>
            cleanup === "throws"
              ? reject(signal.reason ?? new Error("cleanup failed after death"))
              : resolve({ ...died(targetId), kind: "bot_died", attacks: 3 });
        }), undefined, { entities: { 7: hostile("zombie", 15) } },
    );
    fixture.bot.entity.position = new Vec3(12, 70, 9);
    fixture.bot.entities[7]!.position = new Vec3(15, 70, 9);
    // Real player-events cancellation happens on death, before cleanup settles.
    const cancelOnDeath = () => {
      fixture.runner.cancelActive("bot died");
    };
    fixture.bot.on("death", cancelOnDeath);
    fixture.tick();
    assert.ok(await until(() => started));
    fixture.bot.health = 0;
    fixture.bot.emit("death");
    fixture.bot.health = 20;
    fixture.bot.entity.position = new Vec3(79.5, 66, 134.5);
    fixture.bot.entities[7]!.position = new Vec3(200, 70, 9);
    fixture.bot.emit("respawn");
    finish();
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.deepEqual(fixture.recorded(), ["fight -> bot_died"]);
    const payload = JSON.parse(
      String(
        fixture.data.read(
          "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex'",
        )[0]!.payload_json,
      ),
    );
    assert.equal(payload.healthBefore, 20);
    assert.equal(payload.healthAfter, 0);
    assert.deepEqual(payload.finalPosition, { x: 12, y: 70, z: 9 });
    assert.deepEqual(payload.finalDistances, [{ id: 7, distance: 3 }]);
    assert.equal(payload.attacks, cleanup === "returns" ? 3 : 0);
    fixture.bot.off("death", cancelOnDeath);
    assert.equal(fixture.bot.listenerCount("death"), fixture.deathListenersAtRest);
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  });
}

test("safe separation answers old distant attack contact, while later damage re-arms it", async () => {
  let routes = 0;
  const fixture = reflexFixture(
    async (id) => died(id),
    async () => {
      routes += 1;
      fixture.bot.entity.position.x = -20;
      return { status: "completed", elapsedMs: 0 };
    },
    // A shield in the off hand admits guarded retreat; these assertions concern its contact bookkeeping. A skeleton shoots arrows: a blaze's ball would set her on fire, and a burning bot under the engage bar hides instead of retreating.
    { entities: { 7: hostile("skeleton", 28) }, slots: { 45: { name: "shield" } }, health: HEALTH_BEFORE_ARROWS },
  );
  fixture.combat.shootBot("arrow", 7, ARROW_DAMAGE);
  await landed(fixture, ARROW_FLIGHT_MS);
  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 1));
  assert.deepEqual(fixture.recorded(), ["evade -> safe_separation"]);
  for (let tick = 0; tick < 5; tick++) {
    fixture.tick();
    await until(() => !fixture.runner.status().busy);
  }
  assert.equal(routes, 1, "already answered contact must not repeatedly claim the same satisfied escape");
  // The bot is 48 blocks from the skeleton now: the second arrow lands 30 ticks after it is shot, past the first one's hurt window (20 ticks).
  fixture.combat.shootBot("arrow", 7, ARROW_DAMAGE);
  await landed(fixture, ARROW_FLIGHT_MS);
  assert.ok(await until(() => fixture.recorded().length === 2));
  assert.equal(routes, 2);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("safe separation cannot erase a new attack observed during the response", async () => {
  let routes = 0;
  const fixture = reflexFixture(
    async (id) => died(id),
    async () => {
      fixture.bot.entity.position.x = -20;
      // The first route ends when a second arrow has landed: the new attack is seen during it. A later route (the second arrow's own contact) is not waited on.
      if (++routes === 1) {
        fixture.combat.shootBot("arrow", 7, ARROW_DAMAGE);
        await new Promise<void>((resolve) => fixture.bot.once("entityHurt", () => resolve()));
      }
      return { status: "completed", elapsedMs: 0 };
    },
    // A shield in the off hand admits guarded retreat; these assertions concern its contact bookkeeping.
    { entities: { 7: hostile("skeleton", 28) }, slots: { 45: { name: "shield" } }, health: HEALTH_BEFORE_ARROWS },
  );
  fixture.combat.shootBot("arrow", 7, ARROW_DAMAGE);
  await landed(fixture, ARROW_FLIGHT_MS);
  await fixture.clock.advance(ARROW_FLIGHT_MS);
  // Before: one response recorded and the attacker still filed. With time passing the clock goes on into the answer to the new attack: a second response is recorded (the erased attack would leave one), and it ends the contact.
  assert.ok(await until(() => fixture.recorded().length === 2));
  assert.deepEqual(fixture.recorded(), ["evade -> safe_separation", "evade -> safe_separation"]);
  assert.equal(routes, 2);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("failed evade immediately yields to the newly chosen hide response", async () => {
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async () => ({ status: "stopped", reason: "timeout", elapsedMs: 15_000 }), { entities: { 7: hostile("zombie", 3) } },
  );
  fixture.bot.health = 9;
  fixture.tick();
  assert.ok(await until(() => !fixture.runner.status().busy && fixture.recorded().length === 1));
  assert.deepEqual(fixture.recorded(), ["evade -> capability_limit"]);
  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 2));
  assert.deepEqual(fixture.recorded(), ["evade -> capability_limit", "hide -> capability_limit"]);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("evade refreshes a completed route when a newly observed cube is still in contact", async () => {
  let routes = 0;
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async () => {
      routes++;
      if (routes === 1) {
        fixture.bot.entity.position.x = 40;
        fixture.entities.spawn({ id: 8, ...hostile("magma_cube", 35) });
      } else fixture.bot.entity.position.x = 80;
      return { status: "completed", elapsedMs: 1 };
    }, { entities: { 7: hostile("magma_cube", 3) } },
  );
  fixture.bot.health = 11;
  const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
  assert.equal(directive.kind, "evade");
  try {
    const result = await evadeReceipt(fixture, directive);
    assert.equal(routes, 2);
    assert.equal(result.outcome, "safe_separation");
    assert.ok(result.finalDistances.every((entry) => entry.distance >= 36));
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("a cube killed during retreat does not fail separation against its last position", async () => {
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async () => {
      fixture.combat.kill(7);
      fixture.entities.remove(7);
      return { status: "completed", elapsedMs: 1 };
    }, { entities: { 7: hostile("magma_cube", 3) } },
  );
  fixture.bot.health = 11;
  const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
  assert.equal(directive.kind, "evade");
  try {
    const result = await evadeReceipt(fixture, directive);
    assert.equal(result.outcome, "safe_separation");
    assert.deepEqual(result.finalDistances, []);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

/**
 * The 2026-09-09 livelock, at the observer: a withdrawal interrupted by a hide
 * that left the bot under the hide bar was resumed, dug out of its own box into
 * the same sight line, and was hidden again - seven times, with the model
 * never told. The hide must hand the body back to the model instead.
 */
test("a hide that leaves the bot under the hide bar does not resume a withdrawal", async () => {
  const fixture = reflexFixture(async () => {
    throw new Error("A hide must not engage");
  }, undefined, { cells: sealedCells(), entities: { 7: hostile("zombie", 12) } });
  // Already sealed in (the cells around the bot), so the hide goes straight to the hold; two health with
  // hunger below the regeneration bar and nothing to eat, so the hold has
  // nothing to wait for and ends at once.
  fixture.bot.health = 2;
  fixture.bot.food = 10;
  seeThroughShelter(fixture.bot);
  // In sight and inside observation range, outside the contact range: under the
  // hide bar that is contact, and the answer is a hide.
  let attempts = 0;
  const input = z.object({});
  const action = defineAction({
    name: "withdraw_test",
    description: "withdraw",
    inputSchema: input,
    resultSchema: actionResultSchema({}),
    formatResult: (result) => result.status,
    parse: (value: unknown) => input.parse(value),
    execution: { kind: "resumable_task" },
    begin: () => async (context) => {
      attempts++;
      const stopped = new Promise<void>((resolve) =>
        context.signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      fixture.tick();
      await stopped;
      return { status: "failed", error: "interrupted" };
    },
  });
  try {
    await fixture.controller.policy.edit({
      operation: "set",
      expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { combat: { engagement: "defend_only", hide: "when_exposed" } },
      lifetime: { kind: "session" },
      reason: "test",
    });
    const output = await fixture.runner.run(action, {});
    assert.equal(output.result.status, "failed");
    assert.equal(attempts, 1);
    assert.ok(await until(() => fixture.recorded().length > 0));
    assert.deepEqual(fixture.recorded(), ["hide -> hidden"]);
    assert.equal(fixture.runner.status().busy, false);
    const [payload] = fixture.data
      .read(
        "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id",
      )
      .map((row) => JSON.parse(String(row.payload_json)) as { error: string; hide: { enclosed: boolean } });
    assert.equal(payload?.hide.enclosed, true);
    assert.match(payload?.error ?? "", /health is still 2: nothing carried can restore it/);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("a recovered hide resumes the same admitted request", async () => {
  const fixture = reflexFixture(async () => {
    throw new Error("A hide must not engage");
  }, undefined, { cells: sealedCells(), entities: { 7: hostile("zombie", 12) } });
  fixture.bot.health = 2;
  seeThroughShelter(fixture.bot);
  let attempts = 0;
  const input = z.object({ count: z.number() });
  const action = defineAction({
    name: "recover_request_test",
    description: "Resume a request after native health recovery",
    inputSchema: input,
    resultSchema: actionResultSchema({}),
    formatResult: (result) => result.status,
    parse: (value: unknown) => input.parse(value),
    execution: { kind: "resumable_task" },
    begin: (request) => async (context) => {
      assert.equal(request.count, 12);
      if (++attempts === 2) return { status: "succeeded" };
      const stopped = new Promise<void>((resolve) =>
        context.signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      fixture.tick();
      await stopped;
      return { status: "failed", error: "interrupted" };
    },
  });
  try {
    await fixture.controller.policy.edit({
      operation: "set",
      expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { combat: { engagement: "defend_only", hide: "when_exposed" } },
      lifetime: { kind: "session" },
      reason: "test",
    });
    const pending = fixture.runner.run(action, { count: 12 });
    assert.ok(await until(() => fixture.observer.activeResponse() === "hide"));
    fixture.bot.health = 18;
    fixture.tick();
    assert.equal((await pending).result.status, "succeeded");
    assert.equal(attempts, 2);
    assert.deepEqual(fixture.recorded(), ["hide -> hidden"]);
    assert.equal(fixture.runner.status().busy, false);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

for (const inUse of [false, true]) {
  test(`nearby hostile shield preparation respects active item use (${inUse})`, async () => {
    const fixture = reflexFixture(async () => assert.fail("Preparation must not engage"), undefined, {
      entities: { 7: hostile("zombie", 12) },
      slots: { 10: { name: "shield" } },
    });
    fixture.bot.usingHeldItem = inUse;
    let equips = 0;
    // A spy on the fake's own `equip`, which moves the shield to the off hand.
    const equip = fixture.bot.equip;
    fixture.bot.equip = async (item, destination) => {
      assert.equal(destination, "off-hand");
      equips++;
      await equip(item, destination);
    };
    try {
      fixture.tick();
      if (!inUse) assert.ok(await until(() => equips === 1));
      else await fixture.clock.advance(50);
      fixture.tick();
      assert.equal(equips, inUse ? 0 : 1);
      assert.equal(fixture.bot.usingHeldItem, inUse);
    } finally {
      await fixture.observer.close();
      fixture.data.close();
    }
  });
}

/** A fight neither side can win: the engage waits for its abort, then reports itself cancelled. Time is the fake bot's clock. */
function standoffScene(...zombies: number[]) {
  return standoffSceneOn(undefined, ...zombies);
}

/** The same standoff on a server at `server.ticksPerSecond` (20 by default). */
function standoffSceneOn(server: FakeBotOptions["server"], ...zombies: number[]) {
  const clock = createFakeClock({ mode: "mocked" });
  const installed = clock.install();
  const engaged: number[] = [];
  const fixture = reflexFixture(
    async (targetId, signal) => {
      engaged.push(targetId);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { ...died(targetId), kind: "cancelled", attacks: 0 };
    },
    undefined,
    {
      runner: { cancelGraceMs: 500 },
      clock,
      server,
      entities: Object.fromEntries(zombies.map((id, index) => [id, hostile("zombie", 3 + index)])),
    },
  );
  /** Time passes in 50 ms slices of the fake clock, with a physics tick at each. */
  const pass = (ms: number) => fixture.clock.advance(ms);
  const decision = () => JSON.stringify(fixture.driver.snapshot()[0]?.decision ?? null);
  const active = () => fixture.runner.status().activeAction?.action === "hostile_reflex";
  const close = async () => {
    try { await fixture.observer[Symbol.asyncDispose](); }
    finally { fixture.data.close(); installed[Symbol.dispose](); }
  };
  return { ...fixture, engaged, pass, active, decision, close };
}

for (const rate of [20, 10]) test(`an active quarry budget owns fight progress while a guard pauses it (${rate} tps)`, async () => {
  const scene = standoffSceneOn({ ticksPerSecond: rate }, 7);
  try {
    await scene.pass(50);
    const budget = scene.driver.budgets.progress({ name: "quarry_progress", scope: "target:7", unit: "ticks",
      measure: () => 0, startedAt: 0, limit: 600, progress: "confirmed_target_damage", exhaustion: "fight owns its no-hit bound" });
    await scene.pass(700 * 1000 / rate);
    assert.equal(scene.active(), true, `guard at wall ${scene.clock.now()}, age ${scene.bot.time.age}`);
    budget[Symbol.dispose]();
    await scene.pass(640 * 1000 / rate);
    assert.equal(scene.active(), false, "a fight without a live quarry budget still has the watchdog backstop");
  } finally { await scene.close(); }
});

test("a wounded defender after its fight's limit picks evade, and target A is not fought again during stand-down", async () => {
  const scene = standoffScene(7);
  try {
    await scene.pass(32_000); // the 30 s window is 600 world ticks and one packet: 31 s in at 20 tps
    assert.equal(scene.active(), false);
    scene.combat.setHealth(11);
    await scene.pass(500);
    assert.ok(scene.recorded().some((outcome) => outcome.startsWith("evade ->")), `an evade ran: ${scene.recorded().join(", ")}`);
    assert.deepEqual(scene.engaged, [7], "the standoff is not fought again while it stands down");
    assert.match(scene.decision(), /"answered"/, "the fight stays excluded as answered");
  } finally {
    await scene.close();
  }
});

/** Runs a standoff for 100 s, giving `mark` at second 20, 40, 60, 80; true when the fight is never released. */
async function keptAlive(mark: (scene: ReturnType<typeof standoffScene>) => void, ...zombies: number[]) {
  const scene = standoffScene(...(zombies.length === 0 ? [7] : zombies));
  try {
    for (let second = 1; second <= 100; second++) {
      if (second % 20 === 0) mark(scene);
      await scene.pass(1_000);
      if (!scene.active()) return false;
    }
    return true;
  } finally {
    await scene.close();
  }
}

test("fight liveness credits hurt and threat deaths, but not blocked hits, pacing, shuttling or shelter holds", async () => {
  type Scene = ReturnType<typeof standoffScene>;
  const rows: { name: string; mark(scene: Scene): void; alive: boolean; targets?: number[] }[] = [
    { name: "shield_block", mark: scene => scene.bot._client.emit("entity_status", { entityId: 1, entityStatus: 29 }), alive: false },
    { name: "hurt", mark: scene => scene.combat.hurt(7, null, 1), alive: true },
    { name: "pacing", mark: scene => { const target = scene.bot.entities[7]!; target.position.x = target.position.x === 3 ? 1.5 : 3; }, alive: false },
    { name: "shuttling", mark: scene => {
      const x = scene.bot.entity.position.x === 0 ? 1 : 0;
      scene.bot.entity.position.x = x;
      scene.bot.entities[7]!.position.x = x + 3;
    }, alive: false },
    { name: "threat_dead", mark: scene => {
      const id = [11, 10, 9, 8].find(id => scene.bot.entities[id]?.isValid);
      if (id !== undefined) scene.combat.kill(id);
    }, alive: true, targets: [7, 8, 9, 10, 11] },
    { name: "enclosed", mark: scene => {
      for (const [key, block] of Object.entries(sealedCells())) scene.world.setCell(new Vec3(...(key.split(",").map(Number) as [number, number, number])), block);
    }, alive: false },
  ];
  for (const row of rows) assert.equal(await keptAlive(row.mark, ...(row.targets ?? [7])), row.alive, row.name);
});

test("the probes of a limited fight are off after it: no listener is left on the bot or its connection", async () => {
  const scene = standoffScene(7);
  try {
    const before = [scene.bot._client.listenerCount("entity_status"), scene.bot.listenerCount("entityDead"), scene.bot.listenerCount("entityHurt")];
    await scene.pass(32_000);
    assert.equal(scene.active(), false);
    assert.deepEqual([scene.bot._client.listenerCount("entity_status"), scene.bot.listenerCount("entityDead"), scene.bot.listenerCount("entityHurt")], before);
  } finally {
    await scene.close();
  }
});

// The stand-down counts world ticks (plan 2026-11-16-reflex-limits-ticks T3): 200 ticks, doubled by each further limit against the
// target, capped at 6 000 (the sixth would be 6 400); each ends at the packet of age R + ticks + 20, R the age read at its limit.
for (const { ticksPerSecond, msPerTick } of [{ ticksPerSecond: 20, msPerTick: 50 }, { ticksPerSecond: 10, msPerTick: 100 }])
test(`a second no_progress limit against the same target stands down 400 ticks, a third 800, capped at 6 000 (${ticksPerSecond} tps)`, async () => {
  const scene = standoffSceneOn({ ticksPerSecond }, 7);
  /** The clock moves in whole seconds (a packet every 1 or 2 s) with the body's physics off, to age `age`. */
  const waitUntilAge = async (age: number) => {
    scene.bot.physicsEnabled = false;
    while (scene.bot.time.age < age) await scene.clock.advance(1_000, 1_000);
    scene.bot.physicsEnabled = true;
  };
  try {
    await scene.pass(50);
    await scene.pass(600 * msPerTick - 1_050);
    assert.ok(scene.active(), "the 600-tick window is open a second short of it (old code: its 30 s wall ended it)");
    for (const ticks of [200, 400, 800, 1_600, 3_200, 6_000, 6_000]) {
      for (let ms = 0; scene.active() && ms <= 640 * msPerTick; ms += 50) await scene.pass(50); // 600 world ticks and one packet
      assert.equal(scene.active(), false);
      const claims = scene.engaged.length;
      const readAge = scene.bot.time.age;
      await waitUntilAge(readAge + ticks);
      await scene.pass(50);
      assert.equal(scene.engaged.length, claims, `no claim at age R + ${ticks}: one packet of margin`);
      await waitUntilAge(readAge + ticks + 20);
      await scene.pass(50);
      assert.equal(scene.engaged.length, claims + 1, `claims at the packet of age R + ${ticks + 20}`);
    }
  } finally { await scene.close(); }
});

test("another target is not stood down", async () => {
  const scene = standoffScene(7);
  try {
    await scene.pass(32_000);
    scene.entities.remove(7);
    scene.entities.spawn({ id: 8, ...hostile("zombie", 2) });
    await scene.pass(100);
    assert.deepEqual(scene.engaged, [7, 8]);
  } finally { await scene.close(); }
});

test("a creeper that exploded and is no longer observed ends the fight by the stand-down, not the reflex limit", async () => {
  for (const ending of ["normal", "stopped", "reappeared", "cancelled"] as const) {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const fixture = reflexFixture((id, signal) => new Promise(resolve => {
    signal.addEventListener("abort", () => resolve({ ...died(id), kind: "cancelled" }), { once: true });
  }), undefined, { clock, entities: { 7: hostile("creeper", 3) } });
  try {
    await fixture.clock.advance(100);
    assert.equal(fixture.runner.status().busy, true);
    fixture.combat.explode(fixture.bot.entities[7]!.position.clone());
    fixture.bot.physicsEnabled = ending === "normal";
    fixture.entities.remove(7);
    if (ending === "reappeared") fixture.entities.spawn({ id: 7, ...hostile("creeper", 3) });
    if (ending === "cancelled") await fixture.driver.cancel("hostile_reflex", new BodyAbort({ kind: "cancelled", by: "model" }, "Stop fighting."));
    // The wait is 200 world ticks and one packet (1 to 39 ticks late): at most 239 ticks = 11 950 ms at 20 tps, so 12 000 ms
    // of clock bound it (plan 2026-11-16-reflex-limits-ticks T5; its tick-exact cases: respond-missing-quarry.test.ts).
    if (ending === "reappeared") {
      await fixture.clock.advance(12_000); // past the wait with the quarry back: the verdict must not come
      assert.equal(fixture.runner.status().busy, true, "same-id reappearance cancels the missing-target verdict");
      fixture.entities.remove(7);
    }
    await advanceUntilIdle(fixture, 12_000);
    assert.equal(fixture.runner.status().busy, false);
    assert.deepEqual(fixture.recorded(), [ending === "cancelled" ? "fight -> cancelled" : "fight -> target_lost"]);
    assert.equal(fixture.driver.answered.snapshot().some(entry => entry.failure.kind === "reflex_limit"), false);
  } finally { await fixture.observer.close(); fixture.data.close(); }
  }
});
