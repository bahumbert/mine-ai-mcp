/**
 * The confirmation deadline of a break in a route: it covers the body's real dig time (Mineflayer's `digTime` with the
 * water and ground penalties), not only the dry grounded price the route was planned at. Live 2026-10-19 (Sana,
 * floating in a flooded nook): a 14.1 s dig outlived the 5 s minimum twice and the failed-edge memory shut her in.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FakeNavigationBot, flatWorld, movementStep, routePlan } from "../../test-support/navigation.js";
import type { EffectHandle } from "../bot.js";
import type { PlannedOperation, PlannedStep } from "../movements/movement.js";
import { ExpectedMutationLedger } from "./mutations.js";
import { OpenedPassages } from "./opened-passages.js";
import { RouteExecutor } from "./route-executor.js";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const BREAK_AT = { x: 1, y: 63, z: 0 };
const FLOATING_ANDESITE_MS = 14_100;
const MINIMUM_DEADLINE_MS = 5_000;

/** A ledger that remembers the deadline each expectation was given. */
class DeadlineLedger extends ExpectedMutationLedger {
  readonly deadlines: number[] = [];
  override expect(input: Parameters<ExpectedMutationLedger["expect"]>[0]) {
    this.deadlines.push(input.deadlineMs);
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
  const startedAt = Date.now();
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
  return { ledger, deadlineIn: ledger.deadlines[0]! - startedAt, execution, abort: () => controller.abort() };
}

/** The deadline is `expected` ms after the start, give or take the time the test itself took. */
function assertDeadlineIn(actual: number, expected: number, message: string) {
  assert.ok(actual >= expected && actual < expected + 1_000, `${message}: ${actual} ms, wanted ${expected}`);
}

test("a dry grounded dig keeps the 5 s minimum deadline", async () => {
  const run = await startBreak(new TimedDiggingBot(600), breakStep(12));
  assertDeadlineIn(run.deadlineIn, MINIMUM_DEADLINE_MS, "dry dig");
  run.abort();
  await run.execution;
});

test("a floating dig of 14.1 s gets twice its dig time", async () => {
  const bot = new TimedDiggingBot(FLOATING_ANDESITE_MS);
  const run = await startBreak(bot, breakStep(12));
  assertDeadlineIn(run.deadlineIn, 2 * FLOATING_ANDESITE_MS, "floating dig");
  assert.equal((bot.asked[0] as { position: unknown }).position, BREAK_AT, "asked about the operation it runs");
  run.abort();
  await run.execution;
});

test("a planned cost above the real dig time still sets the deadline", async () => {
  const run = await startBreak(new TimedDiggingBot(600), breakStep(400));
  assertDeadlineIn(run.deadlineIn, 2 * 400 * 50, "planned 20 s");
  run.abort();
  await run.execution;
});

test("a falling column's settling time is added on top of the dig time", async () => {
  const brings = [{ x: 1, y: 64, z: 0 }, { x: 1, y: 65, z: 0 }];
  const run = await startBreak(new TimedDiggingBot(FLOATING_ANDESITE_MS), breakStep(12, brings));
  assertDeadlineIn(run.deadlineIn, 2 * FLOATING_ANDESITE_MS + 2 * 3_000, "floating dig under a column");
  run.abort();
  await run.execution;
});

test("an unloaded block keeps the planned deadline", async () => {
  const run = await startBreak(new TimedDiggingBot(null), breakStep(12));
  assertDeadlineIn(run.deadlineIn, MINIMUM_DEADLINE_MS, "unloaded block");
  run.abort();
  await run.execution;
});

test("a bot that cannot tell its dig time keeps the planned deadline", async () => {
  const run = await startBreak(new DiggingBot(), breakStep(12));
  assertDeadlineIn(run.deadlineIn, MINIMUM_DEADLINE_MS, "bot without longestBreakDurationMs");
  run.abort();
  await run.execution;
});

test("a cancel during the long dig ends the step at once and leaves no expectation behind", async () => {
  const bot = new TimedDiggingBot(FLOATING_ANDESITE_MS);
  const run = await startBreak(bot, breakStep(12));
  const before = Date.now();
  run.abort();
  assert.equal((await run.execution).kind, "cancelled");
  assert.ok(Date.now() - before < 1_000, "the 28 s deadline does not hold the cancel");
  assert.equal(bot.cancelled, true);
  assert.equal(run.ledger.activeCount, 0);
});

test("a block that never changes expires at the longer deadline, with the step failing on the confirmation", async () => {
  const run = await startBreak(new TimedDiggingBot(FLOATING_ANDESITE_MS), breakStep(12));
  run.ledger.expire(run.ledger.deadlines[0]! - 1);
  await nextTurn();
  assert.equal(run.ledger.activeCount, 1, "not expired a moment before the deadline");
  run.ledger.expire(run.ledger.deadlines[0]!);
  const result = await run.execution;
  assert.equal(result.kind, "failed");
  assert.match(JSON.stringify(result), /Server confirmation deadline elapsed/);
  assert.equal(run.ledger.activeCount, 0);
});
