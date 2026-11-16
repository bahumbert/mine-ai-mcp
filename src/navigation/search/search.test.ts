import assert from "node:assert/strict";
import test from "node:test";
import { WELL_FED, flatWorld, observation, planningStart } from "../../test-support/navigation.js";
import type { PlanningNode, ResolvedGoal } from "../goals/goal.js";
import { exactBlockGoal } from "../goals/index.js";
import {
  type GeneratedMovement,
  type MovementCatalogue,
  type PlanningState,
  createMovementCatalogue,
} from "../movements/catalogue.js";
import { movementList } from "../movements/movement-candidates.js";
import { createMovementPolicy } from "../movements/policy.js";
import { DEFAULT_CONTINUATION_SEARCH_LIMITS, DEFAULT_SEARCH_LIMITS } from "../navigate.js";
import type { StepField } from "../step-field.js";
import { ExpectedMutationLedger } from "../execution/mutations.js";
import { monotonicNow } from "../../utils/monotonic-clock.js";
import { MemoryWorld } from "../world/memory-world.js";
import { blockKey, type NavigationObservation } from "../world/world.js";
import type { SearchLimits } from "./search-result.js";
import { IncrementalSearch, type SearchUpdate } from "./search.js";

type ActiveGoal = Extract<ResolvedGoal, { kind: "active" }>;

const ORIGIN = { x: 0, y: 63, z: 0 };

/**
 * A clock that charges a search one millisecond per node it expands.
 *
 * A time budget has to be able to bite part-way through a slice, so a clock the
 * test only moves between `advance()` calls cannot express one. Charging per
 * expansion keeps the moment exact and repeatable, and reads the way the real
 * budget does: a search that expanded more nodes has spent more of it.
 */
function perExpansionClock(catalogue: MovementCatalogue) {
  let spent = 0;
  return {
    now: () => spent,
    /**
     * The budget that expires as the given expansion is examined. One less than
     * the count, because the budget is checked before that node's successors are
     * generated and so before it has been charged for.
     */
    atExpansion: (count: number) => count - 1,
    catalogue: {
      generate: (state, context, digContext) => {
        spent += 1;
        return catalogue.generate(state, context, digContext);
      },
    } satisfies MovementCatalogue,
  };
}

/** A catalogue whose edges are listed by hand. */
function stubCatalogue(edges: (state: PlanningState) => GeneratedMovement[]): MovementCatalogue {
  return { generate: (state) => movementList(edges(state)) };
}

function graphMovement(state: PlanningState, x: number, z: number, total: number): GeneratedMovement {
  const from = state.node.feet;
  const to = { x, y: from.y, z };
  return {
    step: {
      id: `${from.x},${from.z}>${x},${z}`,
      kind: "walk",
      from,
      to,
      validArrivals: [to],
      preconditions: [],
      operations: [{ kind: "move", movement: "walk", target: { x: x + 0.5, y: to.y, z: z + 0.5 } }],
      effects: [],
      cost: { expectedTicks: total, breakPenalty: 0, placementPenalty: 0, hazardPenalty: 0, total },
    },
    to,
    remainingScaffolds: state.node.remainingScaffolds,
    cost: total,
    state: {
      node: { ...state.node, feet: to },
      overlay: state.overlay,
    },
  };
}

/** A goal with the given estimate, unsatisfiable unless the fixture names its arrival. */
function goalOf(
  revision: string,
  heuristic: (node: PlanningNode) => number,
  isSatisfied: (node: PlanningNode) => boolean = () => false,
): ActiveGoal {
  return { kind: "active", revision, heuristic, isSatisfied };
}

/** One search over the given edges, from the origin of a flat world with the shipped policy. */
function searchOver(
  goal: ActiveGoal,
  catalogue: MovementCatalogue,
  options: {
    id?: string;
    scaffolds?: number;
    limits?: SearchLimits;
    now?: () => number;
    stepField?: StepField;
    world?: MemoryWorld;
    observedStart?: NavigationObservation;
  } = {},
): IncrementalSearch {
  return new IncrementalSearch({
    id: options.id ?? goal.revision,
    start: planningStart(ORIGIN, options.scaffolds ?? 0),
    goal,
    observedStart: options.observedStart,
    ...(options.limits ? { limits: options.limits } : {}),
    now: options.now ?? (() => 0),
    context: {
      world: options.world ?? flatWorld(),
      policy: createMovementPolicy(),
      player: WELL_FED,
      catalogue,
      ...(options.stepField ? { stepField: options.stepField } : {}),
    },
  });
}

