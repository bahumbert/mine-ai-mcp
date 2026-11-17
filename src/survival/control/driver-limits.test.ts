// The limits a reflex claim is held to: no progress, a ceiling, a stand-down after either, and the seated tick.
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { actionResultSchema, defineAction } from "../../actions/index.js";
import { BodyAbort } from "../../session/abort.js";
import { forgetVehicle } from "../../actions/navigate/vehicle-sync.js";
import { ActionRunner } from "../../session/action-runner.js";
import { type FakeBotOptions, type FakeClock, createFakeBot, createFakeClock, flush, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import type { ReflexDefinition, ReflexLimits, SurvivalTransition } from "./contract.js";
import { ReflexDriver, type ReflexDriverOptions } from "./driver.js";

const LIMITS: ReflexLimits = { ceilingTicks: 12_000, noProgressTicks: 20, standDownTicks: 60 };

/**
 * A driver on the bot's clock: `pass(ms)` moves time in 50 ms ticks with a physics tick at each, as a healthy server
 * would. A boat (#7) floats beside the bot; `clock` is a mocked one for a test of the driver's own interval, and
 * `driverOptions: {}` builds the driver as production does, on the global monotonic clock that mocked clock drives.
 */
function scene(limits: ReflexLimits = LIMITS, clock?: FakeClock, driverOptions?: ReflexDriverOptions, server?: FakeBotOptions["server"]) {
  const { bot, combat, clock: time } = createFakeBot({ clock, server, entities: { 7: { name: "oak_boat", position: { x: 1.5, y: 64, z: 0.5 } } } });
  const runner = new ActionRunner({ clock: time, cancelGraceMs: 500 });
  const driver = new ReflexDriver(bot, runner, driverOptions ?? { now: time.now });
  const events: SurvivalTransition[] = [];
  driver.onTransition((event) => events.push(event));
  const counts = { claims: 0, aborted: 0 };
  /** Responds to fire for good; the work stops on its abort unless `deaf`. */
  const definition = (deaf = false): ReflexDefinition<true, true, string> => ({
    name: "fire_reflex",
    sense: () => ({ kind: "observed", danger: true, evidence: { burning: true } }),
    decide: () => ({ kind: "respond", response: true, name: "escape", reason: "Burning." }),
    // The facts change at every read: only the time can keep this scope answered.
    facts: () => {
      let reads = 0;
      return { capability: "fire", response: "escape", scope: "cell:A", facts: () => ++reads, permissions: () => null };
    },
    limits: () => limits,
    act: (_response, signal) => {
      counts.claims++;
      if (deaf) return new Promise<string>(() => {});
      return new Promise<string>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            counts.aborted++;
            resolve("stopped");
          },
          { once: true },
        ),
      );
    },
    continuation: () => ({ kind: "resume" }),
    failure: () => null,
    describe: (outcome) => outcome,
  });
  const pass = (ms: number) => time.advance(ms);
  return { bot, combat, time, runner, driver, events, counts, definition, pass };
}

const outcomes = (events: SurvivalTransition[]) =>
  events.filter((event) => event.kind === "outcome").map((event) => event.evidence as { outcome: Record<string, unknown>; cancelled: boolean });

