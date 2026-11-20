// Fortress verdicts, world-age progress and the exit request that follows a return.
/// <reference types="bun" />
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { mock } from "bun:test";
import { COLLECT_MOB_DROP, huntTerminationSchema } from "../../../src/actions/hunt-mob/contract.ts";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { COVER_REFUSED_CODE } from "../../../src/survival/state/cover-obligation.ts";
import { STALLED_CODE } from "../../../src/survival/state/request-stall.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "../../../tests/minecraft/drivers/server-ticks.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import * as runtimeModule from "../../src/runtime.ts";
import * as sources from "../../src/source-identity.ts";
import * as reflex from "../../flat/combat/reflex.ts";
import * as fortress from "./fortress-common.ts";
import * as pit from "./hazards/pit.ts";
import { judgeFortressHunt, SAFE_HUNT_REFUSALS } from "./fortress-judge.ts";
import * as collection from "./fortress-twelve-rods.ts";

const refusal = { status: "failed", termination: "shield_required", error: "[HUNT_NO_SHIELD] shield missing" } as const;
const capabilityRefusal = { status: "partial", termination: "capability_blocked", error: "[HUNT_CAPABILITY_BLOCKED] recovery" } as const;
const successfulHandBack = { status: "succeeded", arrived: true } as const;
const judgeSample = { quotaMet: false, alive: true, hunt: refusal, handBack: successfulHandBack };

for (const testCase of [
  { name: "a completed quota passes on its own", sample: { quotaMet: true, hunt: { status: "succeeded" }, handBack: null }, outcome: "quota" },
  { name: "an unrelated execution error fails", sample: { hunt: { status: "failed", termination: "execution_failed", error: "[EXECUTION_FAILED] unexpected fault" } }, outcome: null },
  { name: "a cancelled hunt cannot earn hand-back", sample: { hunt: { ...refusal, status: "cancelled" } }, outcome: null },
  { name: "a bot death rules out either outcome", sample: { alive: false, quotaMet: true }, outcome: null },
  { name: "a quota verdict records the contradiction when the hunt failed", sample: { quotaMet: true }, outcome: "quota", contradiction: true },
] as const) {
  const { name, sample, outcome } = testCase;
  test(name, () => {
    const result = judgeFortressHunt({ ...judgeSample, ...sample });
    assert.equal(result.outcome, outcome);
    if ("contradiction" in testCase) assert.match(result.reason ?? "", /quota.*failed/i);
    else if (outcome === "quota") assert.equal(result.reason, null);
  });
}

test("safe refusals are the hunt contract's shield and capability codes", () => {
  assert.deepEqual(SAFE_HUNT_REFUSALS, new Set([
    huntTerminationSchema.enum.shield_required, huntTerminationSchema.enum.capability_blocked,
  ]));
});

const huntInput = { mob_name: "blaze", drop_name: "blaze_rod", count: 12 };
const sliceTicks = 20;

type Phase = { readonly phase: string; readonly camp?: { readonly phase: string }; readonly suspended?: true };
const collecting: Phase = { phase: "collecting" };
const observing: Phase = { phase: "observing" };

/** A runtime boundary double using the hunt's published checkpoint fields. */
function liveHunt(phase: Phase) {
  return { actionId: "hunt", action: COLLECT_MOB_DROP, request: {
    state: { kind: phase.suspended ? "suspended" : "running" }, evidence: { checkpoint: {
      phase: phase.phase, selectedTargetId: null, attacks: 0, targetDeathsObserved: 0, inventory: 0, gained: 0,
      requested: 12, observationStartedAt: null, observationUntil: null,
      camp: phase.camp ? { ...phase.camp, position: null, dimension: "the_nether", returnAfter: null, observationUntil: null } : null,
    } },
  } };
}