test("finish receives an observed pose only for its actual root ancestry, including an edited root", () => {
  for (const observed of [true, false]) for (const edited of [true, false]) {
    const pose = { ...observation(), position: { x: 0.85, y: 63, z: 0.5 } };
    const start = planningStart(ORIGIN);
    const overlay = edited ? start.overlay.apply({ kind: "break", position: { x: 3, y: 64, z: 0 }, stateId: 0 }) : start.overlay;
    const seen: { x: number; overlay: string; actual?: NavigationObservation }[] = [];
    const goal = { ...goalOf("provenance", () => 0), finish: (state, _context, _dig, actual) => {
      seen.push({ x: state.node.feet.x, overlay: state.overlay.identity, actual });
      return null;
    } } satisfies ActiveGoal;
    const catalogue = stubCatalogue((state) => {
      if (state.node.feet.x === 0 && state.node.remainingScaffolds === 0) return [graphMovement(state, 1, 0, 1)];
      if (state.node.feet.x !== 1) return [];
      const returned = graphMovement(state, 0, 0, 1);
      const future = planningStart(ORIGIN, 1);
      return [{ ...returned, remainingScaffolds: 1, state: future }];
    });
    const search = new IncrementalSearch({ id: "ancestry", start: { node: { ...start.node, overlayId: overlay.identity }, overlay },
      goal, observedStart: observed ? pose : undefined, now: () => 0,
      context: { world: flatWorld(), policy: createMovementPolicy(), player: WELL_FED, catalogue } });
    search.advance();
    assert.equal(seen[0]?.actual, observed ? pose : undefined);
    assert.deepEqual(seen.map((call) => call.x), [0, 1, 0]);
    assert.equal(seen[2]?.overlay, start.overlay.identity, "an empty-overlay return is still a future node");
    assert.ok(seen.slice(1).every((call) => call.actual === undefined), "future nodes never inherit the root pose");
  }
});

test("the real catalogue routes around sole edge support while retaining centred descent", () => {
  const world = flatWorld();
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) {
    world.load({ x, y: 61, z }, { stateId: 1 });
    world.load({ x, y: 60, z }, { stateId: 1 });
  }
  world.load({ x: 0, y: 62, z: 0 }, { stateId: 0 });
  const target = { x: 1, y: 62, z: 0 };
  const goal = destination(target);
  for (const [x, observed] of [[0.85, true], [0.85, false], [1.5, true]] as const) {
    const position = { x, y: 63, z: 0.5 };
    const start = planningStart({ x: Math.floor(position.x), y: 63, z: 0 });
    const search = new IncrementalSearch({ id: "real-edge", start, goal,
      observedStart: observed ? { ...observation(), position } : undefined, now: () => 0,
      context: { world, catalogue: createMovementCatalogue(),
        policy: createMovementPolicy({ digTimeEstimator: { estimate: () => 1 } }), player: WELL_FED } });
    const { plan } = expect(search.advance(), "complete");
    const breaks = plan.steps[0]!.operations.filter((op) => op.kind === "break");
    assert.equal(breaks.some((op) => op.position.x === 1 && op.position.y === 62 && op.position.z === 0),
      !observed || x === 1.5, JSON.stringify(plan.steps));
  }
});

test("root support filtering keeps a safe sibling during expansion and reconstruction", () => {
  for (const { y, cellY } of [{ y: 64.0, cellY: 63 }, { y: 64.5, cellY: 64 }]) {
    const world = flatWorld();
    world.load({ x: 0, y: cellY, z: 0 }, { stateId: 0 });
    world.load({ x: 1, y: cellY, z: 0 }, { stateId: 1,
      collisionShapes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: y - cellY, maxZ: 1 }] });
    const pose = { ...observation(0, cellY + 1, 0), position: { x: 0.85, y, z: 0.5 } };
    const catalogue = stubCatalogue((state) => {
      if (state.node.feet.x !== 0) return [];
      const safe = graphMovement(state, 1, 0, 2);
      const unsafe = { ...safe, cost: 1, step: { ...safe.step, id: "unsafe", operations: [
        { kind: "break" as const, position: { x: 1, y: cellY, z: 0 }, expectedStateId: 1, toolType: null, brings: [], stance: state.node.feet },
        ...safe.step.operations,
      ] } };
      return [unsafe, safe];
    });
    for (const actual of [pose, undefined]) {
      const search = new IncrementalSearch({ id: "bank", start: planningStart({ x: 0, y: cellY + 1, z: 0 }),
        goal: goalOf("bank", () => 0, (node) => node.feet.x === 1), observedStart: actual, now: () => 0,
        context: { world, catalogue, policy: createMovementPolicy(), player: WELL_FED } });
      const plan = expect(search.advance(), "complete").plan;
      assert.equal(plan.steps[0]?.id, actual ? "0,0>1,0" : "unsafe");
    }
  }
});

