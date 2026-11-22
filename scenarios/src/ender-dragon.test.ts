import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { scenarioDefinitionSchema } from "mine-labs";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../src/test-support/fake-bot/index.ts";
import { watch } from "../../src/test-support/pending.ts";
import { clearCrystals, fightPerches, parseShortfall, prepare, type EndActionCall } from "./ender-dragon.ts";
import type { MineAiScenarioContext } from "./scenario-client.ts";

/** Preparation never uses navigation or pathfinder telemetry. Entity answers use the shared spawn/remove handlers. */
function crystalPreparation(rate: number, phase: "crystals" | "perch") {
  const clock = createFakeClock({ mode: "mocked" });
  const h = createFakeBot({ clock, server: { startAge: 1_000, ticksPerSecond: rate }, overrides: {
    chat: () => {},
    // Mineflayer blocks.js:70-94 returns once its surrounding columns are loaded; this fixture starts loaded.
    waitForChunksToLoad: async () => {},
  } });
  const controller = new AbortController();
  const context: MineAiScenarioContext = {
    bot: h.bot, signal: controller.signal, log() {}, progress() {},
    scenario: scenarioDefinitionSchema.parse({ params: { phase }, goal: { kind: "completion" } }),
    get navigation(): never { throw new Error("preparation does not navigate"); },
    get pathfinder(): never { throw new Error("preparation does not read telemetry"); },
  };
  const added = listenersAddedSince(h.bot);
  const spawn = () => {
    for (let i = 0; i < 10; i++) h.entities.spawn({ id: 100 + i, name: "end_crystal", position: { x: i * 10, y: 70, z: 0 } });
  };
  if (phase === "perch") spawn();
  return { ...h, controller, context, spawn, remove() {
    for (let i = 0; i < 10; i++) h.entities.remove(100 + i);
  }, async assertClean() {
    assert.equal(clock.pendingGlobalTimers(), 0);
    assert.equal(clock.pendingTimers(), 0);
    for (const event of h.bot.eventNames()) assert.equal(added(String(event)), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await clock.advance(70_000);
    assert.equal(clock.pendingGlobalTimers(), 0);
  } };
}

for (const rate of [20, 10]) {
  for (const [phase, answerTicks, deadlineTicks] of [["crystals", 300, 420], ["perch", 80, 120]] as const) {
    test(`${phase} preparation accepts its answer at +${answerTicks} server ticks at ${rate} tps`, async () => {
      const h = crystalPreparation(rate, phase);
      using _timers = h.clock.install();
      const pending = prepare(h.context);
      const state = watch(pending);
      await h.clock.advance(answerTicks * 1_000 / rate);
      assert.equal(h.bot.time.age, 1_000 + answerTicks);
      assert.equal(state.over, false);
      if (phase === "crystals") h.spawn();
      else h.remove();
      await h.clock.settle(pending, 50);
      assert.equal(h.clock.now(), answerTicks * 1_000 / rate + 50);
      await h.assertClean();
    });

    test(`${phase} preparation rejects a missing answer after +${deadlineTicks} at ${rate} tps`, async () => {
      const h = crystalPreparation(rate, phase);
      using _timers = h.clock.install();
      const pending = prepare(h.context);
      const rejected = assert.rejects(pending, phase === "crystals" ? /Expected all ten native crystals.*ticks/u : /Zero-crystal setup.*ticks/u);
      const state = watch(pending);
      await h.clock.advance(deadlineTicks * 1_000 / rate);
      assert.equal(h.bot.time.age, 1_000 + deadlineTicks);
      assert.equal(state.over, false);
      await h.clock.settle(rejected, 50);
      assert.equal(h.clock.now(), deadlineTicks * 1_000 / rate + 50);
      await h.assertClean();
    });
  }
}

for (const phase of ["crystals", "perch"] as const) {
  for (const end of ["stopped", "cancelled"] as const) {
    test(`${phase} preparation releases its wait when ${end}`, async () => {
      const h = crystalPreparation(10, phase);
      using _timers = h.clock.install();
      if (end === "stopped") h.server.stop();
      const pending = prepare(h.context);
      const reason = new Error("scenario cancelled");
      const rejected = assert.rejects(pending, end === "cancelled" ? error => error === reason : new RegExp(phase === "crystals" ? "native crystals.*stalled" : "Zero-crystal setup.*wall", "u"));
      await h.clock.advance(0);
      if (end === "cancelled") h.controller.abort(reason);
      await h.clock.settle(rejected, end === "cancelled" ? 0 : phase === "crystals" ? 20_000 : 18_000);
      assert.equal(h.bot.time.age, 1_000);
      await h.assertClean();
    });
  }
}

function output(outcome: string, status: "succeeded" | "failed" = "succeeded", reason: string | null = null) {
  return { action: "end_test", durationMs: 0, result: { status, ...(status === "failed" ? { error: reason ?? "missed" } : {}),
    combat: { outcome, attacks: 0, healthBefore: null, healthAfter: null, reason } } } as Awaited<ReturnType<EndActionCall>>;
}

const shortfallText = '[CRYSTAL_STAIRCASE_SHORTFALL] Tower at (1, 70, 2): 70 end_stone blocks still needed; carrying 64. Gather at least 6 more end_stone and retry this crystal. Existing staircase blocks will be reused. Alternatively, approach "pillar" scaffolds straight up beside the tower with about 20 carried scaffold blocks.';

test("the crystal refill reads the requested total and material from the staircase receipt alone", () => {
  assert.deepEqual(parseShortfall(shortfallText), { name: "end_stone", needed: 70, carried: 64 });
  assert.equal(parseShortfall(shortfallText.replace("CRYSTAL_STAIRCASE_SHORTFALL", "PERCH_PASSAGE_CLOUDED")), null);
});

test("crystal shortfall fails on the same refusal after a refill gained nothing", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, entities } = createFakeBot({ clock, carried: { end_stone: 64 } });
  const towers = Array.from({ length: 10 }, (_, i) => entities.spawn({ name: "end_crystal", position: { x: i * 5, y: 70, z: 0 } }));
  const refills: unknown[] = [];
  let attempts = 0;
  const call: EndActionCall = async (_name, input) => {
    assert.equal((input as { entity_id: number }).entity_id, towers[0]!.id);
    assert.ok(++attempts <= 2, "the same shortfall reached a third action call");
    return output("stopped", "failed", shortfallText);
  };
  const pending = clearCrystals(bot, call, "melee", async shortfall => {
    refills.push(shortfall);
  });
  await clock.settle(assert.rejects(pending, error => error instanceof Error && error.message === shortfallText), 10_000);
  assert.equal(attempts, 2);
  assert.deepEqual(refills, [null, { name: "end_stone", needed: 70, carried: 64 }]);
  assert.equal(clock.pendingGlobalTimers(), 0);
});

