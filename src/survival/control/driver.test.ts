import assert from "node:assert/strict";
import test from "node:test";
import { BodyAbort } from "../../session/abort.js";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { ActionRunner } from "../../session/action-runner.js";
import { type SurvivalTransition } from "./contract.js";
import { ReflexDriver } from "./driver.js";

/** Limits far beyond any test: a claim that is not under test never runs into them. */
const TEST_LIMITS = { ceilingTicks: 12_000, noProgressTicks: 12_000, standDownTicks: 40 };
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
const idleBot = () => createFakeBot().bot;

test("a failed moving response answers its final arrangement before another tick", async () => {
  const bot = idleBot();
  await using driver = new ReflexDriver(bot, new ActionRunner());
  let cell = "A",
    attempts = 0;
  driver.register({
    name: "hostile_reflex",
    sense: () => ({ kind: "observed", danger: true, evidence: true }),
    decide: () => ({ kind: "respond", response: true, name: "evade", reason: "Observed aggression." }),
    facts: () => ({ capability: "evade", response: "evade", scope: cell, facts: () => null, permissions: () => null }),
    act: async () => {
      attempts++;
      cell = "B";
      return "exhausted";
    },
    failure: () => ({ kind: "exhausted", why: "The attacker kept pace." }),
    continuation: () => ({ kind: "return", reason: "Escape exhausted." }),
    describe: () => null,
    limits: () => TEST_LIMITS,
  });
  bot.emit("physicsTick");
  await settled();
  for (let tick = 0; tick < 100; tick++) bot.emit("physicsTick");
  assert.equal(attempts, 1);
  assert.equal(driver.answered.snapshot()[0]?.scope, "B");
});

test("an execution exception is answered once and only declared premises rearm it", async () => {
  const bot = idleBot();
  await using driver = new ReflexDriver(bot, new ActionRunner());
  const events: SurvivalTransition[] = [];
  driver.onTransition((event) => events.push(event));
  let terrain = 1,
    unrelated = 1,
    attempts = 0;
  driver.register({
    name: "fire_reflex",
    sense: () => ({ kind: "observed", danger: true, evidence: { burning: true } }),
    decide: () => ({ kind: "respond", response: true, name: "escape", reason: "Burning in place." }),
    decisionFacts: () => ({ terrain, unrelated }),
    facts: () => ({
      capability: "fire",
      response: "escape",
      scope: "cell:A",
      facts: () => ({ terrain }),
      permissions: () => null,
    }),
    act: async () => {
      attempts++;
      throw new Error("Native movement rejected");
    },
    failure: () => null,
    continuation: () => ({ kind: "resume" }),
    describe: () => null,
    limits: () => TEST_LIMITS,
  });
  bot.emit("physicsTick");
  await settled();
  unrelated++;
  for (let tick = 0; tick < 100; tick++) bot.emit("physicsTick");
  assert.equal(attempts, 1);
  assert.equal(driver.answered.snapshot()[0]?.failure.kind, "execution_failed");
  assert.equal(events.filter((event) => event.kind === "outcome").length, 1);
  assert.equal(events.filter((event) => event.kind === "decision").length, 2, "respond then stand down once");
  terrain++;
  bot.emit("physicsTick");
  await settled();
  assert.equal(attempts, 2);
  assert.equal(driver.answered.snapshot().length, 1);
});

for (const cause of ["policy", "death"] as const)
  test(`${cause} interruption is not a failed physical attempt`, async () => {
    const bot = idleBot();
    await using driver = new ReflexDriver(bot, new ActionRunner());
    driver.register({
      name: "fire_reflex",
      sense: () => ({ kind: "observed", danger: true, evidence: true }),
      decide: () => ({ kind: "respond", response: true, name: "escape", reason: "Fire." }),
      facts: () => ({ capability: "fire", response: "escape", scope: "A", facts: () => null, permissions: () => null }),
      act: async (_response, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        signal.throwIfAborted();
      },
      failure: () => ({ kind: "failed", why: "must never be recorded for cancellation" }),
      continuation: () => ({ kind: "resume" }),
      describe: () => null,
      limits: () => TEST_LIMITS,
    });
    bot.emit("physicsTick");
    await settled();
    if (cause === "death") {
      bot.health = 0;
      bot.emit("death");
    } else
      await driver.cancel("fire_reflex", new BodyAbort({ kind: "policy_changed", revision: "next" }, "Policy changed"));
    await settled();
    assert.deepEqual(driver.answered.snapshot(), []);
    assert.equal(driver.snapshot()[0]?.response, null);
    assert.equal(driver.snapshot()[0]?.stale, cause === "death");
  });

