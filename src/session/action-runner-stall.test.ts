// ActionRunner: the stall watch on an action that owns the body with no physics tick.
import { getAmbientHighlighterContext } from "@aibengineering/minecraft-block-highlighter";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createFakeClock } from "../test-support/fake-bot/index.js";
import { ActionRunner } from "./action-runner.js";
import { stubAction } from "./action-runner-fixtures.test.js";

/** Physics ticks the test drives: each one reaches the runner's watch and the stub actions' waits. */
function tickSource(runner: ActionRunner) {
  const ticks = new EventEmitter();
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    next: (signal: AbortSignal) => new Promise<void>((resolve) => {
      ticks.once("tick", resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
    start: () => {
      timer ??= setInterval(() => { runner.observePhysicsTick(); ticks.emit("tick"); }, 10);
    },
    stop: () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

test("an action without a highlighter skips collection display work", async () => {
  let visited = 0;
  const action = stubAction(async () => {
    assert.equal(getAmbientHighlighterContext()?.enabled, false);
    const position = { get x() { visited++; return 0; }, y: 0, z: 0 };
    await [position].toHighlightableBlocks().highlight("#ffffff");
    return { status: "succeeded" };
  });
  const output = await new ActionRunner().run(action, { block_name: "stone" });
  assert.equal(output.result.status, "succeeded");
  assert.equal(visited, 0);
});

// Run 14: twelve bots left mounted at sea never ticked again; their navigate waited for a tick for ever and ignored its cancel.
test("an action that owns the body with no physics tick fails RUNTIME_PHYSICS_STALLED and releases the body", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runner = new ActionRunner({ physicsStallMs: 80, cancelGraceMs: 40 });
  const action = stubAction(() => new Promise<never>(() => {}));
  const running = runner.run(action, { block_name: "stone" });
  // Past the 80 ms without a tick and the 40 ms of grace the stopped action gets.
  await clock.advance(300);
  const output = await running;
  assert.equal(output.result.status, "failed");
  assert.match("error" in output.result ? output.result.error ?? "" : "", /RUNTIME_PHYSICS_STALLED/);
  assert.equal(runner.status().busy, false);
  // The next action starts at once on the freed body.
  const next = stubAction(async () => ({ status: "succeeded" }));
  assert.equal((await runner.run(next, { block_name: "stone" })).result.status, "succeeded");
});

test("an action that keeps getting physics ticks is not stalled, however long it waits", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runner = new ActionRunner({ physicsStallMs: 80 });
  const ticking = setInterval(() => runner.observePhysicsTick(), 10);
  try {
    const action = stubAction(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { status: "succeeded" };
    });
    const running = runner.run(action, { block_name: "stone" });
    await clock.advance(300, 10);
    assert.equal((await running).result.status, "succeeded");
  } finally {
    clearInterval(ticking);
  }
});

test("a passenger owes no physics tick, an idle runner is never failed", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  let riding = true;
  const runner = new ActionRunner({ physicsStallMs: 40, physicsExpected: () => !riding });
  const action = stubAction(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { status: "succeeded" };
  });
  const running = runner.run(action, { block_name: "stone" });
  await clock.advance(200);
  assert.equal((await running).result.status, "succeeded");
  riding = false;
  await clock.advance(150);
  assert.equal(runner.status().busy, false);
});

// Run 20 (Vex): a 36 s ride, then a get-off; the silence of the ride was counted and the navigate failed before its first tick.
test("an action that was a passenger for longer than the stall limit is not stalled by the ride when it ticks after the get-off", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  let riding = true;
  const runner = new ActionRunner({ physicsStallMs: 40, physicsExpected: () => !riding });
  let ticking: ReturnType<typeof setInterval> | null = null;
  try {
    const action = stubAction(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      riding = false;
      ticking = setInterval(() => runner.observePhysicsTick(), 20);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { status: "succeeded" };
    });
    const running = runner.run(action, { block_name: "stone" });
    await clock.advance(300, 10);
    assert.equal((await running).result.status, "succeeded");
  } finally {
    if (ticking !== null) clearInterval(ticking);
  }
});

