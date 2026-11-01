import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "../../test-support/fake-bot/index.js";
import { FakeNavigationBot, flatWorld } from "../../test-support/navigation.js";
import { monotonicNow } from "../../utils/monotonic-clock.js";
import { airMatcher, stateMatcher } from "../movements/movement.js";
import { ExpectedMutationLedger } from "./mutations.js";
import { executeWorldEffect } from "./world-effect.js";

for (const failure of ["timeout", "conflict"] as const) {
  test(`a world effect stops and drains on ${failure}, without physics ticks`, async () => {
    const world = flatWorld();
    const position = { x: 0, y: 64, z: 0 };
    world.load(position, { stateId: 1 });
    const ledger = new ExpectedMutationLedger();
    const unsubscribe = world.subscribe((change) => ledger.classify(change, new Set(), monotonicNow()));
    const bot = new FakeNavigationBot();
    let finish!: () => void;
    let cancellations = 0;
    bot.startEffect = () => ({
      issued: true,
      completion: new Promise((resolve) => { finish = () => resolve({ kind: "failed", observation: "stopped" }); }),
      cancel: () => { cancellations++; finish(); },
    });
    try {
      const pending = executeWorldEffect({
        bot, ledger, signal: new AbortController().signal,
        token: { runId: "run", planId: "plan", stepId: "break", attempt: 1 },
        operation: { kind: "break", position, expectedStateId: 1, toolType: null, brings: [] },
        targets: [{ position, before: stateMatcher(1), after: airMatcher }],
        deadlineMs: monotonicNow() + (failure === "timeout" ? 10 : 1_000),
      });
      if (failure === "conflict") world.load(position, { stateId: 2 });
      const { result } = await pending;
      assert.equal(result.kind, failure === "timeout" ? "expired" : "conflicting");
      assert.equal(cancellations, 1);
      assert.equal(ledger.activeCount, 0);
      assert.equal(bot.ticks.size, 0);
    } finally { unsubscribe(); }
  });
}

test("a world effect's confirmation deadline is monotonic time: it expires 3 s later though the wall clock stepped back 0.8 s", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const world = flatWorld();
  const position = { x: 0, y: 64, z: 0 };
  world.load(position, { stateId: 1 });
  const bot = new FakeNavigationBot();
  bot.startEffect = () => {
    let finish!: () => void;
    return {
      issued: true,
      completion: new Promise((resolve) => { finish = () => resolve({ kind: "failed", observation: "stopped" }); }),
      cancel: () => finish(),
    };
  };
  const deadlineMs = monotonicNow() + 3_000;
  clock.stepWallClock(-800);
  let settled: string | null = null;
  const pending = executeWorldEffect({
    bot, ledger: new ExpectedMutationLedger(), signal: new AbortController().signal,
    token: { runId: "run", planId: "plan", stepId: "break", attempt: 1 },
    operation: { kind: "break", position, expectedStateId: 1, toolType: null, brings: [] },
    targets: [{ position, before: stateMatcher(1), after: airMatcher }],
    deadlineMs,
  }).then(({ result }) => { settled = result.kind; });
  await clock.advance(2_900);
  assert.equal(settled, null, "not expired a moment before the deadline");
  await clock.advance(100);
  assert.equal(settled, "expired", "expired at 3 s of clock");
  await pending;
});
