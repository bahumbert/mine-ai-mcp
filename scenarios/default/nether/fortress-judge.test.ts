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

const safeHandoff = { kind: "safe", observedAt: 1, basis: "clear", position: { x: 0, y: 64, z: 0 } } as const;
const unsafeHandoff = { kind: "unsafe", observedAt: 1, reason: "a blaze is in sight", position: { x: 0, y: 64, z: 0 } } as const;
const interruptedHandoff = { kind: "interrupted", reason: "a reflex took the body" } as const;
const refusal = { status: "failed", termination: "shield_required", error: "[HUNT_NO_SHIELD] shield missing", handoff: safeHandoff } as const;
const capabilityRefusal = { status: "partial", termination: "capability_blocked", error: "[HUNT_CAPABILITY_BLOCKED] recovery", handoff: safeHandoff } as const;
/** A hand-back as the driver reports it: the completed run's last request and the return count, then the server's arrival answer. */
const handBackOf = (last: "succeeded" | "failed", returns: number, arrived: boolean) =>
  ({ run: { kind: "completed", last: { result: { status: last } }, returns }, arrived }) as const;
const successfulHandBack = handBackOf("succeeded", 0, true);
const judgeSample = { quotaMet: false, alive: true, hunt: refusal, handBack: successfulHandBack };

for (const testCase of [
  { name: "a completed quota passes on its own", sample: { quotaMet: true, hunt: { status: "succeeded" }, handBack: null }, outcome: "quota" },
  { name: "an unrelated execution error fails", sample: { hunt: { status: "failed", termination: "execution_failed", error: "[EXECUTION_FAILED] unexpected fault" } }, outcome: null },
  { name: "a cancelled hunt cannot earn hand-back", sample: { hunt: { ...refusal, status: "cancelled" } }, outcome: null },
  { name: "a bot death rules out either outcome", sample: { alive: false, quotaMet: true }, outcome: null },
  { name: "a quota verdict records the contradiction when the hunt failed", sample: { quotaMet: true }, outcome: "quota", contradiction: true },
  { name: "a safe refusal with one return and a confirmed arrival hands back", sample: { handBack: handBackOf("succeeded", 1, true) }, outcome: "hand_back" },
  { name: "a second return fails the hand-back", sample: { handBack: handBackOf("succeeded", 2, true) }, outcome: null },
  { name: "a last request that did not succeed fails the hand-back", sample: { handBack: handBackOf("failed", 1, true) }, outcome: null },
  { name: "an unconfirmed arrival fails the hand-back", sample: { handBack: handBackOf("succeeded", 0, false) }, outcome: null },
  { name: "a run that never admitted a navigate fails the hand-back", sample: { handBack: { run: { kind: "not_admitted" }, arrived: false } }, outcome: null },
  { name: "an unsafe handoff earns no hand-back", sample: { hunt: { ...refusal, handoff: unsafeHandoff } }, outcome: null },
  { name: "an interrupted handoff earns no hand-back", sample: { hunt: { ...refusal, handoff: interruptedHandoff } }, outcome: null },
  { name: "a refusal with no handoff earns no hand-back", sample: { hunt: { status: "failed", termination: "shield_required", error: "[HUNT_NO_SHIELD] x" } }, outcome: null },
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

type Route = typeof navigated | typeof stalled | typeof coverRefused | { readonly status: "failed"; readonly error: string };

interface CollectionScene {
  readonly hunt: typeof refusal | typeof capabilityRefusal | (Omit<typeof refusal, "handoff"> & { readonly handoff: unknown });
  /** One reply per navigate the driver may send, in order. */
  readonly routes: readonly Route[];
  readonly arrives: boolean;
  readonly rate: number;
  /** The runner is busy (a reflex holds the body) for this many ticks of world age after the hunt settles. */
  readonly reflexTicks?: number;
  /** The bot loses its health while the arrival is being confirmed. */
  readonly diesInConfirmation?: boolean;
}

/** Keep the real collection driver and fake world, replacing the physical requests and fixture acknowledgements. */
async function collectWithHandBack({ hunt, routes, arrives, rate, reflexTicks = 0, diesInConfirmation = false }: CollectionScene) {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, combat } = createFakeBot({ clock, username: "FortressHunter", dimension: "the_nether", server: { ticksPerSecond: rate },
    position: { x: -27.5, y: 82, z: 355.5 }, slots: { 8: { name: "diamond_boots" } },
    cells: { "-28,81,355": "nether_bricks", "-28,82,357": "spawner" },
    // The arrangement starts with the named cells already loaded in the shared fake world.
    overrides: { waitForChunksToLoad: async () => {} },
  });
  const signal = new AbortController().signal;
  let busyUntilAge = 0;
  /** Whether the signal the confirmation got was aborted by the time the server answered. */
  const confirmationEnds: boolean[] = [];
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
        busyUntilAge = bot.time.age + reflexTicks;
        return { state: "settled", output: { action: COLLECT_MOB_DROP, durationMs: 0, result: hunt } };
      },
    },
    async run(action: { name: string }, input: unknown) {
      calls.push([action.name, input, bot.time.age >= busyUntilAge ? "runner idle" : "runner busy"]);
      const result = routes[calls.filter((call) => Array.isArray(call) && call[0] === "navigate").length - 1];
      assert.ok(result, "an unplanned navigate was started");
      return { action: action.name, durationMs: 400, result };
    },
    navigation: { onEvent: () => () => {} }, async close() {},
    status: () => {
      const busy = bot.time.age < busyUntilAge;
      return { busy, activeAction: busy ? { action: "hostile_reflex", startedAt: "" } : null, owner: busy ? "foreground" : "idle" };
    },
  } as unknown as runtimeModule.Runtime;
  const originalRuntime = { ...runtimeModule };
  const originalFortress = { ...fortress };
  const originalSources = { ...sources };
  const originalReflex = { ...reflex };
  const originalPit = { ...pit };
  mock.module("../../src/runtime.ts", () => ({ ...originalRuntime, openRuntime: async () => runtime, wearArmor: async () => {} }));
  mock.module("./fortress-common.ts", () => ({ ...originalFortress, releaseThreats: async () => {},
    confirmArrival: async (confirmed: MineAiScenarioContext, target: { x: number; y: number; z: number }, radius: number) => {
      calls.push(["arrival", [target.x, target.y, target.z], radius]);
      if (diesInConfirmation) combat.setHealth(0);
      confirmationEnds.push(confirmed.signal.aborted);
      return arrives;
    },
  }));
  mock.module("../../src/source-identity.ts", () => ({ ...originalSources, recordSourceIdentity: async () => {} }));
  mock.module("../../flat/combat/reflex.ts", () => ({ ...originalReflex, readReflexOutcomes: async () => ({ encounters: [], failures: [], limits: [] }) }));
  mock.module("./hazards/pit.ts", () => ({ ...originalPit, observe: async () => {} }));
  try {
    return { completion: await clock.settle(collection.run(context), 120_000), calls, confirmationEnds };
  } finally {
    mock.module("../../src/runtime.ts", () => originalRuntime);
    mock.module("./fortress-common.ts", () => originalFortress);
    mock.module("../../src/source-identity.ts", () => originalSources);
    mock.module("../../flat/combat/reflex.ts", () => originalReflex);
    mock.module("./hazards/pit.ts", () => originalPit);
  }
}