/** The update carrying a route, asserting the search reached the named kind of answer. */
function expect(update: SearchUpdate, kind: "complete" | "segment_ready") {
  const described = JSON.stringify(update, (_key, value) => (value instanceof Map ? undefined : value))?.slice(0, 300);
  assert.equal(update.kind, kind, described);
  if (update.kind !== "complete" && update.kind !== "segment_ready") throw new Error(described);
  return update;
}

/** An active goal for a real destination, resolved from a standing observation. */
function destination(cell: { x: number; y: number; z: number }): ActiveGoal {
  const goal = exactBlockGoal(cell).resolve(observation());
  if (goal.kind !== "active") throw new Error(goal.observation);
  return goal;
}

test("a radius keeps every route that stays inside it, and a useful prefix of one that cannot", () => {
  // A branch that leaves the radius must not discard the valid route beside it.
  const detour = searchOver(
    goalOf(
      "inside",
      (node) => Math.abs(2 - node.feet.x) + Math.abs(1 - node.feet.z),
      (node) => node.feet.x === 2 && node.feet.z === 1,
    ),
    stubCatalogue((state) => {
      const { x, z } = state.node.feet;
      if (x === 0 && z === 0) return [graphMovement(state, 1, 0, 1), graphMovement(state, 0, 1, 10)];
      if (z === 0 && x < 3) return [graphMovement(state, x + 1, 0, 1)];
      if (z === 1 && x < 2) return [graphMovement(state, x + 1, 1, 1)];
      return [];
    }),
    { id: "radius-detour", limits: { maximumRadius: 2 } },
  );
  expect(detour.advance({ maximumMilliseconds: Infinity }), "complete");

  // A goal beyond the radius keeps the progress made toward it rather than none.
  const escape = searchOver(
    goalOf(
      "beyond",
      (node) => 60 - node.feet.x,
      (node) => node.feet.x === 60,
    ),
    stubCatalogue((state) => [graphMovement(state, state.node.feet.x + 1, 0, 1)]),
    { id: "radius-prefix", limits: { maximumRadius: 48 } },
  );
  assert.equal(expect(escape.advance({ maximumMilliseconds: Infinity }), "segment_ready").plan.end.x, 48);
});

test("terminal work competes with travel even when it can start at the root", () => {
  const goal: ActiveGoal = {
    ...goalOf("priced-work", () => 0),
    finish: (state) => graphMovement(state, state.node.feet.x, 0, state.node.feet.x === 0 ? 100 : 10),
  };
  const search = searchOver(
    goal,
    stubCatalogue((state) => (state.node.feet.x === 0 ? [graphMovement(state, 1, 0, 5)] : [])),
    { id: "work-cost" },
  );

  const { plan } = expect(search.advance(), "complete");
  assert.equal(plan.totalCost, 15);
  assert.equal(plan.end.x, 1);
  assert.equal(plan.steps.length, 2);
});

test("incremental A* finds the lowest-cost flat route without mutating its plan", () => {
  const search = searchOver(destination({ x: 3, y: 63, z: 0 }), createMovementCatalogue(), { id: "search" });

  const { plan } = expect(search.advance({ maximumExpansions: 1_000, maximumMilliseconds: 8 }), "complete");
  assert.equal(plan.end.x, 3);
  assert.equal(plan.totalCost, 12);
  assert.equal(
    plan.steps.every((step) => step.kind === "sprint"),
    true,
  );
  assert.equal(Object.isFrozen(plan.steps), true);
});

