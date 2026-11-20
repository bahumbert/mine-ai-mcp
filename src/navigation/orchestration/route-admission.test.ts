// route admission: a caller's veto over a route at its commit and at each step boundary (plan 2026-11-18-evade-resume-bound T2).
import assert from "node:assert/strict";
import test from "node:test";
import { FakeNavigationBot, flatWorld, observation, onEvent, settle } from "../../test-support/navigation.js";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { exactBlockGoal } from "../goals/index.js";
import type { PlannedStep } from "../movements/movement.js";
import { createNavigationRuntime } from "../runtime.js";
import { createMovementPolicy } from "../movements/policy.js";
import type { RouteAdmission } from "../route-admission.js";
import type { NavigationEvent } from "../telemetry/index.js";
import type { BlockPosition } from "../world/world.js";
import { createNavigator } from "./navigator.js";
import { walking } from "./navigation-run-fixtures.test.js";

const EAST = exactBlockGoal({ x: 5, y: 63, z: 0 });

type CheckedPlan = Parameters<RouteAdmission["check"]>[0];

/** One flat-world run toward EAST that records its events, with `admission` (or none) registered. */
function runEast(bot: FakeNavigationBot, admission: ((plan: CheckedPlan) => string | null) | null, options: { provider?: () => RouteAdmission | null; world?: ReturnType<typeof flatWorld>; policy?: ReturnType<typeof walking>; goal?: typeof EAST } = {}) {
  const events: NavigationEvent[] = [];
  const world = options.world ?? flatWorld();
  const navigator = createNavigator({ world, bot, createId: () => "admission-run", telemetry: onEvent((event) => events.push(event)) });
  if (options.provider) navigator.setRouteAdmissionProvider(options.provider);
  else if (admission) navigator.setRouteAdmissionProvider(() => ({ check: (plan) => admission(plan) }));
  const outcome = settle(navigator, { goal: options.goal ?? EAST, policy: options.policy ?? walking() });
  return { events, navigator, outcome };
}

const kinds = (events: readonly NavigationEvent[], kind: NavigationEvent["kind"]) => events.filter((event) => event.kind === kind);

function refusal(outcome: Awaited<ReturnType<typeof runEast>["outcome"]>) {
  assert.equal(outcome.kind, "failed", JSON.stringify(outcome));
  if (outcome.kind !== "failed") throw new Error("unreachable");
  assert.equal(outcome.failure.kind, "no_progress");
  if (outcome.failure.kind !== "no_progress") throw new Error("unreachable");
  return outcome.failure;
}

test("a refused route ends the run with route_refused after one search", async () => {
  const bot = new FakeNavigationBot();
  const seen: number[] = [];
  const { events, navigator, outcome } = runEast(bot, (plan) => {
    seen.push(plan.steps.length);
    return plan.steps.length >= 2 ? "refused at step 2" : null;
  });
  const failure = refusal(await outcome);
  assert.equal(failure.reason, "route_refused");
  assert.equal(failure.observation, "refused at step 2");
  assert.equal(kinds(events, "route_refused").length, 1);
  const refused = kinds(events, "route_refused")[0];
  assert.ok(refused?.kind === "route_refused" && refused.observation === "refused at step 2" && refused.planId.length > 0);
  assert.equal(kinds(events, "route_committed").length, 0);
  assert.equal(kinds(events, "search_started").length, 1);
  assert.equal(kinds(events, "step_started").length, 0);
  assert.deepEqual(bot.current, observation(), "the body did not move");
  assert.equal(seen.length, 1, "one check, at the commit");
  assert.equal(navigator.active, null);
});

test("a step-boundary refusal stops after the current step", async () => {
  const bot = new FakeNavigationBot();
  let committed: number | null = null;
  const { events, navigator, outcome } = runEast(bot, (plan) => {
    committed ??= plan.steps.length;
    return plan.steps.length === committed - 1 ? "the shooter moved" : null;
  });
  const failure = refusal(await outcome);
  assert.equal(failure.reason, "route_refused");
  assert.equal(failure.observation, "the shooter moved");
  assert.equal(kinds(events, "route_committed").length, 1);
  assert.equal(kinds(events, "step_started").length, 1);
  assert.equal(kinds(events, "step_completed").length, 1);
  assert.equal(kinds(events, "route_refused").length, 1);
  assert.equal(kinds(events, "search_started").length, 1, "a refusal does not search again");
  const order = events.map((event) => event.kind).filter((kind) => kind === "step_completed" || kind === "route_refused");
  assert.deepEqual(order, ["step_completed", "route_refused"]);
  const committedEvent = kinds(events, "route_committed")[0];
  assert.ok(committedEvent?.kind === "route_committed");
  const first = committedEvent.plan.steps[0]!;
  assert.deepEqual(
    { x: Math.floor(bot.current.position.x), y: Math.floor(bot.current.position.y), z: Math.floor(bot.current.position.z) },
    { x: first.to.x, y: first.to.y, z: first.to.z },
    "the body stands on step 1's arrival",
  );
  assert.equal(bot.ownedControlCount, 0);
  assert.equal(navigator.active, null);
});

