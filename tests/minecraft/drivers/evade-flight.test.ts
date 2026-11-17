// Verify the flight verdict rejects missing survival and resumed-order evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { loadScenario, scenarioDefinitionSchema } from "mine-labs";
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import { MemoryWorld } from "../../../src/navigation/world/memory-world.ts";
import { DEFAULT_COMBAT_POLICY } from "../../../src/survival/policy/combat/contract.ts";
import { SurvivalPolicyState } from "../../../src/survival/state/survival-policy.ts";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { positionExposed } from "../../../src/survival/positioning/combat/exposure.ts";
import { positionWorld } from "../../../src/survival/positioning/combat/geometry.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { settingsOf } from "../arena/settings.ts";
import { withTickRate } from "../shared/tick-rate-variant.ts";
import type { ScenarioCall } from "../scenario.ts";
import { flightEvidence, flightVerdict, run } from "./evade-flight.ts";

// check-reads: tests/minecraft/scenarios/combat/evade-flat-skeleton-held-cover.yaml, tests/minecraft/scenarios/combat/evade-flat-skeleton-cover-slow-server.yaml, tests/minecraft/templates/**/*.yaml

const passing = { health: 7, outcome: "safe_separation", basis: "cover", distance: 12,
  healthAfter: 3, floor: { kind: "ok" }, receipts: [], skipped: [], status: "succeeded", interruptions: ["[HOSTILE_CONTACT] skeleton"] } as const;

test("judges first separation, floor, survival and resumed order independently", () => {
  const pursuit = { ...passing, basis: "range", distance: 38, status: "cancelled", health: 0 };
  const cases = [
    ["living resumed order", passing, ["cover"], 20, {}, true],
    ["below floor", { ...passing, floor: { kind: "below", index: 1, y: -62 } }, ["cover"], 20, {}, false],
    ["unknown floor", { ...passing, floor: { kind: "unknown", index: 0 } }, ["cover"], 20, {}, false],
    ["pursuit first evade", pursuit, ["range"], undefined, { judge: "evade" }, true],
    ["first evade fatal", { ...pursuit, healthAfter: 0 }, ["range"], undefined, { judge: "evade" }, false],
    ["held wrong basis", { ...pursuit, distance: 12 }, ["cover"], 36, { judge: "evade" }, false],
    ["missing basis", { ...passing, basis: undefined }, ["cover"], 20, {}, false],
    ["physical without basis", { ...passing, basis: undefined }, ["cover"], 20, { requireBasis: false }, true],
    ["physical too far", { ...passing, basis: undefined, distance: 44 }, ["cover"], 20, { requireBasis: false }, false],
    ...([
      ["dead actor", { health: 0 }], ["no separation", { outcome: "capability_limit" }],
      ["wrong basis", { basis: "range" }], ["cover too far", { distance: 20 }],
      ["order cancelled", { status: "cancelled" }], ["no hostile contact", { interruptions: [] }],
    ] as const).map(([name, changes]) => [name, { ...passing, ...changes }, ["cover"], 20, {}, false] as const),
  ] as const;
  for (const [name, evidence, bases, distance, options, expected] of cases)
    assert.equal(flightVerdict(evidence, bases, distance, options), expected, name);
});

// t00381 (a6 T9a): the first evade spent its 300 server ticks as capability_limit; the resumed order then succeeded.
// The evade budget is evadeBudgetTicks(DEFAULT_COMBAT_POLICY) = 300 server ticks (driver budgetTicks).
const budgetSpent = { ...passing, outcome: "capability_limit", basis: null, distance: 21.7, healthAfter: 7, elapsedTicks: 300 } as const;

