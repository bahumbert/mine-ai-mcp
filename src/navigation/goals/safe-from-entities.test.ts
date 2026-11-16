import { MemoryWorld as GoalTestWorld } from "../world/memory-world.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { PlanningNode } from "./goal.js";
import { UNLOADED, type NavigationObservation, type WorldView } from "../world/world.js";
import { safeFromEntitiesGoal } from "./index.js";
import { observation } from "../../test-support/navigation.js";

const goalTestWorld = new GoalTestWorld();

/** The bot at the origin, watching threat 7 at `entityX`; nothing observed when it is absent. */
function watching(entityX?: number): NavigationObservation {
  return {
    ...observation(0, 0, 0),
    position: { x: 0, y: 0, z: 0 },
    entities:
      entityX === undefined
        ? new Map()
        : new Map([[7, { id: 7, position: { x: entityX, y: 0, z: 0 }, width: 0.6, height: 1.8 }]]),
  };
}

function node(x: number): PlanningNode {
  return { feet: { x, y: 0, z: 0 }, remainingScaffolds: 0, overlayId: "test" };
}

test("safe-from-entities grades the distance still owed and follows the threat it can see", () => {
  const goal = safeFromEntitiesGoal([{ id: 7, position: { x: 0, y: 0, z: 0 } }], 16);
  const first = goal.resolve(watching(0));
  const moved = goal.resolve(watching(1));
  assert.equal(first.kind, "active");
  assert.equal(moved.kind, "active");
  if (first.kind !== "active") return;

  assert.equal(first.revision, "safe-from:16:entity:7:0,0,0");
  assert.equal(first.heuristic(node(5)), 44);
  assert.equal(first.isSatisfied(node(16), goalTestWorld), true);
  assert.equal(first.isSatisfied(node(15), goalTestWorld), false);
  assert.notEqual(first.revision, moved.revision);

  // The blocked-retreat scenario lost its creeper to an explosion. Navigation
  // must still satisfy the same last-observed separation checked by survival.
  const gone = goal.resolve(watching());
  assert.equal(gone.kind, "active");
  if (gone.kind !== "active") return;
  assert.equal(gone.isSatisfied(node(0), goalTestWorld), false);
  assert.equal(gone.isSatisfied(node(16), goalTestWorld), true);
});

test("a snapshot retains its creation position across observations and caller mutation", () => {
  const position = { x: 0, y: 0, z: 0 };
  const goal = safeFromEntitiesGoal([{ id: 7, position }], 36, { follow: "snapshot" });
  const first = goal.resolve(watching(0));
  const moved = goal.resolve(watching(20));
  position.x = 20;
  const mutated = goal.resolve(watching());
  for (const resolved of [first, moved, mutated]) {
    assert.equal(resolved.kind, "active");
    if (resolved.kind !== "active") return;
    assert.equal(resolved.revision, "safe-from:36:snapshot:7@0,0,0");
    assert.equal(resolved.isSatisfied(node(44), goalTestWorld), true);
  }
});

const shooter = { id: 7, position: { x: 0, y: 0, z: 0 }, cover: { minRange: 8, eyeHeight: 1.6, width: 0.6 } };

function coverWorld(wallX?: number): GoalTestWorld {
  const world = new GoalTestWorld();
  for (let x = -1; x <= 14; x++) for (let y = 0; y <= 3; y++) for (let z = -4; z <= 4; z++) {
    world.load({ x, y, z }, { stateId: x === wallX && Math.abs(z) <= 3 ? 1 : 0 });
  }
  return world;
}

function coverGoal(entity = shooter, follow: "live" | "snapshot" = "snapshot") {
  const resolved = safeFromEntitiesGoal([entity], 44, { follow }).resolve(watching(0));
  assert.equal(resolved.kind, "active");
  if (resolved.kind !== "active") throw new Error("inactive goal");
  return resolved;
}

test("cover requires sufficient range and loaded blocking geometry", () => {
  const world = coverWorld();
  const unknown: WorldView = { revision: world.revision, subscribe: world.subscribe.bind(world),
    blockAt: (x, y, z) => x === 10 ? UNLOADED : world.blockAt(x, y, z) };
  const covered = coverGoal();
  const plain = safeFromEntitiesGoal([{ id: 7, position: shooter.position }], 44).resolve(watching(0));
  assert.equal(plain.kind, "active");
  if (plain.kind !== "active") throw new Error("inactive goal");
  for (const [goal, x, view, expected] of [
    [coverGoal(), 12, coverWorld(10), true], [coverGoal(), 12, world, false],
    [coverGoal(), 7, coverWorld(5), false], [plain, 12, coverWorld(10), false], [coverGoal(), 12, unknown, false],
  ] as const) assert.equal(goal.isSatisfied(node(x), view), expected);
  assert.equal(covered.heuristic(node(7)), 4);
  assert.equal(covered.heuristic(node(12)), 0);
  assert.equal(covered.progress?.(node(12)), 128);
});

test("rays are cached per resolve and overlay even when world wrappers change", () => {
  const world = coverWorld(10);
  let reads = 0;
  const wrapper = (): WorldView => ({ revision: world.revision, subscribe: world.subscribe.bind(world),
    blockAt: (x, y, z) => { reads++; return world.blockAt(x, y, z); } });
  const first = wrapper();
  const goal = coverGoal();
  assert.equal(goal.isSatisfied(node(12), wrapper()), true);
  assert.ok(reads > 0);
  reads = 0;
  assert.equal(goal.isSatisfied(node(12), first), true);
  assert.equal(reads, 0);
  assert.equal(goal.isSatisfied({ ...node(12), overlayId: "other" }, first), true);
  assert.ok(reads > 0);
  reads = 0;
  assert.equal(coverGoal().isSatisfied(node(12), wrapper()), true);
  assert.ok(reads > 0);
});

test("cover parameters change the revision", () => {
  assert.notEqual(coverGoal().revision, coverGoal({ ...shooter, cover: { ...shooter.cover, minRange: 12 } }).revision);
});

test("live mode keeps the caller's cover when observation moves the entity", () => {
  const goal = safeFromEntitiesGoal([{ ...shooter, position: { x: -10, y: 0, z: 0 } }], 44);
  const resolved = goal.resolve(watching(0));
  assert.equal(resolved.kind, "active");
  if (resolved.kind === "active") assert.equal(resolved.isSatisfied(node(12), coverWorld(10)), true);
});
