// navigation run: continuations under one navigation, plan-ahead searches and goals revised mid-run.
import type { Goal } from "../goals/goal.js";
import { exactBlockGoal, itemPickupGoal, nearEntityGoal, nearGoal } from "../goals/index.js";
import type { PlannedStep } from "../movements/movement.js";
import { createMovementCatalogue, type MovementCatalogue } from "../movements/catalogue.js";
import type { NavigationObservation } from "../world/world.js";
import { createNavigator } from "./navigator.js";
import assert from "node:assert/strict";
import test from "node:test";
import { FakeNavigationBot, flatWorld, observation, onEvent, settle } from "../../test-support/navigation.js";
import { walking, EARLY_COMMIT, OvershootingBot } from "./navigation-run-fixtures.test.js";

// ── A goal that changes while the run is under way ───────────────────────────

function movingEntityObservation(playerX: number, targetX: number): NavigationObservation {
  return {
    ...observation(playerX),
    entities: new Map([[7, { id: 7, position: { x: targetX + 0.5, y: 63, z: 0.5 }, width: 0.25, height: 0.25 }]]),
  };
}

class MovingEntityBot extends FakeNavigationBot {
  targetX = 5;
  moveAfterFirstStep = false;
  moved = false;

  constructor() {
    super();
    this.current = movingEntityObservation(0, this.targetX);
  }

  moveTargetTo(targetX: number) {
    this.targetX = targetX;
    this.current = movingEntityObservation(this.current.position.x - 0.5, targetX);
  }

  removeTarget() {
    this.current = observation(this.current.position.x - 0.5);
  }

  override async prepareMovement(step: PlannedStep) {
    this.current = movingEntityObservation(step.to.x, this.targetX);
    if (this.moveAfterFirstStep && !this.moved) {
      this.moved = true;
      this.moveTargetTo(4);
    }
    this.arrive(step.to, this.current);
    return { kind: "completed", arrival: step.to } as const;
  }
}

/**
 * The target moves, or vanishes, on the first search slice. A search limit
 * that expires on the first node makes the stale answer the only one on
 * offer, and the revised goal must win over it.
 */
const PLANNING_REVISIONS = [
  { change: "moves nearby", target: 4, searchLimits: undefined, expect: { kind: "completed", slices: null, x: null } },
  {
    change: "moves onto the bot",
    target: 0,
    searchLimits: { failureTimeoutMs: 0 },
    expect: { kind: "completed", slices: 1, x: 0.5 },
  },
  {
    change: "disappears",
    target: null,
    searchLimits: { failureTimeoutMs: 0 },
    expect: { kind: "failed", slices: 1, x: null },
  },
] as const;

// ── Continuing under one run ─────────────────────────────────────────────────

test("a non-terminal arrival continues under the same navigation run", async () => {
  const actuator = new FakeNavigationBot();
  let destination = 1;
  const events: string[] = [];
  const goal: Goal = {
    resolve(observed) {
      return exactBlockGoal({ x: destination, y: 63, z: 0 }).resolve(observed);
    },
  };
  const navigator = createNavigator({
    world: flatWorld(),
    bot: actuator,
    createId: () => "continuous-process",
    telemetry: onEvent((event) => {
      if (event.kind === "run_started") events.push("run");
      if (event.kind === "search_started") events.push(`search:${event.reason}`);
      if (event.kind === "goal_arrived") events.push(`arrival:${event.result}`);
    }),
  });
  const outcome = await settle(navigator, {
    goal,
    policy: walking(),
    onArrival: () => {
      if (destination === 1) {
        destination = 2;
        return { kind: "continue" };
      }
      return { kind: "completed" };
    },
  });

  assert.equal(outcome.kind, "completed");
  if (outcome.kind !== "completed") return;
  assert.equal(actuator.current.position.x, 2.5);
  assert.equal(outcome.evidence.searches, 2);
  assert.equal(outcome.evidence.continuations, 1);
  assert.equal(outcome.evidence.replans, 0);
  assert.deepEqual(events, [
    "run",
    "search:initial",
    "arrival:continue",
    "search:arrival_continuation",
    "arrival:completed",
  ]);
});