test("chain judge proves survival, floor, interruption and resumed order, not first separation", () => {
  const chain = { judge: "chain", budgetTicks: 300 } as const;
  assert.equal(flightVerdict(budgetSpent, ["cover"], undefined, chain), true, "budget-spent chain");
  assert.equal(flightVerdict(budgetSpent, ["cover"], undefined, { judge: "evade" }), false, "evade keeps its separation check");
  assert.equal(flightVerdict(budgetSpent, ["cover"], undefined, { judge: "order" }), false, "order keeps its separation check");
  assert.equal(flightVerdict({ ...budgetSpent, outcome: "safe_separation", basis: "cover", distance: 12 }, ["cover"], undefined, chain),
    true, "a real separation also chains");
  const cases = [
    ["dead actor", { health: 0 }], ["fatal first evade", { healthAfter: 0 }], ["missing evade", { outcome: undefined }],
    ["failed evade", { outcome: "failed" }], ["cancelled evade", { outcome: "cancelled" }],
    ["budget one tick short", { elapsedTicks: 299 }], ["wall stop below the budget", { elapsedTicks: 225 }],
    ["budget not measured", { elapsedTicks: null }],
    ["below floor", { floor: { kind: "below", index: 1, y: -62 } }], ["unknown floor", { floor: { kind: "unknown", index: 0 } }],
    ["no hostile contact", { interruptions: [] }], ["order cancelled", { status: "cancelled" }], ["order failed", { status: "failed" }],
  ] as const;
  for (const [name, changes] of cases)
    assert.equal(flightVerdict({ ...budgetSpent, ...changes }, ["cover"], undefined, chain), false, name);
  // Boundary rows: one tick of life, one tick of budget, each stays true.
  assert.equal(flightVerdict({ ...budgetSpent, healthAfter: 1 }, ["cover"], undefined, chain), true, "healthAfter 1");
  assert.equal(flightVerdict({ ...budgetSpent, health: 1 }, ["cover"], undefined, chain), true, "health 1");
  assert.equal(flightVerdict({ ...budgetSpent, elapsedTicks: 301 }, ["cover"], undefined, chain), true, "budget plus one");
  assert.equal(flightVerdict(budgetSpent, ["cover"], undefined, { judge: "chain" }), false, "no budget given: capability_limit cannot chain");
  // The same receipt as flightEvidence reads it: a respawn at 20 health is a death, and the budget ticks are recorded.
  const evade = { type: "survival_outcome", payload: { source: "hostile_reflex", evidence: { outcome: {
    response: "evade", outcome: "capability_limit", healthAfter: 7, elapsedTicks: 300,
    finalPosition: { x: 0, y: -60, z: 0 }, ends: [{ id: 1, name: "skeleton", distance: 21.7, basis: null }] } } } };
  const alive = { startY: -60, deaths: 0, health: 7, status: "succeeded", interruptions: ["[HOSTILE_CONTACT] skeleton"] };
  assert.equal(flightVerdict(flightEvidence([evade], alive), ["cover"], undefined, chain), true);
  assert.equal(flightVerdict(flightEvidence([evade], { ...alive, deaths: 1, health: 20 }), ["cover"], undefined, chain), false,
    "a respawn at 20 health is a death");
  assert.equal(flightEvidence([evade], alive).elapsedTicks, 300);
});

test("the slow-server fixture judges the chain; its default rate is the run's, and a 10 tps variant applies after loading", async () => {
  const scenario = await loadScenario(new URL("../scenarios/combat/evade-flat-skeleton-cover-slow-server.yaml", import.meta.url).pathname);
  assert.equal((scenario.params as { judge?: string }).judge, "chain");
  assert.equal(settingsOf(scenario, {}).settings.tickRate, null, "no setup tick rate: the default 20 applies");
  const variant = withTickRate(scenario, 10);
  assert.equal(variant.changed, true);
  assert.deepEqual(variant.scenario.setup, ["difficulty normal", "fill 10 -60 3 10 -58 9 stone", "tick rate 10"]);
  assert.equal(settingsOf(variant.scenario, {}).settings.tickRate, 10);
  assert.equal(variant.scenario.tags.includes("exclusive"), false, "the fixture is not exclusive");
});

