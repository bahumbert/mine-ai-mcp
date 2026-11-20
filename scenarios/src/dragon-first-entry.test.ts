/** First-entry waits preserve server time, cancellation and cleanup at both game rates. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtempDisposable } from "node:fs/promises";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import { z } from "zod";
import { defineAction } from "../../src/actions/action.ts";
import { outcomes as collectionOutcomes } from "../../src/actions/collect-block/contract.ts";
import { endCombatActionResult, interruptedEndCombatResult } from "../../src/actions/end-combat-result.ts";
import { BodyAbort } from "../../src/session/abort.ts";
import { createFakeBot, createFakeClock, itemOf, listenersAddedSince, NEW_LIFE_SETTLE_MS } from "../../src/test-support/fake-bot/index.ts";
import { watch } from "../../src/test-support/pending.ts";
import { carriedCount } from "../../src/world/inventory-count.ts";
import { ServerPacedExpired } from "../../src/world/server-paced.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "../../tests/minecraft/drivers/server-ticks.ts";
import { run as runBow } from "./dragon-bow.ts";
import * as driver from "./dragon-first-entry.ts";
import { run as runDragon } from "./ender-dragon.ts";
import type { Runtime } from "./runtime.ts";
import type { MineAiScenario } from "./scenario-client.ts";

const action = defineAction({
  name: "first_entry_test", description: "Wait for cancellation", execution: { kind: "information" },
  inputSchema: z.strictObject({}), resultSchema: z.strictObject({ status: z.literal("succeeded") }),
  parse: () => ({}), formatResult: () => "done", execute: async () => ({ status: "succeeded" as const }),
});

/** An action blocked on its caller's signal, without any game answers invented by the runtime stub. */
function waitingRuntime() {
  const runtime: Pick<Runtime, "run"> = { run: async (_action, _input, signal) => {
    assert.ok(signal);
    signal.throwIfAborted();
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  } };
  return runtime;
}

