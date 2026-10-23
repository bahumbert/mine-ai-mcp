// navigation run: physics stopped, a bot carried by a current, repeated arrivals and an abandoned run that wakes late.
import { exactBlockGoal, nearGoal } from "../goals/index.js";
import type { PlannedStep } from "../movements/movement.js";
import { createMovementCatalogue, type MovementCatalogue } from "../movements/catalogue.js";
import { createNavigator } from "./navigator.js";
import assert from "node:assert/strict";
import test from "node:test";
import { FakeNavigationBot, flatWorld, observation, onEvent, settle } from "../../test-support/navigation.js";
import { type FakeClock, createFakeClock } from "../../test-support/fake-bot/index.js";
import { walking, EARLY_COMMIT } from "./navigation-run-fixtures.test.js";

/** The clock a run waiting on the fake clock may take before the test calls it stuck. */
const RUN_LIMIT_MS = 60_000;

/** A bot whose physics stopped: its landing wait settles only on the signal it is given, as one with no physics tick does. */
function stabilizeUntilAborted(bot: FakeNavigationBot) {
  bot.stabilize = (signal: AbortSignal) =>
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}

// ── Arrival is judged once, in the foreground ────────────────────────────────

/** A bot whose first step carries the body to `landing` at once (a push, a current), then takes `walkMs` of `clock` to report it done. */
class CarriedBot extends FakeNavigationBot {
  inFlight = false;
  carried = false;
  constructor(
    readonly landing: { readonly x: number; readonly y: number; readonly z: number },
    readonly walkMs: number,
    readonly clock: FakeClock,
  ) {
    super();
  }
  override async prepareMovement(step: PlannedStep) {
    if (this.carried) {
      this.arrive(step.to);
      return { kind: "completed", arrival: step.to } as const;
    }
    this.carried = true;
    this.arrive(this.landing);
    this.inFlight = true;
    await this.clock.sleep(this.walkMs);
    this.inFlight = false;
    return { kind: "completed", arrival: step.to } as const;
  }
}

/** A monotonic clock that reads `stepMs` later at every look, so a run's "twenty seconds" take a few looks. */
function steppingClock(stepMs: number): () => number {
  let now = 0;
  return () => (now += stepMs);
}

/** An arrival that waits a moment of `clock`, as work with a physics tick does, then asks to go on. */
const idleArrival = (clock: FakeClock) => async () => {
  await clock.sleep(5);
  return { kind: "continue" } as const;
};

test("an airborne start with physics stopped fails unstable within about two seconds", async () => {
  const bot = new FakeNavigationBot();
  bot.current = { ...bot.current, stance: "airborne" };
  stabilizeUntilAborted(bot);
  // The landing wait is a wall-clock wait of the run's own: the clock moves it.
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const startedAt = clock.now();
  const outcome = await clock.settle(settle(createNavigator({ world: flatWorld(), bot }), {
    goal: exactBlockGoal({ x: 3, y: 63, z: 0 }),
    policy: walking(),
  }), RUN_LIMIT_MS);
  const waited = clock.now() - startedAt;
  assert.equal(outcome.kind, "failed");
  assert.ok(waited >= 1_800 && waited < 3_000, `failed after ${waited} ms`);
  if (outcome.kind === "failed" && outcome.failure.kind === "movement_failed" && outcome.failure.movement.kind === "unstable")
    assert.match(outcome.failure.movement.observation, /No physics tick for 2 s while airborne/);
  else assert.fail(`expected an unstable movement failure, got ${JSON.stringify(outcome)}`);
  assert.equal(outcome.evidence.cleanup.listeners, 0);
});

test("a body the server holds in the air has its cell resent through the run, lands, and walks to the goal", async () => {
  const world = flatWorld();
  world.load({ x: 0, y: 62, z: 0 }, { stateId: 0 });
  const bot = new FakeNavigationBot();
  bot.current = { ...bot.current, stance: "airborne" };
  let asked = 0;
  bot.requestCellResync = async () => {
    asked += 1;
    world.load({ x: 0, y: 62, z: 0 }, { stateId: 1 });
    return "resent";
  };
  bot.stabilize = async () => {
    if (asked === 0) return { kind: "failed", observation: "No stable stance was observed; last position 0.50,63.00,0.50, stance=airborne." };
    bot.current = observation();
    return { kind: "stable" };
  };
  const outcome = await settle(createNavigator({ world, bot }), { goal: exactBlockGoal({ x: 3, y: 63, z: 0 }), policy: walking() });
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome.kind === "failed" ? outcome.failure : outcome));
  assert.equal(asked, 1, "the cell was asked for once");
});