/** A fire reflex whose escape throws on every attempt, counted; `retryAfterFailureTicks` is the rule under test. */
function throwingEscape(retryAfterFailureTicks: number | undefined) {
  const attempts = { count: 0 };
  const definition = {
    name: "fire_reflex" as const,
    retryAfterFailureTicks,
    sense: () => ({ kind: "observed" as const, danger: true, evidence: { burning: true } }),
    decide: () => ({ kind: "respond" as const, response: true, name: "escape", reason: "Burning in place." }),
    facts: () => ({ capability: "fire", response: "escape", scope: "cell:A", facts: () => null, permissions: () => null }),
    act: async () => {
      attempts.count++;
      throw new Error("Native movement rejected");
    },
    failure: () => null,
    continuation: () => ({ kind: "resume" as const }),
    describe: () => null,
    limits: () => TEST_LIMITS,
  };
  return { attempts, definition };
}

// A retry pause counts world ticks (plan 2026-11-16-reflex-limits-ticks T3). The fake server's first packet, of age `A`, is
// at 0 ms and one comes per 20 ticks; the first attempt fails ~50 ms in, so its pause (40 ticks) is remembered at the cached
// age A and ends at the packet of age A + 60: 3 000 ms in at 20 tps, 6 000 ms in at 10 tps (old code: 2 000 ms after the failure).
const START_AGE = 1_000;
const RATES = [
  { ticksPerSecond: 20, msPerTick: 50 },
  { ticksPerSecond: 10, msPerTick: 100 },
] as const;

/** A driver on the fake bot's own clock and server, as the production driver is wired (`now` the clock, the age the bot's). */
function retryScene(ticksPerSecond: number, retryAfterFailureTicks: number | undefined) {
  const clock = createFakeClock({ mode: "manual" });
  const { bot, server } = createFakeBot({ clock, server: { startAge: START_AGE, ticksPerSecond } });
  const driver = new ReflexDriver(bot, new ActionRunner({ clock }), { now: clock.now });
  const { attempts, definition } = throwingEscape(retryAfterFailureTicks);
  driver.register(definition);
  return { bot, server, clock, driver, attempts, age: () => bot.time.age };
}

for (const { ticksPerSecond, msPerTick } of RATES) {
  test(`an execution exception of a reflex with retryAfterFailureTicks is retried after the packet of age A + 60, not A + 40 (${ticksPerSecond} tps)`, async () => {
    const { clock, driver, attempts, age } = retryScene(ticksPerSecond, 40);
    try {
      await clock.advance(100);
      assert.equal(attempts.count, 1);
      await clock.advance(40 * msPerTick + 100 - clock.now());
      assert.equal(age(), START_AGE + 40, `${clock.now()} ms in: the old code (2 000 ms) retried here`);
      assert.equal(attempts.count, 1, "A + 40: still answered, one packet of margin");
      await clock.advance(20 * msPerTick - 100 - 50);
      assert.equal(age(), START_AGE + 40, "a physics tick before the packet of age A + 60");
      assert.equal(attempts.count, 1);
      await clock.advance(100);
      assert.equal(age(), START_AGE + 60);
      assert.equal(attempts.count, 2, "retried at the first physics tick after that packet");
      assert.equal(driver.answered.snapshot()[0]?.temporal?.premise, "retry_after_failure");
    } finally {
      await driver[Symbol.asyncDispose]();
    }
  });
}

test("an execution exception on a stopped server is retried on the pause's 9 000 ms wall, not before", async () => {
  const { clock, server, driver, attempts } = retryScene(20, 40);
  try {
    await clock.advance(100);
    assert.equal(attempts.count, 1);
    server.stop();
    await clock.advance(8_900 - 100);
    assert.equal(attempts.count, 1, "8 900 ms in: the age stands still, 8 850 ms after the failure");
    await clock.advance(200);
    assert.equal(attempts.count, 2, "9 100 ms in: 9 000 ms after the failure");
  } finally {
    await driver[Symbol.asyncDispose]();
  }
});

/** Attempts of a reflex with a 40-tick retry pause, driven as production builds it (no `now`) on a mocked clock whose wall clock steps after the first failure. */
async function attemptsAfterWallStep(wallStepMs: number, advanceAfterStepMs: number) {
  const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
  using _installed = clock.install();
  // Live the wall clock and the monotonic one read unrelated values (epoch vs uptime): a delay on the wrong one cannot pass.
  clock.stepWallClock(5_000);
  const { bot } = createFakeBot({ clock });
  await using driver = new ReflexDriver(bot, new ActionRunner({ clock }));
  const { attempts, definition } = throwingEscape(40);
  driver.register(definition);
  await clock.advance(100); // the first attempt fails and is answered at ~50 ms
  assert.equal(attempts.count, 1);
  clock.stepWallClock(wallStepMs);
  await clock.advance(advanceAfterStepMs);
  return attempts.count;
}

