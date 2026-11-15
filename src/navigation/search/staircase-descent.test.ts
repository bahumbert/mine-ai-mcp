// Search regressions for descents that retain a walkable route back.
import assert from "node:assert/strict";
import test from "node:test";
import { WELL_FED, observation, planningStart } from "../../test-support/navigation.js";
import { exactBlockGoal } from "../goals/index.js";
import { createMovementCatalogue } from "../movements/catalogue.js";
import { createMovementPolicy } from "../movements/policy.js";
import { MemoryWorld } from "../world/memory-world.js";
import { packKey } from "../world/world.js";
import { IncrementalSearch } from "./search.js";

type Cell = { x: number; y: number; z: number };
const start = { x: 0, y: 64, z: 0 };
const goals = [{ x: 0, y: 48, z: 0 }, { x: 1, y: 50, z: 1 }, { x: 0, y: 56, z: 0 }, { x: 0, y: 60, z: 0 }, { x: 0, y: 50, z: 0 }];

function rockWorld(narrow = false, tunnel = false): MemoryWorld {
  const world = new MemoryWorld();
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) for (let y = 30; y <= 70; y++) {
    const solid = y <= 63 || (tunnel && y <= 66 && !(z === 0 && x >= 0 && x <= 3 && y <= 65));
    world.load({ x, y, z }, { stateId: solid ? 1 : 0, traits: { safeToBreak: solid && (!narrow || (x >= 0 && x <= 1 && z === 0)) } });
  }
  return world;
}

function search(world: MemoryWorld, from: Cell, goal: Cell, downward = false, digging = true) {
  const resolved = exactBlockGoal(goal).resolve(observation(from.x, from.y, from.z));
  if (resolved.kind !== "active") throw new Error("goal is not active");
  const policy = createMovementPolicy({
    scaffold: digging ? { itemType: 35, stateId: 14 } : null, placementPenalty: 20,
    allowDownward: downward, allowDigging: digging,
    evaluateBreak: block => ({ decision: block.kind === "loaded" && block.traits.safeToBreak
      ? { kind: "penalized", reason: "preserve terrain", cost: 25 }
      : { kind: "prohibited", reason: "unsafe" }, tool: { itemType: null, expectedTicks: 11 } }),
  });
  const planner = new IncrementalSearch({ id: "descent", start: planningStart(from, digging ? 64 : 0), goal: resolved, now: () => 0,
    context: { world, policy, player: WELL_FED, catalogue: createMovementCatalogue(), protectedFeet: new Set([packKey(from.x, from.y, from.z)]) } });
  let result = planner.advance({ maximumExpansions: 200_000 });
  while (result.kind === "progress") result = planner.advance({ maximumExpansions: 200_000 });
  assert.equal(result.kind, "complete");
  if (result.kind !== "complete") throw new Error("no route");
  return result.plan;
}

function cut(world: MemoryWorld, plan: ReturnType<typeof search>) {
  for (const step of plan.steps) for (const op of step.operations) if (op.kind === "break") world.load(op.position, { stateId: 0 });
}

test("the descent preserves earlier treads and is walked back up without digging or placing", () => {
  for (const goal of goals) {
    const world = rockWorld();
    const down = search(world, start, goal); const feet: Cell[] = [start];
    for (const step of down.steps) {
      for (const op of step.operations) if (op.kind === "break") assert.ok(!feet.some(t => t.x === op.position.x && t.y - 1 === op.position.y && t.z === op.position.z));
      feet.push(step.to);
    }
    cut(world, down);
    const up = search(world, goal, start, false, false);
    assert.equal(up.steps.flatMap(s => s.operations).filter(o => o.kind === "break" || o.kind === "place").length, 0);
  }
});

test("straight-down mode still digs a one-column shaft", () => {
  const plan = search(rockWorld(), start, { x: 0, y: 50, z: 0 }, true);
  assert.equal(plan.steps.length, 14); assert.equal(plan.totalCost, 588);
  for (const step of plan.steps) { assert.equal(step.kind, "downward"); assert.equal(step.operations.filter(o => o.kind === "break").length, 1); }
});

test("a reconstructed step carries its undercut price", () => {
  const plan = search(rockWorld(true), start, { x: 0, y: 58, z: 0 }); const feet: Cell[] = [start]; let undercuts = 0;
  for (const step of plan.steps) {
    if (step.operations.some(op => op.kind === "break" && feet.some(t => t.x === op.position.x && t.y - 1 === op.position.y && t.z === op.position.z))) {
      undercuts++; assert.ok(step.cost.breakPenalty >= 93);
    }
    feet.push(step.to);
  }
  assert.ok(undercuts > 0);
});

test("a planned walk through open air protects its tread", () => {
  const world = rockWorld(false, true); const goal = { x: 3, y: 58, z: 0 }; const plan = search(world, start, goal);
  const feet = new Set<number>();
  for (const step of plan.steps) {
    for (const op of step.operations) if (op.kind === "break") assert.ok(!feet.has(packKey(op.position.x, op.position.y + 1, op.position.z)));
    if (step.to.z === 0 && step.to.y === 64 && step.to.x >= 1 && step.to.x <= 3) feet.add(packKey(step.to.x, step.to.y, step.to.z));
  }
  cut(world, plan); search(world, goal, start, false, false);
});
