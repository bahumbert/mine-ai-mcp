// The limits a reflex claim is held to: no progress, a ceiling, a stand-down after either, and the seated tick.
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { actionResultSchema, defineAction } from "../../actions/index.js";
import { BodyAbort } from "../../session/abort.js";
import { forgetVehicle } from "../../actions/navigate/vehicle-sync.js";
import { ActionRunner } from "../../session/action-runner.js";
import { type FakeClock, createFakeBot, createFakeClock, flush } from "../../test-support/fake-bot/index.js";
import type { ReflexDefinition, ReflexLimits, SurvivalTransition } from "./contract.js";
import { ReflexDriver } from "./driver.js";

const LIMITS: ReflexLimits = { ceilingMs: 600_000, noProgressMs: 1_000, standDownMs: 3_000 };

/**
 * A driver on the bot's clock: `pass(ms)` moves time in 50 ms ticks with a physics tick at each, as a healthy server
 * would. A boat (#7) floats beside the bot; `clock` is a mocked one for a test of the driver's own interval.
 */
function scene(limits: ReflexLimits = LIMITS, clock?: FakeClock) {
  const { bot, combat, clock: time } = createFakeBot({ clock, entities: { 7: { name: "oak_boat", position: { x: 1.5, y: 64, z: 0.5 } } } });
  const runner = new ActionRunner({ clock: time, cancelGraceMs: 500 });
  const driver = new ReflexDriver(bot, runner, { now: time.now });
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

test("a claim with no progress is released, stands down for standDownMs whatever the facts, and claims again after", async () => {
  const { driver, runner, counts, definition, pass } = scene();
  driver.register(definition());
  await pass(100);
  assert.equal(counts.claims, 1);
  await pass(1_000);
  assert.equal(counts.aborted, 1, "the work was told to stop at the no-progress limit");
  assert.equal(runner.status().owner, "idle");
  assert.equal(driver.answered.snapshot()[0]?.failure.kind, "reflex_limit");
  assert.equal(driver.answered.snapshot()[0]?.temporal?.premise, "reflex_limit");
  await pass(2_500);
  assert.equal(counts.claims, 1, "the facts changed at every read, still no claim within the stand-down");
  await pass(1_000);
  assert.equal(counts.claims, 2, "after the stand-down it claims again");
});

test("a limit is not a cancel: no claim on the next tick, and the decision says it stands down", async () => {
  const { driver, events, counts, definition, pass } = scene();
  driver.register(definition());
  await pass(1_300);
  const afterLimit = counts.claims;
  await pass(500);
  assert.equal(counts.claims, afterLimit);
  const decisions = events.filter((event) => event.kind === "decision").map((event) => (event.evidence as { decision: { kind: string } }).decision.kind);
  assert.equal(decisions.at(-1), "stand_down");
});

test("the limit outcome names the limit and the last progress", async () => {
  const { combat, events, driver, definition, pass } = scene();
  driver.register(definition());
  await pass(300);
  combat.setHealth(18);
  await pass(1_300);
  const limit = outcomes(events).at(0);
  assert.equal(limit?.cancelled, false);
  assert.equal(limit?.outcome.kind, "limit");
  assert.equal(limit?.outcome.limit, "no_progress");
  assert.equal(limit?.outcome.lastProgress, "health_changed");
});

test("a claim that keeps marking runs into its ceiling, not the no-progress limit", async () => {
  const { combat, events, driver, definition, pass } = scene({ ceilingMs: 2_000, noProgressMs: 1_000, standDownMs: 3_000 });
  driver.register(definition());
  for (let step = 0; step < 50; step++) {
    combat.setHealth(step % 2 === 0 ? 19 : 20);
    await pass(50);
  }
  assert.equal(outcomes(events).at(0)?.outcome.limit, "ceiling");
});

test("a work that ignores the abort is released after the grace and the limit still stands the reflex down", async () => {
  const { driver, runner, events, counts, definition, pass } = scene();
  driver.register(definition(true));
  await pass(1_100);
  assert.equal(runner.status().owner, "takeover", "the work has the grace to stop");
  await pass(600);
  assert.equal(runner.status().owner, "idle");
  assert.equal(outcomes(events).at(0)?.outcome.limit, "no_progress");
  assert.equal(driver.answered.snapshot()[0]?.failure.kind, "reflex_limit");
  await pass(1_000);
  assert.equal(counts.claims, 1);
});

test("a cancel is no stand-down", async () => {
  const { driver, counts, definition, pass } = scene();
  driver.register(definition());
  await pass(100);
  await driver.cancel("fire_reflex", new BodyAbort({ kind: "policy_changed", revision: "next" }, "Policy changed"));
  await flush();
  assert.deepEqual(driver.answered.snapshot(), []);
  await pass(100);
  assert.equal(counts.claims, 2, "claims again at once");
});

test("a death during a claim is no stand-down, and the probes are off afterwards", async () => {
  const { bot, combat, driver, definition, pass } = scene();
  driver.register(definition());
  await pass(100);
  const during = bot.listenerCount("health");
  assert.ok(during > 0, "the base probe listens during the claim");
  combat.setHealth(0);
  await flush();
  combat.setHealth(20);
  assert.deepEqual(driver.answered.snapshot(), []);
  assert.equal(bot.listenerCount("health"), 0, "the probes detach when the claim ends");
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
  await pass(1_400);
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