const handBackInput = { x: -28, y: 82, z: 355, range: 1 };
const walk = ["navigate", handBackInput, "runner idle"] as const;
const arrival = ["arrival", collectionTarget, 2] as const;
const retrieved = "retrieved the hunt";

for (const rate of [20, 10]) {
  for (const { name, scene, want, calls: wanted, returns } of [
    { name: "a shield refusal with confirmed arrival", scene: { hunt: refusal, routes: [navigated], arrives: true },
      want: "hand_back", calls: [retrieved, walk, arrival], returns: 0 },
    { name: "a partial capability refusal with confirmed arrival", scene: { hunt: capabilityRefusal, routes: [navigated], arrives: true },
      want: "hand_back", calls: [retrieved, walk, arrival], returns: 0 },
    { name: "a succeeded hand-back without confirmation", scene: { hunt: refusal, routes: [navigated], arrives: false },
      want: null, calls: [retrieved, walk, arrival], returns: 0 },
    { name: "a failed hand-back that is no return", scene: { hunt: refusal, routes: [{ status: "failed", error: "[EXECUTION_FAILED] failed" }], arrives: true },
      want: null, calls: [retrieved, walk], returns: 0 },
    { name: "a reflex holding the body, a refused cover route, then a confirmed arrival", scene: { hunt: refusal, routes: [coverRefused, navigated], arrives: true, reflexTicks: 60 },
      want: "hand_back", calls: [retrieved, walk, walk, arrival], returns: 1 },
    { name: "a stalled return then a confirmed arrival", scene: { hunt: refusal, routes: [stalled, navigated], arrives: true },
      want: "hand_back", calls: [retrieved, walk, walk, arrival], returns: 1 },
    { name: "a second return", scene: { hunt: refusal, routes: [stalled, coverRefused, navigated], arrives: true },
      want: null, calls: [retrieved, walk, walk], returns: 2 },
    { name: "an unsafe handoff, which sends no navigate", scene: { hunt: { ...refusal, handoff: unsafeHandoff }, routes: [], arrives: true },
      want: null, calls: [retrieved], returns: undefined },
    { name: "an interrupted handoff, which sends no navigate", scene: { hunt: { ...refusal, handoff: interruptedHandoff }, routes: [], arrives: true },
      want: null, calls: [retrieved], returns: undefined },
    { name: "a death during the arrival confirmation", scene: { hunt: refusal, routes: [navigated], arrives: true, diesInConfirmation: true },
      want: null, calls: [retrieved, walk, arrival], returns: 0 },
  ] as const) {
    test(`collection judges ${name} at ${rate} tps`, async () => {
      const { completion, calls, confirmationEnds } = await collectWithHandBack({ ...scene, rate });
      if ("diesInConfirmation" in scene) assert.deepEqual(confirmationEnds, [true], "the bot's death did not reach the arrival confirmation");
      assert.equal(completion.status, want === "hand_back" ? "succeeded" : "failed");
      const detail = JSON.parse(completion.detail!);
      assert.equal(detail.outcome, want);
      assert.deepEqual(calls, wanted);
      assert.equal(detail.handBack?.run?.returns, returns);
    });
  }
}

