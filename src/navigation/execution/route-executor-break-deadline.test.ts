/**
 * The confirmation deadline of a break in a route: it covers the body's real dig time (Mineflayer's `digTime` with the
 * water and ground penalties), not only the dry grounded price the route was planned at. Live 2026-10-19 (Sana,
 * floating in a flooded nook): a 14.1 s dig outlived the 5 s minimum twice and the failed-edge memory shut her in.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { FakeNavigationBot, flatWorld, movementStep, routePlan } from "../../test-support/navigation.js";
import type { EffectHandle } from "../bot.js";
import type { PlannedOperation, PlannedStep } from "../movements/movement.js";
import { monotonicNow } from "../../utils/monotonic-clock.js";
import { ExpectedMutationLedger } from "./mutations.js";
import { OpenedPassages } from "./opened-passages.js";
import { RouteExecutor } from "./route-executor.js";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const BREAK_AT = { x: 1, y: 63, z: 0 };
const FLOATING_ANDESITE_MS = 14_100;

/** A ledger that remembers the deadline each expectation was given. */
class DeadlineLedger extends ExpectedMutationLedger {
  readonly deadlines: number[] = [];
  override expect(input: Parameters<ExpectedMutationLedger["expect"]>[0]) {
    this.deadlines.push(input.deadline.ticks);
    return super.expect(input);
  }
}

/** A bot whose dig never ends until it is cancelled, and that cannot tell how long the dig takes. */
class DiggingBot extends FakeNavigationBot {
  cancelled = false;
  override startEffect(): EffectHandle {
    let settle!: (result: { kind: "failed"; observation: string }) => void;
    const completion = new Promise<{ kind: "failed"; observation: string }>((resolve) => (settle = resolve));
    return {
      issued: true,
      completion,
      cancel: () => {
        this.cancelled = true;
        settle({ kind: "failed", observation: "Digging aborted" });
      },
    };
  }
}

/** A digging bot that answers how long the dig takes (null: the block is not loaded). */
class TimedDiggingBot extends DiggingBot {
  readonly asked: PlannedOperation[] = [];
  constructor(readonly digMs: number | null) {
    super();
  }
  longestBreakDurationMs(operation: Extract<PlannedOperation, { kind: "break" }>) {
    this.asked.push(operation);
    return this.digMs;
  }
}

function breakStep(expectedTicks: number, brings: readonly { x: number; y: number; z: number }[] = []): PlannedStep {
  return {
    ...movementStep("walk", { x: 0, y: 63, z: 0 }, BREAK_AT, { expectedTicks }),
    operations: [
      { kind: "break", position: BREAK_AT, expectedStateId: 2, toolType: 7, brings },
      { kind: "move", movement: "walk", target: { x: 1.5, y: 63, z: 0.5 } },
    ],
  };
}

/** Run a break step until its dig is under way; return the deadline it was given and a way to end the run. */
async function startBreak(bot: FakeNavigationBot, step: PlannedStep) {
  const world = flatWorld();
  world.load(BREAK_AT, { stateId: 2 });
  const ledger = new DeadlineLedger();
  const controller = new AbortController();
  const execution = new RouteExecutor({
    context: { runId: "run", world, bot, ledger, signal: controller.signal },
    passages: new OpenedPassages(world, bot.observe().dimension),
    allowDoors: true,
    plan: routePlan([step]),
    stepStarted: () => undefined,
    phase: () => undefined,
    effectConfirmed: () => undefined,
    stepCompleted: () => "continue",
  }).execute();
  await nextTurn();
  assert.equal(ledger.deadlines.length, 1, "the break registers one expectation");
  return { ledger, deadlineIn: ledger.deadlines[0]!, execution, abort: () => controller.abort() };
}

test("route confirmation budgets cover live digs, planned work, falling columns and unknown durations", async () => {
  const brings = [{ x: 1, y: 64, z: 0 }, { x: 1, y: 65, z: 0 }];
  for (const [label, digMs, plannedTicks, column, budget] of [
    ["dry grounded", 600, 12, [], 100],
    ["floating", FLOATING_ANDESITE_MS, 12, [], 564],
    ["planned above actual", 600, 400, [], 800],
    ["falling column", FLOATING_ANDESITE_MS, 12, brings, 1288],
    ["unloaded", null, 12, [], 100],
    ["no duration method", undefined, 12, [], 100],
  ] as const) {
    const bot = digMs === undefined ? new DiggingBot() : new TimedDiggingBot(digMs);
    const run = await startBreak(bot, breakStep(plannedTicks, column));
    try {
      assert.equal(run.deadlineIn, budget, label);
      if (bot instanceof TimedDiggingBot) {
        assert.equal(bot.asked[0]?.kind === "break" && bot.asked[0].position, BREAK_AT, "asked about the operation it runs");
      }
    } finally { run.abort(); await run.execution; }
  }
});

test("a cancel during the long dig ends the step at once and leaves no expectation behind", async () => {
  const bot = new TimedDiggingBot(FLOATING_ANDESITE_MS);
  const run = await startBreak(bot, breakStep(12));
  const before = monotonicNow();
  run.abort();
  assert.equal((await run.execution).kind, "cancelled");
  assert.ok(monotonicNow() - before < 1_000, "the 28 s deadline does not hold the cancel");
  assert.equal(bot.cancelled, true);
  assert.equal(run.ledger.activeCount, 0);
});

test("the confirmation deadline counts monotonic time: a 1.2 s wall step forward does not expire a 5 s deadline at 4 s", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const bot = new TimedDiggingBot(600);
  const run = await startBreak(bot, breakStep(12));
  await clock.advance(4_000);
  clock.stepWallClock(1_200);
  for (const tick of bot.ticks) tick();
  await nextTurn();
  assert.equal(run.ledger.activeCount, 1, "the physics tick's clock reading is monotonic: 4 s in, 1 s to go");
  await clock.advance(1_000);
  const result = await run.execution;
  assert.equal(result.kind, "failed");
  assert.match(JSON.stringify(result), /Server confirmation deadline elapsed/);
});

test("a block that never changes expires at the longer deadline, with the step failing on the confirmation", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const fake = createFakeBot({ clock });
  const bot = Object.assign(new TimedDiggingBot(FLOATING_ANDESITE_MS), { worldAge: () => fake.bot.time.age });
  const run = await startBreak(bot, breakStep(12));
  // The first +20 packet past the 564-tick budget is at 29 s (+580 ticks).
  await clock.advance(28_975, 25);
  await nextTurn();
  assert.equal(run.ledger.activeCount, 1, "not expired a moment before the deadline");
  await clock.advance(50, 25);
  const result = await run.execution;
  assert.equal(result.kind, "failed");
  assert.match(JSON.stringify(result), /Server confirmation deadline elapsed/);
  assert.equal(run.ledger.activeCount, 0);
});
