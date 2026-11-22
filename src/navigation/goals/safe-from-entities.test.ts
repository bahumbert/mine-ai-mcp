import { MemoryWorld as GoalTestWorld } from "../world/memory-world.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { positionExposed } from "../../survival/positioning/combat/exposure.js";
import { EMPTY_OVERLAY_IDENTITY } from "../search/planning-overlay.js";
import { obstaclesOf, worldViewRaycaster } from "../world/line-of-sight.js";
import type { PlanningNode } from "./goal.js";
import { UNLOADED, type NavigationObservation, type WorldView } from "../world/world.js";
import { safeFromEntitiesGoal } from "./index.js";
import { observation } from "../../test-support/navigation.js";
import { PLAYER_STANDING_HEIGHT } from "../../world/player-physics.js";
import { shooterSeesBody } from "../../world/entity-geometry.js";
import { navigationFeet } from "../world/block-geometry.js";

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
  return { feet: { x, y: 0, z: 0 }, remainingScaffolds: 0, overlayId: EMPTY_OVERLAY_IDENTITY };
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

test("rays are cached per resolve and edited routes get distance alone without reading blocks", () => {
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
  assert.equal(goal.isSatisfied({ ...node(12), overlayId: "overlay:7" }, first), false);
  assert.equal(reads, 0);
  assert.equal(goal.isSatisfied({ ...node(44), overlayId: "overlay:7" }, first), true);
  assert.equal(reads, 0);
  reads = 0;
  assert.equal(coverGoal().isSatisfied(node(12), wrapper()), true);
  assert.ok(reads > 0);
});

test("a cell the route dug is not cover", () => {
  const world = coverWorld();
  for (let x = -1; x <= 14; x++) for (let y = -3; y < 0; y++) for (let z = -4; z <= 4; z++) {
    world.load({ x, y, z }, { stateId: x === 12 && z === 0 && y >= -2 ? 0 : 1 });
  }
  const resolved = safeFromEntitiesGoal([shooter], 36, { follow: "snapshot" }).resolve(watching(0));
  assert.equal(resolved.kind, "active");
  if (resolved.kind !== "active") throw new Error("inactive goal");
  const pit = { ...node(12), feet: { x: 12, y: -2, z: 0 } };
  assert.equal(resolved.isSatisfied({ ...pit, overlayId: "overlay:7" }, world), false);
  assert.equal(resolved.isSatisfied(pit, world), true);
  assert.equal(resolved.isSatisfied({ ...node(40), overlayId: "overlay:7" }, world), true);
});