test("a cancelled action that cannot stop for want of ticks settles as cancelled, and the next action runs", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runner = new ActionRunner({ physicsStallMs: 10_000, cancelGraceMs: 60 });
  let entered!: () => void;
  const running = new Promise<void>((resolve) => { entered = resolve; });
  const action = stubAction(async () => {
    entered();
    return new Promise<never>(() => {});
  });
  const pending = runner.run(action, { block_name: "stone" });
  await running;
  runner.cancelActive("stop");
  // The watch of a 10 s limit checks every 250 ms: it sees the cancel at one check and the 60 ms of grace gone at the next.
  await clock.advance(600);
  const output = await pending;
  assert.equal(output.result.status, "cancelled");
  // The model is told the stop is done, or it repeats it (review V5).
  assert.match("error" in output.result ? output.result.error ?? "" : "", /the next action may start/);
  assert.equal(runner.status().busy, false);
  const next = stubAction(async () => ({ status: "succeeded" }));
  assert.equal((await runner.run(next, { block_name: "stone" })).result.status, "succeeded");
});

// Run 14b (review V2): the stall released the body but left the old navigate running; it held the navigation for good.
test("a stalled action's signal is aborted with the stall reason", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runner = new ActionRunner({ physicsStallMs: 80, cancelGraceMs: 40 });
  let seen: AbortSignal | undefined;
  const action = stubAction((_request, context) => {
    seen = context.signal;
    return new Promise<never>(() => {});
  });
  const running = runner.run(action, { block_name: "stone" });
  await clock.advance(300);
  const output = await running;
  assert.equal(output.result.status, "failed");
  assert.equal(seen?.aborted, true);
  assert.match(seen?.reason instanceof Error ? seen.reason.message : String(seen?.reason), /RUNTIME_PHYSICS_STALLED/);
});

// Run 14b: physics stopped after a ride; the old navigate woke when ticks came back and steered beside the new one.
test("ticks resume after a stall: the old action stops before the body is released, and only the new action moves", async () => {
  const moves: string[] = [];
  let stalls = 0;
  let oldStopped = false;
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  // The runtime's recovery turns physics back on: here, the ticks start.
  const runner = new ActionRunner({ physicsStallMs: 80, cancelGraceMs: 2_000, onPhysicsStall: () => { stalls += 1; source.start(); } });
  const source = tickSource(runner);
  try {
    // Waits for ticks that do not come; when they come back it moves, unless it was stopped.
    const old = stubAction(async (_request, context) => {
      for (;;) {
        await source.next(new AbortController().signal);
        if (context.signal?.aborted) {
          oldStopped = true;
          return { status: "failed", error: "stopped" };
        }
        moves.push("old");
      }
    });
    const stalled = runner.run(old, { block_name: "stone" });
    await clock.advance(300, 10);
    const output = await stalled;
    assert.equal(output.result.status, "failed");
    assert.match("error" in output.result ? output.result.error ?? "" : "", /RUNTIME_PHYSICS_STALLED/);
    assert.equal(stalls, 1);
    assert.equal(oldStopped, true, "the old action settled before the body was released");
    const next = stubAction(async (_request, context) => {
      for (let step = 0; step < 3; step += 1) {
        await source.next(context.signal ?? new AbortController().signal);
        moves.push("new");
      }
      return { status: "succeeded" };
    });
    const moving = runner.run(next, { block_name: "stone" });
    await clock.advance(50, 10);
    assert.equal((await moving).result.status, "succeeded");
    assert.deepEqual(moves, ["new", "new", "new"]);
  } finally {
    source.stop();
  }
});

// Review V3: WSL resyncs its wall clock after the host wakes; the watch must not read that step as 60 s without a tick.
test("a 60 s wall clock step fails nothing while ticks come", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runner = new ActionRunner({ physicsStallMs: 200 });
  const realNow = Date.now;
  let paused = false;
  const ticking = setInterval(() => { if (!paused) runner.observePhysicsTick(); }, 10);
  try {
    const action = stubAction(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stepped = realNow() + 60_000;
      const startedReal = realNow();
      Date.now = () => stepped + (realNow() - startedReal);
      // A gap between ticks shorter than the limit but longer than a check: a wall clock watch fails here.
      paused = true;
      await new Promise((resolve) => setTimeout(resolve, 120));
      paused = false;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { status: "succeeded" };
    });
    const running = runner.run(action, { block_name: "stone" });
    await clock.advance(300, 10);
    assert.equal((await running).result.status, "succeeded");
  } finally {
    Date.now = realNow;
    clearInterval(ticking);
  }
});
