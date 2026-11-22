import assert from "node:assert/strict";
import test from "node:test";
import { type FakeBot, createFakeBot } from "../../test-support/fake-bot/index.js";
import { loadLavaAtDiagonals } from "../../test-support/layered-world.js";
import { FAILURE_A_START, failureAScene, flatWorld } from "../../test-support/navigation.js";
import type { MovementKind, PlannedStep } from "../movements/movement.js";
import { BREAK_OPENS_INTO_LIQUID, createMovementPolicy, type MovementPolicy } from "../movements/policy.js";
import { createMovements } from "../runtime.js";
import type { MemoryWorld } from "../world/memory-world.js";
import type { BlockPosition } from "../world/world.js";
import { RELAXED_DIG_STRAIGHT_DOWN, RELAXED_FLOWING_WATER, RelaxedRulesUsed, isShutInByEscapableRefusals } from "./escape-policy.js";
import type { NavigationCalculationFailure } from "./process-events.js";

const FEET = { x: 0, y: 63, z: 0 } as const;
const BELOW = { x: 0, y: 62, z: 0 } as const;
const BESIDE = { x: 1, y: 63, z: 0 } as const;

/** A step of a committed route: its moves and the cells it breaks first. */
function step(kind: MovementKind, to: BlockPosition, breaks: readonly BlockPosition[]): PlannedStep {
  return {
    id: `${kind}>${to.x},${to.y},${to.z}`, kind, from: FEET, to, validArrivals: [to], preconditions: [], effects: [],
    operations: [
      ...breaks.map((position) => ({ kind: "break" as const, position, expectedStateId: 1, toolType: null, brings: [] })),
      { kind: "move" as const, movement: kind, target: { x: to.x + 0.5, y: to.y, z: to.z + 0.5 } },
    ],
    cost: { expectedTicks: 10, breakPenalty: 0, placementPenalty: 0, hazardPenalty: 0, total: 10 },
  };
}

/** The bot's own policy: the dig down switched `digDown` (its persona), a break beside `flowing` water refused as the flood rule does. */
function ownPolicy(options: { digDown: boolean; floods?: "flowing" | "source" }): MovementPolicy {
  const floods = options.floods;
  return createMovementPolicy({
    allowDownward: options.digDown,
    ...(floods !== undefined && {
      evaluateBreak: (_block, _position) => ({
        decision: { kind: "prohibited", reason: BREAK_OPENS_INTO_LIQUID, cause: "opens_into_liquid" },
        tool: { itemType: null, expectedTicks: 20 },
      }),
      opensOnlyIntoFlowingWater: () => floods === "flowing",
    }),
  });
}

function rulesUsedBy(steps: readonly PlannedStep[], policy: MovementPolicy, world = flatWorld()): readonly string[] {
  const used = new RelaxedRulesUsed();
  used.note(steps, policy, world);
  return used.rules;
}

test("a dig down the bot's own rule forbids is the dig_straight_down rule set aside, and nothing else", () => {
  assert.deepEqual(rulesUsedBy([step("downward", BELOW, [BELOW])], ownPolicy({ digDown: false })), [RELAXED_DIG_STRAIGHT_DOWN]);
});

test("a dig down the bot's own rule allowed anyway set nothing aside", () => {
  assert.deepEqual(rulesUsedBy([step("downward", BELOW, [BELOW])], ownPolicy({ digDown: true })), []);
});

test("a dig down through a block that stands free in open air set nothing aside: the rule never covered it", () => {
  const world = flatWorld();
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) world.load({ x: dx, y: 62, z: dz }, { stateId: 0 });
  assert.deepEqual(rulesUsedBy([step("downward", BELOW, [BELOW])], ownPolicy({ digDown: false }), world), []);
});

test("a downward step that breaks nothing (a fall) set nothing aside", () => {
  assert.deepEqual(rulesUsedBy([step("downward", BELOW, [])], ownPolicy({ digDown: false })), []);
});

test("a side dig that lets in flowing water only is the dig_next_to_flowing_water exception, with no word of digging down", () => {
  assert.deepEqual(rulesUsedBy([step("walk", BESIDE, [BESIDE])], ownPolicy({ digDown: true, floods: "flowing" })), [RELAXED_FLOWING_WATER]);
});

test("a side dig that lets in a water source or lava was never let through: it set nothing aside", () => {
  assert.deepEqual(rulesUsedBy([step("walk", BESIDE, [BESIDE])], ownPolicy({ digDown: true, floods: "source" })), []);
});

test("a side dig the bot's policy allows anyway set nothing aside", () => {
  assert.deepEqual(rulesUsedBy([step("walk", BESIDE, [BESIDE])], ownPolicy({ digDown: true })), []);
});

test("a route that digs down and beside flowing water used both, listed in the rules' own order across routes", () => {
  const policy = ownPolicy({ digDown: false, floods: "flowing" });
  const used = new RelaxedRulesUsed();
  used.note([step("walk", BESIDE, [BESIDE])], policy, flatWorld());
  assert.deepEqual(used.rules, [RELAXED_FLOWING_WATER]);
  used.note([step("downward", BELOW, [BELOW])], policy, flatWorld());
  assert.deepEqual(used.rules, [RELAXED_DIG_STRAIGHT_DOWN, RELAXED_FLOWING_WATER]);
});

test("a route that walks only used nothing, whatever the escape was allowed", () => {
  assert.deepEqual(rulesUsedBy([step("walk", BESIDE, [])], ownPolicy({ digDown: false, floods: "flowing" })), []);
});

// ── Spreading lava around the start (plan p4-06b T7, spec D5) ───────────────────────────────────────────────────
/** Flat ground with lava in each diagonal cell of the start: every side cell (the four around FEET) has lava beside it. */
function worldWithLavaAtDiagonals(bot: FakeBot): MemoryWorld {
  const world = flatWorld();
  loadLavaAtDiagonals(world, bot, FEET);
  return world;
}

/** An exhausted search that visited only its start cell: the failure the run handles. */
const NEVER_LEFT_START: Extract<NavigationCalculationFailure, { readonly kind: "no_path" }> = {
  kind: "no_path",
  search: { queued: 0, visited: 1, farthestVisited: 0, generated: 1, slices: 1, computeMs: 1 },
  closest: { position: FEET, heuristic: 4, routeCost: 0, basis: "best_heuristic_search_node" },
};

test("every exit beside spreading lava: shut in by escapable refusals, the escape prices what lava is about to flow into", () => {
  const { bot } = createFakeBot();
  assert.equal(isShutInByEscapableRefusals(NEVER_LEFT_START, worldWithLavaAtDiagonals(bot), createMovements(bot), FEET), true);
});

// ── Digging off (plan 2026-11-16-p4-20-descents-a3 T1): the escape keeps the request's rule, so it is no escape case ──
test("a start shut in only by digging off is no escape case", () => {
  const failure = { kind: "no_path" as const, search: { queued: 0, visited: 2, farthestVisited: 1, generated: 2, slices: 1, computeMs: 1 },
    closest: { position: { x: 0, y: -55, z: -1 }, heuristic: 1, routeCost: 10, basis: "best_heuristic_search_node" as const } };
  const policy = createMovementPolicy({ allowDigging: false, allowDownward: false });
  assert.equal(isShutInByEscapableRefusals(failure, failureAScene(), policy, FAILURE_A_START), false);
});

test("no lava near the start: nothing to relax, so no escape search is started", () => {
  const { bot } = createFakeBot();
  assert.equal(isShutInByEscapableRefusals(NEVER_LEFT_START, flatWorld(), createMovements(bot), FEET), false);
});
