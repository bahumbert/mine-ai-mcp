// The full-night driver: server-tick nightfall, a request held through dawn, a declared night watch and its verdict (plan 2026-11-18-scenario-reds-part2-a3 T13e).
/// <reference types="bun" />
import assert from "node:assert/strict";
import test from "node:test";
import { COLLECT_MOB_DROP } from "../../../src/actions/hunt-mob/contract.ts";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "../../../tests/minecraft/drivers/server-ticks.ts";
import { awaitNightfall, judgeNight, watchNight, type NightSample } from "./full-night-request.ts";

const NIGHT_TICKS = 11_000;
const request = { mob_name: "cow", drop_name: "leather", count: 1, observe_for_ms: 550_000 };
const safeHandoff = { kind: "safe", observedAt: 0, basis: "clear", position: { x: 0.5, y: -59, z: 0.5 } } as const;

// A hunt with no cows ends `failed`, or `partial` after progress, with `observation_exhausted` (hunt-mob.ts `stoppedResult`).
const passing: NightSample = {
  died: false, handoffs: 1, dawnTicks: NIGHT_TICKS, settledTicks: NIGHT_TICKS + 40, worldTicks: NIGHT_TICKS + 40,
  settled: { status: "failed", termination: "observation_exhausted", handoffKind: "safe" },
};

/** The assertions the driver made before D34: one return, not cancelled, a native clock past 10,800 ticks that read dawn. */
function oldJudge({ died, handoffs, settled, worldTicks }: NightSample): boolean {
  return !died && handoffs === 1 && settled?.status !== "cancelled" && worldTicks >= 10_800;
}

test("a collection that returned at half the night passed the old judge and fails the new one", () => {
  const halfNight: NightSample = { ...passing, dawnTicks: NIGHT_TICKS, settledTicks: NIGHT_TICKS / 2, worldTicks: NIGHT_TICKS };
  assert.equal(oldJudge(halfNight), true, "the red: the old driver counted returns only");
  assert.match(judgeNight(halfNight) ?? "", /returned before dawn/);
  assert.equal(oldJudge(passing), true);
  assert.equal(judgeNight(passing), null);
});

for (const { name, sample, failure } of [
  { name: "a collection settling after dawn", sample: passing, failure: null },
  { name: "a collection settling on the dawn packet", sample: { ...passing, settledTicks: NIGHT_TICKS }, failure: null },
  { name: "a collection that returned at the old 10 tps budget, before dawn was seen", sample: { ...passing, dawnTicks: null, settledTicks: 5_500, worldTicks: 5_500 }, failure: /returned before dawn/ },
  { name: "a collection one packet before dawn", sample: { ...passing, settledTicks: NIGHT_TICKS - 20 }, failure: /returned before dawn/ },
  { name: "a night whose dawn was never seen", sample: { ...passing, dawnTicks: null }, failure: /dawn was never observed/i },
  { name: "a death", sample: { ...passing, died: true }, failure: /died/ },
  { name: "two handoffs", sample: { ...passing, handoffs: 2 }, failure: /exactly one/i },
  { name: "no handoff", sample: { ...passing, handoffs: 0 }, failure: /exactly one/i },
  { name: "a cancelled request", sample: { ...passing, settled: { ...passing.settled!, status: "cancelled", termination: undefined } }, failure: /observation_exhausted/ },
  { name: "another termination", sample: { ...passing, settled: { ...passing.settled!, termination: "no_loaded_targets" } }, failure: /observation_exhausted/ },
  { name: "an unreadable result", sample: { ...passing, settled: null }, failure: /could not read/ },
  { name: "an unsafe handoff", sample: { ...passing, settled: { ...passing.settled!, handoffKind: "unsafe" } }, failure: /safe handoff/ },
  { name: "a night one tick short of the bound", sample: { ...passing, worldTicks: 10_799 }, failure: /10,800/ },
  { name: "a night exactly at the bound", sample: { ...passing, worldTicks: 10_800 }, failure: null },
] satisfies { name: string; sample: NightSample; failure: RegExp | null }[]) {
  test(`judgeNight: ${name}`, () => {
    const verdict = judgeNight(sample);
    if (failure === null) assert.equal(verdict, null);
    else assert.match(verdict ?? "", failure);
  });
}

