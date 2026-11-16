import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { FakeNavigationBot, flatWorld } from "../../test-support/navigation.js";
import { monotonicNow } from "../../utils/monotonic-clock.js";
import { airMatcher, stateMatcher } from "../movements/movement.js";
import { ExpectedMutationLedger } from "./mutations.js";
import { executeWorldEffect } from "./world-effect.js";

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

/** Observe global poll handles separately from the fake clock's own scheduled callbacks. */
function trackPollIntervals() {
  const start = globalThis.setInterval;
  const clear = globalThis.clearInterval;
  const live = new Set<ReturnType<typeof setInterval>>();
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = start(...args);
    live.add(handle);
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
    live.delete(handle as ReturnType<typeof setInterval>);
    clear(handle);
  }) as typeof clearInterval;
  return {
    assertReleased() {
      assert.equal(live.size, 0, "the effect released every global polling interval");
    },
    [Symbol.dispose]() {
      for (const handle of live) clear(handle);
      globalThis.clearInterval = clear;
      globalThis.setInterval = start;
    },
  };
}

for (const scenario of ["late answer", "stopped clock", "abort", "on time"] as const) {
  test(`confirmation uses server age: ${scenario}`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    using intervals = trackPollIntervals();
    const fake = createFakeBot({ clock, server: { ticksPerSecond: scenario === "on time" ? 20 : 5 } });
    const world = flatWorld();
    const position = { x: 0, y: 64, z: 0 };
    world.load(position, { stateId: 1 });
    const bot = Object.assign(new FakeNavigationBot(), { worldAge: () => fake.bot.time.age });
    const ledger = new ExpectedMutationLedger();
    const unsubscribe = world.subscribe(change => ledger.classify(change, new Set(), monotonicNow()));
    const controller = new AbortController();
    let complete!: () => void;
    bot.startEffect = () => ({
      issued: true,
      completion: new Promise(resolve => { complete = () => resolve({ kind: "accepted" }); }),
      cancel: () => complete(),
    });
    if (scenario === "stopped clock") fake.server.stop();
    let result: string | undefined;
    const pending = executeWorldEffect({
      bot, ledger, signal: controller.signal,
      token: { runId: "run", planId: "plan", stepId: "break", attempt: 1 },
      operation: { kind: "break", position, expectedStateId: 1, toolType: null, brings: [] },
      targets: [{ position, before: stateMatcher(1), after: airMatcher }],
      deadlineTicks: 100,
    }).then(outcome => { result = outcome.result.kind; });
    try {
      if (scenario === "late answer") {
        await clock.advance(12_000);
        assert.equal(fake.bot.time.age, 24_060);
        assert.equal(result, undefined, "60 server ticks at 12 s are within the 100 tick budget");
        world.load(position, { stateId: 0 });
        complete();
        await pending;
        assert.equal(result, "confirmed");
      } else if (scenario === "abort") {
        await clock.advance(3_000);
        controller.abort("stop");
        await pending;
        assert.equal(result, "cancelled");
      } else {
        const expiresAt = scenario === "stopped clock" ? 20_000 : 5_000;
        await clock.advance(expiresAt - 25, 25);
        assert.equal(result, undefined, "no physics tick or world change drives expiry");
        await clock.advance(50, 25);
        await pending;
        assert.equal(result, "expired");
        assert.equal(fake.bot.time.age, scenario === "stopped clock" ? 24_000 : 24_100);
      }
      intervals.assertReleased();
    } finally {
      controller.abort();
      await pending;
      unsubscribe();
    }
  });
}

test("poll interval tracking restores the global timers after the clock is disposed", () => {
  assert.equal(globalThis.setInterval, originalSetInterval);
  assert.equal(globalThis.clearInterval, originalClearInterval);
});

for (const failure of ["timeout", "conflict"] as const) {
  test(`a world effect stops and drains on ${failure}, without physics ticks`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
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
        deadlineTicks: failure === "timeout" ? 1 : 20,
      });
      if (failure === "conflict") world.load(position, { stateId: 2 });
      else await clock.advance(50, 25);
      const { result } = await pending;
      assert.equal(result.kind, failure === "timeout" ? "expired" : "conflicting");
      assert.equal(cancellations, 1);
      assert.equal(ledger.activeCount, 0);
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
  clock.stepWallClock(-800);
  let settled: string | null = null;
  const pending = executeWorldEffect({
    bot, ledger: new ExpectedMutationLedger(), signal: new AbortController().signal,
    token: { runId: "run", planId: "plan", stepId: "break", attempt: 1 },
    operation: { kind: "break", position, expectedStateId: 1, toolType: null, brings: [] },
    targets: [{ position, before: stateMatcher(1), after: airMatcher }],
    deadlineTicks: 60,
  }).then(({ result }) => { settled = result.kind; });
  await clock.advance(2_900);
  assert.equal(settled, null, "not expired a moment before the deadline");
  await clock.advance(100);
  assert.equal(settled, "expired", "expired at 3 s of clock");
  await pending;
});