// A claim with no progress is released at its limit, stands down whatever the facts, and claims again after. The 1 s window is
// 20 ticks and one packet (plan 2026-11-16-reflex-limits-ticks T2/T3): the claim starts ~50 ms in at the cached age A; the window
// ends at the packet of age A + 40 (the limit's read age: 2 s in at 20 tps, 4 s at 10; the old wall window ended it 1 s in), the
// 3 s stand-down (60 ticks) at the packet of age A + 120: 6 s in at 20 tps, 12 s in at 10 tps (old code: ~3 s after the limit).
const START_AGE = 1_000;
const RATES = [
  { ticksPerSecond: 20, msPerTick: 50 },
  { ticksPerSecond: 10, msPerTick: 100 },
] as const;
for (const { ticksPerSecond, msPerTick } of RATES)
  test(`a claim with no progress is released at the packet of age A + 40 and stands down until A + 120, whatever the facts (${ticksPerSecond} tps)`, async () => {
    const { bot, time, runner, driver, events, counts, definition, pass } = scene(LIMITS, undefined, undefined, { startAge: START_AGE, ticksPerSecond });
    driver.register(definition());
    try {
      await pass(100);
      assert.equal(counts.claims, 1);
      await pass(20 * msPerTick + 50 - time.now());
      assert.equal(bot.time.age, START_AGE + 20, "20 of the 40 ticks");
      assert.equal(counts.aborted, 0, "the old wall window of 1 s would have ended it long ago");
      await pass(40 * msPerTick + 300 - time.now());
      assert.equal(bot.time.age, START_AGE + 40);
      assert.equal(counts.aborted, 1, "the work was told to stop at the first check after the packet of age A + 40");
      assert.equal(runner.status().owner, "idle");
      assert.equal(driver.answered.snapshot()[0]?.failure.kind, "reflex_limit");
      assert.equal(driver.answered.snapshot()[0]?.temporal?.premise, "reflex_limit");
      await pass(500);
      assert.equal(counts.claims, 1, "a limit is not a cancel: the facts change at every read, still no claim on the next ticks");
      const decisions = events.filter((event) => event.kind === "decision").map((event) => (event.evidence as { decision: { kind: string } }).decision.kind);
      assert.equal(decisions.at(-1), "stand_down", "and the decision says it stands down");
      await pass(100 * msPerTick + 50 - time.now());
      assert.equal(bot.time.age, START_AGE + 100, "20 ticks short of the end, one packet of margin");
      assert.equal(counts.claims, 1);
      await pass(20 * msPerTick);
      assert.equal(bot.time.age, START_AGE + 120);
      assert.equal(counts.claims, 2, "claims again at the first driver tick after the packet of age A + 120");
    } finally { await driver[Symbol.asyncDispose](); }
  });

// 150 000 ms is 3 000 ticks: doubled it is the 6 000-tick cap exactly; 151 000 ms (3 020) doubled would be 6 040. Each limit is
// followed by `answered.clear()` so the reflex claims again at once and the count of its limits keeps climbing.
const ESCALATIONS: ReadonlyArray<readonly [standDownTicks: number, recordMs: readonly number[]]> = [
  [100, [5_000, 10_000, 20_000]],
  [3_000, [150_000, 300_000, 300_000]],
  [3_020, [151_000, 300_000, 300_000]],
];
for (const [standDownTicks, recordMs] of ESCALATIONS)
  test(`a repeated no-progress limit doubles a ${standDownTicks} tick stand-down up to 6 000 ticks: ${recordMs.join(", ")} ms`, async () => {
    const { driver, definition, pass } = scene({ ceilingTicks: 12_000, noProgressTicks: 20, standDownTicks });
    driver.register({ ...definition(), escalateStandDown: () => true });
    try {
      for (const expected of recordMs) {
        await pass(2_300);
        const answer = driver.answered.snapshot()[0]!;
        assert.equal(answer.temporal!.expiresAt - answer.since, expected);
        driver.answered.clear();
      }
    } finally { await driver[Symbol.asyncDispose](); }
  });

test("repeated life-saving limits keep their declared pause, including an independent footing impulse", async () => {
  for (const name of ["breath_reflex", "fire_reflex", "recover_footing", "hunger_reflex"] as const) {
    const { driver, definition, pass } = scene();
    let needed = true;
    driver.register({ ...definition(), name,
      sense: () => needed ? { kind: "observed", danger: true, evidence: true } : null });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await pass(2_300);
        const answer = driver.answered.snapshot()[0]!;
        assert.equal(answer.temporal!.expiresAt - answer.since, 3_000, name);
        needed = false;
        await pass(4_000); // past the 3 s stand-down's end at the packet of age A + 120 (6 s in)
        needed = true;
      }
    } finally { await driver[Symbol.asyncDispose](); }
  }
});

