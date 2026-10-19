import assert from "node:assert/strict";
import test from "node:test";
import { flatWorld } from "../../test-support/navigation.js";
import type { MovementKind, PlannedStep } from "../movements/movement.js";
import { BREAK_OPENS_INTO_LIQUID, createMovementPolicy, type MovementPolicy } from "../movements/policy.js";
import type { BlockPosition } from "../world/world.js";
import { RELAXED_DIG_STRAIGHT_DOWN, RELAXED_FLOWING_WATER, RelaxedRulesUsed } from "./escape-policy.js";

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