/** World age, entity removal and health packets use the shared fake's measured contracts. */
function trial(rate = 20, timePacketYet = true, dimension = "overworld") {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, dimension, server: { startAge: 1_000, ticksPerSecond: rate, timePacketYet } });
  const added = listenersAddedSince(harness.bot);
  const clientAdded = listenersAddedSince(harness.bot._client);
  return { ...harness, assertClean: async (signal: AbortSignal) => {
    for (const event of harness.bot.eventNames()) assert.equal(added(String(event)), 0, String(event));
    for (const event of harness.bot._client.eventNames()) assert.equal(clientAdded(String(event)), 0, String(event));
    assert.equal(getEventListeners(signal, "abort").length, 0);
    assert.equal(clock.pendingTimers(), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
    await clock.advance(550_000, 1_000);
    assert.equal(clock.pendingTimers(), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
  } };
}

for (const rate of [20, 10]) {
  test(`action budget aborts only after the +3620 packet at ${rate} tps`, async () => {
    const { bot, clock, assertClean } = trial(rate);
    using _timers = clock.install();
    const controller = new AbortController();
    const runtime = waitingRuntime();
    const pending = driver.runActionWithin(runtime, action, {}, bot, controller.signal);
    const state = watch(pending);
    const rejected = assert.rejects(pending, error => {
      assert.ok(error instanceof ServerPacedExpired);
      assert.equal(error.end, "ticks");
      assert.equal(error.elapsedTicks, 3_620);
      return true;
    });
    const packetMs = 3_620 * 1_000 / rate;
    await clock.advance(packetMs - 50);
    assert.equal(bot.time.age, 4_600);
    assert.equal(state.over, false);
    await clock.advance(50);
    assert.equal(bot.time.age, 4_620);
    assert.equal(state.over, false, "the packet arrives after this look");
    await clock.advance(50);
    await rejected;
    assert.equal(clock.now(), packetMs + 50);
    await assertClean(controller.signal);
  });

  test(`dragon removal at +220 ticks beats the removal budget at ${rate} tps`, async () => {
    const { bot, clock, entities, assertClean } = trial(rate);
    using _timers = clock.install();
    const dragon = entities.spawn({ name: "ender_dragon", position: { x: 0, y: 70, z: 0 } });
    const controller = new AbortController();
    const pending = driver.awaitDragonRemoval(bot, dragon, controller.signal);
    const state = watch(pending);
    const removalMs = 220 * 1_000 / rate;
    await clock.advance(removalMs);
    assert.equal(bot.time.age, 1_220);
    assert.equal(state.over, false);
    entities.remove(dragon.id);
    await clock.settle(pending, 50);
    assert.equal(clock.now(), removalMs + 50);
    await assertClean(controller.signal);
  });

  test(`missing dragon removal fails only after the +260 packet at ${rate} tps`, async () => {
    const { bot, clock, entities, assertClean } = trial(rate);
    using _timers = clock.install();
    const dragon = entities.spawn({ name: "ender_dragon", position: { x: 0, y: 70, z: 0 } });
    const controller = new AbortController();
    const pending = driver.awaitDragonRemoval(bot, dragon, controller.signal);
    const state = watch(pending);
    const rejected = assert.rejects(pending, /Native death\/removal.*ticks.*elapsedMs.*elapsedTicks/);
    await clock.advance(260 * 1_000 / rate);
    assert.equal(bot.time.age, 1_260);
    assert.equal(state.over, false);
    await clock.advance(50);
    await rejected;
    await assertClean(controller.signal);
  });

  for (const death of [true, false]) {
    test(`failure settle ${death ? "sees death at +10" : "waits past +60"} ticks at ${rate} tps`, async () => {
      const { bot, clock, combat, assertClean } = trial(rate);
      using _timers = clock.install();
      const controller = new AbortController();
      const pending = driver.settleFailure(bot, controller.signal);
      const state = watch(pending);
      const ticks = death ? 10 : 60;
      await clock.advance(ticks * 1_000 / rate);
      assert.equal(state.over, false);
      assert.equal(bot.time.age, death ? 1_000 : 1_060);
      if (death) combat.setHealth(0);
      await clock.settle(pending, 50);
      assert.equal(clock.now(), ticks * 1_000 / rate + 50);
      if (death) await clock.settle(new Promise<void>(resolve => bot.once("physicsTick", resolve)), NEW_LIFE_SETTLE_MS);
      await assertClean(controller.signal);
    });
  }
}

for (const kind of ["action", "removal", "settle"] as const) {
  test(`stopped server bounds ${kind} and releases every resource`, async () => {
    const { bot, clock, server, entities, assertClean } = trial();
    using _timers = clock.install();
    server.stop();
    const dragon = entities.spawn({ name: "ender_dragon", position: { x: 0, y: 70, z: 0 } });
    const controller = new AbortController();
    const pending = kind === "action" ? driver.runActionWithin(waitingRuntime(), action, {}, bot, controller.signal)
      : kind === "removal" ? driver.awaitDragonRemoval(bot, dragon, controller.signal)
      : driver.settleFailure(bot, controller.signal);
    const state = watch<unknown>(pending);
    const finished = kind === "settle" ? pending : assert.rejects(pending, error => {
      if (kind === "action") {
        assert.ok(error instanceof ServerPacedExpired);
        assert.equal(error.end, "stalled");
        assert.equal(error.elapsedMs, 180_000);
        assert.equal(error.elapsedTicks, 0);
      } else assert.match(String(error), /Native death\/removal.*wall.*39000.*elapsedTicks/);
      return true;
    });
    const finishMs = kind === "action" ? 180_000 : kind === "removal" ? 39_000 : 9_000;
    await clock.advance(finishMs - 1);
    assert.equal(state.over, false);
    await clock.advance(1);
    await finished;
    assert.equal(bot.time.age, 1_000);
    await assertClean(controller.signal);
  });

  for (const alreadyAborted of [false, true]) {
    test(`${kind} preserves exact trial cancellation (already aborted ${alreadyAborted})`, async () => {
      const { bot, clock, entities, assertClean } = trial();
      using _timers = clock.install();
      const dragon = entities.spawn({ name: "ender_dragon", position: { x: 0, y: 70, z: 0 } });
      const controller = new AbortController();
      const reason = new Error("trial cancelled");
      if (alreadyAborted) controller.abort(reason);
      const pending = kind === "action" ? driver.runActionWithin(waitingRuntime(), action, {}, bot, controller.signal)
        : kind === "removal" ? driver.awaitDragonRemoval(bot, dragon, controller.signal)
        : driver.settleFailure(bot, controller.signal);
      const rejected = assert.rejects(pending, error => error === reason);
      if (!alreadyAborted) {
        await clock.advance(100);
        controller.abort(reason);
      }
      await rejected;
      await assertClean(controller.signal);
    });
  }
}

test("already removed dragon and settled death need no interval", async () => {
  const { bot, clock, combat, assertClean } = trial();
  using _timers = clock.install();
  const controller = new AbortController();
  await driver.awaitDragonRemoval(bot, undefined, controller.signal);
  combat.setHealth(0);
  await driver.settleFailure(bot, controller.signal);
  assert.equal(clock.now(), 0);
  await clock.settle(new Promise<void>(resolve => bot.once("physicsTick", resolve)), NEW_LIFE_SETTLE_MS);
  await assertClean(controller.signal);
});

for (const fails of [false, true]) {
  test(`action ${fails ? "failure" : "completion"} releases its unused budget`, async () => {
    const { bot, clock, assertClean } = trial();
    using _timers = clock.install();
    const controller = new AbortController();
    const reason = new Error("runtime rejected");
    const runtime: Pick<Runtime, "run"> = { run: async (definition, input, signal) => {
      if (fails) throw reason;
      if (!definition.execute) throw new Error("test action must be one-shot");
      return { action: definition.name, durationMs: 0, result: await definition.execute(definition.parse(input), { signal }) };
    } };
    const pending = driver.runActionWithin(runtime, action, {}, bot, controller.signal);
    if (fails) await assert.rejects(pending, error => error === reason);
    else assert.equal((await pending).result.status, "succeeded");
    await assertClean(controller.signal);
  });
}

test("without an initial world age each wait stays bounded and removal fails unobserved", async () => {
  const { bot, clock, server, entities, assertClean } = trial(20, false);
  using _timers = clock.install();
  server.stop();
  const dragon = entities.spawn({ name: "ender_dragon", position: { x: 0, y: 70, z: 0 } });
  const controller = new AbortController();
  const actionPending = driver.runActionWithin(waitingRuntime(), action, {}, bot, controller.signal);
  const actionRejected = assert.rejects(actionPending, error => error instanceof ServerPacedExpired && error.end === "unobserved");
  const removalRejected = assert.rejects(driver.awaitDragonRemoval(bot, dragon, controller.signal), /not observed.*unobserved/);
  const settle = driver.settleFailure(bot, controller.signal);
  const state = watch(settle);
  await clock.advance(1_999);
  assert.equal(state.over, false);
  await clock.advance(1);
  await settle;
  await clock.advance(178_000);
  await Promise.all([actionRejected, removalRejected]);
  await assertClean(controller.signal);
});

const driverCases = [
  ...[20, 10].flatMap(rate => ["ready", "ticks", "cancel", "settle-cancel"].map(mode => ({ mode, rate }))),
  { mode: "stalled", rate: 20 }, { mode: "unobserved", rate: 20 },
];

/** Keep Bun's module replacements out of the rest of the suite. */
function isolatedDriverTest(name: string, exercise: () => Promise<void>): void {
  test(name, async () => {
    if (process.env.FIRST_ENTRY_CANCEL_CHILD === "1") return await exercise();
    const result = spawnSync(process.execPath, ["test", "--timeout", "30000", import.meta.filename,
      "--test-name-pattern", `^${name}$`], {
      encoding: "utf8", env: { ...process.env, FIRST_ENTRY_CANCEL_CHILD: "1" },
      timeout: 30_000, // limit: all five child groups took 4.87 s together on 2026-11-20; standard Bun hang bound.
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  });
}

/** Keep the case name and original failure while sharing child startup across fake clocks. */
function isolatedDriverCases<Case>(name: string, cases: readonly Case[], exercise: (sample: Case) => Promise<void>): void {
  isolatedDriverTest(name, async () => {
    const previousArtifacts = process.env.MINE_LABS_ARTIFACTS_DIR;
    for (const sample of cases) {
      try {
        await exercise(sample);
      } catch (cause) {
        throw new Error(`${name} ${JSON.stringify(sample)}`, { cause });
      } finally {
        if (previousArtifacts === undefined) delete process.env.MINE_LABS_ARTIFACTS_DIR;
        else process.env.MINE_LABS_ARTIFACTS_DIR = previousArtifacts;
      }
    }
  });
}

isolatedDriverCases("driver admission preserves budgets and cleanup", driverCases, async ({ mode, rate }) => {
  const { mock } = await import("bun:test");
  const { bot, clock, server, assertClean } = trial(rate, mode !== "unobserved");
  using _timers = clock.install();
  await using artifacts = await mkdtempDisposable("/dev/shm/first-entry-");
  process.env.MINE_LABS_ARTIFACTS_DIR = artifacts.path;
  if (mode === "stalled" || mode === "unobserved") server.stop();
  let captures = 0, closed = 0, busy = mode !== "settle-cancel", startedAt: number | null = null;
  let active: AbortSignal | undefined;
  mock.module("./source-identity.ts", () => ({ recordSourceIdentity: async () => {} }));
  mock.module("./runtime.ts", () => ({ openRuntime: async () => ({
    actions: [{ ...action, name: "view_status" }], status: () => ({ busy }),
    run: async (_action: unknown, _input: unknown, signal: AbortSignal) => {
      startedAt = clock.now();
      active = signal;
      if (mode === "settle-cancel") throw new Error("action failed");
      return await waitingRuntime().run(action, {}, signal);
    },
    captureIncident: async () => { captures++; return {}; }, flushIncidents: async () => {},
    [Symbol.asyncDispose]: async () => { closed++; },
  }) }));
  const controller = new AbortController();
  const reason = new Error("cancel trial");
  const context = {
    bot, signal: controller.signal, log: () => {}, progress: () => {},
    scenario: { world: { seed: 1 } } as Parameters<typeof driver.run>[0]["scenario"],
    get navigation(): never { throw new Error("navigation is outside the failure-settle path"); },
    get pathfinder(): never { throw new Error("pathfinder is outside the failure-settle path"); },
  };
  const pending = driver.run(context);
  const state = watch(pending);
  const packetMs = 3_620 * 1_000 / rate;
  if (mode === "ready") {
    await clock.advance(packetMs - 50);
    assert.equal(startedAt, null);
    busy = false;
    await clock.advance(50);
    assert.equal(startedAt, packetMs);
    await clock.advance(packetMs);
    assert.equal(active?.aborted, false, "admission leaves a fresh full action budget");
    assert.equal(bot.time.age, 8_240);
    await clock.advance(50);
    assert.ok(active?.reason instanceof ServerPacedExpired);
    assert.equal(active.reason.end, "ticks");
    assert.equal(active.reason.elapsedTicks, 3_620);
  } else if (mode === "cancel" || mode === "settle-cancel") {
    await clock.advance(100);
    assert.equal(mode === "cancel" ? startedAt : captures, mode === "cancel" ? null : 0);
  } else {
    const endMs = mode === "ticks" ? packetMs + 50 : 180_000;
    await clock.advance(endMs - 1);
    assert.equal(state.over, false);
    assert.equal(captures, 0);
    await clock.advance(1);
    assert.equal(startedAt, null, "an expired admission must never start the action");
    assert.equal(captures, 0, "failure settlement follows the admission expiry");
    const result = await clock.settle(pending, 9_000);
    assert.equal(result.status, "failed");
    const failure = JSON.parse(result.detail!);
    for (const part of ["Runtime remained busy", `"end":"${mode}"`, `"elapsedMs":${endMs}`,
      `"elapsedTicks":${mode === "ticks" ? 3_620 : mode === "unobserved" ? "null" : 0}`]) {
      assert.ok(failure.error.includes(part), failure.error);
    }
    assert.equal(captures, 1);
  }
  if (mode === "ready" || mode === "cancel" || mode === "settle-cancel") {
    assert.equal(state.over, false);
    const rejected = assert.rejects(pending, error => error === reason);
    controller.abort(reason);
    await clock.advance(0);
    assert.equal(state.over, true, "trial cancel settles immediately");
    await rejected;
    assert.equal(captures, 0);
  }
  assert.equal(closed, 1);
  await assertClean(controller.signal);
});

const endActions = ["view_status", "set_survival_policy", "drop_item", "collect_block", "navigate",
  "destroy_end_crystal", "prepare_dragon_perch", "attack_dragon_perch", "shoot_dragon"];

/** Substitute the runtime's slow action boundary, using the real driver, clock, and entity observations. */
async function endTrial(rate = 20, dimension = "the_end", source: Promise<void> = Promise.resolve()) {
  const { mock } = await import("bun:test");
  const h = trial(rate, true, dimension);
  const artifacts = await mkdtempDisposable("/dev/shm/end-driver-");
  const timers = h.clock.install();
  process.env.MINE_LABS_ARTIFACTS_DIR = artifacts.path;
  const controller = new AbortController();
  const progress: string[] = [];
  let closed = 0;
  mock.module("./source-identity.ts", () => ({ recordSourceIdentity: () => source }));
  return { ...h, controller, progress,
    async [Symbol.asyncDispose]() { timers[Symbol.dispose](); await artifacts.remove(); },
    spawnTower(x: number) { return h.entities.spawn({ name: "end_crystal", position: { x, y: 70, z: 0 } }); },
    async assertClosed() { assert.equal(closed, 1); await h.assertClean(controller.signal); },
    start(run: MineAiScenario, phase: "crystals" | "perch" | "full", respond: (name: string, input: unknown) => unknown,
      isBusy = () => false) {
      mock.module("./runtime.ts", () => ({ openRuntime: async () => ({
        actions: endActions.map(name => ({ ...action, name })), status: () => ({ busy: isBusy() }),
        run: async ({ name }: typeof action, input: unknown) => ({ action: name, durationMs: 0, ...await respond(name, input) as object }),
        captureIncident: async () => ({}), flushIncidents: async () => {},
        [Symbol.asyncDispose]: async () => { closed++; },
      }) }));
      return run({ bot: h.bot, signal: controller.signal, log() {}, progress: reason => { progress.push(reason); },
        scenario: scenarioDefinitionSchema.parse({ players: [{ name: h.bot.username, pos: [0, 70, 0] }],
          params: { phase, call_gap_ticks: 0 }, goal: { kind: "completion" } }),
        get navigation(): never { throw new Error("the action boundary owns navigation"); },
        get pathfinder(): never { throw new Error("the action boundary owns pathfinding"); },
      });
    },
  };
}

/** Action receipts and server packets are independent evidence. */
function endReceipt(outcome: string) {
  return { result: { status: "succeeded", combat: { outcome, attacks: 0, healthBefore: null, healthAfter: null, reason: null } } };
}

/** Replay setup can add inventory or arrange a tower before the fight. */
function firstEntrySetup(name: string) {
  return { result: { status: "succeeded" }, ...(name === "view_status" ? { survivalPolicy: { revision: 1 } } : {}) };
}

isolatedDriverCases("first entry fills to 70 after partial pickup", [[20, 64, [6, 3]], [10, 34, [32, 7]]] as const, async ([rate, start, requests]) => {
  await using h = await endTrial(rate);
  const towers = Array.from({ length: 10 }, (_, i) => h.spawnTower(i * 5));
  h.inventory.updateSlot(9, itemOf(h.bot.registry, "end_stone", start));
  const requested: unknown[] = [];
  const visited: number[] = [];
  let retriedWith: number | undefined;
  const reason = `[CRYSTAL_STAIRCASE_SHORTFALL] Tower at (0, 70, 0): 70 end_stone blocks still needed; carrying ${start}. Gather at least ${70 - start} more end_stone and retry this crystal.`;
  const pending = h.start(driver.run, "full", async (name, input) => {
    // The live staging route spent one freshly collected block before the retry.
    if (name === "navigate" && visited.length === 1) {
      const stack = h.bot.inventory.items().find(item => item.name === "end_stone" && item.count > 1)!;
      h.inventory.updateSlot(stack.slot, itemOf(h.bot.registry, "end_stone", stack.count - 1));
    }
    if (name === "collect_block") {
      const { count } = input as { count: number };
      const first = requested.length === 0;
      requested.push(input);
      const gained = first ? 70 - start - requests[1] : requests[1];
      const pickedUp = new Promise<void>(resolve => h.bot.once("playerCollect", () => resolve()));
      h.entities.spawn({ name: "item", position: h.bot.entity.position, item: { name: "end_stone", count: gained }, pickupDelayTicks: 10 });
      await pickedUp;
      const brokenAt = Array.from({ length: count }, (_, x) => ({ x, y: 63, z: 0, distanceFromStart: x + 1 }));
      const collected = { requested: count, gained, gainedByItem: { end_stone: gained }, blocksBroken: count, brokenAt };
      return { result: first
        ? { status: "partial", error: collectionOutcomes.dropAttemptsExhausted(count, gained, count), collected }
        : { status: "succeeded", collected } };
    }
    if (name !== "destroy_end_crystal") return firstEntrySetup(name);
    const { entity_id } = input as { entity_id: number };
    visited.push(entity_id);
    if (visited.length === 1) return { result: { ...endReceipt("stopped").result, status: "failed", error: reason,
      combat: { ...endReceipt("stopped").result.combat, reason } } };
    if (visited.length === 2) retriedWith = carriedCount(h.bot, "end_stone");
    else h.controller.abort(new Error("advanced to the next tower"));
    h.entities.remove(entity_id);
    return endReceipt("crystal_destroyed");
  });
  const advanced = assert.rejects(pending, /advanced to the next tower/u);
  const pickupMs = 10_000 / rate;
  await h.clock.advance(pickupMs - 1);
  assert.equal(h.bot.time.age, 1_000);
  assert.equal(carriedCount(h.bot, "end_stone"), start, "stock is unchanged before the fake server's pickup");
  await h.clock.settle(advanced, 6_000);
  assert.deepEqual(requested, requests.map(count => ({ block_name: "end_stone", count })));
  assert.equal(retriedWith, 70, "the retried action sees the receipt's requested total in the inventory");
  assert.deepEqual(visited, [towers[0]!.id, towers[0]!.id, towers[1]!.id]);
  await h.assertClosed();
});

const progressCases = [["shared", runDragon, 20], ["first-entry", driver.run, 20],
  ["bow", runBow, 20], ["bow", runBow, 10], ["bow", runBow, "stalled"]] as const;
isolatedDriverCases("End drivers report a server hit and release their observer at exit", progressCases, async ([label, run, rate]) => {
  const source = Promise.withResolvers<void>();
  await using h = await endTrial(rate === "stalled" ? 20 : rate, "the_end", source.promise);
  const dragon = h.entities.spawn({ name: "ender_dragon", position: { x: 0, y: 70, z: 0 }, metadata: { 9: 200 } });
  let busy = label === "bow", shots = 0;
  const pending = h.start(run, "perch", name => {
    assert.equal(name, "shoot_dragon");
    shots++;
    h.combat.kill(dragon.id);
    return { result: endCombatActionResult({ outcome: "dragon_died", attacks: 0, healthBefore: 199, healthAfter: 0, reason: null }) };
  }, () => busy);
  h.combat.hurt(dragon.id, h.bot.entity.id, 1);
  await h.clock.advance(100);
  assert.deepEqual(h.progress, ["hit"], "the driver watches for confirmed hits while recording its source");
  source.resolve();
  if (label !== "bow") {
    const reason = new Error("stop after recording the hit");
    const cancelled = assert.rejects(pending, error => error === reason);
    h.controller.abort(reason);
    await h.clock.settle(cancelled, 0);
  } else if (rate === "stalled") {
    h.server.stop();
    const state = watch(pending);
    const failed = assert.rejects(pending, /Bow fighter waiting for the body stalled/u);
    await h.clock.advance(DRIVER_CLOCK_STOPPED_MS - 1);
    assert.equal(h.bot.time.age, 1_000);
    assert.equal(state.over, false);
    await h.clock.settle(failed, 1);
    assert.equal(shots, 0);
    h.server.resume();
  } else {
    const packetMs = 20_000 / rate;
    await h.clock.advance(packetMs - h.clock.now());
    assert.equal(h.bot.time.age, 1_020);
    assert.equal(shots, 0);
    busy = false;
    assert.equal((await h.clock.settle(pending, 50)).status, "succeeded");
    assert.equal(shots, 1);
    await h.clock.advance(packetMs);
  }
  const other = h.entities.spawn({ name: "ender_dragon", position: { x: 0, y: 70, z: 0 } });
  h.combat.hurt(other.id, h.bot.entity.id, 1);
  assert.deepEqual(h.progress, ["hit"]);
  await h.clock.advance(100);
  await h.assertClosed();
});

const dragonConfirmCases = [
  ["shared", runDragon, 20, "survives"], ["shared", runDragon, 10, "survives"],
  ["first-entry", driver.run, 20, "survives"], ["first-entry", driver.run, 10, "survives"],
  ["shared", runDragon, 20, "preempted"], ["shared", runDragon, 20, "dead"],
  ["shared", runDragon, 20, "left"], ["shared", runDragon, 20, "stalled"], ["shared", runDragon, 20, "cancelled"],
  ["shared", runDragon, 20, "unloaded"],
] as const;
isolatedDriverCases("dragon confirmation keeps the live End fighter until the objective is settled", dragonConfirmCases, async ([label, run, rate, exit]) => {
    await using h = await endTrial(rate);
    if (label === "first-entry") for (let i = 0; i < 10; i++) h.spawnTower(i * 5);
    const dragon = h.entities.spawn({ name: "ender_dragon", position: { x: 0, y: 70, z: 0 } });
    let attacks = 0;
    const pending = h.start(run, "perch", (name, input) => {
      if (name === "destroy_end_crystal") {
        h.entities.remove((input as { entity_id: number }).entity_id);
        return endReceipt("crystal_destroyed");
      }
      if (name === "prepare_dragon_perch") return endReceipt("perch_ready");
      if (name !== "attack_dragon_perch") return firstEntrySetup(name);
      assert.equal(++attacks, 1, "the confirmed death must not prompt another dragon attack");
      if (exit === "unloaded") {
        h.entities.remove(dragon.id);
        return { result: endCombatActionResult({ outcome: "stopped", attacks: 0, healthBefore: 200, healthAfter: null, reason: "Dragon left observation" }) };
      }
      h.combat.kill(dragon.id);
      const combat = { outcome: "dragon_died" as const, attacks: 0, healthBefore: 200, healthAfter: 0, reason: null };
      const footing = new BodyAbort({ kind: "preempted", by: "recover_footing" }, "footing");
      return { result: exit === "preempted" ? interruptedEndCombatResult(combat, footing) : endCombatActionResult(combat) };
    });
    const state = watch(pending);
    await h.clock.advance(0);
    assert.equal(attacks, 1);
    assert.equal(state.over, false, "a death witness starts confirmation and cannot complete the run immediately");
    const packetMs = 20_000 / rate;
    if (exit === "survives" || exit === "preempted") {
      if (label === "first-entry") {
        assert.equal(dragon.isValid, true, "death precedes the server removal packet");
        // The shared fake removes the dead entity after the 19-tick animation.
        await h.clock.advance(19_000 / rate + 50);
        assert.equal(dragon.isValid, false);
      }
      const confirmationAge = h.bot.time.age;
      const lowerPacketMs = (confirmationAge + 40 - 1_000) * 1_000 / rate;
      await h.clock.advance(lowerPacketMs - h.clock.now());
      assert.equal(h.bot.time.age, confirmationAge + 40);
      assert.equal(state.over, false, "a cached +40 age may include ticks before death/removal was observed");
      await h.clock.advance(packetMs + 100);
      assert.equal(h.bot.time.age, confirmationAge + 60);
      assert.equal(state.over, true, "the death witness survives the footing handoff without another attack");
      assert.equal((await pending).status, "succeeded");
      assert.equal(attacks, 1);
    } else if (exit === "cancelled" || exit === "unloaded") {
      if (exit === "unloaded") {
        await h.clock.advance(packetMs * 3);
        assert.equal(state.over, false, "unloading a dragon is no death evidence");
      }
      const reason = new Error("cancel dragon confirmation");
      const cancelled = assert.rejects(pending, error => error === reason);
      h.controller.abort(reason);
      await h.clock.settle(cancelled, exit === "unloaded" ? packetMs : 0);
      await h.clock.advance(packetMs);
    } else {
      if (exit === "dead") h.combat.setHealth(0);
      // Mineflayer game.js applies the new dimension from respawn before clients can read it.
      if (exit === "left") h.bot.game.dimension = "overworld";
      if (exit === "stalled") {
        h.server.stop();
        await h.clock.advance(DRIVER_CLOCK_STOPPED_MS - 1);
        assert.equal(state.over, false);
        assert.equal(h.bot.time.age, 1_000);
        await h.clock.advance(1);
        h.server.resume();
      }
      const result = await h.clock.settle(pending, packetMs);
      assert.equal(result.status, "failed");
      assert.match(result.detail!, exit === "dead" ? /died/u : exit === "stalled" ? /stalled/u : /left the End/u);
      await h.clock.advance(exit === "dead" ? NEW_LIFE_SETTLE_MS : packetMs);
    }
    await h.assertClosed();
});

const crystalConfirmationCases = [
  ["absence", 20], ["absence", 10], ["reappears", 20], ["reappears", 10],
  ["stalled", 20], ["dead", 20], ["cancelled", 20], ["outside the End", 20],
] as const;
isolatedDriverCases("crystal objective settles and cleans up once", crystalConfirmationCases, async ([exit, rate]) => {
    await using h = await endTrial(rate, exit === "outside the End" ? "overworld" : "the_end");
    for (let i = 0; i < 10; i++) h.spawnTower(i * 5);
    if (exit === "stalled") h.server.stop();
    const pending = h.start(runDragon, "crystals", (_name, input) => {
      h.entities.remove((input as { entity_id: number }).entity_id);
      return endReceipt("crystal_destroyed");
    });
    const state = watch(pending);
    await h.clock.advance(0);
    const packetMs = 20_000 / rate;
    if (exit === "absence" || exit === "reappears") {
      if (exit === "reappears") {
        await h.clock.advance(packetMs);
        assert.equal(h.bot.time.age, 1_020);
        const crystal = h.spawnTower(0);
        // A packet between clock looks still interrupts the continuous absence.
        h.entities.remove(crystal.id);
        assert.equal(state.over, false);
      }
      const baseAge = exit === "reappears" ? 1_020 : 1_000;
      await h.clock.advance(packetMs * 2);
      assert.equal(h.bot.time.age, baseAge + 40);
      assert.equal(state.over, false, "the last cached age may predate the absence by one packet");
      await h.clock.advance(packetMs + 100);
      assert.equal(h.bot.time.age, baseAge + 60);
      assert.equal(state.over, true, "three time packets confirm at least 40 server ticks without crystals");
      assert.equal((await pending).status, "succeeded");
    } else if (exit === "cancelled") {
      const reason = new Error("cancel crystal observation");
      const cancelled = assert.rejects(pending, error => error === reason);
      h.controller.abort(reason);
      await h.clock.advance(0);
      assert.equal(state.over, true, "cancel releases the absence observation immediately");
      await cancelled;
    } else {
      if (exit === "dead") h.combat.setHealth(0);
      if (exit === "stalled") {
        await h.clock.advance(DRIVER_CLOCK_STOPPED_MS - 1);
        assert.equal(state.over, false);
        assert.equal(h.bot.time.age, 1_000);
      }
      await h.clock.advance(exit === "dead" ? NEW_LIFE_SETTLE_MS : 1);
      assert.equal(state.over, true, "completion requires a living player in the End and a ticking server");
      const result = await pending;
      assert.equal(result.status, "failed");
      assert.match(result.detail!, exit === "dead" ? /died/u : exit === "stalled" ? /stalled/u : /left the End/u);
    }
    await h.assertClosed();
});