test("the admission sees planned edits", async () => {
  const world = flatWorld();
  // A wall across the whole loaded width: the only way east is through the cell at x=1.
  for (let z = -5; z <= 5; z += 1)
    for (const y of [63, 64, 65]) world.load({ x: 1, y, z }, { stateId: 1, traits: { empty: false, safeToBreak: true } });
  const planned: CheckedPlan[] = [];
  const policy = createMovementPolicy({ allowSprinting: false, evaluateBreak: () => ({ decision: { kind: "allowed" }, tool: { itemType: 42, expectedTicks: 10 } }) });
  // The refusal comes at the commit, before any movement or dig is issued: the plain fake bot is enough.
  const bot = new FakeNavigationBot();
  const { outcome } = runEast(bot, (plan) => {
    planned.push(plan);
    return "the dig is not admitted";
  }, { world, policy, goal: exactBlockGoal({ x: 2, y: 63, z: 0 }) });
  assert.equal(refusal(await outcome).reason, "route_refused");
  const breaks = planned[0]!.steps.flatMap((step) => step.operations).filter((operation) => operation.kind === "break");
  // The wall is three high: the route digs the feet cell and the head cell of the doorway.
  const cell: BlockPosition = { x: 1, y: 63, z: 0 };
  assert.ok(breaks.some((operation) => operation.kind === "break" && operation.position.x === cell.x && operation.position.y === cell.y && operation.position.z === cell.z), JSON.stringify(breaks));
  assert.ok(breaks.every((operation) => operation.kind === "break" && operation.position.x === 1 && operation.position.z === 0), "only the doorway is dug");
  assert.deepEqual(planned[0]!.start, { x: 0, y: 63, z: 0 });
});

test("a null provider or a null admission changes nothing", async () => {
  // The search is cut into slices by compute time, so a slower run gets one more search_slice with the same outcome:
  // the slice count is left out of the shape, every other kind stays in order (plan 2026-11-18-unit-reds-a2 T7, 2026-11-20).
  const shape = async (admission: Parameters<typeof runEast>[2]) => {
    const { events, outcome } = runEast(new FakeNavigationBot(), null, admission);
    const settled = await outcome;
    const shaped = events.map((event) => event.kind).filter((kind) => kind !== "search_slice");
    return { outcome: settled.kind, kinds: shaped, steps: kinds(events, "step_completed").length };
  };
  const bare = await shape({});
  assert.equal(bare.outcome, "completed");
  assert.deepEqual(await shape({ provider: () => null }), bare, "a provider with no admission");
  const suffixes: number[] = [];
  assert.deepEqual(await shape({ provider: () => ({ check: (plan) => { suffixes.push(plan.steps.length); return null; } }) }), bare, "an admission that admits");
  // The commit sees the whole route, each boundary what remains; the last step leaves nothing to ask about.
  assert.deepEqual(suffixes, [bare.steps, ...Array.from({ length: bare.steps - 1 }, (_, index) => bare.steps - 1 - index)]);
});

/** What the goal does once the body has walked one step: the order of outcomes at a step boundary is the admission's place in it. */
function goalChangingAfterStep(change: "satisfied" | "invalid" | "revised") {
  const east = exactBlockGoal({ x: 5, y: 63, z: 0 });
  const west = exactBlockGoal({ x: -5, y: 63, z: 0 });
  return { resolve: (at: Parameters<typeof east.resolve>[0]) => {
    if (at.position.x < 1) return east.resolve(at);
    if (change === "invalid") return { kind: "invalid", observation: "the goal is gone" } as const;
    if (change === "revised") return west.resolve(at);
    const resolved = east.resolve(at);
    return resolved.kind === "invalid" ? resolved : { ...resolved, isSatisfied: () => true };
  } };
}

test("a goal that finished, vanished or moved is settled before the route is judged again", async () => {
  const table = [
    { change: "satisfied", outcome: "completed", refusals: 0, asked: 1 },
    { change: "invalid", outcome: "invalid_goal", refusals: 0, asked: 1 },
    // The old route is dropped without a boundary check; the new one is judged at its own commit.
    { change: "revised", outcome: "route_refused", refusals: 1, asked: 2 },
  ] as const;
  for (const row of table) {
    let asked = 0;
    const { events, outcome } = runEast(new FakeNavigationBot(), null, {
      goal: goalChangingAfterStep(row.change),
      provider: () => ({ check: () => (++asked === 1 ? null : "refused after the goal changed") }),
    });
    const settled = await outcome;
    const label = `${row.change}: ${JSON.stringify(settled)}`;
    if (row.outcome === "completed") assert.equal(settled.kind, "completed", label);
    else {
      assert.equal(settled.kind, "failed", label);
      assert.equal(settled.kind === "failed" && (settled.failure.kind === "no_progress" ? settled.failure.reason : settled.failure.kind), row.outcome, label);
    }
    assert.equal(kinds(events, "route_refused").length, row.refusals, label);
    assert.equal(asked, row.asked, label);
  }
});