/** Async checkpoints have the request state and hunt evidence published by the foreground runtime. */
function huntRuntime(phases: readonly (Phase | null)[], f: ReturnType<typeof createFakeBot>) {
  const samples: number[] = [];
  const cancelled: string[] = [];
  const output = { action: COLLECT_MOB_DROP, durationMs: 0, result: refusal };
  const runtime = {
    actions: [{ name: COLLECT_MOB_DROP }],
    asyncActions: {
      submit(action: { name: string }, input: unknown) {
        assert.equal(action.name, COLLECT_MOB_DROP);
        assert.deepEqual(input, huntInput);
        return { state: "accepted", actionId: "hunt", action: action.name, admittedAt: "" };
      },
      async wait(id: string) {
        const checkpoint = phases[samples.length];
        samples.push(f.bot.time.age);
        if (!checkpoint) return { state: "settled", wakeReason: "settled", actionId: id, output };
        return { state: "pending", wakeReason: "timeout", actionId: id, progress: liveHunt(checkpoint) };
      },
      status() {
        const phase = phases[samples.length - 1];
        return { active: phase ? liveHunt(phase) : null, awaitingResult: null };
      },
      cancel(id: string) { cancelled.push(id); },
    },
  } as unknown as runtimeModule.Runtime;
  return { runtime, samples, cancelled, output };
}

for (const rate of [20, 10]) {
  test(`delayed hunt observation credits two windows and ignores travel and guard at ${rate} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const f = createFakeBot({ clock, server: { ticksPerSecond: rate } });
    const { runtime, samples, output, cancelled } = huntRuntime([
      collecting, collecting, collecting, { ...observing, suspended: true }, observing,
      { ...observing, camp: { phase: "waiting_away" } },
      { ...observing, camp: { phase: "returning" } }, collecting,
      { ...observing, camp: { phase: "waiting_at_spawner" } },
      { ...observing, camp: { phase: "waiting_at_spawner" } }, collecting,
    ], f);
    const signal = new AbortController().signal;
    const declarations: [string, number][] = [];
    const startAge = f.bot.time.age;
    using progress = collection.declareFortressProgress(runtime.asyncActions, f.bot,
      (reason) => declarations.push([reason, f.bot.time.age - startAge]), signal);
    const pending = collection.runFortressHunt(runtime, f.bot, huntInput, progress, signal);
    assert.deepEqual(await clock.settle(pending, 12 * sliceTicks * 1_000 / rate), output);
    assert.deepEqual(samples.map((age) => age - startAge), Array.from({ length: 12 }, (_, index) => index * sliceTicks));
    assert.deepEqual(declarations, [["observing", 100], ["observing", 120], ["observing", 180], ["observing", 200]]);
    assert.deepEqual(cancelled, []);
  });

  test(`a phase exit before a world-age packet earns no observation at ${rate} tps`, async () => {
    const packetMs = sliceTicks * 1_000 / rate;
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const f = createFakeBot({ clock, server: { ticksPerSecond: rate } });
    const campWaiting = { ...observing, camp: { phase: "waiting_away" } };
    const phases: (Phase | null)[] = [campWaiting, campWaiting, observing, null];
    const { runtime, output, samples } = huntRuntime(phases, f);
    const signal = new AbortController().signal;
    const declarations: string[] = [];
    using progress = collection.declareFortressProgress(runtime.asyncActions, f.bot, (reason) => declarations.push(reason), signal);
    const pending = collection.runFortressHunt(runtime, f.bot, huntInput, progress, signal);
    const startAge = f.bot.time.age;
    await clock.advance(packetMs - 1);
    phases[0] = { ...observing, camp: { phase: "returning" } };
    await clock.advance(packetMs);
    phases[1] = { ...observing, suspended: true };
    await clock.advance(packetMs);
    phases[2] = null;
    assert.deepEqual(await clock.settle(pending, packetMs), output);
    assert.deepEqual(samples.map((age) => age - startAge), [0, 20, 40, 60]);
    assert.deepEqual(declarations, [], "return travel, a reflex, and settlement must each suppress stale observation credit");
  });
}

for (const end of ["abort", "death", "stopped"] as const) {
  test(`${end} closes the hunt's observation and cancels its unsettled request`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const f = createFakeBot({ clock });
    const controller = new AbortController();
    const added = listenersAddedSince(f.bot);
    const { runtime, cancelled } = huntRuntime([observing, observing, observing], f);
    const declarations: string[] = [];
    using progress = collection.declareFortressProgress(runtime.asyncActions, f.bot, (reason) => declarations.push(reason), controller.signal);
    const pending = collection.runFortressHunt(runtime, f.bot, huntInput, progress, controller.signal);
    const rejection = assert.rejects(pending, end === "stopped" ? /world age stopped/ : end === "death" ? /died/ : /trial aborted/);
    await clock.advance(1_000);
    assert.deepEqual(declarations, ["observing"]);
    if (end === "abort") controller.abort(new Error("trial aborted"));
    if (end === "death") f.combat.setHealth(0);
    if (end === "stopped") f.server.stop();
    await clock.settle(rejection, DRIVER_CLOCK_STOPPED_MS + 100);
    assert.equal(added("time"), 0);
    progress[Symbol.dispose]();
    assert.equal(added("death"), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.deepEqual(cancelled, ["hunt"]);
    f.server.resume();
    await clock.advance(2_000);
    assert.deepEqual(declarations, ["observing"]);
    assert.equal(clock.pendingGlobalTimers(), 0);
  });
}