test("a calculation failure can revise a process goal under the same navigation run", async () => {
  let destination = 5;
  const events: string[] = [];
  const goal: Goal = {
    resolve(observed) {
      return exactBlockGoal({ x: destination, y: 63, z: 0 }).resolve(observed);
    },
  };
  const navigator = createNavigator({
    world: flatWorld(),
    bot: new FakeNavigationBot(),
    createId: () => "continuous-failure",
    telemetry: onEvent((event) => {
      if (event.kind === "run_started") events.push("run");
      if (event.kind === "search_started") events.push(`search:${event.reason}`);
      if (event.kind === "calculation_failed") events.push(`failure:${event.result}`);
    }),
  });
  const outcome = await settle(navigator, {
    goal,
    policy: walking(),
    searchLimits: { primaryTimeoutMs: 0, failureTimeoutMs: 0 },
    onCalculationFailure: () => {
      destination = 0;
      return { kind: "continue" };
    },
  });

  assert.equal(outcome.kind, "completed");
  assert.deepEqual(events, ["run", "search:initial", "failure:continue"]);
});

test("the next segment is searched for while the current one is being walked", async () => {
  // Baritone plans ahead for the same reason: a search that runs while the bot
  // is walking costs nothing it was going to spend standing still. The proof is
  // ordering — the continuation must be under way before the segment it follows
  // has finished being executed, not afterwards.
  const actuator = new FakeNavigationBot();
  actuator.current = observation(-5);
  const order: string[] = [];
  let holding = false;
  actuator.holdPosition = () => {
    assert.equal(holding, false);
    holding = true;
    return () => {
      holding = false;
    };
  };
  const navigator = createNavigator({
    world: flatWorld(),
    bot: actuator,
    createId: () => "plan-ahead",
    telemetry: onEvent((event) => {
      if (event.kind === "search_started") {
        assert.equal(holding, event.reason !== "segment_continuation");
        order.push(`search:${event.reason}`);
      }
      if (event.kind === "route_committed") {
        assert.equal(holding, false, "stationary controls must release before execution");
        order.push("committed");
      }
      if (event.kind === "step_completed") order.push("step");
    }),
  });
  await settle(navigator, { goal: nearGoal({ x: 5, y: 63, z: 0 }, 0), policy: walking(), searchLimits: EARLY_COMMIT });
  assert.equal(holding, false);

  // Serially every search is separated from the next by the segment it produced:
  // `search, committed, step..., search`. Planning ahead starts the follow-up as
  // soon as the segment is in hand, so two searches meet with no execution
  // between them — which cannot happen while searching and walking take turns.
  const overlapped = order.some(
    (entry, index) => entry.startsWith("search:") && (order[index + 1] ?? "").startsWith("search:"),
  );
  assert.ok(overlapped, `expected a continuation to start before its segment finished: ${order.join(", ")}`);
});