/** A driver built as production builds it (no `now`) on an installed mocked clock whose wall clock steps after the limit. */
async function claimsAfterStandDown(wallStepMs: number, passAfterStepMs: number) {
  const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
  using _installed = clock.install();
  // Live the wall clock and the monotonic one read unrelated values (epoch vs uptime): a stand-down on the wrong one cannot pass.
  clock.stepWallClock(5_000);
  const { driver, counts, definition, pass } = scene(LIMITS, clock, {});
  driver.register(definition());
  await pass(2_300); // the no-progress limit hits at ~2 s (20 world ticks and one packet): the 60-tick stand-down starts there
  assert.equal(counts.claims, 1);
  clock.stepWallClock(wallStepMs);
  await pass(passAfterStepMs);
  await driver[Symbol.asyncDispose]();
  return counts.claims;
}

// The limit hits ~2 s in (the packet of age A + 40) and the stand-down ends at the packet of age A + 120, 6 s in; the helper
// has passed 2.3 s before the wall clock steps.
const STAND_DOWN_ROWS: ReadonlyArray<readonly [wallStepMs: number, passAfterStepMs: number, claims: number, why: string]> = [
  [-800, 3_500, 1, "5.8 s in: the packet of age A + 120 is at 6 s"],
  [-800, 3_800, 2, "6.1 s in: over, the wall clock's 0.8 s do not stretch it"],
  [1_200, 2_700, 1, "5.0 s in: the wall clock alone would call a 3 s stand-down over"],
  [1_200, 3_800, 2, "6.1 s in: over"],
];
for (const [wallStepMs, passAfterStepMs, claims, why] of STAND_DOWN_ROWS)
  test(`a 60-tick stand-down ignores the wall clock: wall step ${wallStepMs} ms, ${passAfterStepMs} ms later it has claimed ${claims} time(s) (${why})`, async () => {
    assert.equal(await claimsAfterStandDown(wallStepMs, passAfterStepMs), claims);
  });

test("the limit outcome names the limit and the last progress", async () => {
  const { combat, events, driver, definition, pass } = scene();
  driver.register(definition());
  await pass(300);
  combat.setHealth(18); // a mark: the window restarts from the age cached at the next check (A, the next packet is at 1 s)
  await pass(2_000);
  const limit = outcomes(events).at(0);
  assert.equal(limit?.cancelled, false);
  assert.equal(limit?.outcome.kind, "limit");
  assert.equal(limit?.outcome.limit, "no_progress");
  assert.equal(limit?.outcome.lastProgress, "health_changed");
});

test("a claim that keeps marking runs into its ceiling, not the no-progress limit", async () => {
  const { combat, events, driver, definition, pass } = scene({ ceilingTicks: 40, noProgressTicks: 20, standDownTicks: 60 });
  driver.register(definition());
  for (let step = 0; step < 70; step++) { // the 2 s ceiling is 40 ticks and one packet: 3 s in at 20 tps
    combat.setHealth(step % 2 === 0 ? 19 : 20);
    await pass(50);
  }
  assert.equal(outcomes(events).at(0)?.outcome.limit, "ceiling");
});

test("a work that ignores the abort is released after the grace and the limit still stands the reflex down", async () => {
  const { driver, runner, events, counts, definition, pass } = scene();
  driver.register(definition(true));
  await pass(2_300);
  assert.equal(runner.status().owner, "takeover", "the work has the grace to stop");
  await pass(600);
  assert.equal(runner.status().owner, "idle");
  assert.equal(outcomes(events).at(0)?.outcome.limit, "no_progress");
  assert.equal(driver.answered.snapshot()[0]?.failure.kind, "reflex_limit");
  await pass(1_000);
  assert.equal(counts.claims, 1);
});