test("yielding an incremental search does not commit a premature route segment", () => {
  const search = searchOver(
    goalOf(
      "goal",
      (node) => 20 - node.feet.x,
      (node) => node.feet.x === 20,
    ),
    stubCatalogue((state) => (state.node.feet.x < 20 ? [graphMovement(state, state.node.feet.x + 1, 0, 1)] : [])),
    { id: "yield-without-segment", limits: { failureTimeoutMs: 100 } },
  );

  assert.equal(search.advance({ maximumExpansions: 8 }).kind, "progress");
  assert.equal(expect(search.advance({ maximumExpansions: 100 }), "complete").plan.steps.length, 20);
});

test("route reconstruction reads the catalogue as it stands, by destination and only as far as it still leads", () => {
  // The catalogue is regenerated during reconstruction, so a stale index into
  // it names the wrong movement once the order changes.
  let rootGenerations = 0;
  const reordered = searchOver(
    goalOf(
      "east",
      (node) => Math.abs(1 - node.feet.x) + Math.abs(node.feet.z),
      (node) => node.feet.x === 1 && node.feet.z === 0,
    ),
    stubCatalogue((state) => {
      if (state.node.feet.x !== 0 || state.node.feet.z !== 0) return [];
      rootGenerations += 1;
      const east = graphMovement(state, 1, 0, 1);
      const north = graphMovement(state, 0, -1, 1);
      return rootGenerations === 1 ? [east, north] : [north, east];
    }),
    { id: "reordered-reconstruction" },
  );
  assert.deepEqual(
    expect(reordered.advance({ maximumExpansions: 10, maximumMilliseconds: Infinity }), "complete").plan.steps.map(
      (step) => step.to,
    ),
    [{ x: 1, y: 63, z: 0 }],
  );

  // A movement that has become impossible cuts the route off where it stops.
  let middleGenerations = 0;
  const cutoff = searchOver(
    goalOf(
      "two-east",
      (node) => Math.abs(2 - node.feet.x),
      (node) => node.feet.x === 2,
    ),
    stubCatalogue((state) => {
      if (state.node.feet.x === 0) return [graphMovement(state, 1, 0, 1)];
      if (state.node.feet.x !== 1) return [];
      middleGenerations += 1;
      return middleGenerations === 1 ? [graphMovement(state, 2, 0, 1)] : [];
    }),
    { id: "cutoff-reconstruction" },
  );
  const { plan } = expect(cutoff.advance({ maximumExpansions: 10, maximumMilliseconds: Infinity }), "segment_ready");
  assert.equal(plan.complete, false);
  assert.deepEqual(
    plan.steps.map((step) => step.to),
    [{ x: 1, y: 63, z: 0 }],
  );
});

test("a bounded segment selects a useful full-length route before a cheaper one-step prefix", () => {
  const clock = perExpansionClock(
    stubCatalogue((state) => {
      const { x, z } = state.node.feet;
      if (x === 0 && z === 0) return [graphMovement(state, 1, 0, 1), graphMovement(state, 0, 1, 100)];
      if (z === 0 && x > 0 && x < 8) return [graphMovement(state, x + 1, 0, 1)];
      if (x === 0 && z > 0 && z < 9) return [graphMovement(state, 0, z + 1, 1)];
      return [];
    }),
  );
  const search = searchOver(
    goalOf("goal", (node) => (node.feet.z > 0 ? 9 - node.feet.z : node.feet.x > 0 ? 9 - node.feet.x : 10)),
    clock.catalogue,
    { id: "best-segment", limits: { failureTimeoutMs: clock.atExpansion(17) }, now: clock.now },
  );

  const { plan } = expect(search.advance({ maximumExpansions: 17, maximumMilliseconds: Infinity }), "segment_ready");
  assert.deepEqual(plan.end, { x: 8, y: 63, z: 0 });
  assert.equal(plan.steps.length, 8);
});