// The first attempt fails ~50 ms in, at the cached age A; the pause ends at the packet of age A + 60, 3 s in at 20 tps (the
// wall clock does not move the age, and the monotonic backstop is 9 s); the helper passes 100 ms before the wall clock steps.
const RETRY_DELAY_ROWS: ReadonlyArray<readonly [wallStepMs: number, advanceAfterStepMs: number, attempts: number, why: string]> = [
  [-800, 2_700, 1, "2.8 s in: still answered, the packet of age A + 60 is at 3 s"],
  [-800, 3_000, 2, "3.1 s in: retried, the 0.8 s do not stretch the pause"],
  [1_200, 1_000, 1, "1.1 s in: the wall clock alone would call a 2 s pause over"],
  [1_200, 3_000, 2, "3.1 s in: retried"],
];
for (const [wallStepMs, advanceAfterStepMs, attempts, why] of RETRY_DELAY_ROWS)
  test(`a 40-tick retry pause ignores the wall clock: wall step ${wallStepMs} ms, ${advanceAfterStepMs} ms later it has made ${attempts} attempt(s) (${why})`, async () => {
    assert.equal(await attemptsAfterWallStep(wallStepMs, advanceAfterStepMs), attempts);
  });

test("a death during the retry delay lets the reflex claim again at once after respawn", async () => {
  const bot = idleBot();
  await using driver = new ReflexDriver(bot, new ActionRunner(), { now: () => 0 });
  const { attempts, definition } = throwingEscape(40);
  driver.register(definition);
  bot.emit("physicsTick");
  await settled();
  bot.emit("death");
  bot.emit("physicsTick");
  await settled();
  assert.equal(attempts.count, 2, "the death cleared the answers: no wait for the 2 s");
});

test("a failure the definition does not retry stays answered while its facts hold, however late", async () => {
  const bot = idleBot();
  let clock = 0;
  await using driver = new ReflexDriver(bot, new ActionRunner(), { now: () => clock });
  const { attempts, definition } = throwingEscape(undefined);
  driver.register(definition);
  bot.emit("physicsTick");
  await settled();
  clock = 10 * 60_000;
  bot.emit("physicsTick");
  await settled();
  assert.equal(attempts.count, 1);
  assert.equal(driver.answered.snapshot()[0]?.temporal, null);
});

test("a definition's own temporal wins over the retry delay", async () => {
  const bot = idleBot();
  const { definition } = throwingEscape(40);
  await using driver = new ReflexDriver(bot, new ActionRunner(), { now: () => 0 });
  driver.register({
    ...definition,
    act: async () => "failed",
    failure: () => ({ kind: "failed", why: "No way out." }),
    temporal: () => ({ premise: "own_premise", ticks: 100, why: "own" }),
  });
  bot.emit("physicsTick");
  await settled();
  assert.equal(driver.answered.snapshot()[0]?.temporal?.premise, "own_premise");
});

test("a throwing sense publishes sensor_failed once, the lower reflexes still tick, and the listener does not throw", async () => {
  const bot = idleBot();
  await using driver = new ReflexDriver(bot, new ActionRunner());
  const events: SurvivalTransition[] = [];
  driver.onTransition((event) => events.push(event));
  let lowerTicks = 0;
  driver.register({
    ...throwingEscape(undefined).definition,
    sense: () => {
      throw new Error("chunk not loaded");
    },
  });
  driver.register({
    ...throwingEscape(undefined).definition,
    name: "hunger_reflex",
    sense: () => {
      lowerTicks++;
      return null;
    },
  });
  for (let tick = 0; tick < 20; tick++) assert.doesNotThrow(() => bot.emit("physicsTick"));
  assert.equal(lowerTicks, 20);
  const dangers = events.filter((event) => event.kind === "danger" && event.reflex === "fire_reflex");
  assert.equal(dangers.length, 1, "one publish for twenty failing ticks");
  assert.deepEqual(dangers[0]?.evidence, { danger: null, missing: "sensor_failed: chunk not loaded" });
  assert.equal(driver.snapshot()[0]?.missing, "sensor_failed: chunk not loaded");
});

test("a throwing decide or facts is guarded the same and makes no claim", async () => {
  for (const broken of ["decide", "facts"] as const) {
    const bot = idleBot();
    const runner = new ActionRunner();
    await using driver = new ReflexDriver(bot, runner);
    const { attempts, definition } = throwingEscape(undefined);
    driver.register({
      ...definition,
      [broken]: () => {
        throw new TypeError(`${broken} broke`);
      },
    });
    assert.doesNotThrow(() => bot.emit("physicsTick"));
    await settled();
    assert.equal(attempts.count, 0);
    assert.equal(runner.status().activeAction, null);
    assert.equal(driver.snapshot()[0]?.missing, `sensor_failed: ${broken} broke`);
    assert.equal(driver.snapshot()[0]?.response, null);
  }
});

test("a sense that recovers after a throw reads its danger again", async () => {
  const bot = idleBot();
  await using driver = new ReflexDriver(bot, new ActionRunner());
  let broken = true;
  driver.register({
    ...throwingEscape(undefined).definition,
    sense: () => {
      if (broken) throw new Error("not yet");
      return { kind: "unknown", missing: "own_air_metadata" };
    },
  });
  bot.emit("physicsTick");
  broken = false;
  bot.emit("physicsTick");
  assert.equal(driver.snapshot()[0]?.missing, "own_air_metadata");
});