test("the bot's own cell is judged where the body stands", () => {
  const world = new GoalTestWorld();
  for (let x = -2; x <= 20; x++) for (let z = -3; z <= 3; z++) for (let y = 62; y <= 66; y++) {
    world.load({ x, y, z }, { stateId: y === 62 || (x === 10 && z === 0 && y <= 65) ? 1 : 0 });
  }
  const ray = worldViewRaycaster((x, y, z) => obstaclesOf(world.blockAt(x, y, z)));
  const threat = { id: 7, position: new Vec3(0, 63, 0), width: 0.6, height: 1.74 / 0.85,
    attack: "projectile" as const };
  const goal = safeFromEntitiesGoal([{ id: 7, position: threat.position,
    cover: { minRange: 8, eyeHeight: 1.74, width: 0.6 } }], 36, { follow: "snapshot" });
  const current = { ...node(12), feet: { x: 12, y: 63, z: 0 } };
  assert.equal(positionExposed(ray, { position: new Vec3(12.5, 63, 0.95), width: 0.6, height: 1.8 }, threat), true);
  assert.equal(positionExposed(ray, { position: new Vec3(12.5, 63, 0.5), width: 0.6, height: 1.8 }, threat), false);
  for (const [z, exposed] of [[0.95, true], [0.5, false]] as const) {
    const position = new Vec3(12.5, 63, z);
    const resolved = goal.resolve({ ...observation(12), position });
    assert.equal(resolved.kind, "active");
    if (resolved.kind !== "active") throw new Error("inactive goal");
    assert.equal(resolved.isSatisfied(current, world), !exposed, `body at z ${z}`);
    assert.equal(resolved.isSatisfied({ ...current, feet: { x: 12, y: 63, z: -1 } }, world), false,
      "another cell is judged at its centre");
  }
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

type Cell = { readonly x: number; readonly y: number; readonly z: number };

/** A vanilla fence post: the centre 4/16 of a cell in x and z, 1.5 blocks tall. */
const FENCE_POST_SHAPE = [{ minX: 0.375, minY: 0, minZ: 0.375, maxX: 0.625, maxY: 1.5, maxZ: 0.625 }];

/** Air around the shooter line, stone at `stone`, fence posts at `posts`, and no load at `unloaded`. */
function sightWorld(stone: readonly Cell[], unloaded: Cell | null = null, posts: readonly Cell[] = []): GoalTestWorld {
  const world = new GoalTestWorld();
  const at = (cells: readonly Cell[], x: number, y: number, z: number) =>
    cells.some((cell) => cell.x === x && cell.y === y && cell.z === z);
  for (let x = -1; x <= 10; x++) for (let y = 63; y <= 68; y++) for (let z = -4; z <= 4; z++) {
    if (unloaded && unloaded.x === x && unloaded.y === y && unloaded.z === z) continue;
    if (at(posts, x, y, z)) world.load({ x, y, z }, { stateId: 2, collisionShapes: FENCE_POST_SHAPE });
    else world.load({ x, y, z }, { stateId: at(stone, x, y, z) ? 1 : 0 });
  }
  return world;
}

/** A wall at x=4, y 64-67, from z=-2 to `lastZ`. */
function sightWall(lastZ: number): Cell[] {
  const cells: Cell[] = [];
  for (let y = 64; y <= 67; y++) for (let z = -2; z <= lastZ; z++) cells.push({ x: 4, y, z });
  return cells;
}

test("shooter sight agrees across the verdict and the goal", () => {
  // The eye is height * 0.85, as positionExposed computes it; the goal receives the same eye height.
  const shooterPosition = new Vec3(9.5, 64, 0.5);
  const shooterHeight = 1.99;
  const threat = { id: 7, position: shooterPosition, width: 0.6, height: shooterHeight, attack: "projectile" as const };
  const goal = safeFromEntitiesGoal([{ id: 7, position: shooterPosition,
    cover: { minRange: 8, eyeHeight: shooterHeight * 0.85, width: 0.6 } }], 16, { follow: "snapshot" });
  // An unloaded cell reads as a hit to both the verdict's ray and the goal's ray; only the goal
  // also counts it as unknown, and an unknown cell is never cover (`&& !unknown`), so the goal
  // equals `!exposed && !unknown`.
  // Each body is judged where it stands: the goal's current cell takes the observed position exactly.
  const cases: readonly { name: string; world: GoalTestWorld; bodyZ: number; unloaded?: boolean; exposed?: boolean }[] = [
    { name: "open ground", world: sightWorld([]), bodyZ: 0.5, exposed: true },
    { name: "wall", world: sightWorld(sightWall(2)), bodyZ: 0.5, exposed: false },
    // A thin post: only its 0.25-block core is solid, so the body's width against the shooter decides.
    { name: "fence post", world: sightWorld([], null, [{ x: 4, y: 65, z: 0 }]), bodyZ: 0.5 },
    { name: "unloaded cell on the line", world: sightWorld([], { x: 4, y: 65, z: 0 }), bodyZ: 0.5, unloaded: true },
    // The wall's last cell is z=1, so its edge is z=2; a body centred on z=2 is half past it.
    { name: "body half past the wall's edge", world: sightWorld(sightWall(1)), bodyZ: 2 },
  ];
  for (const { name, world, bodyZ, unloaded = false, exposed: expected } of cases) {
    const ray = worldViewRaycaster((x, y, z) => obstaclesOf(world.blockAt(x, y, z)));
    const position = new Vec3(0.5, 64, bodyZ);
    const body = { position, width: 0.6, height: PLAYER_STANDING_HEIGHT };
    const exposed = positionExposed(ray, body, threat);
    if (expected !== undefined) assert.equal(exposed, expected, `${name}: verdict`);
    assert.equal(shooterSeesBody(ray, { position: shooterPosition, width: 0.6, height: shooterHeight }, body), exposed,
      `${name}: helper`);
    const resolved = goal.resolve({ ...observation(0, 64, 0), position });
    assert.equal(resolved.kind, "active");
    if (resolved.kind !== "active") throw new Error("inactive goal");
    const feet = navigationFeet(position, true);
    assert.equal(resolved.isSatisfied({ feet, remainingScaffolds: 0, overlayId: EMPTY_OVERLAY_IDENTITY }, world),
      !exposed && !unloaded, `${name}: goal`);
  }
});

test("an unsafe predicate refuses an otherwise covered cell", () => {
  const world = coverWorld(6);
  const entity = { id: 7, position: { x: 12, y: 0, z: 0 }, cover: { minRange: 8, eyeHeight: 1.6, width: 0.6 } };
  const at = (x: number) => ({ feet: { x, y: 0, z: 0 }, remainingScaffolds: 0, overlayId: EMPTY_OVERLAY_IDENTITY });
  const activeGoal = (unsafeRevision?: number) => {
    const options = unsafeRevision === undefined ? { follow: "snapshot" as const }
      : { follow: "snapshot" as const, unsafe: (feet: Vec3) => feet.x === 0, unsafeRevision };
    const resolved = safeFromEntitiesGoal([entity], 16, options).resolve(observation(30, 0, 30));
    if (resolved.kind !== "active") throw new Error("inactive goal");
    return resolved;
  };
  const refused = activeGoal(1);
  assert.equal(activeGoal().isSatisfied(at(0), world), true);
  assert.equal(refused.isSatisfied(at(0), world), false);
  assert.equal(refused.isSatisfied(at(-1), world), true);
  assert.notEqual(refused.revision, activeGoal().revision);
  assert.notEqual(refused.revision, activeGoal(2).revision);
});