test("a partial detour keeps its useful endpoint instead of cutting before the turn away from the goal", () => {
  const clock = perExpansionClock(
    stubCatalogue((state) => {
      const { x, z } = state.node.feet;
      if (z === 0 && x > -16) return [graphMovement(state, x - 1, 0, 1)];
      if (z === 0) return [graphMovement(state, x, 1, 1)];
      return [graphMovement(state, x + 1, 1, 1)];
    }),
  );
  const search = searchOver(
    goalOf("goal", (node) => Math.hypot(node.feet.x - 40, node.feet.z - 1) * 4),
    clock.catalogue,
    { id: "detour-prefix", limits: { failureTimeoutMs: clock.atExpansion(58) }, now: clock.now },
  );

  const result = expect(search.advance({ maximumExpansions: 100, maximumMilliseconds: Infinity }), "segment_ready");
  assert.deepEqual(result.plan.end, result.checkpoint?.selected.position);
  assert.ok(result.plan.end.x > 0, "the committed detour must reach its selected progress beyond the initial retreat");
});

test("the short budget waits until there is something worth committing, then returns the best partial route", () => {
  // Baritone's two timeouts turn on its `failing` flag: while no node has
  // travelled far enough to be worth walking, the long budget applies, because
  // a search with nothing to fall back on has everything to lose by stopping.
  // The moment one has, more thinking competes with moving and the short budget
  // takes over. The floor is five blocks.
  const short = perExpansionClock(
    stubCatalogue((state) => (state.node.feet.x < 9 ? [graphMovement(state, state.node.feet.x + 1, 0, 1)] : [])),
  );
  // The short budget would have expired on the second node examined had it been
  // allowed to; it cannot apply until the search has walked the floor.
  const waiting = searchOver(
    goalOf("goal", (node) => 20 - node.feet.x),
    short.catalogue,
    {
      id: "two-tier-budget",
      limits: { primaryTimeoutMs: short.atExpansion(2), failureTimeoutMs: 1_000 },
      now: short.now,
    },
  );
  const waited = expect(waiting.advance({ maximumExpansions: 20, maximumMilliseconds: Infinity }), "segment_ready");
  assert.equal(waited.plan.end.x, 5);
  assert.equal(waited.checkpoint?.selectedBy, "long_progress");

  // Once it applies, the first eligible segment is the one that cleared the
  // floor: the three-step prefix has not travelled far enough to be a candidate.
  const capped = perExpansionClock(
    stubCatalogue((state) => (state.node.feet.x < 5 ? [graphMovement(state, state.node.feet.x + 1, 0, 1)] : [])),
  );
  const search = searchOver(
    goalOf("goal", (node) => 20 - node.feet.x),
    capped.catalogue,
    {
      id: "deepest-partial",
      limits: { primaryTimeoutMs: capped.atExpansion(4), failureTimeoutMs: capped.atExpansion(10) },
      now: capped.now,
    },
  );
  const { plan } = expect(search.advance({ maximumExpansions: 10, maximumMilliseconds: Infinity }), "segment_ready");
  assert.equal(plan.steps.length, 5);
  assert.equal(plan.end.x, 5);
});

test("a partial-route diagnostic does not skip the node being expanded", () => {
  const clock = perExpansionClock(
    stubCatalogue((state) => (state.node.feet.x < 2 ? [graphMovement(state, state.node.feet.x + 1, 0, 1)] : [])),
  );
  // Nothing here travels far enough to be worth committing, so the short budget
  // never applies and the long one is what reports.
  const search = searchOver(
    goalOf(
      "detour-goal",
      (node) => node.feet.x,
      (node) => node.feet.x === 2,
    ),
    clock.catalogue,
    { id: "diagnostic-is-observational", limits: { failureTimeoutMs: clock.atExpansion(2) }, now: clock.now },
  );

  const result = search.advance({ maximumExpansions: 10, maximumMilliseconds: Infinity });
  assert.equal(result.kind, "limit");
  if (result.kind !== "limit") return;
  assert.equal(result.checkpoint?.outcome, "no_progress_candidate");
  // The diagnostic describes the frontier including the node being expanded,
  // rather than the state as it stood before this expansion began.
  assert.equal(result.checkpoint?.closestGenerated?.position.x, 1);
});

test("a capped search retains a generated goal while cheaper-looking nodes remain open", () => {
  const clock = perExpansionClock(
    stubCatalogue((state) => {
      const { x, z } = state.node.feet;
      if (x === 0 && z === 0) return [graphMovement(state, 1, 0, 100), graphMovement(state, 0, 1, 1)];
      if (x === 0 && z > 0) return [graphMovement(state, 0, z + 1, 1)];
      return [];
    }),
  );
  const search = searchOver(
    goalOf(
      "goal",
      () => 0,
      (node) => node.feet.x === 1 && node.feet.z === 0,
    ),
    clock.catalogue,
    { id: "goal-incumbent", limits: { failureTimeoutMs: clock.atExpansion(2) }, now: clock.now },
  );

  const { plan } = expect(search.advance({ maximumExpansions: 2 }), "segment_ready");
  assert.deepEqual(plan.end, { x: 1, y: 63, z: 0 });
  assert.equal(plan.endNode.remainingScaffolds, 0);
});

