/** First-entry waits preserve server time, cancellation and cleanup at both game rates. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtempDisposable } from "node:fs/promises";
import test from "node:test";
import { z } from "zod";
import { defineAction } from "../../src/actions/action.ts";
import { createFakeBot, createFakeClock, listenersAddedSince, NEW_LIFE_SETTLE_MS } from "../../src/test-support/fake-bot/index.ts";
import { watch } from "../../src/test-support/pending.ts";
import { ServerPacedExpired } from "../../src/world/server-paced.ts";
import * as driver from "./dragon-first-entry.ts";
import type { Runtime } from "./runtime.ts";

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
function trial(rate = 20, timePacketYet = true) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, server: { startAge: 1_000, ticksPerSecond: rate, timePacketYet } });
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
for (const { mode, rate } of driverCases) {
  const name = `driver admission ${mode} at ${rate} tps preserves budgets and cleanup`;
  test(name, async () => {
  if (process.env.FIRST_ENTRY_CANCEL_CHILD !== "1") {
    // A child keeps Bun's module replacements out of other scenario tests.
    const result = spawnSync(process.execPath, ["test", "--timeout", "30000", import.meta.filename,
      "--test-name-pattern", `^${name}$`], {
      encoding: "utf8", env: { ...process.env, FIRST_ENTRY_CANCEL_CHILD: "1" },
      timeout: 30_000, // limit: isolated cancellation child measured 0.82–0.87 s, n=3; Bun's standard hang bound.
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return;
  }
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
}
