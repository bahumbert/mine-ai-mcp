import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "../../test-support/fake-bot/index.js";
import { FakeNavigationBot, flatWorld } from "../../test-support/navigation.js";
import { airMatcher, stateMatcher } from "../movements/movement.js";
import { ExpectedMutationLedger } from "./mutations.js";
import { executeWorldEffect } from "./world-effect.js";

// Live 2026-10-11 (orders test, Vex, collect_block): the bot was teleported right after its dig timer fired. mineflayer's
// finishDigging() clears bot.targetDigBlock and then waits for a block update to air that never comes; stopDigging()
// returns at once when targetDigBlock is null, so the dig promise (the effect's `completion`) never settles and
// executeWorldEffect's `await completion` after a cancel or an expiry never returns. The action sat in "stopping" for
// 6 minutes, deaf to cancel_foreground_action and to its own 180 s stall guard.
test("a world effect whose completion never settles still returns after its cancel", async () => {
  const world = flatWorld();
  const position = { x: 0, y: 64, z: 0 };
  world.load(position, { stateId: 1 });
  const ledger = new ExpectedMutationLedger();
  const unsubscribe = world.subscribe((change) => ledger.classify(change, new Set(), Date.now()));
  const bot = new FakeNavigationBot();
  bot.startEffect = () => ({ issued: true, completion: new Promise(() => {}), cancel: () => {} });
  const abort = new AbortController();
  // The effect's deadline and its drain read the global timers: the clock moves them.
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  try {
    const pending = executeWorldEffect({
      bot, ledger, signal: abort.signal,
      token: { runId: "run", planId: "plan", stepId: "break", attempt: 1 },
      operation: { kind: "break", position, expectedStateId: 1, toolType: null, brings: [] },
      targets: [{ position, before: stateMatcher(1), after: airMatcher }],
      deadlineMs: Date.now() + 60_000,
    });
    let settled: Awaited<typeof pending> | undefined;
    void pending.then((outcome) => (settled = outcome));
    clock.after(20, () => abort.abort());
    // Past the 20 ms cancel and the drain (EFFECT_DRAIN_MS) the effect has to be over, 3 s of clock in all.
    await clock.advance(3_000);
    assert.notEqual(settled, undefined, "the effect still waits for its completion 3 s after the cancel");
    assert.equal(settled!.result.kind, "cancelled");
    assert.equal(ledger.activeCount, 0);
  } finally { unsubscribe(); }
});