test("a search overtaken by an impulse with physics stopped still releases its hold", async () => {
  const bot = new FakeNavigationBot();
  let holding = false;
  let hit = false;
  bot.holdPosition = () => {
    holding = true;
    return () => {
      holding = false;
    };
  };
  stabilizeUntilAborted(bot);
  const navigator = createNavigator({
    world: flatWorld(),
    bot,
    telemetry: onEvent((event) => {
      if (!hit && event.kind === "search_started") {
        hit = true;
        bot.current = { ...bot.current, stance: "airborne" };
      }
    }),
  });
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const outcome = await clock.settle(settle(navigator, { goal: nearGoal({ x: 5, y: 63, z: 0 }, 0), policy: walking() }), RUN_LIMIT_MS);
  assert.equal(hit, true);
  assert.notEqual(outcome.kind, "completed");
  assert.equal(holding, false, "the hold is released although the landing could not be observed");
  assert.equal(outcome.evidence.cleanup.listeners, 0);
  assert.equal(navigator.active, null);
});

test("the plan-ahead search never runs the arrival work while a segment is walked", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const actuator = new CarriedBot({ x: 5, y: 63, z: 0 }, 200, clock);
  actuator.current = observation(-5);
  const arrivals: boolean[] = [];
  const outcome = await clock.settle(settle(createNavigator({ world: flatWorld(), bot: actuator }), {
    goal: exactBlockGoal({ x: 5, y: 63, z: 0 }),
    policy: walking(),
    searchLimits: EARLY_COMMIT,
    onArrival: () => {
      arrivals.push(actuator.inFlight);
      return { kind: "completed" };
    },
  }), RUN_LIMIT_MS);
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(arrivals, [false], "the arrival work ran once, with no movement in flight");
});

test("a goal reached at a step's end drains the plan-ahead search before the arrival work", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const actuator = new CarriedBot({ x: 5, y: 63, z: 0 }, 0, clock);
  actuator.current = observation(-5);
  const real = createMovementCatalogue();
  let continuationId: string | null = null;
  const finished = new Set<string>();
  // Each expansion of the continuation costs more than a slice's budget, so it is still running when the step ends.
  const catalogue: MovementCatalogue = {
    generate(state, context, digContext) {
      const until = performance.now() + 20;
      while (performance.now() < until) {
        /* burn one slice */
      }
      return real.generate(state, context, digContext);
    },
  };
  const order: string[] = [];
  const outcome = await clock.settle(settle(
    createNavigator({
      world: flatWorld(),
      bot: actuator,
      catalogue,
      telemetry: onEvent((event) => {
        if (event.kind === "search_started" && event.reason === "segment_continuation" && continuationId === null)
          continuationId = event.searchId;
        if (event.kind === "search_finished") finished.add(event.searchId);
      }),
    }),
    {
      goal: exactBlockGoal({ x: 5, y: 63, z: 0 }),
      policy: walking(),
      searchLimits: EARLY_COMMIT,
      continuationSearchLimits: { primaryTimeoutMs: 60_000, failureTimeoutMs: 60_000 },
      onArrival: () => {
        order.push(continuationId !== null && finished.has(continuationId) ? "drained" : "running");
        return { kind: "completed" };
      },
    },
  ), RUN_LIMIT_MS);
  assert.equal(outcome.kind, "completed");
  assert.notEqual(continuationId, null, "expected a continuation to have started");
  assert.deepEqual(order, ["drained"]);
});

// ── Loops the pinned watch cannot end ────────────────────────────────────────

test("a swimmer carried by a current with searches slower than the drift settles drifting instead of looping", async () => {
  const actuator = new FakeNavigationBot();
  actuator.current = observation(-5);
  let carriedTo = -5;
  // Every slice the current moves the body one block on: each search starts from a cell the body has already left.
  const navigator = createNavigator({
    world: flatWorld(),
    bot: actuator,
    now: steppingClock(4_000),
    telemetry: onEvent((event) => {
      if (event.kind === "search_slice") actuator.current = observation(++carriedTo);
    }),
  });
  const outcome = await settle(navigator, { goal: nearGoal({ x: 5, y: 63, z: 5 }, 0), policy: walking() });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed" && outcome.failure.kind === "no_progress") {
    assert.equal(outcome.failure.reason, "drifting");
    assert.match(outcome.failure.observation, /^Carried \d+ blocks in \d+ s/);
  } else assert.fail(`expected a drifting failure, got ${JSON.stringify(outcome.kind)}`);
});

test("after drifting the next navigate plans from where the body is", async () => {
  const actuator = new FakeNavigationBot();
  actuator.current = observation(-5);
  let carriedTo = -5;
  let carrying = true;
  const navigator = createNavigator({
    world: flatWorld(),
    bot: actuator,
    now: steppingClock(4_000),
    telemetry: onEvent((event) => {
      if (carrying && event.kind === "search_slice") actuator.current = observation(++carriedTo);
    }),
  });
  const first = await settle(navigator, { goal: nearGoal({ x: 5, y: 63, z: 5 }, 0), policy: walking() });
  assert.equal(first.kind, "failed");
  carrying = false;
  const goalCell = { x: carriedTo + 1, y: 63, z: 0 };
  const next = await settle(navigator, { goal: exactBlockGoal(goalCell), policy: walking() });
  assert.equal(next.kind, "completed");
  assert.equal(actuator.current.position.x, goalCell.x + 0.5);
});