type Phase = "collecting" | "observing";
type Owner = "idle" | "foreground" | "yielding" | "takeover";

/** The runtime boundary the night watch reads: the async request's checkpoint and the body owner. */
function nightRuntime(bot: { time: { age: number } }, state: { phase: Phase; owner: Owner; settleAt: number }, startAge: number) {
  const calls: string[] = [];
  const cancelled: string[] = [];
  const settled = () => bot.time.age - startAge >= state.settleAt;
  const live = () => ({ actionId: "night", action: COLLECT_MOB_DROP, request: {
    state: { kind: "running" }, evidence: { checkpoint: {
      phase: state.phase, selectedTargetId: null, attacks: 0, targetDeathsObserved: 0, inventory: 0, gained: 0,
      requested: 1, observationStartedAt: null, observationUntil: null, camp: null,
    } },
  } });
  const output = { action: COLLECT_MOB_DROP, durationMs: 0, result: { status: "failed", termination: "observation_exhausted", handoff: safeHandoff } };
  const asyncActions = {
    submit(action: { name: string }, input: unknown) {
      assert.equal(action.name, COLLECT_MOB_DROP);
      assert.deepEqual(input, request);
      calls.push("submit");
      return { state: "accepted", actionId: "night", action: action.name, admittedAt: "" };
    },
    async wait(id: string) {
      if (settled()) return { state: "settled", wakeReason: "settled", actionId: id, output };
      return { state: "pending", wakeReason: "timeout", actionId: id, progress: live() };
    },
    status: () => ({ active: settled() ? null : live(), awaitingResult: null }),
    cancel(id: string) { cancelled.push(id); },
  };
  const runtime = {
    actions: [{ name: COLLECT_MOB_DROP }],
    asyncActions,
    status: () => ({ busy: state.owner !== "idle", owner: state.owner, foreground: asyncActions.status() }),
  } as unknown as Parameters<typeof watchNight>[0]["runtime"];
  return { runtime, calls, cancelled };
}

/** A fake world whose dawn comes `nightTicks` after the start, as `watchNight` sees a night. */
function nightWorld(rate: number, nightTicks: number) {
  const clock = createFakeClock({ mode: "mocked" });
  const f = createFakeBot({ clock, server: { ticksPerSecond: rate, timeOfDay: 24_000 - nightTicks } });
  return { ...f, startAge: f.bot.time.age };
}

async function watch(world: ReturnType<typeof nightWorld>, state: { phase: Phase; owner: Owner; settleAt: number }, signal = new AbortController().signal) {
  const { bot, startAge } = world;
  const { runtime, calls, cancelled } = nightRuntime(bot, state, startAge);
  const declarations: [string, number][] = [];
  const logs: string[] = [];
  const pending = watchNight({
    runtime, bot, request,
    context: { signal, log: (line: string) => logs.push(line), progress: (reason: string) => declarations.push([reason, bot.time.age - startAge]) },
    release: () => calls.push(`release at +${bot.time.age - startAge}`),
  });
  return { pending, calls, cancelled, declarations, logs };
}

type World = ReturnType<typeof nightWorld>;
interface ExitRun { world: World; pending: Promise<NightSample>; controller: AbortController }