test("a continuation the bot did not arrive at is stopped, not waited for", async () => {
  // The plan-ahead search runs under the larger budget. When the route ends
  // somewhere other than where that search assumed, its answer is useless and
  // the run must not stand still until it is finished. The proof is how many
  // slices the continuation gets: a stopped search ends within one slice of
  // the route ending, while an awaited one runs to its answer.
  const actuator = new OvershootingBot(2);
  actuator.current = observation(-5);
  const real = createMovementCatalogue();
  let slow = false;
  // Each expansion of the continuation costs more than a slice's budget, so an
  // awaited continuation would need one slice per node on the way to the goal.
  const catalogue: MovementCatalogue = {
    generate(state, context, digContext) {
      if (slow) {
        const until = performance.now() + 20;
        while (performance.now() < until) {
          /* burn one slice */
        }
      }
      return real.generate(state, context, digContext);
    },
  };
  let continuationId: string | null = null;
  let continuationSlices = 0;
  const abandoned: string[] = [];
  const navigator = createNavigator({
    world: flatWorld(),
    bot: actuator,
    catalogue,
    createId: () => "abandoned",
    telemetry: onEvent((event) => {
      if (event.kind === "search_started") {
        // Only the first continuation is under test; the replanned route
        // starts a second, legitimate one that is walked to and used.
        if (event.reason === "segment_continuation" && continuationId === null) continuationId = event.searchId;
        slow = event.searchId === continuationId;
      }
      if (event.kind === "search_slice" && event.searchId === continuationId) continuationSlices += 1;
      if (event.kind === "continuation_abandoned") abandoned.push(event.observation);
    }),
  });
  const outcome = await settle(navigator, {
    goal: nearGoal({ x: 5, y: 63, z: 0 }, 0),
    policy: walking(),
    searchLimits: EARLY_COMMIT,
    continuationSearchLimits: { primaryTimeoutMs: 60_000, failureTimeoutMs: 60_000 },
  });

  assert.equal(outcome.kind, "completed");
  assert.notEqual(continuationId, null, "expected a continuation to have started");
  assert.equal(abandoned.length, 1, "the abandoned plan-ahead result is reported once, with why");
  assert.ok(
    continuationSlices <= 3,
    `expected the abandoned continuation to stop within a slice, but it ran ${continuationSlices} slices`,
  );
});

test("a failed plan-ahead search recalculates inline from the reached endpoint", async () => {
  const actuator = new FakeNavigationBot();
  actuator.current = observation(-5);
  const outcome = await settle(
    createNavigator({ world: flatWorld(), bot: actuator, createId: () => "continuation-budget" }),
    {
      goal: nearGoal({ x: 5, y: 63, z: 0 }, 0),
      policy: walking(),
      searchLimits: EARLY_COMMIT,
      continuationSearchLimits: { primaryTimeoutMs: 0, failureTimeoutMs: 0 },
    },
  );

  assert.equal(outcome.kind, "completed");
  assert.ok(outcome.evidence.continuations >= 1);
  assert.ok(outcome.evidence.replans >= 1);
});

test("a goal revised during planning keeps a route whose terminal state still satisfies it, or ends the run if it is gone", async () => {
  for (const row of PLANNING_REVISIONS) {
    const actuator = new MovingEntityBot();
    let revised = false;
    const navigator = createNavigator({
      world: flatWorld(),
      bot: actuator,
      telemetry: onEvent((event) => {
        if (revised || event.kind !== "search_slice") return;
        revised = true;
        if (row.target === null) actuator.removeTarget();
        else actuator.moveTargetTo(row.target);
      }),
    });
    const outcome = await settle(navigator, {
      goal: nearEntityGoal({ id: 7 }, 2),
      policy: walking(),
      searchLimits: row.searchLimits,
    });
    assert.equal(outcome.kind, row.expect.kind, row.change);
    assert.equal(revised, true, row.change);
    assert.equal(outcome.evidence.searches, 1, row.change);
    assert.equal(outcome.evidence.replans, 0, row.change);
    if (row.expect.slices !== null) assert.equal(outcome.evidence.searchSlices, row.expect.slices, row.change);
    if (row.expect.x !== null) assert.equal(actuator.current.position.x, row.expect.x, row.change);
    if (outcome.kind === "failed") assert.equal(outcome.failure.kind, "invalid_goal", row.change);
  }
});

test("a target oscillating between two cells is not mistaken for a repeated search", async () => {
  // A dropped item can cross a cell boundary and cross back while the bot is
  // still planning and has not moved. Each abandoned search used to leave its
  // identity behind, so the third round matched the first and the run failed
  // with `repeated_search` having never taken a step. Removing the settling
  // wait before pickup made that reachable in ordinary play.
  const actuator = new MovingEntityBot();
  let flips = 0;
  const navigator = createNavigator({
    world: flatWorld(),
    bot: actuator,
    createId: () => "oscillating-goal",
    telemetry: onEvent((event) => {
      if (event.kind !== "search_slice" || flips >= 4) return;
      flips += 1;
      actuator.moveTargetTo(flips % 2 === 1 ? 4 : 5);
    }),
  });
  const outcome = await settle(navigator, {
    // An exact-cell goal, so a flip genuinely invalidates the route it was
    // planned for. A range goal would simply retain the plan and never reach
    // the ledger this guards.
    goal: itemPickupGoal({ id: 7 }),
    policy: walking(),
  });
  // Three flips is the smallest number that returns the target to its first
  // cell, which is the repeat the guard has to tell apart. How many more happen
  // depends on how many search slices the machine fits in before arrival.
  assert.ok(flips >= 3, `expected the target to flip at least three times, saw ${flips}`);
  assert.equal(outcome.kind, "completed");
});