// Every way a claim ends from outside is no attempt and no stand-down: the work is told to stop once, the probes are off,
// the old no-progress window (and the world-age deadline behind it) fires nothing later, and the next claim is admitted
// and released at its own limit (plan 2026-11-16-reflex-limits-ticks T3, T6 and T13 of skill test-writing).
const CLAIM_EXITS = ["policy cancel", "death", "dimension change", "close"] as const;
for (const exit of CLAIM_EXITS)
  test(`a ${exit} during a claim is no stand-down, leaves no probe, and the next claim is admitted and released`, async () => {
    const { bot, combat, time, runner, driver, events, counts, definition, pass } = scene();
    const added = listenersAddedSince(bot);
    driver.register(definition());
    await pass(100);
    assert.equal(counts.claims, 1);
    assert.ok(added("health") > 0, "the base probe listens during the claim");
    if (exit === "policy cancel") await driver.cancel("fire_reflex", new BodyAbort({ kind: "policy_changed", revision: "next" }, "Policy changed"));
    else if (exit === "death") { combat.setHealth(0); await flush(); combat.setHealth(20); }
    else if (exit === "dimension change") { bot.game.dimension = "the_nether"; bot.emit("game"); await flush(); }
    else await driver[Symbol.asyncDispose]();
    await flush();
    assert.deepEqual(driver.answered.snapshot(), [], "no stand-down");
    assert.equal(counts.aborted, 1, "the work was told to stop once");
    assert.equal(outcomes(events).filter((outcome) => outcome.cancelled).length, 1, "settled once, as a cancel");
    assert.equal(added("health"), 0, "the probes detach when the claim ends");
    if (exit === "close") {
      assert.equal(added("physicsTick"), 0, "the driver's own tick listener is gone");
      await pass(60_000); // past the claim's old windows: nothing fires, nothing claims
      assert.equal(counts.claims, 1);
      assert.deepEqual(driver.answered.snapshot(), []);
      const successor = new ReflexDriver(bot, runner, { now: time.now });
      successor.register(definition());
      await pass(100);
      assert.equal(counts.claims, 2, "a fresh driver is admitted on the same body");
      await pass(2_300);
      assert.equal(runner.status().owner, "idle", "and released at its own limit");
      await successor[Symbol.asyncDispose]();
      return;
    }
    if (exit === "death") { bot.emit("physicsTick"); await flush(); } // the fake's physics stop at a death: the next tick is the respawn's
    await pass(100);
    assert.equal(counts.claims, 2, "claims again at once");
    await pass(2_300); // the new claim's own window: 20 ticks and one packet
    assert.equal(runner.status().owner, "idle", "the successor is released at its own limit");
    assert.equal(counts.aborted, 2);
    await driver[Symbol.asyncDispose]();
  });

// Today's rule on the tick path: a death clears every answered scope, a stand-down too, so the reflex answers again at once.
test("a death during a stand-down clears it: the reflex claims again at the first tick after the respawn", async () => {
  const { bot, driver, counts, definition, pass } = scene();
  driver.register(definition());
  await pass(2_300);
  assert.equal(driver.answered.snapshot()[0]?.temporal?.premise, "reflex_limit");
  assert.equal(counts.claims, 1);
  bot.emit("death"); // the event the driver resets on, as `driver.test.ts` "a death during the retry delay"
  assert.deepEqual(driver.answered.snapshot(), []);
  bot.emit("physicsTick");
  await flush();
  assert.equal(counts.claims, 2, "no wait for the stand-down's 60 ticks (it would end 6 s in)");
  await driver[Symbol.asyncDispose]();
});