for (const rate of [20, 10]) {
  const packetMs = 20_000 / rate;
  const nightMs = (ticks: number) => ticks * packetMs / 20 + 5_000;

  test(`a full night's collection that settles after dawn passes at ${rate} tps`, async () => {
    const world = nightWorld(rate, NIGHT_TICKS);
    using _clock = world.clock.install();
    const { pending, calls } = await watch(world, { phase: "observing", owner: "idle", settleAt: NIGHT_TICKS + 40 });
    const sample = await world.clock.settle(pending, nightMs(NIGHT_TICKS + 200), 1_000);
    assert.equal(sample.dawnTicks, NIGHT_TICKS);
    assert.equal(sample.settledTicks, NIGHT_TICKS + 40);
    assert.equal(sample.handoffs, 1);
    assert.equal(judgeNight(sample), null);
    assert.deepEqual(calls.slice(0, 2), ["submit", "release at +0"], "the request is armed before the ring's release");
  });

  for (const { name, nightTicks, settleAt } of [
    { name: "at half the night (the old 10 tps budget)", nightTicks: NIGHT_TICKS, settleAt: NIGHT_TICKS / 2 },
    { name: "one packet before dawn", nightTicks: 200, settleAt: 180 },
  ]) {
    test(`a collection that settles ${name} is read as returned before dawn at ${rate} tps`, async () => {
      const world = nightWorld(rate, nightTicks);
      using _clock = world.clock.install();
      const { pending } = await watch(world, { phase: "observing", owner: "idle", settleAt });
      const sample = await world.clock.settle(pending, nightMs(nightTicks + 200), 1_000);
      // The look that sees the settlement may also hear the next packet (dawn): the verdict is the same either way.
      assert.equal(sample.settledTicks, settleAt);
      assert.match(judgeNight(sample) ?? "", /returned before dawn/);
    });
  }

  // The watch's progress. Dawn is 100 ticks after the start: declarations come each 20 ticks of age.
  for (const { name, state, expected } of [
    { name: "a hunt in its observing phase", state: { phase: "observing", owner: "idle" }, expected: [20, 40, 60, 80] },
    { name: "a reflex that owns the body while the request is pending", state: { phase: "collecting", owner: "takeover" }, expected: [20, 40, 60, 80] },
    { name: "a reflex yielding the body to the request's takeover", state: { phase: "collecting", owner: "yielding" }, expected: [20, 40, 60, 80] },
    { name: "a pending request in another phase with the body idle (the nonproductive stall)", state: { phase: "collecting", owner: "idle" }, expected: [] },
    { name: "the foreground request owning the body in another phase", state: { phase: "collecting", owner: "foreground" }, expected: [] },
  ] as const) {
    test(`${name} declares progress each 20 ticks, none at or after dawn, at ${rate} tps`, async () => {
      const world = nightWorld(rate, 100);
      using _clock = world.clock.install();
      const { pending, declarations } = await watch(world, { ...state, settleAt: 300 });
      const sample = await world.clock.settle(pending, nightMs(400), 1_000);
      assert.equal(sample.dawnTicks, 100);
      assert.deepEqual(declarations.filter(([reason]) => reason === "observing").map(([, age]) => age), expected);
      await world.clock.advance(5_000);
      assert.equal(declarations.length, declarations.filter(([, age]) => age <= 100).length, "nothing is declared after the watch ends");
    });
  }

  // Every way the watch ends (T6, T13): it settles once, leaves no listener or timer, declares nothing afterwards and
  // cancels a request that had not settled.
  for (const exit of [
    {
      name: "a settlement", nightTicks: NIGHT_TICKS, cancelled: [] as string[],
      state: { phase: "observing", owner: "takeover", settleAt: 60 } as const,
      async end({ world, pending }: ExitRun) {
        const sample = await world.clock.settle(pending, nightMs(200), 1_000);
        assert.equal(sample.settledTicks, 60);
      },
    },
    {
      name: "a death", nightTicks: NIGHT_TICKS, cancelled: ["night"],
      state: { phase: "observing", owner: "idle", settleAt: NIGHT_TICKS + 40 } as const,
      async end({ world, pending }: ExitRun) {
        await world.clock.advance(3_000);
        world.combat.setHealth(0);
        const sample = await world.clock.settle(pending, 2 * packetMs + 5_000, 1_000);
        assert.equal(sample.died, true);
        assert.match(judgeNight(sample) ?? "", /died/);
      },
    },
    ...(["before dawn", "after dawn"] as const).map((stoppedAt) => ({
      name: `a stopped clock ${stoppedAt}`, nightTicks: 100, cancelled: ["night"],
      state: { phase: "observing", owner: "idle", settleAt: 10_000 } as const,
      async end({ world, pending }: ExitRun) {
        const rejection = assert.rejects(pending, /stood still/);
        if (stoppedAt === "after dawn") await world.clock.advance(100 * packetMs / 20 + 2 * packetMs);
        world.server.stop();
        await world.clock.settle(rejection, DRIVER_CLOCK_STOPPED_MS + 2 * packetMs + 1_000, 1_000);
      },
    })),
    {
      name: "an abort", nightTicks: NIGHT_TICKS, cancelled: ["night"],
      state: { phase: "observing", owner: "idle", settleAt: NIGHT_TICKS + 40 } as const,
      async end({ world, pending, controller }: ExitRun) {
        const rejection = assert.rejects(pending, /trial aborted/);
        await world.clock.advance(3_000);
        controller.abort(new Error("trial aborted"));
        await world.clock.settle(rejection, 5_000, 500);
      },
    },
  ]) {
    test(`${exit.name} leaves no listener, timer or declaration and cancels what is unsettled at ${rate} tps`, async () => {
      const world = nightWorld(rate, exit.nightTicks);
      using _clock = world.clock.install();
      const added = listenersAddedSince(world.bot);
      const addedClient = listenersAddedSince(world.bot._client);
      const controller = new AbortController();
      const { pending, declarations, cancelled } = await watch(world, { ...exit.state }, controller.signal);
      await exit.end({ world, pending, controller });
      assert.deepEqual(cancelled, exit.cancelled);
      const count = declarations.length;
      await world.clock.advance(DRIVER_CLOCK_STOPPED_MS + 10_000);
      assert.equal(declarations.length, count, "nothing is declared after the watch ended");
      for (const event of ["time", "death", "health"]) assert.equal(added(event), 0, event);
      assert.equal(addedClient("damage_event"), 0);
      assert.equal(world.clock.pendingGlobalTimers(), 0);
    });
  }

  test(`awaitNightfall waits for a time packet newer than the command with the dusk time at ${rate} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot, server } = createFakeBot({ clock, server: { ticksPerSecond: rate, timeOfDay: 18_000 } });
    let sent = 0;
    const pending = awaitNightfall(bot, () => { sent++; server.setDayTime(13_000); server.resendTime(); }, new AbortController().signal);
    await clock.settle(pending, 20_000, 500);
    assert.equal(sent, 1);
  });

  // The dusk window is [13000, 13100) of day time (T10): the command's own packet at its edges, with nothing else in it.
  for (const { dayTime, seen } of [
    { dayTime: 13_000, seen: true }, { dayTime: 13_099, seen: true }, { dayTime: 13_100, seen: false },
  ]) {
    test(`awaitNightfall ${seen ? "sees" : "never sees"} a command packet at day time ${dayTime} at ${rate} tps`, async () => {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const { bot, server } = createFakeBot({ clock, server: { ticksPerSecond: rate, timeOfDay: 18_000 } });
      await clock.advance(600); // a few ticks past the last regular packet: the command's packet carries a newer age
      const outcome = awaitNightfall(bot, () => { server.setDayTime(dayTime); server.resendTime(); }, new AbortController().signal);
      if (seen) await clock.settle(outcome, 60_000, 500);
      else await clock.settle(assert.rejects(outcome, /Did not observe nightfall/), 60_000, 500);
    });
  }

  test(`awaitNightfall fails after 400 server ticks when the time never reaches dusk at ${rate} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot } = createFakeBot({ clock, server: { ticksPerSecond: rate, timeOfDay: 18_000 } });
    const startAge = bot.time.age;
    const rejection = assert.rejects(awaitNightfall(bot, () => {}, new AbortController().signal), /Did not observe nightfall within 400 server ticks/);
    await clock.settle(rejection, 60_000, 500);
    assert.ok(bot.time.age - startAge >= 400, `waited ${bot.time.age - startAge} server ticks`);
  });
}

test("awaitNightfall fails as stalled when the server clock stops", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, server } = createFakeBot({ clock, server: { timeOfDay: 18_000 } });
  server.stop();
  const rejection = assert.rejects(awaitNightfall(bot, () => {}, new AbortController().signal), /stood still/);
  await clock.settle(rejection, DRIVER_CLOCK_STOPPED_MS + 5_000, 1_000);
});
