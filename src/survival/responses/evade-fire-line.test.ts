import assert from "node:assert/strict";
import test from "node:test";
import { createMovements } from "../../navigation/index.js";
import { safeFromEntitiesGoal, exactBlockGoal } from "../../navigation/goals/index.js";
import type { ResolvedGoal } from "../../navigation/goals/goal.js";
import { createMovementCatalogue } from "../../navigation/movements/catalogue.js";
import type { RoutePlan } from "../../navigation/movements/movement.js";
import type { MovementPolicy } from "../../navigation/movements/policy.js";
import type { SearchEvidence } from "../../navigation/search/search-result.js";
import { IncrementalSearch } from "../../navigation/search/search.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import type { BlockPosition, NavigationObservation } from "../../navigation/world/world.js";
import { monotonicNow } from "../../utils/monotonic-clock.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { WELL_FED, observation, planningStart } from "../../test-support/navigation.js";
import { FIRE_LINE_PRICE_TICKS, FIRE_LINE_THETA_RAD, fireLinePrice, withFireLine } from "./evade-fire-line.js";

const DEGREES = Math.PI / 180;
const cell = (x: number, z: number): BlockPosition => ({ x, y: 63, z });

/** Degrees between the step's direction and the bearing from the shooter to the step's start cell (the rule's own angle). */
function degreesToBearing(shooter: BlockPosition, from: BlockPosition, to: BlockPosition): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const bx = from.x + 0.5 - shooter.x;
  const bz = from.z + 0.5 - shooter.z;
  const cos = (dx * bx + dz * bz) / (Math.hypot(dx, dz) * Math.hypot(bx, bz));
  return Math.acos(Math.min(1, Math.max(-1, cos))) / DEGREES;
}

/** The shared price: 10 ticks, the walk-sized one a step pays under the rule. */
const PRICE = 10;
const THETA = 35 * DEGREES;

/** Test options: the shooters are read live through `shooters` each time a price is asked. */
function fireOptions(shooters: () => readonly BlockPosition[], priceTicks = PRICE) {
  return { shooters, thetaRad: THETA, priceTicks };
}

test("a step that runs straight away from a shooter pays the price; a crossing step and a step toward the shooter pay nothing", () => {
  const options = fireOptions(() => [{ x: 0, y: 63, z: 0 }]);
  const from = cell(6, 0);
  assert.equal(fireLinePrice(from, cell(7, 0), options), PRICE, "straight away: 4.4 degrees off the bearing");
  assert.equal(fireLinePrice(from, cell(7, 1), options), 0, "45 degrees to +x, 40.6 to the bearing");
  assert.equal(fireLinePrice(from, cell(7, -1), options), 0, "-45 degrees, 49.4 to the bearing");
  assert.equal(fireLinePrice(from, cell(6, 1), options), 0, "90 degrees, 85.6 to the bearing");
  assert.equal(fireLinePrice(from, cell(5, 0), options), 0, "toward the shooter, 175.6 to the bearing");
  assert.equal(fireLinePrice(cell(6, 3), cell(7, 3), options), PRICE, "bearing 28.3 degrees off +x, step at 0 degrees");
  const high = fireOptions(() => [{ x: 0, y: 80, z: 0 }]);
  assert.equal(fireLinePrice(from, { x: 7, y: 64, z: 0 }, high), PRICE, "shooter 17 blocks higher and a step up: the price is horizontal only");
});

test("the price is charged once for any number of shooters under the angle", () => {
  const from = cell(6, 0);
  const both = fireOptions(() => [{ x: 0, y: 63, z: 0 }, { x: 0, y: 63, z: 2 }]);
  assert.equal(fireLinePrice(from, cell(7, 0), both), PRICE, "two shooters that both price the step: once");
  const one = fireOptions(() => [{ x: 0, y: 63, z: 0 }, { x: 6, y: 63, z: 6 }]);
  assert.equal(fireLinePrice(from, cell(7, 0), one), PRICE, "a second shooter that prices nothing does not remove the first's price");
});

test("a zero-length step, a shooter at the cell centre and no shooters each cost nothing", () => {
  const from = cell(6, 0);
  assert.equal(fireLinePrice(from, from, fireOptions(() => [{ x: 0, y: 63, z: 0 }])), 0, "zero-length step");
  assert.equal(fireLinePrice(from, cell(7, 0), fireOptions(() => [{ x: 6.5, y: 63, z: 0.5 }])), 0, "shooter at the centre");
  assert.equal(fireLinePrice(from, cell(7, 0), fireOptions(() => [])), 0, "no shooters");
});

test("the shooters are read live: a changed answer changes the next price", () => {
  let shooters: BlockPosition[] = [{ x: 0, y: 63, z: 0 }];
  const options = fireOptions(() => shooters);
  const from = cell(6, 0);
  assert.equal(fireLinePrice(from, cell(7, 0), options), PRICE);
  shooters = [{ x: 0, y: 63, z: 9 }];
  assert.equal(fireLinePrice(from, cell(7, 0), options), 0, "the shooter moved to the side: the bearing now crosses the step");
});