for (const strategy of ["mixed", "bow", "melee"] as const) {
  test(`crystal sequence ${strategy} classifies cages, preserves explicit methods and retries a missed shot`, async () => {
    // Crystal ids 1..10 as in the assertions: id 1 replaces the fake's own entities[1] entry, as the old fixture's did (bot.entity stays the bot).
    const { bot } = createFakeBot({
      cells: { "2,70,0": "iron_bars", "12,71,0": "iron_bars" },
      groundY: null,
      entities: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, { name: "end_crystal", position: { x: i * 10, y: 70 + i, z: 0 } }])),
    });
    const calls: Array<{ entity_id: number; weapon: string }> = [];
    let missed = false, interruptedBuild = false, prepared = 0;
    bot.waitForTicks = async () => {};
    const call: EndActionCall = async (name, input) => {
      assert.equal(name, "destroy_end_crystal");
      const shot = input as { entity_id: number; weapon: string };
      calls.push(shot);
      if (shot.weapon === "bow" && !missed) { missed = true; return output("shot_missed", "failed"); }
      if (shot.weapon === "melee" && !interruptedBuild) { interruptedBuild = true; return output("stopped", "failed", "[END_SHELTER_STOPPED] Shelter unsafe"); }
      bot.entities[shot.entity_id]!.isValid = false;
      return output("crystal_destroyed");
    };
    await clearCrystals(bot, call, strategy, async () => { prepared++; });
    const ids = [...new Set(calls.map(c => c.entity_id))];
    assert.deepEqual(ids, strategy === "mixed" ? [3, 4, 5, 6, 7, 8, 9, 10, 1, 2] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(prepared, 10);
    assert.equal(calls.length, strategy === "mixed" ? 12 : 11);
    for (const call of calls) assert.equal(call.weapon, strategy === "mixed" ? (call.entity_id <= 2 ? "melee" : "bow") : strategy);
  });
}