test("an airborne body at a satisfied stance whose arrival never acts fails repeated_arrival within six seconds", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const actuator = new FakeNavigationBot();
  actuator.current = { ...observation(), stance: "airborne" };
  let calls = 0;
  const navigator = createNavigator({ world: flatWorld(), bot: actuator, now: steppingClock(1_000) });
  const outcome = await clock.settle(settle(navigator, {
    goal: exactBlockGoal({ x: 0, y: 63, z: 0 }),
    policy: walking(),
    onArrival: () => {
      calls += 1;
      return idleArrival(clock)();
    },
  }), RUN_LIMIT_MS);
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed" && outcome.failure.kind === "no_progress") {
    assert.equal(outcome.failure.reason, "repeated_arrival");
    assert.match(outcome.failure.observation, /changed nothing for \d+ s in the airborne stance/);
  } else assert.fail(`expected repeated_arrival, got ${outcome.kind}`);
  assert.ok(calls >= 3 && calls < 20, `${calls} arrival calls`);
});

test("after repeated_arrival the next navigate elsewhere starts", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const actuator = new FakeNavigationBot();
  actuator.current = { ...observation(), stance: "airborne" };
  const navigator = createNavigator({ world: flatWorld(), bot: actuator, now: steppingClock(1_000) });
  const first = await clock.settle(settle(navigator, {
    goal: exactBlockGoal({ x: 0, y: 63, z: 0 }),
    policy: walking(),
    onArrival: idleArrival(clock),
  }), RUN_LIMIT_MS);
  assert.equal(first.kind, "failed");
  actuator.current = observation();
  const next = await settle(navigator, { goal: exactBlockGoal({ x: 3, y: 63, z: 0 }), policy: walking() });
  assert.equal(next.kind, "completed");
  assert.equal(actuator.current.position.x, 3.5);
});

test("a mining arrival that digs each time is not cut", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const world = flatWorld();
  const navigator = createNavigator({ world, bot: new FakeNavigationBot(), now: steppingClock(1_000) });
  let digs = 0;
  const outcome = await clock.settle(settle(navigator, {
    goal: exactBlockGoal({ x: 0, y: 63, z: 0 }),
    policy: walking(),
    onArrival: async () => {
      digs += 1;
      // The block beside the bot changes every time, as a dig does.
      world.load({ x: 1, y: 64, z: 0 }, { stateId: digs % 2 });
      await clock.sleep(5);
      return digs < 8 ? ({ kind: "continue" } as const) : ({ kind: "completed" } as const);
    },
  }), RUN_LIMIT_MS);
  assert.equal(outcome.kind, "completed");
  assert.equal(digs, 8);
});

// ── An abandoned run cannot touch the next run's body ────────────────────────

test("an abandoned run that wakes later does not clear the next run's controls", async () => {
  class WalkingBot extends FakeNavigationBot {
    controls = new Set<string>();
    calls = 0;
    gates: Array<() => void> = [];
    entered: Array<() => void> = [];
    override get ownedControlCount() {
      return this.controls.size;
    }
    override clearOwnedControls() {
      this.controls.clear();
    }
    /** The first movement of each run holds `forward` until the test lets it finish, as a walk in flight does. */
    override async prepareMovement(step: PlannedStep) {
      this.calls += 1;
      if (this.calls <= 2) {
        this.controls.add("forward");
        this.entered.shift()?.();
        await new Promise<void>((resolve) => this.gates.push(resolve));
      }
      // The abandoned run's body is not moved by its wake-up: only the new run's walk arrives.
      if (this.calls !== 1) this.arrive(step.to);
      return { kind: "completed", arrival: step.to } as const;
    }
  }
  const actuator = new WalkingBot();
  const navigator = createNavigator({ world: flatWorld(), bot: actuator });
  const entered = () => new Promise<void>((resolve) => actuator.entered.push(resolve));

  const firstWalking = entered();
  const first = navigator.startRun({ goal: exactBlockGoal({ x: 3, y: 63, z: 0 }), policy: walking() });
  assert.equal(first.kind, "started");
  if (first.kind !== "started") return;
  await firstWalking;
  navigator.abandonActive("its owner is gone");
  assert.equal(actuator.controls.size, 0, "the abandoned run's controls are cleared when it is abandoned");

  const secondWalking = entered();
  const next = navigator.startRun({ goal: exactBlockGoal({ x: -2, y: 63, z: 0 }), policy: walking() });
  assert.equal(next.kind, "started");
  if (next.kind !== "started") return;
  await secondWalking;
  assert.equal(actuator.controls.has("forward"), true);

  // The old run wakes (its tick came back) and unwinds: it must not clear what the new run holds.
  actuator.gates.shift()?.();
  assert.equal((await first.handle.outcome).kind, "stopped");
  assert.equal(actuator.controls.has("forward"), true, "the new run still holds its control");

  actuator.gates.shift()?.();
  assert.equal((await next.handle.outcome).kind, "completed");
});