test("a goal revised during execution keeps a route whose terminal state still satisfies it", async () => {
  const actuator = new MovingEntityBot();
  actuator.moveAfterFirstStep = true;
  const outcome = await settle(
    createNavigator({ world: flatWorld(), bot: actuator, createId: () => "execution-revision" }),
    {
      goal: nearEntityGoal({ id: 7 }, 2),
      policy: walking(),
    },
  );
  assert.equal(outcome.kind, "completed");
  assert.equal(actuator.moved, true);
  assert.equal(outcome.evidence.searches, 1);
  assert.equal(outcome.evidence.replans, 0);
});

test("a revised goal retains a partial route that never promised to reach the old goal", async () => {
  const actuator = new FakeNavigationBot();
  actuator.current = observation(-5);
  const destination = exactBlockGoal({ x: 5, y: 63, z: 0 });
  let revised = false;
  let partialRouteObserved = false;
  const goal: Goal = {
    resolve(observed) {
      const snapshot = destination.resolve(observed);
      return snapshot.kind === "invalid"
        ? snapshot
        : { ...snapshot, revision: revised ? "same-target:latest" : "same-target:planned" };
    },
  };
  const navigator = createNavigator({
    world: flatWorld(),
    bot: actuator,
    createId: () => "partial-goal-revision",
    telemetry: onEvent((event) => {
      if (event.kind === "route_committed" && !event.plan.complete) partialRouteObserved = true;
      if (event.kind === "step_completed") revised = true;
    }),
  });
  const outcome = await settle(navigator, { goal, policy: walking(), searchLimits: EARLY_COMMIT });

  assert.equal(outcome.kind, "completed");
  assert.equal(partialRouteObserved, true);
  assert.equal(revised, true);
  assert.equal(outcome.evidence.replans, 0);
  assert.equal(actuator.current.position.x, 5.5);
});

test("a discovered target replaces a partial exploration route that now leads away", async () => {
  const world = flatWorld();
  for (let x = 6; x <= 30; x += 1)
    for (let z = -5; z <= 5; z += 1) {
      world.load({ x, y: 62, z }, { stateId: 1 });
      for (let y = 63; y <= 65; y += 1) world.load({ x, y, z }, { stateId: 0 });
    }
  const actuator = new FakeNavigationBot();
  const destination = exactBlockGoal({ x: -3, y: 63, z: 0 });
  let discovered = false;
  let firstEndpoint = 0;
  let furthestX = 0;
  const goal: Goal = {
    resolve(observed) {
      return discovered
        ? destination.resolve(observed)
        : { kind: "active", revision: "exploring-east", isSatisfied: () => false, heuristic: (node) => -node.feet.x };
    },
  };
  const navigator = createNavigator({
    world,
    bot: actuator,
    telemetry: onEvent((event) => {
      if (event.kind === "route_committed" && !discovered) firstEndpoint = event.plan.end.x;
      if (event.kind === "step_completed") {
        discovered = true;
        furthestX = Math.max(furthestX, actuator.current.position.x);
      }
    }),
  });
  const outcome = await settle(navigator, { goal, policy: walking(), searchLimits: EARLY_COMMIT });
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  assert.ok(firstEndpoint > 1, "the original partial route contains more than the discovery step");
  assert.ok(furthestX < firstEndpoint, "replan before walking to the obsolete exploration endpoint");
  assert.equal(outcome.evidence.replans, 1);
  assert.equal(actuator.current.position.x, -2.5);
});