test("the probes of a refused claim are detached", async () => {
  const { bot, runner, driver, definition } = scene();
  Object.defineProperty(runner, "claim", { value: () => ({ kind: "busy", activeAction: { action: "other", startedAt: "now" } }) });
  driver.register(definition());
  bot.emit("physicsTick");
  assert.equal(bot.listenerCount("health"), 0);
});

test("a probe that cannot attach does not keep the reflex from answering", async () => {
  const { driver, counts, definition, pass } = scene();
  driver.register({
    ...definition(),
    progress: () => {
      throw new Error("no entity yet");
    },
  });
  await pass(100);
  assert.equal(counts.claims, 1);
});

test("the reflex's own probe keeps the claim alive and is detached with it", async () => {
  const { bot, driver, events, definition, pass } = scene();
  let mark: (reason: string) => void = () => {};
  let detached = 0;
  driver.register({
    ...definition(),
    progress: (_response, onMark) => {
      mark = onMark;
      return () => {
        detached++;
      };
    },
  });
  for (let step = 0; step < 6; step++) {
    mark("out_of_lava");
    await pass(500);
  }
  assert.equal(outcomes(events).length, 0, "a mark every 500 ms keeps a 1 s window open");
  assert.equal(detached, 0);
  await pass(1_300);
  assert.equal(outcomes(events).at(0)?.outcome.lastProgress, "out_of_lava");
  assert.equal(detached, 1);
  void bot;
});

test("the interrupted request returns with the [REFLEX_LIMIT] reason, not a bare cancel", async () => {
  const { runner, driver, definition, pass } = scene();
  const inputSchema = z.object({ block_name: z.string() });
  const resultSchema = actionResultSchema({});
  let attempts = 0;
  const navigate = defineAction({
    name: "stub",
    description: "stub",
    inputSchema,
    resultSchema,
    formatResult: (result) => result.status,
    parse: (input: unknown) => inputSchema.parse(input),
    execution: { kind: "resumable_task" },
    begin: () => async (context) => {
      attempts++;
      await new Promise<void>((_resolve, reject) => context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true }));
      return { status: "succeeded" as const };
    },
  });
  const running = runner.run(navigate, { block_name: "stone" });
  await flush();
  // The reflex takes the body from the action; its continuation is `resume`, but a limit returns the request instead.
  driver.register({ ...definition(), continuation: () => ({ kind: "resume" }) });
  await pass(2_400);
  const output = await running;
  assert.equal(attempts, 1, "the request was not resumed into the same danger");
  assert.equal(output.interruptions?.length, 1);
  assert.match(output.interruptions![0]!, /^\[REFLEX_LIMIT\] fire_reflex held the body .*without progress/);
});

/** Two reflexes, one that can act from a seat; the bot sits in a boat and the pace ticks come from a mocked interval. */
test("a seated tick reaches only the reflexes that can act from a seat", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { bot, driver, definition } = scene(LIMITS, clock);
  const seen: string[] = [];
  driver.register({ ...definition(), name: "breath_reflex", sense: () => (seen.push("breath"), null) });
  driver.register({ ...definition(), name: "hunger_reflex", seated: true, sense: () => (seen.push("hunger"), null) });
  bot.emit("physicsTick");
  assert.deepEqual(seen, ["breath", "hunger"], "on foot both sense");
  seen.length = 0;
  bot.mount(bot.entities[7]!);
  await clock.advance(50); // the server seats her: the mount event, and no physics tick while seated
  seen.length = 0;
  await clock.advance(50);
  await clock.advance(50);
  assert.deepEqual(seen, ["hunger", "hunger"], "seated, with no physics tick, only hunger senses");
  // The client hearing she is off: both of Mineflayer's seats cleared, then the dismount event.
  forgetVehicle(bot);
  seen.length = 0;
  bot.emit("physicsTick");
  assert.deepEqual(seen, ["breath", "hunger"]);
  await driver[Symbol.asyncDispose]();
  assert.equal(bot.listenerCount("physicsTick"), 0, "no body tick listener is left");
});