interface RodExitTrial {
  readonly results: readonly { readonly status: string; readonly error?: string }[];
  readonly arrival: boolean;
  readonly death?: boolean;
  readonly status: string;
  readonly count: number;
  /** A reflex holds the body for this many ticks of world age after the hunt (the exit may only start after it). */
  readonly reflexTicks?: number;
}

/** Drive the exit scenario with real bot state and controlled runtime replies. */
async function checkRodExit({ results, arrival, death, status, count, reflexTicks = 0 }: RodExitTrial) {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  // Start near the exit to expose incorrect passes based on the client's position.
  const { bot, combat } = createFakeBot({ clock, dimension: "the_nether", carried: { blaze_rod: 1 } });
  const added = listenersAddedSince(bot);
  const exit = [0.5, 64, 0.5];
  const context = { bot, signal: new AbortController().signal, scenario: { params: { exit } }, log() {}, progress() {} } as unknown as MineAiScenarioContext;
  const inputs: unknown[] = [];
  const busyAtSend: boolean[] = [];
  let confirmations = 0;
  let busyUntilAge = 0;
  const runtime = {
    actions: [{ name: COLLECT_MOB_DROP }, { name: "navigate" }],
    async run(action: { name: string }, input: unknown) {
      if (action.name === COLLECT_MOB_DROP) {
        busyUntilAge = bot.time.age + reflexTicks;
        return { action: action.name, durationMs: 0, result: navigated };
      }
      inputs.push(input);
      busyAtSend.push(bot.time.age < busyUntilAge);
      if (death) combat.setHealth(0);
      const result = results[inputs.length - 1];
      assert.ok(result, "an unplanned navigate was started");
      return { action: action.name, durationMs: 400, result };
    },
    status: () => {
      const busy = bot.time.age < busyUntilAge;
      return { busy, activeAction: busy ? { action: "hostile_reflex", startedAt: "" } : null, owner: busy ? "foreground" : "idle" };
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
    const outcome = await clock.settle(run(context), 120_000);
    assert.equal(outcome.status, status);
    assert.deepEqual(inputs, Array.from({ length: count }, () => ({ x: 0, y: 64, z: 0, range: 1 })),
      death ? "death must prevent the second navigate" : "a live bot must get the expected number of exit requests");
    assert.deepEqual(busyAtSend, inputs.map(() => false), "an exit navigate started while a reflex held the body");
    assert.equal(confirmations, results.at(-1)?.status === "succeeded" ? 1 : 0);
    assert.equal(added("death"), 0);
    // A return keeps the first exit in the detail beside the last one.
    const detail = JSON.parse(outcome.detail!);
    assert.equal(detail.firstExit?.result.status, count > 1 ? results[0]!.status : undefined);
    assert.equal(detail.exit.result.status, results[count - 1]!.status);
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
  { name: "a reflex holding the body delays the exit navigate", trial: { results: [navigated], arrival: true, status: "succeeded", count: 1, reflexTicks: 60 } },
  { name: "a failed exit near the destination fails", trial: { results: [{ status: "failed", error: "[EXECUTION_FAILED] failed" }], arrival: true, status: "failed", count: 1 } },
  { name: "a succeeded exit without server confirmation fails", trial: { results: [navigated], arrival: false, status: "failed", count: 1 } },
  { name: "a second return fails without a third navigate", trial: { results: [stalled, coverRefused], arrival: true, status: "failed", count: 2 } },
]) {
  test(name, () => checkRodExit(trial));
}