test("search prunes an arrival that costs more and leaves fewer scaffolds", () => {
  let dominatedExpansions = 0;
  const movement = (state: PlanningState, x: number, cost: number, remainingScaffolds: number): GeneratedMovement => {
    const generated = graphMovement(state, x, 0, cost);
    return {
      ...generated,
      remainingScaffolds,
      state: { ...generated.state, node: { ...generated.state.node, remainingScaffolds } },
    };
  };
  const search = searchOver(
    goalOf(
      "goal",
      () => 0,
      (node) => node.feet.x === 2,
    ),
    stubCatalogue((state) => {
      if (state.node.feet.x === 0) return [movement(state, 1, 10, 1), movement(state, 1, 5, 2)];
      if (state.node.remainingScaffolds === 1) dominatedExpansions += 1;
      return [movement(state, 2, 100, state.node.remainingScaffolds)];
    }),
    { id: "scaffold-dominance", scaffolds: 2 },
  );

  expect(search.advance({ maximumExpansions: 10 }), "complete");
  assert.equal(dominatedExpansions, 0);
});

test("search can repair and reuse a staircase instead of committing a cheaper first excavation", () => {
  const catalogue = stubCatalogue((state) => {
    const { x, z } = state.node.feet;
    if (x === 0 && z === 0) return [graphMovement(state, 1, 0, 24), graphMovement(state, 0, 1, 33)];
    if (x === 1 && z === 0) return [graphMovement(state, 2, 0, 24)];
    if (x === 2 && z === 0) return [graphMovement(state, 3, 0, 24)];
    if (x === 0 && z === 1) return [graphMovement(state, 1, 1, 4)];
    if (x === 1 && z === 1) return [graphMovement(state, 3, 0, 4)];
    return [];
  });
  const heuristic = ({ feet }: PlanningNode): number => {
    if (feet.x === 3 && feet.z === 0) return 0;
    if (feet.x === 2 && feet.z === 0) return 6;
    if (feet.x === 1 && feet.z === 0) return 8;
    if (feet.x === 1 && feet.z === 1) return 4;
    return 10;
  };
  // The policy is unweighted, because this asks whether the search finds the
  // *cheapest* route — the staircase at 41 against the excavation at 72. That
  // is the shipped setting; extra weight above it is pure greediness and would
  // commit to the 72 route.
  const search = searchOver(
    goalOf("goal", heuristic, (node) => node.feet.x === 3 && node.feet.z === 0),
    catalogue,
    { id: "reuse-staircase", scaffolds: 1, limits: { failureTimeoutMs: 20 } },
  );

  const { plan } = expect(search.advance({ maximumExpansions: 20 }), "complete");
  assert.deepEqual(
    plan.steps.map((step) => step.to),
    [
      { x: 0, y: 63, z: 1 },
      { x: 1, y: 63, z: 1 },
      { x: 3, y: 63, z: 0 },
    ],
  );
  assert.equal(plan.totalCost, 41);
});

test("an incomplete segment follows configured cost instead of hidden scaffold preservation", () => {
  const clock = perExpansionClock(
    stubCatalogue((state) => {
      const { x, z } = state.node.feet;
      if (x !== 0 || z !== 0) return [];
      const consuming = graphMovement(state, 1, 0, 1);
      return [
        {
          ...consuming,
          remainingScaffolds: 0,
          state: { ...consuming.state, node: { ...consuming.state.node, remainingScaffolds: 0 } },
        },
        graphMovement(state, 0, 1, 2),
      ];
    }),
  );
  const search = searchOver(
    goalOf("goal", (node) => (node.feet.x === 1 ? 0 : node.feet.z === 1 ? 1 : 2)),
    clock.catalogue,
    { id: "preserve-scaffold", scaffolds: 1, limits: { failureTimeoutMs: clock.atExpansion(3) }, now: clock.now },
  );

  const { plan } = expect(search.advance({ maximumExpansions: 10, maximumMilliseconds: Infinity }), "segment_ready");
  assert.deepEqual(plan.end, { x: 1, y: 63, z: 0 });
});