test("the held wall's lee is cover inside the disengage line", async () => {
  const scenario = await loadScenario(new URL("../scenarios/combat/evade-flat-skeleton-held-cover.yaml", import.meta.url).pathname);
  const params = scenario.params as { spawn: [number, number, number] };
  const [sx, sy, sz] = params.spawn;
  // Summon centres integer coordinates: trial t00001 measured 11.531 blocks (a4 T5, 2026-11-17).
  const spawn = new Vec3(sx + 0.5, sy, sz + 0.5);
  const actor = scenario.players[0]!.pos!;
  const fill = scenario.setup!.find((command) => /^fill .* stone$/u.test(command))!;
  const [, x1, y1, z1, x2, y2, z2] = fill.split(" ").map(Number);
  const world = new MemoryWorld();
  for (let x = -25; x <= 25; x++) for (let y = -61; y <= -57; y++) for (let z = -25; z <= 25; z++) {
    const wall = x! >= x1! && x! <= x2! && y! >= y1! && y! <= y2! && z! >= z1! && z! <= z2!;
    world.load({ x, y, z }, { stateId: y === -61 || wall ? 1 : 0 });
  }
  const registry = minecraftData("1.21.4");
  const skeleton = registry.entitiesByName.skeleton!;
  const player = registry.entitiesByName.player!;
  assert.ok(player.width !== null && player.height !== null && skeleton.width !== null && skeleton.height !== null);
  const { width, height } = player;
  const threat = { id: 1, position: spawn, width: skeleton.width, height: skeleton.height, attack: "projectile" as const };
  const exposed = (position: Vec3) => positionExposed(positionWorld(world), { position, width, height }, threat);
  assert.equal(exposed(new Vec3(Number(actor[0]), Number(actor[1]), Number(actor[2]))), true);
  for (let z = 4.5; z <= 7.5; z++) {
    const position = new Vec3(5.5, sy, z);
    assert.ok(position.distanceTo(spawn) >= DEFAULT_COMBAT_POLICY.evade_cover_range &&
      position.distanceTo(spawn) < DEFAULT_COMBAT_POLICY.evade_clear_range);
    assert.equal(exposed(position), false, `lee at ${z}`);
  }
  // The wall still occludes z=9.5 from this spawn; z=11.5 is exposed (a4 T5, 2026-11-17).
  for (const position of [new Vec3(5.5, sy, 2.5), new Vec3(5.5, sy, 11.5), new Vec3(-17.5, sy, 0.5),
    new Vec3(-5.5, sy, 12.5), new Vec3(-5.5, sy, -11.5)]) assert.equal(exposed(position), true, position.toString());
  // The former wall cannot provide cover before the current disengage distance (a4 T5, 2026-11-17).
  for (let y = y1!; y <= y2!; y++) for (let z = z1!; z <= z2!; z++) {
    world.load({ x: x1!, y, z }, { stateId: 0 });
    world.load({ x: 10, y, z }, { stateId: 1 });
  }
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) {
    const position = new Vec3(x + 0.5, sy, z + 0.5);
    if (position.distanceTo(spawn) < DEFAULT_COMBAT_POLICY.evade_clear_range) assert.equal(exposed(position), true, `old wall at ${position}`);
  }
});
test("reads every evade receipt in page order and rejects missing positions", () => {
  // Recorded t8-fixed-after receipt fields; the second endpoint reproduces the pit at lane z=512.
  const event = (healthAfter: number, y?: number) => ({ type: "survival_outcome", payload: {
    source: "hostile_reflex", evidence: { outcome: { response: "evade", outcome: "safe_separation", healthAfter,
      ...(y === undefined ? {} : { finalPosition: { x: 34.67839066305869, y, z: 512.5 } }),
      ends: [{ id: 50, name: "zombie", distance: 36.14250199118369, basis: "range" }] } } } });
  const options = { startY: -60, deaths: 1, status: "cancelled", interruptions: [] };
  const result = flightEvidence([event(3, -60), event(0, -62)], options);
  assert.equal(result.healthAfter, 3);
  assert.deepEqual(result.floor, { kind: "below", index: 1, y: -62 });
  assert.deepEqual(flightEvidence([event(3)], options).floor, { kind: "unknown", index: 0 });
  for (const [y, kind] of [[-60.499, "ok"], [-60.5, "ok"], [-60.501, "below"]] as const) {
    const floor = flightEvidence([event(3, -60), event(0, y)], options).floor;
    assert.equal(floor.kind, kind, `floor at ${y}`);
    if (floor.kind === "below") assert.equal(floor.index, 1);
  }
  const malformed = (position: unknown) => ({ type: "survival_outcome", payload: { source: "hostile_reflex",
    evidence: { outcome: { response: "evade", outcome: "safe_separation", healthAfter: 3, finalPosition: position } } } });
  for (const position of [null, { x: 0, y: null, z: 512 }, { x: 0, y: Infinity, z: 512 }]) {
    assert.deepEqual(flightEvidence([event(3, -60), malformed(position)], options).floor, { kind: "unknown", index: 1 });
    assert.deepEqual(flightEvidence([malformed(position), event(3, -60)], options).floor, { kind: "unknown", index: 0 });
  }
});

