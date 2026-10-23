import type { Goal } from "../goals/goal.js";
import { exactBlockGoal, nearGoal } from "../goals/index.js";
import { createMovementPolicy } from "../movements/policy.js";
import { createNavigator } from "./navigator.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FakeNavigationBot, flatWorld, observation, onEvent, settle } from "../../test-support/navigation.js";
import { createFakeClock } from "../../test-support/fake-bot/index.js";
import { timeoutSignal } from "../../utils/wall-timers.js";
import { walking } from "./navigation-run-fixtures.test.js";

/** Each row breaks one thing a run depends on; the run must still release the navigator and say what failed. */
const BROKEN = [
  {
    name: "a failed control release",
    breakIt: (bot: FakeNavigationBot) => {
      bot.clearOwnedControls = () => {
        throw new Error("control release failed");
      };
    },
    message: "control release failed",
    lastEvents: ["cleanup_completed", "run_settled"],
  },
  {
    name: "a failed world subscription",
    breakIt: (_bot: FakeNavigationBot, world: ReturnType<typeof flatWorld>) => {
      world.subscribe = () => {
        throw new Error("world subscription failed");
      };
    },
    message: "world subscription failed",
  },
  {
    name: "a failed goal and a failed cleanup",
    breakIt: (bot: FakeNavigationBot) => {
      bot.clearOwnedControls = () => {
        throw new Error("control release failed");
      };
    },
    goal: {
      resolve() {
        throw new Error("goal resolution failed");
      },
    } satisfies Goal,
    message: "goal resolution failed; cleanup failed: control release failed",
  },
];

test("repeated start invalidation settles as planning_stalled and releases the navigation owner", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const bot = new FakeNavigationBot();
  bot.current = { ...bot.current, position: { ...bot.current.position, x: 0.99 } };
  const world = flatWorld();
  let retries = 0;
  const navigator = createNavigator({ world, bot, telemetry: onEvent((event) => {
    if (event.kind === "search_started") {
      now += 4_000;
      if (event.reason === "start_changed") retries++;
    }
    if (event.kind === "search_slice")
      bot.current = { ...bot.current, position: { ...bot.current.position, x: bot.current.position.x < 1 ? 1.01 : 0.99 } };
  }) });
  const outcome = await settle(navigator, { goal: exactBlockGoal({ x: 6, y: 63, z: 0 }), policy: walking() });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed" || outcome.failure.kind !== "no_progress") assert.fail(JSON.stringify(outcome));
  assert.equal(outcome.failure.reason, "planning_stalled");
  assert.ok(retries >= 3);
  assert.equal(outcome.evidence.plans, 0);
  assert.equal(navigator.active, null);
  assert.equal(world.listenerCount, 0);
  assert.deepEqual(outcome.evidence.cleanup, { listeners: 0, controls: 0, expectations: 0 });
});

// ── Admission, stopping, and cleanup ─────────────────────────────────────────

test("the service admits one run and settles from observed final state", async () => {
  const world = flatWorld();
  const actuator = new FakeNavigationBot();
  const navigator = createNavigator({ world, bot: actuator, createId: () => "run-1" });
  const admission = navigator.startRun({ goal: exactBlockGoal({ x: 2, y: 63, z: 0 }), policy: createMovementPolicy() });
  assert.equal(admission.kind, "started");
  assert.equal(
    navigator.startRun({ goal: exactBlockGoal({ x: 1, y: 63, z: 0 }), policy: createMovementPolicy() }).kind,
    "busy",
  );
  if (admission.kind !== "started") return;
  const outcome = await admission.handle.outcome;
  assert.equal(outcome.kind, "completed");
  assert.equal(actuator.current.position.x, 2.5);
  assert.equal(navigator.active, null);
  assert.equal(world.listenerCount, 0);
  // Measured after cleanup, so a leak would show here rather than being hidden.
  assert.deepEqual(outcome.evidence.cleanup, { listeners: 0, controls: 0, expectations: 0 });
});