const navigated = { status: "succeeded" } as const;
const stalled = { status: "cancelled", error: `${STALLED_CODE} interrupted` } as const;
const coverRefused = { status: "failed", error: `${COVER_REFUSED_CODE} route refused` } as const;

const collectionTarget = [-27.5, 82, 355.5] as const;

/** Keep the real collection driver and fake world, replacing the physical requests and fixture acknowledgements. */
async function collectWithHandBack(hunt: typeof refusal | typeof capabilityRefusal, route: typeof navigated | typeof coverRefused, arrives: boolean) {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot } = createFakeBot({ clock, username: "FortressHunter", dimension: "the_nether",
    position: { x: -27.5, y: 82, z: 355.5 }, slots: { 8: { name: "diamond_boots" } },
    cells: { "-28,81,355": "nether_bricks", "-28,82,357": "spawner" },
    // The arrangement starts with the named cells already loaded in the shared fake world.
    overrides: { waitForChunksToLoad: async () => {} },
  });
  const signal = new AbortController().signal;
  const context = { bot, signal, scenario: { params: { handBack: collectionTarget },
    players: [{ name: bot.username, pos: collectionTarget }], entities: [] }, log() {}, progress() {},
  } as unknown as MineAiScenarioContext;
  const calls: unknown[] = [];
  const runtime = {
    actions: [{ name: COLLECT_MOB_DROP }, { name: "navigate" }],
    asyncActions: {
      submit: () => ({ state: "accepted", actionId: "collect" }),
      async wait() {
        calls.push("retrieved the hunt");
        return { state: "settled", output: { action: COLLECT_MOB_DROP, durationMs: 0, result: hunt } };
      },
    },
    async run(action: { name: string }, input: unknown) {
      calls.push([action.name, input]);
      return { action: action.name, durationMs: 0, result: route };
    },
    navigation: { onEvent: () => () => {} }, status: () => ({}), async close() {},
  } as unknown as runtimeModule.Runtime;
  const originalRuntime = { ...runtimeModule };
  const originalFortress = { ...fortress };
  const originalSources = { ...sources };
  const originalReflex = { ...reflex };
  const originalPit = { ...pit };
  mock.module("../../src/runtime.ts", () => ({ ...originalRuntime, openRuntime: async () => runtime, wearArmor: async () => {} }));
  mock.module("./fortress-common.ts", () => ({ ...originalFortress, releaseThreats: async () => {},
    confirmArrival: async (_context: MineAiScenarioContext, target: { x: number; y: number; z: number }, radius: number) => {
      calls.push(["arrival", [target.x, target.y, target.z], radius]);
      return arrives;
    },
  }));
  mock.module("../../src/source-identity.ts", () => ({ ...originalSources, recordSourceIdentity: async () => {} }));
  mock.module("../../flat/combat/reflex.ts", () => ({ ...originalReflex, readReflexOutcomes: async () => ({ encounters: [], failures: [], limits: [] }) }));
  mock.module("./hazards/pit.ts", () => ({ ...originalPit, observe: async () => {} }));
  try {
    return { completion: await clock.settle(collection.run(context), 1_000), calls };
  } finally {
    mock.module("../../src/runtime.ts", () => originalRuntime);
    mock.module("./fortress-common.ts", () => originalFortress);
    mock.module("../../src/source-identity.ts", () => originalSources);
    mock.module("../../flat/combat/reflex.ts", () => originalReflex);
    mock.module("./hazards/pit.ts", () => originalPit);
  }
}