test("judges the evade after footing cancelled its predecessor", () => {
  // t00108, campaign pursuit: the next survival outcome landed the bot before it fled again.
  const cancelled = { response: "evade", outcome: "cancelled", healthAfter: 3,
    finalPosition: { x: 9.119747941128798, y: -59.724875, z: 2569.032738464071 }, elapsedMs: 2273.323548,
    ends: [{ id: 87, name: "skeleton", distance: 14.962724256750887, basis: null }] };
  const separated = { response: "evade", outcome: "safe_separation", healthAfter: 3,
    finalPosition: { x: 49.25554573031275, y: -60, z: 2607.2556102127446 }, elapsedMs: 12298.369129,
    ends: [{ id: 87, name: "skeleton", distance: 36.00321186553232, basis: "range" }] };
  const event = (source: string, outcome: unknown) => ({ type: "survival_outcome", payload: { source, evidence: { outcome } } });
  const options = { startY: -60, deaths: 0, health: 3, status: "succeeded", interruptions: ["[HOSTILE_CONTACT]"] };
  const footing = event("recover_footing", { kind: "landed", water: null });
  const result = flightEvidence([event("hostile_reflex", cancelled), footing, event("hostile_reflex", separated)], options);
  assert.equal(result.outcome, "safe_separation");
  assert.deepEqual(result.skipped, [{ receipt: cancelled, reason: "footing" }]);
  assert.equal(flightEvidence([event("hostile_reflex", cancelled), event("hostile_reflex", separated)], options).outcome, "cancelled");
  assert.equal(flightEvidence([event("hostile_reflex", separated), footing], options).outcome, "safe_separation");
  assert.equal(flightEvidence([event("hostile_reflex", cancelled), event("other", {}), footing, event("hostile_reflex", separated)], options).outcome, "cancelled");
  const allSkipped = flightEvidence([event("hostile_reflex", cancelled), footing], options);
  assert.equal(allSkipped.outcome, undefined);
  assert.equal(flightVerdict(allSkipped, ["range"], undefined, { judge: "evade" }), false);
  // t00110, the slow-server pursuit.
  const slowCancelled = { ...cancelled, finalPosition: { x: 9.112497941128797, y: -59.724875, z: 521.044988464071 },
    elapsedMs: 2272.0018770000006, ends: [{ id: 40, name: "skeleton", distance: 14.220699351213945, basis: null }] };
  const slowSeparated = { ...separated, finalPosition: { x: 12.549204950571488, y: -60, z: 522.5051743513252 },
    elapsedMs: 3747.858738000001, ends: [{ id: 40, name: "skeleton", distance: 17.547487011396466, basis: "cover" }] };
  const slow = flightEvidence([event("hostile_reflex", slowCancelled), footing, event("hostile_reflex", slowSeparated)], options);
  assert.equal(slow.outcome, "safe_separation");
  assert.deepEqual(slow.skipped, [{ receipt: slowCancelled, reason: "footing" }]);
  for (const elapsedTicks of [42, null, undefined]) {
    const receipt = { ...separated, ...(elapsedTicks === undefined ? {} : { elapsedTicks }) };
    assert.equal(flightEvidence([event("hostile_reflex", receipt)], options).receipts[0]?.elapsedTicks, elapsedTicks);
  }
});

interface TimelineOptions { readonly judge?: "order" | "evade" | "chain"; readonly events?: unknown[]; readonly interruptions?: string[] }

function timelineFixture(rate: number, status: "succeeded" | "failed" = "succeeded", driverError = false, options: TimelineOptions = {}) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, health: 7, server: { ticksPerSecond: rate } });
  const { bot } = harness;
  const added = listenersAddedSince(bot);
  const order = Promise.withResolvers<ScenarioCall>();
  const events = options.events ?? [];
  let listenerAtSend = -1;
  bot.chat = () => { if (driverError) throw new Error("summon failed"); };
  const judge = options.judge;
  const context = scenarioTestContext({ bot, scenario: scenarioDefinitionSchema.parse({
    params: { mob: "skeleton", target: [55, 64, 0], spawn: [-6, 64, 0], bases: ["cover"], ...(judge === undefined ? {} : { judge }) },
    goal: { kind: "completion" } }),
    call: async (action) => {
      if (action === "view_status") return { survivalPolicy: { revision: "1", effective: { combat: { hide: "never" } } } } as ScenarioCall;
      if (action === "set_survival_policy") return { result: { status: "succeeded" } } as ScenarioCall;
      if (action === "navigate") { listenerAtSend = added("time"); bot.entity.position.x += 0.25; return order.promise; }
      return { action, durationMs: 0, summary: "events", result: { status: "succeeded", source: { queryIds: ["events"] },
        events, readThroughEventId: events.length, remainingEventCount: 0 } } as ScenarioCall;
    } });
  const finish = () => order.resolve({ action: "navigate", durationMs: 0, summary: "order", interruptions: options.interruptions,
    result: status === "succeeded" ? { status } : { status, error: "order failed" } } as ScenarioCall);
  return { clock, harness, added, context, finish, events, listenerAtSend: () => listenerAtSend };
}