/** A policy whose decideMovement answers `decision`; the other members are real values, so reference equality is checked. */
function policyAnswering(decision: ReturnType<NonNullable<MovementPolicy["decideMovement"]>> | undefined): MovementPolicy {
  const base = createMovements(createFakeBot().bot, { allowParkour: false });
  return Object.freeze({ ...base, decideMovement: decision === undefined ? undefined : () => decision });
}

test("withFireLine: an allowed step becomes penalized for line of fire, a prohibited one stays the same object", () => {
  const shooters = () => [{ x: 0, y: 63, z: 0 }];
  const priced = withFireLine(policyAnswering({ kind: "allowed" }), { shooters, thetaRad: THETA, priceTicks: 10 });
  assert.deepEqual(priced.decideMovement?.("walk", cell(6, 0), cell(7, 0)),
    { kind: "penalized", reason: "line_of_fire", cost: 10 });
  const refusal = { kind: "prohibited", reason: "x" } as const;
  const refused = withFireLine(policyAnswering(refusal), { shooters, thetaRad: THETA, priceTicks: 10 });
  assert.equal(refused.decideMovement?.("walk", cell(6, 0), cell(7, 0)), refusal);
});

test("withFireLine: a penalized step adds the price and keeps its reason; a priced-zero step returns the base decision object", () => {
  const shooters = () => [{ x: 0, y: 63, z: 0 }];
  const base = { kind: "penalized", reason: "x", cost: 5 } as const;
  const adding = withFireLine(policyAnswering(base), { shooters, thetaRad: THETA, priceTicks: 10 });
  assert.deepEqual(adding.decideMovement?.("walk", cell(6, 0), cell(7, 0)), { kind: "penalized", reason: "x", cost: 15 });
  const free = { kind: "allowed" } as const;
  const crossing = withFireLine(policyAnswering(free), { shooters, thetaRad: THETA, priceTicks: 10 });
  assert.equal(crossing.decideMovement?.("walk", cell(6, 0), cell(6, 1)), free, "a crossing step is the base decision itself");
});

test("withFireLine: a policy with no decideMovement is allowed, and priced when the step runs away", () => {
  const shooters = () => [{ x: 0, y: 63, z: 0 }];
  const policy = withFireLine(policyAnswering(undefined), { shooters, thetaRad: THETA, priceTicks: 10 });
  assert.deepEqual(policy.decideMovement?.("walk", cell(6, 0), cell(7, 0)), { kind: "penalized", reason: "line_of_fire", cost: 10 });
  assert.deepEqual(policy.decideMovement?.("walk", cell(6, 0), cell(6, 1)), { kind: "allowed" });
});

test("withFireLine: every other member of the policy is the same reference, and the result is frozen", () => {
  const base = policyAnswering({ kind: "allowed" });
  const wrapped = withFireLine(base, fireOptions(() => []));
  for (const key of ["allowDownward", "movementTicks", "decideStep", "evaluateBreak", "decidePlace"] as const)
    assert.equal(wrapped[key], base[key], key);
  assert.ok(Object.isFrozen(wrapped));
});

// The search tests: the design's proof. The route is searched on open ground with the real catalogue and a fake-bot
// policy, from (0, 0) to a goal 44 blocks from a shooter at (-6, 0), so the walk leaves it straight to the east.
const SHOOTER = { x: -6, y: 63, z: 0 };
const START = { x: 0, y: 63, z: 0 };
const FIRST = 12;

/** Open ground wide enough for a 44-block route (the test-support flat world is only 11 blocks square). */
function openGround(): MemoryWorld {
  const world = new MemoryWorld();
  for (let x = -8; x <= 50; x += 1)
    for (let z = -30; z <= 30; z += 1) {
      world.load({ x, y: 62, z }, { stateId: 1 });
      for (const y of [63, 64, 65]) world.load({ x, y, z }, { stateId: 0 });
    }
  return world;
}

type ActiveGoal = Extract<ResolvedGoal, { kind: "active" }>;

function activeGoal(goal: { resolve(seen: NavigationObservation): ResolvedGoal }): ActiveGoal {
  const resolved = goal.resolve(observation());
  if (resolved.kind !== "active") throw new Error(JSON.stringify(resolved));
  return resolved;
}

/** The goal of the design: out of range 44 of the shooter (the evade's range 36 plus margin 8). */
const escapeGoal = () => activeGoal(safeFromEntitiesGoal([{ id: 1, position: SHOOTER }], 44));
const cellGoal = (target: BlockPosition) => activeGoal(exactBlockGoal(target));

/** A finished route with the search's counts (`evidence`: visited, computeMs). */
interface Route {
  readonly plan: RoutePlan;
  readonly evidence: SearchEvidence;
}

function routeTo(goal: ActiveGoal, policy: MovementPolicy): Route {
  const update = new IncrementalSearch({
    id: "fire-line",
    start: planningStart(START),
    goal,
    now: monotonicNow,
    context: { world: openGround(), policy, player: WELL_FED, catalogue: createMovementCatalogue() },
  }).advance({ maximumExpansions: Number.POSITIVE_INFINITY, maximumMilliseconds: Number.POSITIVE_INFINITY });
  assert.equal(update.kind, "complete", JSON.stringify(update.kind));
  if (update.kind !== "complete") throw new Error(update.kind);
  return { plan: update.plan, evidence: update.evidence };
}