test("a step field bends the route around what it prices", () => {
  // Two cells of open ground made expensive, with clear flat ground either
  // side of them: nothing is forbidden, so the only reason to leave the
  // straight line is the price.
  const search = searchOver(destination({ x: 5, y: 63, z: 0 }), createMovementCatalogue(), {
    id: "field",
    stepField: { costAt: (x, _y, z) => (z === 0 && x >= 2 && x <= 3 ? 40 : 0), fingerprint: "corridor" },
  });

  const { plan } = expect(search.advance({ maximumExpansions: 1_000, maximumMilliseconds: 8 }), "complete");
  const walked = plan.steps.map((step) => step.to);
  assert.ok(
    walked.every((cell) => !(cell.z === 0 && cell.x >= 2 && cell.x <= 3)),
    `the route walked through the priced cells: ${JSON.stringify(walked)}`,
  );
  // It still arrives. A field is a detour, not a refusal.
  assert.deepEqual(plan.steps.at(-1)?.to, { x: 5, y: 63, z: 0 });
});

test("the shipped limits are Baritone's inline and plan-ahead search timeouts", () => {
  assert.deepEqual(DEFAULT_SEARCH_LIMITS, { primaryTimeoutMs: 500, failureTimeoutMs: 2_000 });
  assert.deepEqual(DEFAULT_CONTINUATION_SEARCH_LIMITS, { primaryTimeoutMs: 4_000, failureTimeoutMs: 5_000 });
});

test("a timeout whose nearest node is within the minimum route distance of the start reports that distance (run 12 Y4, run 13 R10)", () => {
  // Everything reachable lies east while the goal lies west: no node ever beats the start.
  const clock = perExpansionClock(
    stubCatalogue((state) => (state.node.feet.x < 30 ? [graphMovement(state, state.node.feet.x + 1, 0, 1)] : [])),
  );
  const search = searchOver(
    goalOf("west", (node) => Math.abs(node.feet.x + 100) * 4),
    clock.catalogue,
    { id: "dead-end", limits: { failureTimeoutMs: clock.atExpansion(10) }, now: clock.now },
  );
  const update = search.advance({ maximumExpansions: 20, maximumMilliseconds: Infinity });
  assert.equal(update.kind, "limit");
  if (update.kind !== "limit") return;
  assert.equal(update.limit.closest.withinStartBlocks, 5);
  assert.deepEqual(update.limit.closest.position, { x: 0, y: 63, z: 0 });
});

test("a closest node 3 blocks from the start is within the minimum route distance, one 6 blocks away is not (run 13 R10)", () => {
  const run = (reach: number) => {
    const clock = perExpansionClock(
      stubCatalogue((state) => (state.node.feet.x < reach ? [graphMovement(state, state.node.feet.x + 1, 0, 1)] : [])),
    );
    const search = searchOver(
      goalOf("east", (node) => Math.abs(node.feet.x - 100) * 4),
      clock.catalogue,
      { id: `reach-${reach}`, limits: { failureTimeoutMs: clock.atExpansion(30) }, now: clock.now },
    );
    return search.advance({ maximumExpansions: 50, maximumMilliseconds: Infinity });
  };
  const near = run(3);
  assert.ok(near.kind === "no_path");
  assert.deepEqual(near.closest.position, { x: 3, y: 63, z: 0 });
  assert.equal(near.closest.withinStartBlocks, 5);
  const far = run(6);
  assert.ok(far.kind === "no_path");
  assert.deepEqual(far.closest.position, { x: 6, y: 63, z: 0 });
  assert.equal(far.closest.withinStartBlocks, undefined);
});

/** Edges between the listed (x, z) cells of the origin's level, each step one block in any of the four directions. */
function roomOf(cells: readonly (readonly [number, number])[]): MovementCatalogue {
  const inRoom = (x: number, z: number) => cells.some(([cx, cz]) => cx === x && cz === z);
  return stubCatalogue((state) => {
    const { x, z } = state.node.feet;
    return ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).flatMap(([dx, dz]) => (inRoom(x + dx, z + dz) ? [graphMovement(state, x + dx, z + dz, 1)] : []));
  });
}