// Run 14b: a route whose owner was gone waited for a physics tick for good; its admission must not outlive it.
test("an abandoned run frees admission at once, and its aborted control stops it when it wakes", async () => {
  const world = flatWorld();
  const actuator = new FakeNavigationBot();
  let id = 0;
  const navigator = createNavigator({ world, bot: actuator, createId: () => `run-${++id}` });
  const first = navigator.startRun({ goal: exactBlockGoal({ x: 2, y: 63, z: 0 }), policy: createMovementPolicy() });
  assert.equal(first.kind, "started");
  navigator.abandonActive("its owner is gone");
  assert.equal(navigator.active, null);
  const next = navigator.startRun({ goal: exactBlockGoal({ x: -2, y: 63, z: 0 }), policy: createMovementPolicy() });
  assert.equal(next.kind, "started");
  if (first.kind !== "started" || next.kind !== "started") return;
  assert.equal((await first.handle.outcome).kind, "stopped");
  assert.equal((await next.handle.outcome).kind, "completed");
  assert.equal(actuator.current.position.x, -1.5, "only the new run moved the body");
});

test("a run stops in the words of whoever asked, before it moves, and a timeout reads as a timeout", async () => {
  const far = { goal: exactBlockGoal({ x: 6, y: 63, z: 0 }), policy: createMovementPolicy() };

  const caller = new AbortController();
  caller.abort("the requested quantity is in the inventory");
  const bot = new FakeNavigationBot();
  const byCaller = await settle(createNavigator({ world: flatWorld(), bot }), { ...far, signal: caller.signal });
  assert.equal(byCaller.kind, "stopped");
  if (byCaller.kind === "stopped") assert.equal(byCaller.reason, "the requested quantity is in the inventory");
  assert.equal(bot.current.position.x, 0.5);

  const clock = createFakeClock({ mode: "mocked" });
  let timeout: AbortSignal;
  {
    using _timers = clock.install();
    timeout = timeoutSignal(0);
    await clock.advance(10);
  }
  const byTimeout = await settle(createNavigator({ world: flatWorld(), bot: new FakeNavigationBot() }), {
    ...far,
    signal: timeout,
  });
  assert.equal(byTimeout.kind, "stopped");
  if (byTimeout.kind === "stopped") assert.equal(byTimeout.reason, "navigation timeout");

  const world = flatWorld();
  const navigator = createNavigator({ world, bot: new FakeNavigationBot() });
  const admission = navigator.startRun(far);
  assert.equal(admission.kind, "started");
  if (admission.kind !== "started") return;
  navigator.cancelActive("operator stop");
  const byOperator = await admission.handle.outcome;
  assert.equal(byOperator.kind, "stopped");
  if (byOperator.kind === "stopped") assert.equal(byOperator.reason, "operator stop");
  assert.equal(navigator.active, null);
  assert.equal(world.listenerCount, 0);
  assert.equal(byOperator.evidence.cleanup.listeners, 0);
});

test("a run that cannot set up or clean up reports why, releases the navigator, and admits the next run", async () => {
  for (const row of BROKEN) {
    const world = flatWorld();
    const bot = new FakeNavigationBot();
    const events: string[] = [];
    const navigator = createNavigator({ world, bot, telemetry: onEvent((event) => events.push(event.kind)) });
    const request = { goal: row.goal ?? exactBlockGoal({ x: 0, y: 63, z: 0 }), policy: createMovementPolicy() };
    const pristine = { subscribe: world.subscribe.bind(world), clearOwnedControls: bot.clearOwnedControls };
    row.breakIt(bot, world);

    const outcome = await settle(navigator, request);
    assert.equal(outcome.kind, "failed", row.name);
    if (outcome.kind !== "failed") continue;
    assert.deepEqual(outcome.failure, { kind: "internal_error", message: row.message }, row.name);
    assert.equal(outcome.evidence.cleanup.listeners, 0, row.name);
    assert.equal(world.listenerCount, 0, row.name);
    assert.equal(navigator.active, null, row.name);
    if (row.lastEvents) assert.deepEqual(events.slice(-2), row.lastEvents, row.name);

    world.subscribe = pristine.subscribe;
    bot.clearOwnedControls = pristine.clearOwnedControls;
    assert.equal(
      (await settle(navigator, { ...request, goal: exactBlockGoal({ x: 0, y: 63, z: 0 }) })).kind,
      "completed",
      row.name,
    );
  }
});