const fieldPolicy = (): MovementPolicy => createMovements(createFakeBot().bot, { allowParkour: false });

/** The first steps of a route, as the angles to the bearing of the given shooter. */
function firstAngles(steps: readonly { from: BlockPosition; to: BlockPosition }[], shooter: BlockPosition): number[] {
  return steps.slice(0, FIRST).map((step) => degreesToBearing(shooter, step.from, step.to));
}

test("(a) the unpriced search runs its first steps along the shooter's bearing (the red before the design)", () => {
  const route = routeTo(escapeGoal(), fieldPolicy());
  const within = firstAngles(route.plan.steps, SHOOTER).filter((angle) => angle < 10).length;
  assert.ok(within >= 9, `${within} of the first ${FIRST} steps are within 10 degrees of the bearing`);
});

test("(b) a priced route crosses the bearing: the least price multiple that meets the bar is the one the module names", () => {
  const walk = fieldPolicy().movementTicks.walk;
  const unpriced = routeTo(escapeGoal(), fieldPolicy());
  const results = [1, 2, 4].map((multiple) => {
    const policy = withFireLine(fieldPolicy(), { shooters: () => [SHOOTER], thetaRad: FIRE_LINE_THETA_RAD, priceTicks: multiple * walk });
    const update = routeTo(escapeGoal(), policy);
    const angles = firstAngles(update.plan.steps, SHOOTER);
    return {
      multiple,
      crossing: angles.filter((angle) => angle >= 35).length,
      allCross: angles.every((angle) => angle >= 35),
      length: update.plan.steps.length,
      cost: update.plan.totalCost,
      visited: update.evidence.visited,
      computeMs: Math.round(update.evidence.computeMs),
      unprunedLength: unpriced.plan.steps.length,
    };
  });
  const chosen = results.find((result) => result.allCross && result.length <= 1.5 * unpriced.plan.steps.length);
  assert.ok(chosen, JSON.stringify(results));
  assert.equal(FIRE_LINE_PRICE_TICKS, chosen.multiple * walk, JSON.stringify(results));
});

// The shooter stands 40 blocks north of the start, so the bearing runs south to the start and an east walk crosses it:
// the cell 30 blocks east is 30 blocks to the side of that bearing. (The first draft, shooter (-6, 0) with the goal 30
// blocks north at (0, 30), was not a crossing route: past z = 9 the bearing swings to within 35 degrees of the north walk,
// so the priced route left the x = 0 column; measured, a plan fault of this case, not of the price.)
test("(c) a route that already crosses the bearing is unchanged by the price", () => {
  const crossed = { x: 0, y: 63, z: -40 };
  const goal = cellGoal(cell(30, 0));
  const priced = withFireLine(fieldPolicy(), { shooters: () => [crossed], thetaRad: FIRE_LINE_THETA_RAD, priceTicks: FIRE_LINE_PRICE_TICKS });
  const cells = (update: Route) => update.plan.steps.map((step) => `${step.to.x},${step.to.z}`);
  assert.deepEqual(cells(routeTo(goal, priced)), cells(routeTo(goal, fieldPolicy())));
});

test("(d) two shooters: the price is charged once per step, and the priced route runs under fewer of their bearings", () => {
  const shooters = [SHOOTER, { x: -6, y: 63, z: 4 }];
  const policy = withFireLine(fieldPolicy(), { shooters: () => shooters, thetaRad: FIRE_LINE_THETA_RAD, priceTicks: FIRE_LINE_PRICE_TICKS });
  // Steps of the first FIRST that run under the angle to at least one shooter's bearing.
  const underFire = (steps: readonly { from: BlockPosition; to: BlockPosition }[]) => steps.slice(0, FIRST)
    .filter((step) => shooters.some((shooter) => degreesToBearing(shooter, step.from, step.to) < 35)).length;
  const unpricedCount = underFire(routeTo(escapeGoal(), fieldPolicy()).plan.steps);
  const pricedCount = underFire(routeTo(escapeGoal(), policy).plan.steps);
  assert.ok(pricedCount < unpricedCount, `priced ${pricedCount} of ${FIRST} steps under fire, unpriced ${unpricedCount}`);
});

test("(e) a shooter that moves one block between two searches changes the second route the way its new bearing says", () => {
  let shooter = SHOOTER;
  const policy = withFireLine(fieldPolicy(), { shooters: () => [shooter], thetaRad: FIRE_LINE_THETA_RAD, priceTicks: FIRE_LINE_PRICE_TICKS });
  const first = routeTo(escapeGoal(), policy);
  shooter = { x: -6, y: 63, z: 1 };
  const second = routeTo(escapeGoal(), policy);
  const angles = firstAngles(second.plan.steps, shooter);
  assert.ok(angles.every((angle) => angle >= 35), angles.map((a) => a.toFixed(1)).join(" "));
  assert.notDeepEqual(second.plan.steps.map((step) => step.to), first.plan.steps.map((step) => step.to));
});