test("confirmed crystal destruction advances the sequence even when its return walk fails", async () => {
  const { bot } = createFakeBot({
    groundY: null,
    entities: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, { name: "end_crystal", position: { x: (i + 1) * 10, y: 70, z: 0 } }])),
  });
  const visited: number[] = [];
  bot.waitForTicks = async () => assert.fail("do not wait for an already destroyed crystal");
  const call: EndActionCall = async (_name, input) => {
    const id = (input as { entity_id: number }).entity_id;
    visited.push(id);
    bot.entities[id]!.isValid = false;
    return { ...output("stopped", "failed", "Crystal destroyed; return route failed"),
      request: { evidence: { completion: { kind: "event", observed: true } } },
    } as Awaited<ReturnType<EndActionCall>>;
  };
  await clearCrystals(bot, call, "melee");
  assert.deepEqual(visited, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("shared perch caller attacks an early landing, resumes unfinished preparation, then reuses readiness", async () => {
  const metadata = { 9: 200, 16: 0 };
  const { bot } = createFakeBot({ dimension: "the_end", entities: { 42: { name: "ender_dragon", position: { x: 0, y: 70, z: 0 }, metadata } } });
  const calls: string[] = [];
  let preparations = 0, attacks = 0;
  const call: EndActionCall = async (name, input) => {
    calls.push(name);
    assert.deepEqual(input, { entity_id: 42 });
    if (name === "prepare_dragon_perch") return output(++preparations === 1 ? "perch_approaching" : "perch_ready");
    metadata[9] = ++attacks === 3 ? 0 : 200 - attacks * 56;
    return output(attacks === 3 ? "dragon_died" : "perch_ended");
  };
  await fightPerches(bot, call, new AbortController().signal);
  assert.deepEqual(calls, ["prepare_dragon_perch", "attack_dragon_perch", "prepare_dragon_perch", "attack_dragon_perch", "attack_dragon_perch"]);
});

test("perch failures retry preparation and attacking until the dragon dies", async () => {
  const { bot } = createFakeBot({ dimension: "the_end", entities: { 42: { name: "ender_dragon", position: { x: 0, y: 70, z: 0 }, metadata: { 9: 200, 16: 0 } } } });
  let preparations = 0, attacks = 0, waits = 0;
  bot.waitForTicks = async () => { waits++; };
  const call: EndActionCall = async (name, input) => {
    assert.deepEqual(input, { entity_id: 42 });
    if (name === "prepare_dragon_perch") return ++preparations <= 3
      ? output("stopped", "failed", "[PERCH_PREPARATION_DAMAGED] escaped") : output("perch_ready");
    return ++attacks <= 3 ? output("stopped", "failed", "route failed") : output("dragon_died");
  };
  await fightPerches(bot, call, new AbortController().signal);
  assert.equal(preparations, 7);
  assert.equal(attacks, 4);
  assert.equal(waits, 6);
  const cancelled = new AbortController();
  cancelled.abort(new Error("scenario deadline"));
  await assert.rejects(fightPerches(bot, call, cancelled.signal), /scenario deadline/);
});

test("clouded attack returns to preparation between requests without losing the dragon target", async () => {
  const { bot } = createFakeBot({ dimension: "the_end", entities: { 42: { name: "ender_dragon", position: { x: 0, y: 70, z: 0 }, metadata: { 9: 200, 16: 0 } } } });
  let waits = 0, attacks = 0;
  bot.waitForTicks = async (ticks: number) => { waits += ticks; };
  const calls: string[] = [];
  const call: EndActionCall = async (name, input) => {
    calls.push(name);
    assert.deepEqual(input, { entity_id: 42 });
    if (name === "prepare_dragon_perch") return output("perch_ready");
    if (++attacks === 1) return output("stopped", "failed", "[PERCH_PASSAGE_CLOUDED] Wait for clearance");
    return output("dragon_died");
  };
  await fightPerches(bot, call, new AbortController().signal);
  assert.equal(waits, 20);
  assert.deepEqual(calls, ["prepare_dragon_perch", "attack_dragon_perch", "prepare_dragon_perch", "attack_dragon_perch"]);
});