test("cancelling a stationary search releases its position hold", async () => {
  const bot = new FakeNavigationBot();
  const abort = new AbortController();
  let holding = false;
  bot.holdPosition = () => {
    holding = true;
    return () => {
      holding = false;
    };
  };
  const navigator = createNavigator({
    world: flatWorld(),
    bot,
    telemetry: onEvent((event) => {
      if (event.kind === "search_started") {
        assert.equal(holding, true);
        abort.abort("cancel during calculation");
      }
    }),
  });
  const outcome = await settle(navigator, {
    goal: nearGoal({ x: 5, y: 63, z: 0 }, 0),
    policy: createMovementPolicy(),
    signal: abort.signal,
  });
  assert.equal(outcome.kind, "stopped");
  assert.equal(holding, false);
});

for (const cancelled of [false, true]) {
  test(`an airborne search retains its hold until landing before ${cancelled ? "cancellation" : "replanning"}`, async () => {
    const bot = new FakeNavigationBot();
    const abort = new AbortController();
    let holding = false;
    let hit = false;
    let landed = false;
    bot.holdPosition = () => {
      holding = true;
      return () => {
        holding = false;
      };
    };
    bot.stabilize = async () => {
      assert.equal(holding, true, "the search must not relinquish steering during knockback");
      bot.current = observation();
      landed = true;
      return { kind: "stable" };
    };
    const navigator = createNavigator({
      world: flatWorld(),
      bot,
      telemetry: onEvent((event) => {
        if (!hit && event.kind === "search_started") {
          hit = true;
          bot.current = { ...bot.current, stance: "airborne" };
          if (cancelled) abort.abort("reflex requested body during knockback");
        }
      }),
    });
    const outcome = await settle(navigator, {
      goal: nearGoal({ x: 5, y: 63, z: 0 }, 0),
      policy: createMovementPolicy(),
      signal: abort.signal,
    });
    assert.equal(outcome.kind, cancelled ? "stopped" : "completed");
    assert.equal(landed, true);
    assert.equal(holding, false);
  });
}

test("an arrival cancelled by observed pickup is stopped rather than an internal error", async () => {
  const abort = new AbortController();
  const errors: unknown[] = [];
  const navigator = createNavigator({
    world: flatWorld(),
    bot: new FakeNavigationBot(),
    telemetry: { emit: () => undefined, error: (_runId, cause) => errors.push(cause) },
  });
  const outcome = await settle(navigator, {
    goal: exactBlockGoal({ x: 0, y: 63, z: 0 }),
    policy: createMovementPolicy(),
    signal: abort.signal,
    onArrival: () => {
      abort.abort("the requested quantity is in the inventory");
      abort.signal.throwIfAborted();
      return { kind: "completed" };
    },
  });
  assert.equal(outcome.kind, "stopped");
  assert.deepEqual(errors, []);
});

test("a plan-ahead search that arrives after the caller stopped the run rejects nothing unhandled", () => {
  // Live 2026-10-09: the runtime exited on the bare abort reason of a mining
  // route. The scenario runs in a child process so the runtime's own verdict
  // on an unhandled rejection is what is asserted.
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./continuation-abort.fixture.ts", import.meta.url))], {
    encoding: "utf8",
  });
  const output = `${child.stdout}${child.stderr}`;
  assert.match(output, /OUTCOME stopped arrivals=1/u, output);
  assert.doesNotMatch(output, /UNHANDLED|ERROR/u, output);
  assert.equal(child.status, 0, output);
});