test("the provider is read at each commit", async () => {
  class FailsOnce extends FakeNavigationBot {
    failed = false;
    override async prepareMovement(step: PlannedStep) {
      this.arrive(step.to);
      if (!this.failed) {
        this.failed = true;
        return { kind: "failed", observation: "the first movement did not settle" } as const;
      }
      return { kind: "completed", arrival: step.to } as const;
    }
  }
  let reads = 0;
  const { events, outcome } = runEast(new FailsOnce(), null, {
    provider: () => {
      reads += 1;
      return reads === 1 ? null : { check: () => "refused on the replan" };
    },
  });
  const failure = refusal(await outcome);
  assert.equal(failure.observation, "refused on the replan");
  assert.equal(reads, 2, "read once per commit");
  assert.equal(kinds(events, "route_committed").length, 1, "the replanned route never committed");
  assert.equal(kinds(events, "route_refused").length, 1);
});

test("a check that throws, at the commit or at a step boundary, ends the run as an internal error and frees the navigator", async () => {
  for (const at of ["commit", "boundary"] as const) {
    let asked = 0;
    const bot = new FakeNavigationBot();
    const { events, navigator, outcome } = runEast(bot, () => {
      if (at === "boundary" && ++asked === 1) return null;
      throw new Error("admission exploded");
    });
    const settled = await outcome;
    assert.equal(settled.kind, "failed", at);
    assert.ok(settled.kind === "failed" && settled.failure.kind === "internal_error" && settled.failure.message.includes("admission exploded"), `${at}: ${JSON.stringify(settled)}`);
    assert.equal(kinds(events, "route_committed").length, at === "commit" ? 0 : 1, at);
    assert.equal(kinds(events, "route_refused").length, 0, at);
    assert.equal(navigator.active, null, at);
    assert.equal(bot.ticks.size, 0, `${at}: the physics tick subscription is released`);
    // The next run on the same navigator is admitted and finishes.
    navigator.setRouteAdmissionProvider(null);
    const next = await settle(navigator, { goal: exactBlockGoal({ x: 2, y: 63, z: 0 }), policy: walking() });
    assert.equal(next.kind, "completed", at);
  }
});

for (const ticksPerSecond of [20, 10]) for (const at of ["commit", "boundary"] as const)
  test(`a ${at} refusal on the shared fake leaves no listener, no held control and a next navigate that finishes at ${ticksPerSecond} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot } = createFakeBot({ clock, simulatePhysics: true, position: new Vec3(0.5, 63, 0.5), groundY: 62, server: { ticksPerSecond } });
    await using navigation = createNavigationRuntime(bot);
    const movements = createMovementPolicy();
    const run = (x: number) => clock.settle(navigation.navigate({ movements, goal: exactBlockGoal({ x, y: 63, z: 0 }) }), 20_000);
    // The movement policy and the runtime keep persistent per-bot listeners from their first use: count after one run.
    assert.equal((await run(1)).status, "completed");
    const added = listenersAddedSince(bot);
    let asked = 0;
    navigation.setRouteAdmissionProvider(() => ({ check: () => (at === "commit" || ++asked > 1 ? "refused for the test" : null) }));
    const startX = bot.entity.position.x;
    const refused = await run(6);
    assert.equal(refused.status, "stopped", JSON.stringify(refused));
    assert.match(refused.status === "stopped" ? refused.reason : "", /route_refused: refused for the test/);
    // The body may still settle a fraction of a block from the earlier run's arrival; a step is a whole block.
    const walked = bot.entity.position.x - startX;
    if (at === "commit") assert.ok(Math.abs(walked) < 0.3, `no step was walked, moved ${walked}`);
    else assert.ok(walked > 0.5 && walked < 2, `one step walked, moved ${walked}`);
    assert.equal(Object.values(bot.controlState).some(Boolean), false, "no control is held");
    for (const event of bot.eventNames()) assert.equal(added(String(event)), 0, `listeners added on ${String(event)}`);
    assert.equal(navigation.active, false);
    // Nothing the refused run owned fires later, and the next request is admitted from the refused stance.
    await clock.advance(30_000);
    assert.equal(Object.values(bot.controlState).some(Boolean), false, "no control after the old deadline");
    navigation.setRouteAdmissionProvider(null);
    const next = await run(Math.floor(bot.entity.position.x) + 2);
    assert.equal(next.status, "completed", JSON.stringify(next));
    for (const event of bot.eventNames()) assert.equal(added(String(event)), 0, `listeners added on ${String(event)} after the next navigate`);
  });