for (const { name, hunt, route, arrives, want } of [
  { name: "a shield refusal with confirmed arrival", hunt: refusal, route: navigated, arrives: true, want: "hand_back" },
  { name: "a partial capability refusal with confirmed arrival", hunt: capabilityRefusal, route: navigated, arrives: true, want: "hand_back" },
  { name: "a succeeded hand-back without confirmation", hunt: refusal, route: navigated, arrives: false, want: null },
  { name: "a failed hand-back at the destination", hunt: refusal, route: coverRefused, arrives: true, want: null },
]) {
  test(`collection judges ${name}`, async () => {
    const { completion, calls } = await collectWithHandBack(hunt, route, arrives);
    assert.equal(completion.status, want === "hand_back" ? "succeeded" : "failed");
    assert.equal(JSON.parse(completion.detail!).outcome, want);
    assert.deepEqual(calls, ["retrieved the hunt", ["navigate", { x: -28, y: 82, z: 355, range: 1 }],
      ...(route.status === "succeeded" ? [["arrival", collectionTarget, 2]] : [])]);
  });
}

interface RodExitTrial {
  readonly results: readonly { readonly status: string; readonly error?: string }[];
  readonly arrival: boolean;
  readonly death?: boolean;
  readonly status: string;
  readonly count: number;
}

/** Drive the exit scenario with real bot state and controlled runtime replies. */
async function checkRodExit({ results, arrival, death, status, count }: RodExitTrial) {
  // Start near the exit to expose incorrect passes based on the client's position.
  const { bot, combat } = createFakeBot({ dimension: "the_nether", carried: { blaze_rod: 1 } });
  const added = listenersAddedSince(bot);
  const exit = [0.5, 64, 0.5];
  const context = { bot, signal: new AbortController().signal, scenario: { params: { exit } }, log() {}, progress() {} } as unknown as MineAiScenarioContext;
  const inputs: unknown[] = [];
  let confirmations = 0;
  const runtime = {
    actions: [{ name: COLLECT_MOB_DROP }, { name: "navigate" }],
    async run(action: { name: string }, input: unknown) {
      if (action.name === COLLECT_MOB_DROP) return { action: action.name, durationMs: 0, result: navigated };
      inputs.push(input);
      if (death) combat.setHealth(0);
      const result = results[inputs.length - 1];
      assert.ok(result, "an unplanned navigate was started");
      return { action: action.name, durationMs: 0, result };
    },
    async close() {},
  } as unknown as runtimeModule.Runtime;
  const originalRuntime = { ...runtimeModule };
  const originalFortress = { ...fortress };
  mock.module("../../src/runtime.ts", () => ({ ...originalRuntime, openRuntime: async () => runtime }));
  mock.module("./fortress-common.ts", () => ({ ...originalFortress,
    prepareFortress: async () => {}, releaseThreats: async () => {},
    confirmArrival: async (_context: MineAiScenarioContext, target: { x: number; y: number; z: number }, radius: number) => {
      confirmations++;
      assert.deepEqual([target.x, target.y, target.z], exit);
      assert.equal(radius, 2);
      return arrival;
    },
  }));
  try {
    const { run } = await import("./fortress-rod-and-exit.ts");
    assert.equal((await run(context)).status, status);
    assert.deepEqual(inputs, Array.from({ length: count }, () => ({ x: 0, y: 64, z: 0, range: 1 })),
      death ? "death must prevent the second navigate" : "a live bot must get the expected number of exit requests");
    assert.equal(confirmations, results.at(-1)?.status === "succeeded" ? 1 : 0);
    assert.equal(added("death"), 0);
  } finally {
    mock.module("../../src/runtime.ts", () => originalRuntime);
    mock.module("./fortress-common.ts", () => originalFortress);
  }
}

test("one stalled exit returns to the same target only if the bot is alive", async () => {
  await checkRodExit({ results: [stalled, navigated], arrival: true, status: "succeeded", count: 2 });
  await checkRodExit({ results: [stalled], arrival: true, death: true, status: "failed", count: 1 });
});

for (const { name, trial } of [
  { name: "a refused cover route navigates again", trial: { results: [coverRefused, navigated], arrival: true, status: "succeeded", count: 2 } },
  { name: "a failed exit near the destination fails", trial: { results: [{ status: "failed", error: "[EXECUTION_FAILED] failed" }], arrival: true, status: "failed", count: 1 } },
  { name: "a succeeded exit without server confirmation fails", trial: { results: [navigated], arrival: false, status: "failed", count: 1 } },
  { name: "a second return fails without a third navigate", trial: { results: [stalled, coverRefused], arrival: true, status: "failed", count: 2 } },
]) {
  test(name, () => checkRodExit(trial));
}