const NOWHERE = goalOf("nowhere", () => 50);

test("an exhausted search reports the farthest visited node for its reachable room", () => {
  const cases = [
    { id: "pocket", cells: [[0, 0], [1, 0]] as const, visited: 2, farthest: 1 },
    { id: "cell", cells: [[0, 0]] as const, visited: 1, farthest: 0 },
    { id: "room", cells: [-1, 0, 1].flatMap((z) => [0, 1, 2].map((x) => [x, z] as const)), visited: 9, farthest: 2 },
  ];
  for (const row of cases) {
    const update = searchOver(NOWHERE, roomOf(row.cells), { id: row.id }).advance({ maximumExpansions: 100, maximumMilliseconds: Infinity });
    assert.equal(update.kind, "no_path", row.id);
    assert.deepEqual([update.evidence.visited, update.evidence.farthestVisited], [row.visited, row.farthest], row.id);
  }
});

test("the farthest visited node counts height as well as the level, and a search that succeeds or hits a limit reports it", () => {
  const corridor = stubCatalogue((state) => (state.node.feet.x < 4 ? [graphMovement(state, state.node.feet.x + 1, 0, 1)] : []));
  const complete = searchOver(goalOf("east", (node) => Math.abs(node.feet.x - 3) * 4, (node) => node.feet.x === 3), corridor, { id: "east" })
    .advance({ maximumExpansions: 100, maximumMilliseconds: Infinity });
  assert.equal(complete.kind, "complete");
  assert.equal(complete.evidence.farthestVisited, 3);
  const clock = perExpansionClock(corridor);
  const limited = searchOver(NOWHERE, clock.catalogue, { id: "limit", limits: { failureTimeoutMs: clock.atExpansion(3) }, now: clock.now })
    .advance({ maximumExpansions: 100, maximumMilliseconds: Infinity });
  assert.equal(limited.kind, "limit");
  assert.equal(limited.evidence.farthestVisited, 2);
  const climb = stubCatalogue((state) => (state.node.feet.y < 66 ? [{
    ...graphMovement(state, 0, 0, 1),
    to: { x: 0, y: state.node.feet.y + 1, z: 0 },
    state: { node: { ...state.node, feet: { x: 0, y: state.node.feet.y + 1, z: 0 } }, overlay: state.overlay },
  }] : []));
  const tall = searchOver(NOWHERE, climb, { id: "tall" }).advance({ maximumExpansions: 100, maximumMilliseconds: Infinity });
  assert.equal(tall.evidence.farthestVisited, 3);
});

/*
 * Lava that starts 3 cells from a route cell is outside the near-lava scan (2 cells), so the route gained no dependency
 * there; the flow reaches the cell beside the route one flow step before it fills the route cell (plan 2026-11-07-p4-06b
 * T3b). The lava dependencies are watched whatever lies near. The search reads no dimension: the Nether (flow every 10
 * ticks) changes when the flow arrives, not which cell is watched.
 */
test("lava flowing into a cell beside a route cell invalidates the route, for a flow that began 3 cells away", () => {
  const world = flatWorld();
  const lava = { stateId: 10, traits: { empty: true, liquid: "lava", liquidLevel: 8, damaging: true } } as const;
  world.load({ x: 1, y: 63, z: 3 }, lava);
  const done = expect(
    searchOver(destination({ x: 3, y: 63, z: 0 }), createMovementCatalogue(), { id: "beside-lava", world }).advance({
      maximumExpansions: 1_000,
      maximumMilliseconds: Infinity,
    }),
    "complete",
  );
  const beside = { x: 1, y: 63, z: 1 };
  assert.ok(done.plan.lavaDependencies.has(blockKey(beside)), "the cell beside the route is a lava dependency");
  assert.equal(done.plan.dependencies.has(blockKey(beside)), false, "and not a plain one: a non-lava change there is irrelevant");

  const before = world.blockAt(beside.x, beside.y, beside.z);
  world.load(beside, lava);
  const flow = { position: beside, before, after: world.blockAt(beside.x, beside.y, beside.z), worldRevision: world.revision };
  const ledger = new ExpectedMutationLedger();
  assert.equal(ledger.classify(flow, done.plan.dependencies, monotonicNow(), done.plan.lavaDependencies), "invalidating");
});