/** A survival_outcome row of one evade, shaped as read_recent_events returns it (the schema parses it). */
function evadeOutcomeRow(y: number, outcome: Record<string, unknown>) {
  const status = { summary: "safe" as const, request: null, owner: { current: null, reserved: null, connected: true, transfer: null },
    dangers: [], response: null, decisions: [], budgets: [], answered: [], observations: { missing: [], stale: [] },
    policy: new SurvivalPolicyState(createFakeBot().bot).snapshot(), vitals: { health: 7, food: 20, air: null, inWater: false },
    runtime: { liveness: "observed_in_process" as const, observedAt: 0, physicsObservedAt: null } };
  return { eventId: 1, botId: "Actor", type: "survival_outcome", observedAt: "2026-11-17T00:00:00.000Z", summary: "evade",
    payload: { kind: "outcome", source: "hostile_reflex", evidence: { outcome: { response: "evade", finalPosition: { x: 0, y, z: 0 }, ...outcome } }, status } };
}

test("the chain judge param selects the chain verdict through the event stream; order judges the same evidence strictly", async () => {
  for (const [judge, expected] of [["chain", "succeeded"], ["order", "failed"]] as const) {
    const f = timelineFixture(20, "succeeded", false, { judge, interruptions: ["[HOSTILE_CONTACT] skeleton"] });
    f.events.push(evadeOutcomeRow(f.harness.bot.entity.position.y, { outcome: "capability_limit", healthAfter: 7, elapsedTicks: 300,
      ends: [{ id: 1, name: "skeleton", distance: 21.7, basis: null }] }));
    using _timers = f.clock.install();
    const pending = run(f.context);
    await f.clock.advance(5_000);
    f.finish();
    const result = await f.clock.settle(pending, 1_000);
    assert.equal(result.status, expected, `${judge} judge`);
    const detail = JSON.parse(result.detail ?? "{}") as { chainPass?: boolean; outcome?: string; basis?: string | null;
      elapsedTicks?: number | null; budgetTicks?: number; status?: string };
    assert.deepEqual([detail.chainPass, detail.outcome, detail.basis, detail.elapsedTicks, detail.budgetTicks, detail.status],
      [true, "capability_limit", null, 300, 300, "succeeded"]);
  }
});

for (const rate of [20, 10]) {
  for (const stopped of [false, true]) {
  test(`flight timeline records ${stopped ? "stopped and resumed" : "continuous"} server at ${rate} tps`, async () => {
    const f = timelineFixture(rate, stopped ? "failed" : "succeeded");
    using _timers = f.clock.install();
    const pending = run(f.context);
    if (stopped) {
      await f.clock.advance(2_000);
      f.harness.server.stop();
      await f.clock.advance(4_000);
      f.harness.server.resume();
      await f.clock.advance(2_000);
    } else await f.clock.advance(5_000);
    assert.equal(f.listenerAtSend(), 1, "listener is armed before navigate");
    f.finish();
    const result = await f.clock.settle(pending, 1_000);
    assert.ok(result.detail);
    const ages = (JSON.parse(result.detail) as { ages: { age: number; ms: number; health: number; x: number; y: number; z: number }[] }).ages;
    const times = stopped ? (rate === 20 ? [1000, 2000, 7000, 8000] : [2000, 8000])
      : (rate === 20 ? [1000, 2000, 3000, 4000, 5000] : [2000, 4000]);
    assert.deepEqual(ages.map((sample) => sample.ms), times);
    assert.deepEqual(ages.map((sample) => sample.age), times.map((_, index) => 24000 + 20 * (index + 1)));
    const { x, y, z } = f.harness.bot.entity.position;
    assert.ok(ages.every((sample) => sample.health === 7 && sample.x === x && sample.y === y && sample.z === z));
    assert.equal(f.added("time"), 0);
    await f.clock.advance(3_000);
    assert.equal(f.added("time"), 0);
  });
  }

test(`flight timeline removes its listener on a driver error at ${rate} tps`, async () => {
  const f = timelineFixture(rate, "succeeded", true);
  using _timers = f.clock.install();
  await assert.rejects(run(f.context), /summon failed/);
  assert.equal(f.listenerAtSend(), 1);
  assert.equal(f.added("time"), 0);
  await f.clock.advance(5_000);
  assert.equal(f.added("time"), 0);
});
}
