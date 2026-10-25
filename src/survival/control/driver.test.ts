import assert from "node:assert/strict";
import test from "node:test";
import { BodyAbort } from "../../session/abort.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { ActionRunner } from "../../session/action-runner.js";
import { type SurvivalTransition } from "./contract.js";
import { ReflexDriver } from "./driver.js";

/** Limits far beyond any test: a claim that is not under test never runs into them. */
const TEST_LIMITS = { ceilingMs: 600_000, noProgressMs: 600_000, standDownMs: 2_000 };
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

/** A fire reflex whose escape throws on every attempt, counted; `retryAfterFailureMs` is the rule under test. */
function throwingEscape(retryAfterFailureMs: number | undefined) {
  const attempts = { count: 0 };
  const definition = {
    name: "fire_reflex" as const,
    retryAfterFailureMs,
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

test("an execution exception of a reflex with retryAfterFailureMs is retried after it", async () => {
  const bot = idleBot();
  let clock = 0;
  await using driver = new ReflexDriver(bot, new ActionRunner(), { now: () => clock });
  const { attempts, definition } = throwingEscape(2_000);
  driver.register(definition);
  bot.emit("physicsTick");
  await settled();
  assert.equal(attempts.count, 1);
  clock = 1_999;
  bot.emit("physicsTick");
  await settled();
  assert.equal(attempts.count, 1, "still answered 1 ms before the retry time");
  clock = 2_001;
  bot.emit("physicsTick");
  await settled();
  assert.equal(attempts.count, 2);
  assert.equal(driver.answered.snapshot()[0]?.temporal?.premise, "retry_after_failure");
});

test("a death during the retry delay lets the reflex claim again at once after respawn", async () => {
  const bot = idleBot();
  await using driver = new ReflexDriver(bot, new ActionRunner(), { now: () => 0 });
  const { attempts, definition } = throwingEscape(2_000);
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
  const { definition } = throwingEscape(2_000);
  await using driver = new ReflexDriver(bot, new ActionRunner(), { now: () => 0 });
  driver.register({
    ...definition,
    act: async () => "failed",
    failure: () => ({ kind: "failed", why: "No way out." }),
    temporal: () => ({ premise: "own_premise", expiresAt: 5_000, why: "own" }),
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
