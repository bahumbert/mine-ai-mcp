import assert from "node:assert/strict";
import test from "node:test";
import { setCarriedCount } from "../../test-support/carried-counts.js";
import { type FakeHarness, createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { PhysicsStoppedError } from "../../utils/physics-ticks.js";
import { DEFAULT_SURVIVAL_POLICY } from "../policy/contract.js";
import { survivalResources } from "../state/resources.js";
import { type CoveredRecovery, recoverUnderCover } from "./recover.js";

/**
 * D33 (plan 2026-11-18-scenario-reds-part2-a3 T13g): the covered hold's `maximumMs` is game time at 20 ticks a second.
 * The server runs on the shared fake's clock; health arrives at a chosen server tick (no regeneration model), the hold's
 * one-tick wait is 50 ms of clock (the client always ticks 20 a second), and every age is read from the time packets
 * (one per 20 ticks, as the game sends them).
 */

/** A bite that fills hunger but not health: the meal of a hold whose health still has to come from regeneration. */
function eatWithoutHealing({ bot, inventory }: FakeHarness): void {
  const [food] = inventory.items();
  setCarriedCount(inventory, bot.registry, food!.type, inventory.count(food!.type, null) - 1);
  bot.food = 20;
}

/** What the hold's callbacks did, in order, with the markers the test's own steps add (`exit`, `step finished`). */
type HoldLog = string[];

interface StepContext {
  readonly harness: FakeHarness;
  /** Server ticks since the hold began. */
  readonly since: () => number;
  readonly log: HoldLog;
}

interface TimedHold {
  /** What the hold returned; `threw` when it rejected (a cancellation). */
  readonly result: CoveredRecovery | { readonly kind: "threw"; readonly cause: unknown };
  /** Server ticks the client's world age moved between the hold's start and its end. */
  readonly endAgeTicks: number;
  /** Clock milliseconds between the hold's start and its end. */
  readonly endMs: number;
  readonly harness: FakeHarness;
  readonly survival: ReturnType<typeof survivalResources>;
  readonly log: HoldLog;
}

interface TimedHoldOptions {
  readonly ticksPerSecond: number;
  readonly maximumMs: number;
  /** Server ticks after the start at which health reaches `recoverTo`. */
  readonly healthAtTick?: number;
  /** Stop the server at the start (the clock goes on, the age stands still). */
  readonly stopServer?: boolean;
  readonly noAgeAtStart?: boolean;
  readonly carried?: Record<string, number>;
  readonly signal?: AbortSignal;
  readonly defendIntruder?: (context: StepContext) => Promise<void>;
  readonly consume?: (context: StepContext) => Promise<void>;
  readonly limitMs?: number;
}

async function timedHold(options: TimedHoldOptions): Promise<TimedHold> {
  const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
  using _installed = clock.install();
  // Carried food means a hungry bot (below the regeneration bar), so the hold eats; otherwise it is fed and only waits.
  const harness = createFakeBot({ clock, health: 6, food: options.carried ? 10 : 20, carried: options.carried,
    server: { ticksPerSecond: options.ticksPerSecond, timePacketYet: !options.noAgeAtStart } });
  const { bot, server } = harness;
  const startTick = server.gameTime, startMs = clock.now();
  const context: StepContext = { harness, since: () => server.gameTime - startTick, log: [] };
  if (options.healthAtTick !== undefined) {
    const at = options.healthAtTick;
    const release = server.onTick(() => { if (context.since() >= at) { bot.health = 18; release(); } });
  }
  if (options.stopServer) server.stop();
  if (options.consume) bot.consume = () => options.consume!(context);
  const startAge = bot.time?.age ?? null;
  const survival = survivalResources();
  let result: TimedHold["result"];
  try {
    result = await clock.settle(recoverUnderCover(bot, {
      signal: options.signal ?? new AbortController().signal, recoverTo: 18, maximumMs: options.maximumMs,
      isProtected: () => true,
      defendIntruder: () => { context.log.push("defend"); return options.defendIntruder?.(context) ?? Promise.resolve(); },
      releaseItemUse: () => { context.log.push("release"); },
      // As the real waits (`waitForPhysicsTicks`, `holdFacing`): an aborted signal rejects before any tick is waited.
      wait: () => { options.signal?.throwIfAborted(); context.log.push("wait"); return clock.sleep(50); },
      survival, policy: () => DEFAULT_SURVIVAL_POLICY,
    }), options.limitMs ?? 60_000);
  } catch (cause) { result = { kind: "threw", cause }; }
  return { result, endAgeTicks: startAge === null ? NaN : (bot.time?.age ?? NaN) - startAge, endMs: clock.now() - startMs, harness, survival, log: context.log };
}

for (const ticksPerSecond of [20, 10]) {
  test(`a 10 s covered hold at ${ticksPerSecond} tps is 200 game ticks: health at tick 160 recovers it`, async () => {
    const { result, harness, survival } = await timedHold({ ticksPerSecond, maximumMs: 10_000, healthAtTick: 160 });
    assert.deepEqual(result, { kind: "recovered", ate: null });
    assert.equal(harness.bot.listenerCount("physicsTick"), 0);
    assert.deepEqual(survival.budgets.snapshot(), [], "no budget entry is left after the hold");
  });

  // The hold is pending at the look after tick 200 and ends at the first look after tick 220; health on that last packet
  // is read before the expiry.
  for (const healthAtTick of [undefined, 220]) test(`a 200-tick hold at ${ticksPerSecond} tps with ${healthAtTick === undefined ? "no health" : `health at tick ${healthAtTick}`} ends at the packet 220 ticks on`, async () => {
    const { result, endAgeTicks, endMs } = await timedHold({ ticksPerSecond, maximumMs: 10_000, healthAtTick });
    assert.equal(result.kind === "held" ? result.stop : result.kind, healthAtTick === undefined ? "exhausted" : "recovered");
    assert.equal(endAgeTicks, 220, "the hold ends at the packet 220 ticks after its start, not at the 200 of its budget");
    const gameMs = (220 * 1_000) / ticksPerSecond;
    assert.ok(endMs >= gameMs && endMs <= gameMs + 100, `${endMs} ms for 220 ticks at ${ticksPerSecond} tps`);
  });
}

test("a covered hold with the server stopped ends exhausted at its 3 x (ticks + 20) x 50 ms wall: 33 000 ms for 200 ticks", async () => {
  const { result, endMs } = await timedHold({ ticksPerSecond: 20, maximumMs: 10_000, stopServer: true, limitMs: 40_000 });
  assert.equal(result.kind === "held" && result.stop, "exhausted");
  assert.ok(endMs >= 33_000 && endMs <= 33_100, `${endMs} ms`);
});

for (const ticksPerSecond of [20, 10]) test(`a covered hold that began with no world age ends at its 10 000 ms on-time wall at ${ticksPerSecond} tps, whatever ages arrive later`, async () => {
  const { result, endMs } = await timedHold({ ticksPerSecond, maximumMs: 10_000, noAgeAtStart: true });
  assert.equal(result.kind === "held" && result.stop, "exhausted");
  assert.ok(endMs >= 10_000 && endMs <= 10_100, `${endMs} ms`);
});

test("a covered hold of 0 ms is exhausted at once: no defence, no wait, no eating", async () => {
  const { bot } = createFakeBot({ health: 6, food: 10, carried: { cooked_beef: 2 } });
  const result = await recoverUnderCover(bot, {
    signal: new AbortController().signal, recoverTo: 18, maximumMs: 0, isProtected: () => true,
    defendIntruder: async () => assert.fail("a spent hold defends nothing"), releaseItemUse: () => {},
    wait: async () => assert.fail("a spent hold waits for nothing"),
    survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
  });
  assert.equal(result.kind === "held" && result.stop, "exhausted");
  assert.equal(bot.inventory.items()[0]!.count, 2);
});

/** 100 server ticks of clock at the rate of the server. */
const hundredTicksMs = (ticksPerSecond: number) => (100 * 1_000) / ticksPerSecond;

for (const ticksPerSecond of [20, 10]) {
  // A bite is 30 ticks: `eatFood` waits 40 server ticks for the stack to drop and gives a longer consume up (EAT_NOT_OBSERVED).
  test(`a 100-tick defence and 30-tick bites inside a ${ticksPerSecond} tps hold renew nothing`, async () => {
    let defences = 0, bites = 0;
    const { result, endAgeTicks } = await timedHold({
      ticksPerSecond, maximumMs: 10_000, carried: { cooked_beef: 20 }, limitMs: 90_000,
      defendIntruder: async ({ harness }) => { if (++defences === 1) await harness.clock.sleep(hundredTicksMs(ticksPerSecond)); },
      consume: async ({ harness }) => {
        bites++;
        await harness.clock.sleep((30 * 1_000) / ticksPerSecond);
        eatWithoutHealing(harness);
        harness.bot.food = 10;
      },
    });
    assert.equal(result.kind === "held" && result.stop, "exhausted");
    assert.ok(bites >= 3, `${bites} bites`);
    // The defence and the bites spent their ticks of the 200; the hold ends at the first packet at or after tick 220, never later.
    assert.ok(endAgeTicks >= 220 && endAgeTicks <= 240, `${endAgeTicks} ticks`);
  });

  test(`a defence still running at the deadline of a ${ticksPerSecond} tps hold finishes, then the hold is exhausted`, async () => {
    let defences = 0;
    const { result, endAgeTicks } = await timedHold({
      ticksPerSecond, maximumMs: 10_000, limitMs: 90_000,
      defendIntruder: async ({ harness, since }) => {
        defences++;
        if (since() >= 150 && defences > 1) await harness.clock.sleep(hundredTicksMs(ticksPerSecond));
      },
    });
    assert.equal(result.kind === "held" && result.stop, "exhausted");
    // The defence began at game tick ~150 and ran its 100 ticks, past the deadline (220: the control above ends there); the
    // client's age trails the game tick by up to 19, so it reads 231 to 250 when the defence ends.
    assert.ok(endAgeTicks >= 240 && endAgeTicks <= 260, `${endAgeTicks} ticks`);
  });
}

// A cancellation or a death inside a step: the hold exits as before, the step finishes under its own bound, and nothing
// of the hold runs after the exit (no wait, no shield release, no defence), no listener and no budget is left, and no
// answer is remembered.
for (const exit of ["cancel", "death"] as const) for (const step of ["defence", "bite"] as const) {
  test(`${exit} during the hold's ${step} exits as before, with no later callback, listener, budget or remembered answer`, async () => {
    const owner = new AbortController();
    const reason = new Error("Caller cancelled");
    const leave = ({ harness, log }: StepContext) => {
      log.push("exit");
      if (exit === "cancel") owner.abort(reason); else harness.bot.health = 0;
    };
    const { result, harness, survival, log } = await timedHold({
      ticksPerSecond: 10, maximumMs: 10_000, signal: owner.signal, carried: { cooked_beef: 2 }, limitMs: 90_000,
      defendIntruder: async (context) => {
        if (step !== "defence" || context.since() < 40) return;
        leave(context);
        await context.harness.clock.sleep(1_000);
        context.log.push("step finished");
      },
      consume: async (context) => {
        if (step === "bite") {
          leave(context);
          await context.harness.clock.sleep(1_000);
          context.log.push("step finished");
        }
        eatWithoutHealing(context.harness);
      },
    });
    if (exit === "cancel") assert.deepEqual(result, { kind: "threw", cause: reason });
    else assert.deepEqual([result.kind, result.kind === "held" && result.stop, result.kind === "held" && result.reason], ["held", "death", "The bot died during recovery."]);
    assert.deepEqual(log.slice(log.indexOf("exit") + 1).filter((entry) => entry !== "step finished"), [], `callbacks after the exit: ${log.join(",")}`);
    assert.equal(harness.bot.listenerCount("physicsTick"), 0);
    assert.deepEqual(survival.budgets.snapshot(), []);
    assert.deepEqual(survival.answered.snapshot(), []);
  });
}

// Client physics that stopped is no answer about recovery itself: the next hold, with a body that ticks, runs.
test("a hold ended unavailable by stopped client physics is not remembered: the next hold runs and recovers", async () => {
  const survival = survivalResources();
  const { bot } = createFakeBot({ health: 6, food: 20 });
  const hold = (wait: () => Promise<void>) => recoverUnderCover(bot, {
    signal: new AbortController().signal, recoverTo: 18, maximumMs: 10_000, isProtected: () => true,
    defendIntruder: async () => {}, releaseItemUse: () => {}, wait, survival, policy: () => DEFAULT_SURVIVAL_POLICY,
  });
  const first = await hold(async () => { throw new PhysicsStoppedError(1_000); });
  assert.equal(first.kind === "held" && first.stop, "unavailable");
  assert.match(first.kind === "held" ? first.reason : "", /client physics stopped: no physics tick for 1000 ms/);
  assert.deepEqual(survival.answered.snapshot(), []);
  bot.health = 18;
  assert.deepEqual(await hold(async () => {}), { kind: "recovered", ate: null });
});

test("a wait that fails for any other reason than stopped physics is not a held state: the hold rejects with it", async () => {
  const { bot } = createFakeBot({ health: 6, food: 20 });
  const failure = new Error("wait broke");
  await assert.rejects(recoverUnderCover(bot, {
    signal: new AbortController().signal, recoverTo: 18, maximumMs: 10_000, isProtected: () => true,
    defendIntruder: async () => {}, releaseItemUse: () => {}, wait: async () => { throw failure; },
    survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
  }), (cause) => cause === failure);
});
