import { MemoryWorld as GoalTestWorld } from "../../world/memory-world.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { occupyGoal } from "../../index.js";
import { setCarriedCount } from "../../../test-support/carried-counts.js";
import { type FakeHarness, createFakeBot, createFakeClock } from "../../../test-support/fake-bot/index.js";
import { createNavigationRuntime } from "../../runtime.js";
import { createMovementPolicy } from "../../movements/policy.js";
import { createMineflayerMovementPolicy } from "../../mineflayer/movement-policy.js";
import { footprintColumns } from "../../../world/player-physics.js";
import { waterStancesHeld } from "../../steering/hold-water-position.js";
import { WORKING_OFFSETS } from "./drowned-target.js";
import { DROP_PICKUP_TIMEOUT_MS } from "./mine-drops.js";
import { mine, type MineRequest, type MineScan, type MineTarget } from "./mine-process.js";
import { MineTargeting } from "./mine-targeting.js";
import { standsOnBlock } from "./target-safety.js";

const goalTestWorld = new GoalTestWorld();

/**
 * The planner asks a goal about the bot's own feet before it searches, so a
 * goal that is satisfied where the bot already stands ends the run without
 * moving. For a mining goal that is a spin: nothing is broken, the quantity is
 * never met, and the process asks again forever.
 */
function satisfiedAt(feet: Vec3, target: Vec3, levels: 2 | 3): boolean {
  const snapshot = occupyGoal(target, levels).resolve({ position: feet, entities: new Map() } as never);
  assert.equal(snapshot.kind, "active");
  if (snapshot.kind !== "active") throw new Error("unreachable");
  return snapshot.isSatisfied({ feet, remainingScaffolds: [], overlayId: "overlay:0" } as never, goalTestWorld);
}

test("occupancy includes the same cell and headroom, excludes other columns and respects its level bound", () => {
  const cases = [
    { feet: new Vec3(5, 64, -2), target: new Vec3(5, 64, -2), levels: 3, occupied: true },
    { feet: new Vec3(5, 63, -2), target: new Vec3(5, 64, -2), levels: 3, occupied: true },
    { feet: new Vec3(5, 62, -2), target: new Vec3(5, 64, -2), levels: 3, occupied: true },
    { feet: new Vec3(5, 63, -2), target: new Vec3(5, 64, -2), levels: 2, occupied: true },
    { feet: new Vec3(5, 62, -2), target: new Vec3(5, 64, -2), levels: 2, occupied: false },
    { feet: new Vec3(0, 64, 0), target: new Vec3(5, 64, -2), levels: 3, occupied: false },
    { feet: new Vec3(5, 64, -2), target: new Vec3(5, 65, -2), levels: 3, occupied: true },
    { feet: new Vec3(5, 66, -2), target: new Vec3(5, 66, -2), levels: 3, occupied: true },
  ] as const;
  for (const { feet, target, levels, occupied } of cases) {
    assert.equal(satisfiedAt(feet, target, levels), occupied);
  }
});

/** Ticks a drop waits before the server lets the bot take it: the scene's item stays on the ground. */
const STAYS_ON_THE_GROUND_TICKS = 1_000_000;
/** Clock the process may use in one test, ms; every wait of a run is a tick or a timer of this clock. */
const RUN_BOUND_MS = 60_000;
/** When the caller of `onArrival` cancels in the test of a wait with physics stopped: after the dig wait's own bound. */
const CALLER_CANCEL_MS = 4_000;

/** The entity id of the scene's `index`th drop: past the bot's own id. */
const dropId = (index: number) => 100 + index;

type Cells = readonly Vec3[];

/** The shared fake with the clock its waits run on, and `dropAt` for the item entities the server spawns. */
type MineScene = FakeHarness & Disposable & { dropAt(index: number, position: Vec3): Entity };

interface SceneOptions {
  /** Stone, the block the requests mine. */
  blocks?: Cells;
  /** Dirt: floors and walls. */
  solids?: Cells;
  lava?: Cells;
  water?: Cells;
  obsidian?: Cells;
  /** Item name to count carried. */
  carrying?: Record<string, number>;
  /** Stone item entities lying at these cells, ids `dropId(0)`, `dropId(1)`, ...; the server never lets the bot pick them up. */
  drops?: Cells;
  feet?: Vec3;
  onGround?: boolean;
  isInWater?: boolean;
  /** Mineflayer's own physics engine moves the body (sinking in water). */
  physics?: boolean;
  /** Counts every `bot.blockAt` read. */
  onBlockRead?: () => void;
  /** Runs when the process starts waiting for ticks, before the wait itself. */
  onWaitForTicks?: (scene: MineScene) => void | Promise<void>;
}

/** The scene on the shared fake, open air below the feet and its clock installed until the scene is disposed. */
function mineScene(options: SceneOptions = {}): MineScene {
  const clock = createFakeClock({ mode: "mocked" });
  const timers = clock.install();
  const cells: Record<string, string> = {};
  const lay = (list: Cells | undefined, name: string) => {
    for (const cell of list ?? []) cells[`${cell.x},${cell.y},${cell.z}`] = name;
  };
  lay(options.solids, "dirt");
  lay(options.lava, "lava");
  lay(options.water, "water");
  lay(options.obsidian, "obsidian");
  lay(options.blocks, "stone");
  const harness = createFakeBot({
    clock,
    cells,
    groundY: null,
    position: options.feet ?? new Vec3(0, 64, 0),
    carried: options.carrying ?? {},
    simulatePhysics: options.physics ?? false,
  });
  const { bot } = harness;
  Object.assign(bot.entity, { onGround: options.onGround ?? true, isInWater: options.isInWater ?? false });
  const dropAt = (index: number, position: Vec3) =>
    harness.entities.spawn({
      id: dropId(index),
      name: "item",
      position,
      item: { name: "stone", count: 1 },
      pickupDelayTicks: STAYS_ON_THE_GROUND_TICKS,
    });
  const scene: MineScene = Object.assign(harness, { dropAt, [Symbol.dispose]: () => timers[Symbol.dispose]() });
  (options.drops ?? []).forEach((cell, index) => dropAt(index, cell));
  if (options.onBlockRead) {
    const blockAt = bot.blockAt.bind(bot);
    bot.blockAt = (...args) => {
      options.onBlockRead!();
      return blockAt(...args);
    };
  }
  if (options.onWaitForTicks) {
    const waitForTicks = bot.waitForTicks.bind(bot);
    bot.waitForTicks = async (ticks) => {
      await options.onWaitForTicks!(scene);
      await waitForTicks(ticks);
    };
    // The miner's own tick wait listens to `physicsTick` itself (`waitForPhysicsTicks`, so a cancel ends it when physics
    // stops): the hook runs on the tick such a wait consumes, before the wait hears it (this listener is the first). Our
    // listener is the only one when nothing waits.
    bot.on("physicsTick", () => {
      if (bot.listenerCount("physicsTick") > 1) void options.onWaitForTicks!(scene);
    });
  }
  return scene;
}

const stateIdOf = (scene: MineScene, name: string) => scene.bot.registry.blocksByName[name]!.defaultState!;

function request(scene: MineScene, overrides: Partial<MineRequest> = {}): MineRequest {
  return {
    matches: (block) => block.name === "stone",
    canMine: (block) =>
      block.diggable === false
        ? { kind: "prohibited", reason: `${block.name} cannot be broken at all` }
        : { kind: "mineable", routeMayBreak: true },
    matchingStateIds: new Set([stateIdOf(scene, "stone")]),
    collects: () => true,
    isSatisfied: () => false,
    observedInventoryGain: () => 0,
    movements: {} as MineRequest["movements"],
    castSearchRadius: 64,
    explore: false,
    maximumBreaks: 4,
    route: async () => ({ status: "completed", elapsedMs: 0 }),
    breakInPlace: async () => ({ status: "broken" }),
    placeInto: async () => ({ kind: "failed", error: "the fake bot places nothing" }),
    cast: null,
    ...overrides,
  };
}

/** Run the process on the scene's clock: each tick or timer it waits for passes in 50 ms slices. */
function runMine(scene: MineScene, overrides: Partial<MineRequest> = {}) {
  return scene.clock.settle(mine(scene.bot, request(scene, overrides)), RUN_BOUND_MS);
}

/** A route that found no path: what the planner tells `onCalculationFailure`. */
function noPath(scene: MineScene, closest: { x: number; y: number; z: number }, heuristic: number) {
  return {
    failure: {
      kind: "no_path" as const,
      search: { queued: 0, visited: 1, farthestVisited: 0, generated: 1, slices: 1, computeMs: 1 },
      closest: { position: closest, heuristic, routeCost: 0, basis: "best_heuristic_search_node" as const },
    },
    observation: { position: scene.bot.entity.position } as never,
    signal: new AbortController().signal,
  };
}

/** The route reaching a node: what `onArrival` receives. */
function arrival(scene: MineScene) {
  return {
    goalRevision: "test",
    node: {} as never,
    observation: { position: scene.bot.entity.position } as never,
    signal: new AbortController().signal,
  };
}

const cellAt = (cell: { x: number; y: number; z: number }) => new Vec3(cell.x, cell.y, cell.z);
const carriedNames = (scene: MineScene) => scene.inventory.items().map((item) => item.name);

/** The server's `set_slot` after a bucket use: the carried `from` item became `to`. */
function swapCarried(scene: MineScene, from: string, to: string): void {
  const { inventory, bot } = scene;
  setCarriedCount(inventory, bot.registry, bot.registry.itemsByName[from]!.id, 0);
  setCarriedCount(inventory, bot.registry, bot.registry.itemsByName[to]!.id, 1);
}

/** A route that must not run: the target is already in reach. */
const noRouteNeeded = async (): Promise<never> => {
  throw new Error("a target already in reach must not be routed to");
};

/** The break in place as the server answers it: the cell becomes air. */
function breakingInPlace(scene: MineScene, onBroken: () => void): MineRequest["breakInPlace"] {
  return async ({ position }) => {
    scene.world.setCell(cellAt(position), "air");
    onBroken();
    return { status: "broken" };
  };
}

/** A route whose arrival callback runs twice, told to continue both times; then `onDone`. */
function twoArrivals(scene: MineScene, onDone: () => void): MineRequest["route"] {
  return async (options) => {
    const arrived = arrival(scene);
    assert.equal((await options.onArrival?.(arrived))?.kind, "continue");
    assert.equal((await options.onArrival?.(arrived))?.kind, "continue");
    onDone();
    return { status: "completed", elapsedMs: 0 };
  };
}

test("a non-exploratory run with nothing matching in range stops", async () => {
  using scene = mineScene();
  const result = await runMine(scene);

  assert.equal(result.status, "no_targets");
  assert.deepEqual(result.broken, []);
});

test("no targetCost keeps today's order and cut", async () => {
  const blocks = Array.from({ length: 70 }, (_, index) => new Vec3(index + 5, 64, 0));
  using scene = mineScene({ blocks });
  let satisfied = false;
  let offered: number[] = [];
  await runMine(scene, {
    isSatisfied: () => satisfied,
    onTargets: (targets) => { offered = targets.map((target) => target.position.x); },
    route: async () => {
      satisfied = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.deepEqual(offered, Array.from({ length: 64 }, (_, index) => index + 5));
});

test("targetCost reorders blocks, never drops", async () => {
  using scene = mineScene({ blocks: [new Vec3(5, 64, 0), new Vec3(7, 64, 0)], drops: [new Vec3(9, 64, 0)] });
  let satisfied = false;
  let begun = false;
  const scans: MineScan[] = [];
  const result = await runMine(scene, {
    isSatisfied: () => satisfied,
    targetCost: {
      beginScan: () => { begun = true; },
      cost: (position) => { assert.equal(begun, true); return position.x === 5 ? 4 : 0; },
    },
    onScan: (scan) => { scans.push(scan); },
    onTargets: (targets) => { assert.deepEqual(targets.map((target) => target.kind), ["drop"]); },
    route: async () => { satisfied = true; return { status: "completed", elapsedMs: 0 }; },
  });
  assert.equal(result.status, "satisfied");
  assert.deepEqual(scans[0]!.targets.map((target) => [target.kind, target.position.x]), [["drop", 9], ["block", 7], ["block", 5]]);
  assert.equal(result.passedOver, 0);
});

test("with a cost the scan looks past the 64 nearest and passedOver is the run's largest; onScan sees every scan", async () => {
  const blocks = Array.from({ length: 70 }, (_, index) => new Vec3(index + 5, 64, 0));
  using scene = mineScene({ blocks });
  let satisfied = false;
  let scans = 0;
  let begins = 0;
  const announcements: number[][] = [];
  const result = await runMine(scene, {
    isSatisfied: () => satisfied,
    targetCost: {
      beginScan: () => { begins += 1; },
      cost: (position) => scans === 0 && position.x !== 74 ? 100 : 0,
    },
    onScan: (scan) => {
      scans += 1;
      assert.equal(scan.candidates.length, 70);
      if (scans === 1) {
        assert.deepEqual(scan.targets.map((target) => target.position.x), [74]);
        assert.equal(scan.passedOver.length, 69);
      } else assert.deepEqual(scan.targets.map((target) => target.position.x), [5, 6, 7, 8, 9]);
    },
    onTargets: (targets) => { announcements.push(targets.map((target) => target.position.x)); },
    route: async ({ goal }) => {
      const observation = { position: scene.bot.entity.position, entities: new Map() } as never;
      goal.resolve(observation); // Cached: this is not another scan.
      await scene.clock.sleep(260);
      goal.resolve(observation);
      await scene.clock.sleep(260);
      goal.resolve(observation); // Unchanged targets still produce a fresh scan observation.
      satisfied = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(scans, 3);
  assert.equal(begins, 3);
  assert.deepEqual(announcements, [[74], [5, 6, 7, 8, 9]]);
  assert.equal(result.passedOver, 69);
  assert.deepEqual(result.passedOverNearest, { x: 5, y: 64, z: 0, distance: Math.sqrt(30.75) });
});

test("the under-water rejection count covers the widened scan", async () => {
  const blocks = Array.from({ length: 1030 }, (_, index) => new Vec3(index + 5, 64, 0));
  using scene = mineScene({ blocks });
  let inspected = false;
  const result = await runMine(scene, {
    targetCost: { beginScan() {}, cost: () => 0 },
    canMine: () => ({ kind: "prohibited", reason: "in water: no dry ground", underWater: true }),
    onScan: (scan) => {
      inspected = true;
      assert.equal(scan.underWaterRejections, 1024);
      assert.deepEqual(scan.candidates, []);
    },
    route: noRouteNeeded,
  });
  assert.equal(inspected, true);
  assert.equal(result.underWater, true);
});

test("a drained target excludes wet stances with and without weighing, preserving weighed identity and metadata", async () => {
  for (const weighed of [false, true]) {
    const target = new Vec3(1, 64, 0);
    const wet = new Vec3(2, 64, 0);
    using scene = mineScene({ blocks: [target], water: [wet], feet: new Vec3(8.5, 64, 0.5) });
    let satisfied = false;
    let inspected = false;
    const result = await runMine(scene, {
      isSatisfied: () => satisfied,
      targetCost: weighed ? { beginScan() {}, cost: () => 0 } : undefined,
      canMine: () => ({ kind: "mineable", routeMayBreak: false, drained: { wetStances: [wet] } }),
      onScan: (scan) => {
        if (!weighed) return;
        inspected = true;
        const kept = scan.targets[0];
        assert.equal(kept, scan.candidates[0]);
        assert.equal(kept?.kind, "block");
        if (kept?.kind !== "block") throw new Error("expected the drained block");
        assert.equal(kept.drained, true);
        assert.deepEqual([...kept.excludedStances], ["2,64,0"]);
      },
      route: async ({ goal }) => {
        const resolved = goal.resolve({ position: scene.bot.entity.position, entities: new Map() } as never);
        assert.equal(resolved.kind, "active");
        if (resolved.kind !== "active") throw new Error("expected a dry working stance");
        const at = (feet: Vec3) => ({ feet, remainingScaffolds: 0, overlayId: "overlay:0" });
        assert.equal(resolved.isSatisfied(at(wet), goalTestWorld), false);
        assert.equal(resolved.isSatisfied(at(new Vec3(0, 64, 0)), goalTestWorld), true);
        satisfied = true;
        return { status: "completed", elapsedMs: 0 };
      },
    });
    assert.equal(result.status, "satisfied");
    assert.equal(inspected, weighed);
  }
});

test("support exclusions cover the occupied edge stance and refresh away while explicit failures persist (P4-34)", async () => {
  const target = new Vec3(1, 64, 0);
  using scene = mineScene({ blocks: [target], feet: new Vec3(0.85, 65, 0.5) });
  let excluded: string[] | null = null;
  await runMine(scene, {
    isSatisfied: () => excluded !== null,
    targetCost: { beginScan() {}, cost: () => 0 },
    onScan: (scan) => {
      const kept = scan.targets[0];
      if (kept?.kind === "block") excluded = [...kept.excludedStances];
    },
    route: async () => ({ status: "completed", elapsedMs: 0 }),
  });
  assert.deepEqual(excluded, ["1,65,0", "0,65,0"]);
  const targeting = new MineTargeting(scene.bot, request(scene, { exactTarget: target }));
  const first = targeting.targets()[0];
  assert.ok(first?.kind === "block");
  targeting.excludeBlockStance(first, new Vec3(3, 65, 0));
  scene.world.setCell(new Vec3(2, 64, 0), "stone");
  scene.bot.entity.position = new Vec3(2.5, 65, 0.5);
  const second = targeting.refresh()[0];
  assert.ok(second?.kind === "block");
  assert.deepEqual([...second.excludedStances], ["3,65,0"]);
  targeting.excludeBlockStance(second, new Vec3(4, 65, 0));
  const third = targeting.refresh()[0];
  assert.ok(third?.kind === "block");
  assert.deepEqual([...third.excludedStances], ["3,65,0", "4,65,0"]);
});

test("sealed edge work reapproaches a stone bank without dispatching a support dig", async () => {
  const target = new Vec3(1, 64, 0);
  using scene = mineScene({ blocks: [target], lava: [new Vec3(1, 64, 1)], feet: new Vec3(0.85, 65, 0.5) });
  scene.world.setCell(new Vec3(2, 64, 0), "stone");
  let broken = false;
  let routed = false;
  const result = await runMine(scene, {
    exactTarget: target,
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    isSatisfied: () => broken,
    placeInto: async (_bot, cell) => {
      assert.deepEqual(cellAt(cell), new Vec3(1, 64, 1));
      scene.world.setCell(cellAt(cell), "cobblestone");
      return { kind: "placed", block: scene.bot.blockAt(cellAt(cell))! };
    },
    route: async () => {
      assert.equal(broken, false);
      scene.bot.entity.position = new Vec3(2.5, 65, 0.5);
      assert.equal(scene.bot.blockAt(new Vec3(2, 64, 0))?.name, "stone");
      assert.equal(standsOnBlock(scene.bot, target), false);
      routed = true;
      return { status: "completed", elapsedMs: 0 };
    },
    breakInPlace: async (options) => {
      assert.equal(routed, true, "the original edge stance cannot dispatch a break");
      assert.equal(options.retainSupport, true);
      scene.world.setCell(target, "air");
      broken = true;
      return { status: "broken" };
    },
  });
  assert.equal(result.status, "satisfied");
  assert.deepEqual(result.broken, [target]);
});

test("alternative centre support permits sealed in-place work without routing", async () => {
  const target = new Vec3(1, 64, 0);
  using scene = mineScene({ blocks: [target], solids: [new Vec3(0, 64, 0)], feet: new Vec3(0.85, 65, 0.5) });
  const targeting = new MineTargeting(scene.bot, request(scene, { exactTarget: target }));
  const kept = targeting.targets()[0];
  assert.ok(kept?.kind === "block");
  assert.deepEqual([...kept.excludedStances], []);
  let broken = false;
  const result = await runMine(scene, {
    exactTarget: target,
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    isSatisfied: () => broken,
    route: noRouteNeeded,
    breakInPlace: async ({ retainSupport }) => {
      assert.equal(retainSupport, true);
      scene.world.setCell(target, "air");
      broken = true;
      return { status: "broken" };
    },
  });
  assert.equal(result.status, "satisfied");
});

test("motion to sole edge support during settle, water clearing or sealing returns to a safe bank", async () => {
  for (const preparation of ["settle", "water", "seal"] as const) {
    const target = new Vec3(1, 64, 0);
    const face = new Vec3(1, 64, 1);
    using scene = mineScene({
      blocks: [target], feet: new Vec3(2.5, preparation === "settle" ? 65.2 : 65, 0.5),
      onGround: preparation !== "settle", isInWater: preparation === "settle",
      water: preparation === "water" ? [face] : [], lava: preparation === "seal" ? [face] : [],
    });
    scene.world.setCell(new Vec3(2, 64, 0), "stone");
    const displace = () => {
      scene.bot.entity.position = new Vec3(0.85, 65, 0.5);
      Object.assign(scene.bot.entity, { onGround: true, isInWater: false });
      assert.equal(standsOnBlock(scene.bot, target), true);
    };
    if (preparation === "settle") scene.bot.once("physicsTick", displace);
    let broken = false;
    let routed = false;
    const result = await runMine(scene, {
      exactTarget: target,
      canMine: () => ({ kind: "mineable", routeMayBreak: false }),
      isSatisfied: () => broken,
      placeInto: async (_bot, cell) => {
        scene.world.setCell(cellAt(cell), "cobblestone");
        displace();
        return { kind: "placed", block: scene.bot.blockAt(cellAt(cell))! };
      },
      route: async () => {
        assert.equal(broken, false, preparation);
        routed = true;
        scene.bot.entity.position = new Vec3(2.5, 65, 0.5);
        return { status: "completed", elapsedMs: 0 };
      },
      breakInPlace: async () => {
        assert.equal(routed, true, `${preparation} must not dispatch from the displaced edge`);
        scene.world.setCell(target, "air");
        broken = true;
        return { status: "broken" };
      },
    });
    assert.equal(result.status, "satisfied", preparation);
    assert.deepEqual(result.broken, [target]);
    assert.equal(scene.bot.listenerCount("physicsTick"), 0);
  }
});

test("a late support refusal refreshes the stance without blacklisting the unbroken target", async () => {
  const target = new Vec3(1, 64, 0);
  using scene = mineScene({ blocks: [target], feet: new Vec3(2.5, 65, 0.5) });
  scene.world.setCell(new Vec3(2, 64, 0), "stone");
  let attempts = 0;
  const result = await runMine(scene, {
    exactTarget: target,
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    isSatisfied: () => attempts === 2,
    breakInPlace: async () => {
      if (++attempts === 1) {
        scene.bot.entity.position = new Vec3(0.85, 65, 0.5);
        return { status: "failed", cause: "support", reason: "support changed; approach from a safe bank" };
      }
      scene.world.setCell(target, "air");
      return { status: "broken" };
    },
    route: async () => {
      assert.equal(scene.bot.blockAt(target)?.name, "stone");
      scene.bot.entity.position = new Vec3(2.5, 65, 0.5);
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(result.status, "satisfied");
  assert.deepEqual(result.broken, [target]);
});

test("cancel or death during preparation prevents later placement and swing, then a fresh action succeeds", async () => {
  for (const interruption of ["cancel", "death"] as const) {
    const target = new Vec3(1, 64, 0);
    using scene = mineScene({ blocks: [target], lava: [new Vec3(1, 64, 1), new Vec3(2, 64, 0)], feet: new Vec3(0.5, 64, 0.5) });
    const lifetime = new AbortController();
    // Runtime action ownership aborts the request on death; this is the process's signal port.
    scene.bot.once("death", () => lifetime.abort(new Error("death")));
    let placements = 0;
    await assert.rejects(runMine(scene, {
      signal: lifetime.signal,
      canMine: () => ({ kind: "mineable", routeMayBreak: false }),
      placeInto: async (_bot, cell) => {
        assert.equal(++placements, 1, "no second preparation after interruption");
        scene.world.setCell(cellAt(cell), "cobblestone");
        if (interruption === "death") scene.bot.emit("death");
        else lifetime.abort(new Error("cancel"));
        return { kind: "placed", block: scene.bot.blockAt(cellAt(cell))! };
      },
      breakInPlace: async () => { throw new Error("unexpected swing after interruption"); },
      route: noRouteNeeded,
    }), new RegExp(interruption));
    let broken = false;
    const next = await runMine(scene, {
      canMine: () => ({ kind: "mineable", routeMayBreak: false }),
      isSatisfied: () => broken,
      placeInto: async (_bot, cell) => {
        scene.world.setCell(cellAt(cell), "cobblestone");
        return { kind: "placed", block: scene.bot.blockAt(cellAt(cell))! };
      },
      breakInPlace: async () => {
        scene.world.setCell(target, "air");
        broken = true;
        return { status: "broken" };
      },
      route: noRouteNeeded,
    });
    assert.equal(next.status, "satisfied");
    assert.equal(scene.bot.listenerCount("physicsTick"), 0);
  }
});

test("nearby drops are recovered before another source is offered for mining", async () => {
  const cell = new Vec3(1, 64, 0);
  using scene = mineScene({ blocks: [cell], drops: [cell] });
  let satisfied = false;
  let kinds: string[] = [];
  const result = await runMine(scene, {
    isSatisfied: () => satisfied,
    onTargets: (targets) => {
      kinds = targets.map((target) => target.kind);
    },
    route: async () => {
      assert.deepEqual(kinds, ["drop"]);
      satisfied = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(result.status, "satisfied");
});

test("an exploratory run keeps one branch point and rewards outward progress at its Y level", async () => {
  using scene = mineScene({ feet: new Vec3(0.5, 64, 0.5) });
  let satisfied = false;

  const result = await runMine(scene, {
    explore: true,
    isSatisfied: () => satisfied,
    route: async (options) => {
      const observation = { position: scene.bot.entity.position, entities: new Map() } as never;
      const first = options.goal.resolve(observation);
      const second = options.goal.resolve(observation);
      assert.equal(first.kind, "active");
      assert.equal(second.kind, "active");
      if (first.kind !== "active" || second.kind !== "active") throw new Error("unreachable");
      assert.equal(first.revision, second.revision);

      const node = (x: number, y: number) =>
        ({ feet: { x, y, z: 0 }, remainingScaffolds: 0, overlayId: "overlay:0" }) as never;
      assert.equal(first.isSatisfied(node(0, 64), goalTestWorld), false);
      assert.ok(first.heuristic(node(6, 64)) < first.heuristic(node(0, 64)));
      assert.ok(first.heuristic(node(6, 65)) > first.heuristic(node(6, 64)));

      satisfied = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "satisfied");
});

test("a calculation failure while exploring stops instead of reopening the same search", async () => {
  using scene = mineScene();
  let routes = 0;

  const result = await runMine(scene, {
    explore: true,
    route: async (options) => {
      routes += 1;
      const resolution = await options.onCalculationFailure?.(noPath(scene, { x: 0, y: 64, z: 0 }, 0));
      assert.equal(resolution?.kind, "completed");
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(routes, 1);
  assert.equal(result.status, "stopped");
  assert.equal(
    result.reason,
    "no path found after 1 ms compute; visited 1 nodes, generated 1; closest node was 0,64,0",
  );
});

test("a newly observed ore target replaces the branch goal in the same route", async () => {
  using scene = mineScene();
  const target = new Vec3(5, 64, 0);
  let satisfied = false;

  const result = await runMine(scene, {
    explore: true,
    isSatisfied: () => satisfied,
    route: async (options) => {
      const observation = { position: scene.bot.entity.position, entities: new Map() } as never;
      const branch = options.goal.resolve(observation);
      assert.equal(branch.kind, "active");
      if (branch.kind !== "active") throw new Error("unreachable");
      assert.match(branch.revision, /^mine-branch:/);

      scene.world.setCell(target, "stone");
      await scene.clock.sleep(260);

      const ore = options.goal.resolve(observation);
      assert.equal(ore.kind, "active");
      if (ore.kind !== "active") throw new Error("unreachable");
      assert.doesNotMatch(ore.revision, /^mine-branch:/);
      assert.match(ore.revision, /5,64,0/);

      satisfied = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "satisfied");
});

test("an anticipated drop follows Mineflayer's item entity before its metadata arrives", async () => {
  const target = new Vec3(5, 64, 0);
  using scene = mineScene({ blocks: [target] });
  let satisfied = false;
  const result = await runMine(scene, {
    isSatisfied: () => satisfied,
    route: async (options) => {
      scene.world.setCell(target, "air");
      const resolution = await options.onArrival?.(arrival(scene));
      assert.equal(resolution?.kind, "continue");
      assert.equal(options.goal.resolve({ position: scene.bot.entity.position } as never).kind, "active");
      setTimeout(() => {
        // The server sends the entity before its item stack: `getDroppedItem` throws until the metadata arrives.
        // Stopgap until the master adds an entity spawned with no metadata: the fake writes the stack first,
        // `prismarine-entity` `getDroppedItem` (`Item.fromNotch(undefined)`) throws once it is cleared.
        const late = scene.dropAt(0, new Vec3(5, 63, 0));
        late.metadata.length = 0;
        assert.throws(() => late.getDroppedItem());
      }, 50);
      const afterFailure = await options.onCalculationFailure?.(noPath(scene, { x: 0, y: 64, z: 0 }, 1));
      assert.equal(afterFailure?.kind, "continue");
      satisfied = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "satisfied");
});

/** Mine one stone that comes down with no item entity ever spawning; returns how many lost drops the process reported. */
async function lostDropsOfUnspawnedBreak(carrying: Record<string, number>): Promise<number> {
  const target = new Vec3(5, 64, 0);
  using scene = mineScene({ blocks: [target], carrying });
  let lost = 0;
  await runMine(scene, {
    onLostDrop: () => { lost += 1; },
    route: async (options) => {
      const observation = { position: scene.bot.entity.position, entities: new Map() } as never;
      options.goal.resolve(observation);
      scene.world.setCell(target, "air");
      await scene.clock.sleep(300);
      options.goal.resolve(observation);
      await scene.clock.sleep(5_500);
      options.goal.resolve(observation);
      return { status: "completed", elapsedMs: 0 };
    },
  });
  return lost;
}

test("a missing stone drop is reported lost with a pickaxe, but never when broken by hand", async () => {
  for (const expected of [1, 0]) {
    assert.equal(await lostDropsOfUnspawnedBreak(expected ? { wooden_pickaxe: 1 } : {}), expected);
  }
});

test("an occupied drop arrival yields a server pickup interval before continuing", async () => {
  let ticks = 0;
  using scene = mineScene({
    drops: [new Vec3(0, 64, 0)],
    feet: new Vec3(0, 64, 0),
    onWaitForTicks: () => {
      ticks += 1;
    },
  });
  let satisfied = false;

  const result = await runMine(scene, {
    isSatisfied: () => satisfied,
    route: async (options) => {
      const resolution = await options.onArrival?.(arrival(scene));
      assert.equal(resolution?.kind, "continue");
      satisfied = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "satisfied");
  assert.equal(ticks, 1);
});

test("a vanished item stays pending until Mineflayer applies the inventory packet", async () => {
  const cell = new Vec3(0, 64, 0);
  let satisfied = false;
  let inventoryGain = 0;
  let ticks = 0;
  using scene = mineScene({
    drops: [cell],
    feet: cell,
    onWaitForTicks: ({ entities }) => {
      ticks += 1;
      if (ticks === 1) entities.remove(dropId(0));
      if (ticks === 2) {
        inventoryGain = 1;
        satisfied = true;
      }
    },
  });

  const result = await runMine(scene, {
    isSatisfied: () => satisfied,
    observedInventoryGain: () => inventoryGain,
    route: async (options) => {
      const arrived = arrival(scene);
      assert.equal((await options.onArrival?.(arrived))?.kind, "continue");
      assert.equal((await options.onArrival?.(arrived))?.kind, "completed");
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "satisfied");
  assert.equal(ticks, 2);
});

test("a confirmed pickup does not linger while another item remains", async () => {
  const cell = new Vec3(0, 64, 0);
  let inventoryGain = 0;
  let satisfied = false;
  const announcements: string[][] = [];
  using scene = mineScene({
    drops: [cell, cell],
    feet: cell,
    onWaitForTicks: ({ bot, entities }) => {
      if (bot.entities[dropId(0)]) {
        entities.remove(dropId(0));
        inventoryGain = 1;
      }
    },
  });

  const result = await runMine(scene, {
    isSatisfied: () => satisfied,
    observedInventoryGain: () => inventoryGain,
    onTargets: (targets) => {
      announcements.push(
        targets.map((target) =>
          target.kind === "drop" || target.kind === "settling_drop" ? `${target.kind}:${target.entityId}` : target.kind,
        ),
      );
    },
    route: twoArrivals(scene, () => (satisfied = true)),
  });

  assert.equal(result.status, "satisfied");
  assert.deepEqual(announcements.at(-1), [`drop:${dropId(1)}`]);
});

test("a vanished route target does not blacklist a different live item", async () => {
  const cell = new Vec3(0, 64, 0);
  using scene = mineScene({ drops: [cell, cell], feet: cell });
  let inventoryGain = 0;
  let routes = 0;

  const result = await runMine(scene, {
    isSatisfied: () => inventoryGain === 2,
    observedInventoryGain: () => inventoryGain,
    route: async () => {
      routes += 1;
      if (routes === 1) {
        scene.entities.remove(dropId(0));
        inventoryGain = 1;
        return { status: "stopped", reason: `Entity ${dropId(0)} is not currently observed.`, elapsedMs: 0 };
      }
      scene.entities.remove(dropId(1));
      inventoryGain = 2;
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "satisfied");
  assert.equal(routes, 2);
});

test("a reachable shaft is submitted to search instead of bypassing excavation cost", async () => {
  const target = new Vec3(0, 66, 0);
  using scene = mineScene({ blocks: [target], feet: new Vec3(0.5, 64, 0.5) });
  let satisfied = false;
  let routes = 0;
  const result = await runMine(scene, {
    isSatisfied: () => satisfied,
    breakInPlace: async () => {
      throw new Error("shaft mining must not bypass search");
    },
    route: async (options) => {
      routes += 1;
      const goal = options.goal.resolve({ position: scene.bot.entity.position, entities: new Map() } as never);
      assert.equal(goal.kind, "active");
      if (goal.kind !== "active") throw new Error("expected mining goal");
      assert.equal(
        goal.isSatisfied({ feet: scene.bot.entity.position, remainingScaffolds: 0, overlayId: "overlay:0" }, goalTestWorld),
        false,
      );
      assert.equal(typeof goal.finish, "function");
      satisfied = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(result.status, "satisfied");
  assert.equal(routes, 1);
});

test("an airborne bot leaves a reachable shaft target for Pathfinder", async () => {
  const target = new Vec3(0, 65, 0);
  using scene = mineScene({ blocks: [target], feet: new Vec3(0.5, 64, 0.5), onGround: false });
  let breakAttempts = 0;
  let satisfied = false;

  const result = await runMine(scene, {
    isSatisfied: () => satisfied,
    breakInPlace: async () => {
      breakAttempts += 1;
      return { status: "broken" };
    },
    route: async () => {
      satisfied = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "satisfied");
  assert.equal(breakAttempts, 0);
});

test("standing inside an upward vein does not declare its excavation complete", async () => {
  const lower = new Vec3(5, 64, 0);
  const upper = new Vec3(5, 65, 0);
  using scene = mineScene({
    blocks: [lower, upper],
    solids: [new Vec3(5, 62, 0), new Vec3(5, 63, 0), new Vec3(5, 66, 0)],
  });
  let satisfied = false;

  const result = await runMine(scene, {
    isSatisfied: () => satisfied,
    route: async (options) => {
      const snapshot = options.goal.resolve({ position: scene.bot.entity.position, entities: new Map() } as never);
      assert.equal(snapshot.kind, "active");
      if (snapshot.kind !== "active") throw new Error("expected active mining goal");
      const node = (feet: Vec3) => ({ feet, remainingScaffolds: [], overlayId: "overlay:0" }) as never;
      assert.equal(snapshot.isSatisfied(node(new Vec3(5, 62, 0)), goalTestWorld), false);
      assert.equal(snapshot.isSatisfied(node(lower), goalTestWorld), false);
      assert.equal(typeof snapshot.finish, "function");
      satisfied = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "satisfied");
});

test("a target the movement policy cannot mine is reported as observed but unmineable", async () => {
  using scene = mineScene({ blocks: [new Vec3(5, 64, 0)] });
  let routes = 0;
  const result = await runMine(scene, {
    canMine: () => ({ kind: "prohibited", reason: "3 lava faces, 1 block carried" }),
    route: async () => {
      routes += 1;
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "unreachable");
  // The numbers, not "the movement policy": this is what the model reads.
  assert.equal(result.reason, "1 loaded matching block(s) cannot be mined: 3 lava faces, 1 block carried");
  assert.equal(routes, 0);
});

test("rejection reasons are counted separately so one bad tool does not hide a lava face", async () => {
  using scene = mineScene({ blocks: [new Vec3(5, 64, 0), new Vec3(6, 64, 0), new Vec3(7, 64, 0)] });
  const result = await runMine(scene, {
    canMine: (block) => ({
      kind: "prohibited",
      reason: block.position.x === 5 ? "no carried tool can harvest this block" : "2 lava faces, 0 blocks carried",
    }),
  });

  assert.equal(result.status, "unreachable");
  assert.equal(
    result.reason,
    "3 loaded matching block(s) cannot be mined: 2 lava faces, 0 blocks carried (×2); no carried tool can harvest this block",
  );
});

/**
 * The whole point of the seal step: a target the route may not break is walked
 * to, its lava faces are closed with carried blocks, and only then is it broken
 * where the bot stands.
 */
test("a target the route may not break is sealed and broken in place", async () => {
  const target = new Vec3(1, 64, 0);
  using scene = mineScene({ blocks: [target], lava: [new Vec3(2, 64, 0)], feet: new Vec3(0.5, 64, 0.5) });
  const sealed: string[] = [];
  let broken = 0;

  const result = await runMine(scene, {
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    isSatisfied: () => broken > 0,
    placeInto: async (_bot, cell) => {
      sealed.push(`${cell.x},${cell.y},${cell.z}`);
      scene.world.setCell(cellAt(cell), "air");
      return { kind: "placed", block: {} as never };
    },
    breakInPlace: async (options) => {
      scene.world.setCell(cellAt(options.position), "air");
      broken += 1;
      return { status: "broken" };
    },
    route: async () => {
      throw new Error("a target already in reach must not be routed to");
    },
  });

  assert.equal(result.status, "satisfied");
  assert.deepEqual(sealed, ["2,64,0"]);
  assert.equal(broken, 1);
});

test("a wet target already in reach can be mined while floating", async () => {
  const target = new Vec3(1, 64, 0);
  using scene = mineScene({ blocks: [target], feet: new Vec3(0.5, 64, 0.5), onGround: false, isInWater: true });
  let broken = false;
  const result = await runMine(scene, {
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    isSatisfied: () => broken,
    breakInPlace: async () => {
      broken = true;
      scene.world.setCell(target, "air");
      return { status: "broken" };
    },
    route: async () => {
      throw new Error("The floating working stance is already in reach.");
    },
  });
  assert.equal(result.status, "satisfied");
  assert.equal(broken, true);
});

test("a dry-eyed body in water over a solid floor lands on it before the dig in reach", async () => {
  // lava-interrupts-mining's escape cell: one source block of water in a floor, the eyes in the air above.
  const target = new Vec3(1, 64, 0);
  using scene = mineScene({
    blocks: [target],
    solids: [new Vec3(0, 63, 0)],
    water: [new Vec3(0, 64, 0)],
    feet: new Vec3(0.5, 64.38, 0.5),
    onGround: false,
    isInWater: true,
    physics: true,
  });
  let stanceAtDig: { grounded: boolean; y: number } | undefined;
  const result = await runMine(scene, {
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    isSatisfied: () => stanceAtDig !== undefined,
    breakInPlace: async () => {
      stanceAtDig = { grounded: scene.bot.entity.onGround, y: scene.bot.entity.position.y };
      scene.world.setCell(target, "air");
      return { status: "broken" };
    },
    route: async () => {
      throw new Error("The working stance is already in reach.");
    },
  });
  assert.equal(result.status, "satisfied");
  assert.deepEqual(stanceAtDig, { grounded: true, y: 64 }, "the dig waited for the floor: off the ground it is x5 slower");
});

test("incidental inventory gain cannot satisfy an unbroken exact target", async () => {
  const target = new Vec3(1, 64, 0);
  using scene = mineScene({ blocks: [target], feet: new Vec3(0.5, 64, 0.5) });
  const result = await runMine(scene, {
    exactTarget: target,
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    isSatisfied: () => true,
    observedInventoryGain: () => 1,
    breakInPlace: async () => {
      scene.world.setCell(target, "air");
      return { status: "broken" };
    },
    route: async () => {
      throw new Error("The named target is already in reach.");
    },
  });
  assert.equal(result.status, "satisfied");
  assert.deepEqual(result.broken, [target]);
});

test("failed water preparation excludes the attempted working cell even after the bot sinks", async () => {
  const target = new Vec3(1, 64, 0);
  const attempted = new Vec3(0, 64, 0);
  using scene = mineScene({ blocks: [target], feet: attempted.offset(0.5, 0, 0.5), isInWater: true, onGround: false });
  scene.world.setCell(attempted, { name: "water", properties: { level: 1 } });
  scene.bot.on("physicsTick", () => {
    scene.bot.entity.position.y = 63.1;
  });
  let inspected = false;
  await runMine(scene, {
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    isSatisfied: () => inspected,
    route: async ({ goal }) => {
      const resolved = goal.resolve({ position: scene.bot.entity.position, entities: new Map() } as never);
      assert.equal(resolved.kind, "active");
      if (resolved.kind !== "active") throw new Error("Expected remaining working positions");
      assert.equal(
        resolved.isSatisfied({ feet: attempted, remainingScaffolds: 0, overlayId: "overlay:0" }, goalTestWorld),
        false,
      );
      inspected = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(inspected, true);
});

test("a drained target whose drain fails with water left is blacklisted once and keeps its reason beside a drowned top", async () => {
  for (const top of [false, true]) {
    const target = new Vec3(1, 64, 0);
    using scene = mineScene({ blocks: [target, ...(top ? [target.offset(0, 1, 0)] : [])], water: [new Vec3(2, 64, 0)] });
    const result = await runMine(scene, {
      canMine: (block) => block.position.y === 65
        ? { kind: "prohibited", reason: "the block is under water", underWater: true }
        : { kind: "mineable", routeMayBreak: false, drained: { wetStances: [] } },
      placeInto: async () => ({ kind: "failed", error: "placement refused" }),
      breakInPlace: async () => { throw new Error("a failed drain must never mine wet"); },
      route: noRouteNeeded,
    });
    assert.equal(result.status, "unreachable");
    assert.equal(result.underWater, undefined);
    assert.match(result.reason ?? "", /in water: the drain failed:.*placement refused/);
  }
});

test("a drain that fails with the faces dry tries another stance", async () => {
  const target = new Vec3(1, 64, 0);
  const face = new Vec3(2, 64, 0);
  using scene = mineScene({ blocks: [target], water: [face], isInWater: true });
  let inspected = false;
  const result = await runMine(scene, {
    canMine: () => ({ kind: "mineable", routeMayBreak: false, drained: { wetStances: [] } }),
    isSatisfied: () => inspected,
    placeInto: async () => {
      scene.world.setCell(face, "air");
      return { kind: "failed", error: "a late placement answer" };
    },
    route: async ({ goal }) => {
      const resolved = goal.resolve({ position: scene.bot.entity.position, entities: new Map() } as never);
      assert.equal(resolved.kind, "active");
      if (resolved.kind !== "active") throw new Error("the target must remain available");
      const at = (feet: Vec3) => ({ feet, remainingScaffolds: 0, overlayId: "overlay:0" });
      assert.equal(resolved.isSatisfied(at(new Vec3(0, 64, 0)), goalTestWorld), false);
      assert.equal(resolved.isSatisfied(at(face), goalTestWorld), true);
      inspected = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(result.status, "satisfied");
});

for (const [rate, stopped] of [[20, false], [10, false], [20, true]] as const)
  test(`a failed wading drain excludes that stance and tries another (${rate} tps, stopped ${stopped})`, async () => {
    const target = new Vec3(1, 64, 0);
    const feet = new Vec3(0, 65, 0);
    using scene = mineScene({ blocks: [target], solids: [new Vec3(0, 64, 0), new Vec3(1, 64, 1)], water: [feet, new Vec3(1, 65, 0), new Vec3(2, 65, 0)], feet: new Vec3(0.5, 65, 0.5), isInWater: true });
    scene.world.setCell(feet, { name: "water", properties: { level: 1 } });
    scene.world.setCell(new Vec3(1, 65, 0), { name: "water", properties: { level: 1 } });
    scene.server.setTickRate(rate);
    if (stopped) scene.server.stop();
    const other = new Vec3(1, 65, 1);
    const result = await runMine(scene, {
      canMine: () => ({ kind: "mineable", routeMayBreak: false, drained: { wetStances: [] } }),
      isSatisfied: () => scene.bot.blockAt(target)?.name === "air",
      placeInto: async (_bot, position) => {
        const cell = new Vec3(position.x, position.y, position.z);
        scene.world.setCell(cell, "cobblestone");
        return { kind: "placed", block: scene.bot.blockAt(cell)! };
      },
      route: async ({ goal }) => {
        const resolved = goal.resolve({ position: scene.bot.entity.position, entities: new Map() } as never);
        assert.equal(resolved.kind, "active");
        if (resolved.kind !== "active") throw new Error("expected a remaining target");
        assert.equal(resolved.isSatisfied({ feet, remainingScaffolds: 0, overlayId: "overlay:0" }, goalTestWorld), false);
        assert.equal(resolved.isSatisfied({ feet: other, remainingScaffolds: 0, overlayId: "overlay:0" }, goalTestWorld), true);
        scene.bot.entity.position = other.offset(0.5, 0, 0.5);
        Reflect.set(scene.bot.entity, "isInWater", false);
        return { status: "completed", elapsedMs: 0 };
      },
      breakInPlace: breakingInPlace(scene, () => {}),
    });
    assert.equal(result.status, "unreachable");
    assert.ok(result.reason, "the bounded stop explains why work could not continue");
    assert.equal(scene.bot.blockAt(target)?.name, "stone");
  });

test("only in-water targets settle unreachable with underWater and no route; mixed refusals do not", async () => {
  for (const mixed of [false, true]) {
    using scene = mineScene({ blocks: [new Vec3(1, 64, 0), new Vec3(2, 64, 0)] });
    const result = await runMine(scene, {
      canMine: (block) => mixed && block.position.x === 2
        ? { kind: "prohibited", reason: "protected region" }
        : { kind: "prohibited", reason: "in water: no dry ground beside it to drain it from", underWater: true },
      route: noRouteNeeded,
    });
    assert.equal(result.status, "unreachable");
    assert.equal(result.underWater, mixed ? undefined : true);
  }
});

test("a target refresh that satisfies the request settles satisfied despite its remaining water rejections", async () => {
  using scene = mineScene({ blocks: [new Vec3(1, 64, 0)] });
  let satisfied = false;
  const result = await runMine(scene, {
    isSatisfied: () => satisfied,
    canMine: () => {
      satisfied = true;
      return { kind: "prohibited", reason: "in water: no dry ground", underWater: true };
    },
    route: noRouteNeeded,
  });
  assert.equal(result.status, "satisfied");
  assert.equal(result.underWater, undefined);
});

test("remaining water refusals never claim no target was walked to after a dry route, pickup or in-place break", async () => {
  for (const work of ["route", "pickup", "break"]) {
    const dry = new Vec3(1, 64, 0);
    using scene = mineScene({ blocks: [...(work === "pickup" ? [] : [dry]), new Vec3(3, 64, 0)], drops: work === "pickup" ? [dry] : [], feet: new Vec3(0.5, 64, 0.5) });
    let gained = 0;
    const removeDry = () => scene.world.setCell(dry, "air");
    const result = await runMine(scene, {
      observedInventoryGain: () => gained,
      canMine: (block) => block.position.x === 1
        ? { kind: "mineable", routeMayBreak: work === "route" }
        : { kind: "prohibited", reason: "in water: no dry ground", underWater: true },
      route: async () => {
        if (work === "pickup") { scene.entities.remove(dropId(0)); gained = 1; }
        else removeDry();
        return { status: "completed", elapsedMs: 0 };
      },
      breakInPlace: async () => {
        removeDry();
        return { status: "broken" };
      },
    });
    assert.equal(result.status, "unreachable");
    assert.equal(result.underWater, undefined);
    assert.deepEqual(result.broken, work === "pickup" ? [] : [dry]);
  }
});

test("a collected item disappearing from a route does not blacklist its remaining block target", async () => {
  const target = new Vec3(5, 64, 0);
  using scene = mineScene({ blocks: [target] });
  let gained = 0;
  let routes = 0;
  const result = await runMine(scene, {
    exactTarget: target,
    isSatisfied: () => gained >= 1,
    observedInventoryGain: () => gained,
    route: async () => {
      routes += 1;
      if (routes === 1) {
        gained = 1;
        return { status: "stopped", reason: `Entity ${dropId(42)} is not currently observed.`, elapsedMs: 0 };
      }
      scene.world.setCell(target, "air");
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(routes, 2);
  assert.equal(result.status, "satisfied");
  assert.deepEqual(result.broken, [target]);
});

/**
 * A target the route may not break is worked from a cell that touches it. The
 * cells *below* it are not offered: for a slab under standing water the
 * cheapest of them is a flooded pit the bot digs itself into.
 */
test("a target the route may not break is approached from the cells that touch it", async () => {
  const target = new Vec3(1, 64, 0);
  using scene = mineScene({ blocks: [target], feet: new Vec3(5.5, 64, 5.5) });
  const stands = (feet: Vec3) => ({ feet, remainingScaffolds: [], overlayId: "overlay:0" }) as never;

  await runMine(scene, {
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    route: async (options) => {
      const goal = options.goal.resolve({ position: scene.bot.entity.position, entities: new Map() } as never);
      assert.equal(goal.kind, "active");
      if (goal.kind !== "active") throw new Error("unreachable");
      assert.equal(goal.isSatisfied(stands(new Vec3(1, 65, 0)), goalTestWorld), true);
      assert.equal(goal.isSatisfied(stands(new Vec3(2, 64, 0)), goalTestWorld), true);
      assert.equal(goal.isSatisfied(stands(new Vec3(1, 63, 0)), goalTestWorld), false);
      assert.equal(goal.isSatisfied(stands(new Vec3(2, 65, 0)), goalTestWorld), true);
      return { status: "stopped", reason: "test stop", elapsedMs: 0 };
    },
  });
});

/**
 * A shore beside a pool level with its own floor, which is what both flat cast
 * fixtures and every generated pool look like: the bot stands on 0,64,0, the
 * lava fills 1..2,64,0 and its floor is the layer under it. The pour is aimed
 * at that floor *through* the near source, so the water lands in the source
 * cell itself and the source beside it turns to obsidian.
 */
function castShore(carrying: Record<string, number>): MineScene {
  return mineScene({
    lava: [new Vec3(1, 64, 0), new Vec3(2, 64, 0)],
    solids: [new Vec3(0, 64, 0), new Vec3(1, 63, 0), new Vec3(2, 63, 0)],
    carrying,
    feet: new Vec3(0.5, 65, 0.5),
  });
}

test("an occluded working stance is removed instead of repeating the same arrival", async () => {
  using scene = mineScene({ blocks: [new Vec3(1, 64, 0)], feet: new Vec3(0.5, 64, 0.5) });
  scene.bot.world.raycast = () => null;
  let checked = false;
  await runMine(scene, {
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    isSatisfied: () => checked,
    route: async (options) => {
      const observation = { position: scene.bot.entity.position, entities: new Map() } as never;
      const node = { feet: scene.bot.entity.position.floored(), remainingScaffolds: 0, overlayId: "overlay:0" };
      const before = options.goal.resolve(observation);
      assert.equal(before.kind === "active" && before.isSatisfied(node, goalTestWorld), true);
      await options.onArrival?.({ goalRevision: "test", node, observation, signal: new AbortController().signal });
      const after = options.goal.resolve(observation);
      assert.equal(after.kind === "active" && after.isSatisfied(node, goalTestWorld), false);
      assert.equal(
        after.kind === "active" && after.isSatisfied({ ...node, feet: new Vec3(2, 63, 0) }, goalTestWorld),
        true,
      );
      checked = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(checked, true);
});

test("liquid-adjacent mining leaves the pickup hole before a submerged dig", async () => {
  using scene = mineScene({ blocks: [new Vec3(1, 64, 0)], water: [new Vec3(2, 65, 0)], feet: new Vec3(5.5, 65, 5.5) });
  let inspected = false;
  await runMine(scene, {
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    isSatisfied: () => inspected,
    route: async ({ goal }) => {
      const resolved = goal.resolve({ position: scene.bot.entity.position, entities: new Map() } as never);
      assert.equal(resolved.kind, "active");
      if (resolved.kind !== "active") throw new Error("missing target");
      const node = (feet: Vec3) => ({ feet, remainingScaffolds: 0, overlayId: "overlay:0" });
      assert.equal(resolved.isSatisfied(node(new Vec3(2, 64, 0)), goalTestWorld), false);
      assert.equal(resolved.isSatisfied(node(new Vec3(2, 65, 0)), goalTestWorld), true);
      inspected = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(inspected, true);
});

const obsidianRequest = (scene: MineScene) => ({
  matches: (block: { name: string }) => block.name === "obsidian",
  matchingStateIds: new Set([stateIdOf(scene, "obsidian")]),
});

test("an unusable pour stance leaves the pool available from another stance", async () => {
  using scene = castShore({ water_bucket: 1 });
  scene.bot.world.raycast = () => null;
  let inspected = false;
  const result = await runMine(scene, {
    ...obsidianRequest(scene),
    isSatisfied: () => inspected,
    cast: async () => {
      throw new Error("no ray means no bucket use");
    },
    route: async ({ goal }) => {
      const resolved = goal.resolve({ position: scene.bot.entity.position, entities: new Map() } as never);
      assert.equal(resolved.kind, "active");
      if (resolved.kind !== "active") throw new Error("pool was discarded");
      const node = (feet: Vec3) => ({ feet, remainingScaffolds: 0, overlayId: "overlay:0" });
      assert.equal(resolved.isSatisfied(node(new Vec3(0, 65, 0)), goalTestWorld), false);
      assert.equal(resolved.isSatisfied(node(new Vec3(1, 65, 1)), goalTestWorld), true);
      assert.equal(resolved.isSatisfied(node(new Vec3(0, 64, 0)), goalTestWorld), false);
      inspected = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(result.status, "satisfied");
  assert.equal(inspected, true);
});

/**
 * Obsidian is the one block a bot can manufacture, so a pool is a target like
 * any other: the route walks to its lip, the loop pours where it arrives, and
 * what forms is mined by the same loop that mines ore.
 */
test("a pool is poured on where the route left the bot, and what forms is mined", async () => {
  using scene = castShore({ water_bucket: 1 });
  const uses: string[] = [];
  let waterLanding: Vec3 | null = null;
  let broken = 0;

  const result = await runMine(scene, {
    ...obsidianRequest(scene),
    isSatisfied: () => broken > 0,
    cast: async (_bot, use) => {
      uses.push(use.item.name);
      if (use.item.name === "water_bucket") {
        swapCarried(scene, "water_bucket", "bucket");
        for (const cell of use.expectedCells ?? []) {
          waterLanding = cellAt(cell.position);
          assert.notEqual(scene.bot.blockAt(waterLanding)?.name, "lava", "casting must not replace its raw material");
          scene.world.setCell(waterLanding, "water");
        }
        // The source beside the water is what turns to obsidian.
        scene.world.setCell(new Vec3(2, 64, 0), "obsidian");
      } else {
        swapCarried(scene, "bucket", "water_bucket");
        assert.notEqual(waterLanding, null);
        scene.world.setCell(waterLanding!, "air");
      }
      return { kind: "used" };
    },
    route: async () => {
      // Mining is pathing: the route breaks the target on its way into it.
      if (scene.bot.blockAt(new Vec3(2, 64, 0))?.name === "obsidian") {
        scene.world.setCell(new Vec3(2, 64, 0), "air");
        broken += 1;
      }
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "satisfied");
  // The pour, then the scoop that gets the bucket back.
  assert.deepEqual(uses, ["water_bucket", "bucket"]);
  assert.equal(broken, 1);
  assert.deepEqual(carriedNames(scene), ["water_bucket"]);
});

test("a scoop is confirmed by the poured source leaving the world, not by the bucket alone", async () => {
  using scene = castShore({ water_bucket: 1 });
  let landing: Vec3 | null = null;
  let broken = 0;
  let checked = false;

  await runMine(scene, {
    ...obsidianRequest(scene),
    isSatisfied: () => broken > 0,
    cast: async (_bot, use) => {
      if (use.item.name === "water_bucket") {
        swapCarried(scene, "water_bucket", "bucket");
        landing = cellAt(use.expectedCells![0]!.position);
        scene.world.setCell(landing, "water");
        scene.world.setCell(new Vec3(2, 64, 0), "obsidian");
        return { kind: "used" };
      }
      // The inventory packet can arrive before the block update: the hand
      // already holds water while the source still stands in the world.
      swapCarried(scene, "bucket", "water_bucket");
      const expected = use.expectedCells?.find((cell) => landing!.equals(cellAt(cell.position)));
      assert.ok(expected, "the scoop names the poured cell");
      assert.equal(expected.matches(scene.bot.blockAt(landing!)!), false, "a standing source is not a completed scoop");
      scene.world.setCell(landing!, "air");
      assert.equal(expected.matches(scene.bot.blockAt(landing!)!), true);
      checked = true;
      return { kind: "used" };
    },
    route: async () => {
      scene.world.setCell(new Vec3(2, 64, 0), "air");
      broken += 1;
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(checked, true);
});

test("a failed scoop is recovered before mining the cast obsidian", async () => {
  using scene = castShore({ water_bucket: 1 });
  let scoops = 0;
  let broken = 0;
  const result = await runMine(scene, {
    ...obsidianRequest(scene),
    isSatisfied: () => broken > 0,
    cast: async (_bot, use) => {
      if (use.item.name === "water_bucket") {
        swapCarried(scene, "water_bucket", "bucket");
        for (const cell of use.expectedCells ?? []) scene.world.setCell(cellAt(cell.position), "water");
        scene.world.setCell(new Vec3(2, 64, 0), "obsidian");
      } else {
        scoops += 1;
        assert.equal(broken, 0, "recover water before mining resumes");
        if (scoops <= 2) {
          // The source can remain visible above the feet after the pour.
          scene.bot.entity.position = new Vec3(0.5, 63, 0.5);
          scene.bot.world.raycast = () => null;
          return { kind: "failed", error: "the original scoop ray missed" };
        }
        swapCarried(scene, "bucket", "water_bucket");
        scene.world.setCell(new Vec3(1, 64, 0), "air");
      }
      return { kind: "used" };
    },
    route: async () => {
      assert.equal(scoops, 3);
      scene.world.setCell(new Vec3(2, 64, 0), "air");
      broken += 1;
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(result.status, "satisfied");
  assert.equal(scoops, 3);
  assert.equal(carriedNames(scene)[0], "water_bucket");
});

test("an unrecoverable cast source cannot be hidden by reaching the inventory quantity", async () => {
  using scene = castShore({ water_bucket: 1 });
  let enough = false;
  const result = await runMine(scene, {
    ...obsidianRequest(scene),
    isSatisfied: () => enough,
    cast: async (_bot, use) => {
      if (use.item.name === "water_bucket") {
        swapCarried(scene, "water_bucket", "bucket");
        scene.world.setCell(new Vec3(2, 64, 0), "obsidian");
        enough = true; // An incidental pickup can satisfy quantity during preparation.
        return { kind: "used" };
      }
      return { kind: "failed", error: "source vanished" };
    },
    route: async () => {
      throw new Error("a missing source must fail before further movement");
    },
  });
  assert.equal(result.status, "unreachable");
  assert.match(result.reason ?? "", /source is no longer observed/);
});

test("a pour the server refuses gives up on the whole pool, not on one source of it", async () => {
  using scene = castShore({ water_bucket: 1 });
  let pours = 0;

  const result = await runMine(scene, {
    ...obsidianRequest(scene),
    cast: async () => {
      pours += 1;
      return { kind: "failed", error: "the server refused the use" };
    },
  });

  assert.equal(pours, 1);
  assert.equal(result.status, "unreachable");
  assert.match(result.reason ?? "", /the lava at 1,64,0 could not be cast: the server refused the use/);
});

test("a pour that formed no obsidian gives up on the pool", async () => {
  using scene = castShore({ water_bucket: 1 });
  let pours = 0;

  const result = await runMine(scene, {
    ...obsidianRequest(scene),
    cast: async (_bot, use) => {
      if (use.item.name !== "water_bucket") {
        swapCarried(scene, "bucket", "water_bucket");
        return { kind: "used" };
      }
      pours += 1;
      swapCarried(scene, "water_bucket", "bucket");
      for (const cell of use.expectedCells ?? []) scene.world.setCell(cellAt(cell.position), "water");
      return { kind: "used" };
    },
  });

  assert.equal(pours, 1);
  assert.equal(result.status, "unreachable");
  assert.match(result.reason ?? "", /the pour into 0,65,0 formed no obsidian/);
});

test("lava is not a target without the water to pour on it", async () => {
  using scene = castShore({ diamond_pickaxe: 1 });

  const result = await runMine(scene, {
    ...obsidianRequest(scene),
    cast: async () => {
      throw new Error("an empty-handed run must not reach the pour");
    },
  });

  assert.equal(result.status, "no_targets");
});

test("a lava face that will not close blacklists the target instead of breaking it", async () => {
  const target = new Vec3(1, 64, 0);
  using scene = mineScene({ blocks: [target], lava: [new Vec3(2, 64, 0)], feet: new Vec3(0.5, 64, 0.5) });
  let breaks = 0;

  const result = await runMine(scene, {
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    placeInto: async () => ({ kind: "failed", error: "no carried item is a full block" }),
    breakInPlace: async () => {
      breaks += 1;
      return { status: "broken" };
    },
    route: async () => ({ status: "completed", elapsedMs: 0 }),
  });

  assert.equal(breaks, 0);
  assert.equal(result.status, "unreachable");
  assert.match(result.reason ?? "", /the lava at 2,64,0 could not be closed: no carried item is a full block/);
});

test("water returning during lava sealing refuses the swing and the next target is tried", async () => {
  const first = new Vec3(1, 64, 0);
  const next = new Vec3(-1, 64, 0);
  const water = new Vec3(1, 65, 0);
  const lava = new Vec3(2, 64, 0);
  using scene = mineScene({ blocks: [first, next], solids: [new Vec3(0, 63, 0), new Vec3(1, 63, 0), new Vec3(-1, 63, 0)],
    water: [water], lava: [lava], feet: new Vec3(0.5, 64, 0.5) });
  const navigation = createNavigationRuntime(scene.bot);
  const attempts: string[] = [];
  let finished = false;
  try {
  const result = await runMine(scene, {
    canMine: () => ({ kind: "mineable", routeMayBreak: false, drained: { wetStances: [] } }),
    movements: createMineflayerMovementPolicy(scene.bot),
    isSatisfied: () => finished,
    placeInto: async (_bot, position) => {
      const cell = cellAt(position);
      scene.world.setCell(cell, "cobblestone");
      if (cell.equals(lava)) scene.world.setCell(water, "water");
      return { kind: "placed", block: scene.bot.blockAt(cell)! };
    },
    breakInPlace: async (options) => {
      attempts.push(cellAt(options.position).toString());
      if (cellAt(options.position).equals(next)) { finished = true; return { status: "broken" }; }
      return navigation.breakBlockInPlace(options);
    },
    route: noRouteNeeded,
  });
  assert.equal(result.status, "satisfied");
  assert.deepEqual(attempts, [first.toString(), next.toString()]);
  assert.equal(scene.bot.blockAt(first)?.name, "stone");
  assert.equal(scene.server.packets.filter((packet) => packet.name === "block_dig" &&
    (packet.data as { location: { x: number; y: number; z: number } }).location.x === first.x).length, 0);
  } finally { await navigation.close(); }
});

/** Obsidian beside an unconverted lava source, with the bot on the working cell west of it. */
function obsidianBesideSource(carrying: Record<string, number>): MineScene {
  return mineScene({
    lava: [new Vec3(2, 64, 0)],
    obsidian: [new Vec3(1, 64, 0)],
    solids: [new Vec3(0, 63, 0), new Vec3(1, 63, 0), new Vec3(2, 63, 0)],
    carrying,
    feet: new Vec3(0.5, 64, 0.5),
  });
}

test("a lava source touching an obsidian target is cast rather than sealed", async () => {
  using scene = obsidianBesideSource({ water_bucket: 1 });
  const sealed: string[] = [];
  const uses: string[] = [];
  let landing: Vec3 | null = null;
  let broken = 0;

  const result = await runMine(scene, {
    ...obsidianRequest(scene),
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    isSatisfied: () => broken > 0,
    cast: async (_bot, use) => {
      uses.push(use.item.name);
      if (use.item.name === "water_bucket") {
        swapCarried(scene, "water_bucket", "bucket");
        const cell = use.expectedCells?.[0]?.position;
        assert.ok(cell);
        landing = cellAt(cell);
        scene.world.setCell(landing, "water");
        scene.world.setCell(new Vec3(2, 64, 0), "obsidian");
      } else {
        swapCarried(scene, "bucket", "water_bucket");
        scene.world.setCell(landing!, "air");
      }
      return { kind: "used" };
    },
    placeInto: async (_bot, cell) => {
      sealed.push(`${cell.x},${cell.y},${cell.z}`);
      return { kind: "placed", block: {} as never };
    },
    breakInPlace: breakingInPlace(scene, () => (broken += 1)),
    route: noRouteNeeded,
  });

  assert.equal(result.status, "satisfied");
  assert.deepEqual(uses, ["water_bucket", "bucket"]);
  assert.deepEqual(sealed, [], "the source became obsidian instead of being closed with rock");
  assert.equal(scene.bot.blockAt(new Vec3(2, 64, 0))?.name, "obsidian");
});

test("a touching source that cannot be cast is still sealed before the break", async () => {
  using scene = obsidianBesideSource({ water_bucket: 1 });
  const sealed: string[] = [];
  let casts = 0;
  let broken = 0;

  const result = await runMine(scene, {
    ...obsidianRequest(scene),
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    isSatisfied: () => broken > 0,
    cast: async () => {
      casts += 1;
      return { kind: "failed", error: "the server refused the use" };
    },
    placeInto: async (_bot, cell) => {
      sealed.push(`${cell.x},${cell.y},${cell.z}`);
      scene.world.setCell(cellAt(cell), "stone");
      return { kind: "placed", block: {} as never };
    },
    breakInPlace: breakingInPlace(scene, () => (broken += 1)),
    route: noRouteNeeded,
  });

  assert.equal(result.status, "satisfied");
  assert.equal(casts, 1, "one refused pour is enough to fall back to the seal");
  assert.deepEqual(sealed, ["2,64,0"]);
  assert.equal(broken, 1);
});

test("a drop that would fall down an open column into lava gets a floor before the break", async () => {
  const target = new Vec3(1, 66, 0);
  using scene = mineScene({
    blocks: [target],
    solids: [new Vec3(0, 65, 0)],
    lava: [new Vec3(1, 64, 0)],
    feet: new Vec3(0.5, 66, 0.5),
  });
  const sealed: string[] = [];
  let broken = 0;

  const result = await runMine(scene, {
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    isSatisfied: () => broken > 0,
    placeInto: async (_bot, cell) => {
      sealed.push(`${cell.x},${cell.y},${cell.z}`);
      return { kind: "placed", block: {} as never };
    },
    breakInPlace: async ({ position }) => {
      assert.deepEqual(sealed, ["1,65,0"], "the floor is placed before the target comes out");
      scene.world.setCell(cellAt(position), "air");
      broken += 1;
      return { status: "broken" };
    },
    route: async () => {
      throw new Error("a target already in reach must not be routed to");
    },
  });

  assert.equal(result.status, "satisfied");
  assert.deepEqual(sealed, ["1,65,0"]);
});

test("a route stopped by a failed break gives up that block, not the target nearest the bot", async () => {
  const near = new Vec3(1, 64, 0);
  const far = new Vec3(5, 64, 0);
  using scene = mineScene({ blocks: [near, far], feet: new Vec3(0.5, 64, 0.5) });
  let routes = 0;
  let broken = 0;
  let offered: string[] = [];

  const result = await runMine(scene, {
    isSatisfied: () => broken > 0,
    onTargets: (targets) => {
      offered = targets.map((target) => `${target.position.x},${target.position.y},${target.position.z}`);
    },
    route: async () => {
      routes += 1;
      if (routes === 1) {
        return {
          status: "stopped",
          reason: "repeated_movement_failure: No face of the block at 5,64,0 is in view",
          elapsedMs: 0,
          failedBreak: { x: 5, y: 64, z: 0 },
        };
      }
      assert.deepEqual(offered, ["1,64,0"], "the near block stays a target; the failed one is dropped");
      scene.world.setCell(near, "air");
      broken += 1;
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "satisfied");
  assert.equal(routes, 2);
});

test("a quantity already in hand is not mined for", async () => {
  using scene = mineScene({ blocks: [new Vec3(5, 64, 0)] });
  let routes = 0;
  const result = await runMine(scene, {
    isSatisfied: () => true,
    route: async () => {
      routes += 1;
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "satisfied");
  assert.equal(routes, 0);
});

/**
 * The stall that failed every mining scenario. A route that reports arrival
 * without changing the world must not be asked the same question again — a
 * target the bot occupies has to be given up so the run can end.
 */
test("a route that arrives without breaking anything cannot loop forever", async () => {
  using scene = mineScene({ blocks: [new Vec3(5, 64, 0)] });
  let routes = 0;
  const result = await runMine(scene, {
    route: async () => {
      routes += 1;
      assert.ok(routes < 200, "the loop ran away instead of giving up on an unreachable target");
      return { status: "stopped", reason: "no route was found", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "unreachable");
  assert.equal(result.reason, "no route was found");
});

test("an exact target remains available beyond the general scan's nearest-match limit", async () => {
  const target = new Vec3(15, 64, 15);
  const nearer = Array.from(
    { length: 256 },
    (_, index) => new Vec3(index % 8, 64 + Math.floor(index / 64), Math.floor(index / 8) % 8),
  );
  using scene = mineScene({ blocks: [target, ...nearer] });
  const offered: string[] = [];

  const result = await runMine(scene, {
    exactTarget: target,
    onTargets: (targets) => {
      offered.push(...targets.map(({ position }) => `${position.x},${position.y},${position.z}`));
    },
    route: async () => ({ status: "stopped", reason: "test stop", elapsedMs: 0 }),
  });

  assert.equal(result.status, "unreachable");
  assert.deepEqual([...new Set(offered)], ["15,64,15"]);
});

test("planner snapshots reuse the composed mining goal without constructing more blocks", async () => {
  let blockReads = 0;
  using scene = mineScene({ blocks: [new Vec3(5, 64, 0)], onBlockRead: () => (blockReads += 1) });
  const result = await runMine(scene, {
    route: async (options) => {
      assert.equal(typeof options.onArrival, "function");
      const beforeSnapshots = blockReads;
      const observed = { position: new Vec3(0.5, 64, 0.5), entities: new Map() } as never;
      options.goal.resolve(observed);
      options.goal.resolve(observed);
      assert.equal(blockReads, beforeSnapshots);
      return { status: "stopped", reason: "test stop", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "unreachable");
});

test("the mining process does not expire a productive route on a wall-clock timer", async () => {
  using scene = mineScene({ blocks: [new Vec3(5, 64, 0)] });
  const result = await runMine(scene, {
    route: async (options) => {
      assert.equal(options.timeoutMs, undefined);
      return { status: "stopped", reason: "test stop", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "unreachable");
});

test("a calculation failure blacklists the target nearest the bot's current position", async () => {
  using scene = mineScene({ blocks: [new Vec3(5, 64, 0), new Vec3(14, 64, 0)] });
  const announcements: string[][] = [];
  let satisfied = false;

  const result = await runMine(scene, {
    isSatisfied: () => satisfied,
    onTargets: (targets) => {
      announcements.push(targets.map((target) => `${target.position.x}`));
    },
    route: async (options) => {
      scene.bot.entity.position = new Vec3(13.5, 64, 0.5);
      const resolution = await options.onCalculationFailure?.(noPath(scene, { x: 13, y: 64, z: 0 }, 1));
      assert.equal(resolution?.kind, "continue");
      satisfied = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "satisfied");
  assert.deepEqual(announcements, [["5", "14"], ["5"]]);
});

test("an unreachable drop is blacklisted without delaying the remaining block target", async () => {
  let ticks = 0;
  using scene = mineScene({
    blocks: [new Vec3(1, 64, 0)],
    drops: [new Vec3(10, 64, 0)],
    feet: new Vec3(0.5, 64, 0.5),
    onWaitForTicks: () => {
      ticks += 1;
    },
  });
  let satisfied = false;

  const result = await runMine(scene, {
    isSatisfied: () => satisfied,
    route: async (options) => {
      const resolution = await options.onCalculationFailure?.(noPath(scene, { x: 0, y: 64, z: 0 }, 1));
      assert.equal(resolution?.kind, "continue");
      satisfied = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "satisfied");
  assert.equal(ticks, 0);
});

test("an unreachable live drop never loiters, whether stationary in air or moving in lava", async () => {
  for (const inLava of [false, true]) {
    const cell = new Vec3(3, 61, 0);
    using scene = mineScene({
      drops: [cell],
      lava: inLava ? [cell] : [],
      onWaitForTicks: () => {
        throw new Error("a live unreachable drop must not loiter, including in lava");
      },
    });
    if (inLava) scene.bot.entities[dropId(0)]!.velocity = new Vec3(0, -0.2, 0);
    let failures = 0;
    const result = await runMine(scene, {
      route: async (options) => {
        failures += 1;
        const resolution = await options.onCalculationFailure?.(noPath(scene, { x: 0, y: 64, z: 0 }, 3));
        assert.equal(resolution?.kind, "completed");
        return { status: "completed", elapsedMs: 0 };
      },
    });
    assert.equal(failures, 1);
    assert.equal(result.status, "unreachable");
  }
});

test("a failed pickup search waits for a falling log to land before judging its reachability", async () => {
  let ticks = 0;
  let satisfied = false;
  using scene = mineScene({
    drops: [new Vec3(3, 67.5, 0)],
    solids: [new Vec3(3, 63, 0)],
    onWaitForTicks: ({ bot }) => {
      ticks += 1;
      bot.entities[dropId(0)]!.position.y = ticks === 3 ? 64 : 67.5 - ticks;
    },
  });
  scene.bot.entities[dropId(0)]!.velocity = new Vec3(0, -0.2, 0);
  const result = await runMine(scene, {
    isSatisfied: () => satisfied,
    route: async (options) => {
      const resolution = await options.onCalculationFailure?.(noPath(scene, { x: 0, y: 64, z: 0 }, 3));
      assert.equal(ticks, 3);
      assert.equal(resolution?.kind, "continue");
      satisfied = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(result.status, "satisfied");
});

test("a failed block cell does not hide an item that later lands there", async () => {
  const cell = new Vec3(5, 64, 0);
  using scene = mineScene({ blocks: [cell] });
  let routes = 0;
  let satisfied = false;

  const result = await runMine(scene, {
    isSatisfied: () => satisfied,
    route: async (options) => {
      routes += 1;
      if (routes === 1) {
        const resolution = await options.onCalculationFailure?.(noPath(scene, cell, 1));
        assert.equal(resolution?.kind, "completed");
        scene.world.setCell(cell, "air");
        scene.dropAt(7, cell);
        return { status: "completed", elapsedMs: 0 };
      }

      satisfied = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "satisfied");
  assert.equal(routes, 2);
});

/** The bot stands in a drop's cell; its first tick wait lasts past the vanished-item settlement window (1.55 s), then `change` happens, and two arrivals follow. */
async function arrivalsAcrossSlowTick(change: (scene: MineScene, cell: Vec3) => void) {
  const cell = new Vec3(0, 64, 0);
  let ticks = 0;
  let satisfied = false;
  using scene = mineScene({
    drops: [cell],
    feet: cell,
    onWaitForTicks: async (waiting) => {
      ticks += 1;
      if (ticks !== 1) return;
      await waiting.clock.sleep(1_550);
      change(waiting, cell);
    },
  });
  const result = await runMine(scene, {
    isSatisfied: () => satisfied,
    route: twoArrivals(scene, () => (satisfied = true)),
  });
  return { status: result.status, ticks };
}

test("a live or replacement item remains a target across a slow tick past the settlement window", async () => {
  for (const replacement of [false, true]) {
    const outcome = await arrivalsAcrossSlowTick(({ entities, dropAt }, cell) => {
      if (!replacement) return;
      entities.remove(dropId(0));
      dropAt(1, cell);
    });
    assert.equal(outcome.status, "satisfied");
    assert.equal(outcome.ticks, 2);
  }
});

test("the 64-target goal width is not a lifetime calculation-failure limit", async () => {
  const blocks = Array.from({ length: 65 }, (_, index) => new Vec3((index % 15) + 1, 64, Math.floor(index / 15)));
  using scene = mineScene({ blocks });
  let failures = 0;
  let routes = 0;

  const result = await runMine(scene, {
    route: async (options) => {
      routes += 1;
      for (;;) {
        failures += 1;
        assert.ok(failures <= blocks.length, "the process retried without consuming a target");
        const resolution = await options.onCalculationFailure?.(noPath(scene, { x: 0, y: 64, z: 0 }, 1));
        if (resolution?.kind === "completed") break;
      }
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "unreachable");
  assert.equal(routes, 1);
  assert.equal(failures, 65);
});

/**
 * The five-minute stand: an item the inventory cannot take stays a live drop
 * target, the pickup goal is satisfied where the bot stands, and nothing ends
 * the arrival until the server despawns the item. The overlap itself is the
 * evidence: past vanilla's pickup delay, an item still under the bot is not
 * coming in.
 */
test("a drop the bot stands in without gaining anything is given up before the server despawns it", async () => {
  const cell = new Vec3(0, 64, 0);
  let ticks = 0;
  let nowMs = 1_000;
  using scene = mineScene({
    drops: [cell],
    feet: cell,
    onWaitForTicks: () => {
      ticks += 1;
      if (ticks === 1) nowMs += DROP_PICKUP_TIMEOUT_MS + 50;
    },
  });

  const result = await runMine(scene, {
    now: () => nowMs,
    route: async (options) => {
      const arrived = arrival(scene);
      assert.equal((await options.onArrival?.(arrived))?.kind, "continue");
      assert.equal((await options.onArrival?.(arrived))?.kind, "completed");
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(ticks, 1);
  assert.equal(result.status, "unreachable");
  assert.match(result.reason ?? "", /the stone drop at 0,64,0 was not picked up after 3 s in reach/);
});

test("mining stops once the requested quantity arrives mid-route", async () => {
  using scene = mineScene({ blocks: [new Vec3(5, 64, 0)] });
  let held = 0;
  const result = await runMine(scene, {
    isSatisfied: () => held >= 1,
    route: async () => {
      held = 1;
      return { status: "stopped", reason: "the requested quantity is in the inventory", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "satisfied");
});

test("target observers see block removal and pickup during a route without an arrival callback", async () => {
  const first = new Vec3(5, 64, 0);
  const second = new Vec3(7, 64, 0);
  using scene = mineScene({ blocks: [first, second] });
  const announcements: string[][] = [];
  let satisfied = false;
  let gained = 0;
  await runMine(scene, {
    isSatisfied: () => satisfied,
    observedInventoryGain: () => gained,
    onTargets: (targets) => {
      announcements.push(targets.map((target) => (target.kind === "drop" ? `drop:${target.entityId}` : `${target.kind}:${target.position.x}`)));
    },
    route: async ({ goal }) => {
      const observation = { position: scene.bot.entity.position, entities: new Map() } as never;
      assert.deepEqual(announcements.at(-1), ["block:5", "block:7"]);
      scene.world.setCell(first, "air");
      scene.dropAt(17, first);
      await scene.clock.sleep(260);
      goal.resolve(observation);
      assert.deepEqual(announcements.at(-1), [`drop:${dropId(17)}`]);
      const count = announcements.length;
      goal.resolve(observation);
      assert.equal(announcements.length, count);
      scene.entities.remove(dropId(17));
      gained = 1;
      await scene.clock.sleep(260);
      goal.resolve(observation);
      assert.deepEqual(announcements.at(-1), ["block:7"]);
      satisfied = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });
});

test("a swimmer waiting to settle while physics has stopped gives up on the arrival dig within seconds", async () => {
  const target = new Vec3(1, 64, 0);
  const feet = new Vec3(0.5, 64, 0.5);
  using scene = mineScene({
    blocks: [target],
    // At this stance the eyes are below the source's surface in the upper cell.
    water: [feet.offset(0, 1.62, 0).floored()],
    feet,
    onGround: false,
    isInWater: true,
  });
  // The last wait for a physics tick starts after the settle wait gave up on the dig; the process waits on it until the caller cancels.
  let lastTickWaitAtMs: number | undefined;
  // `newListener` is the emitter's own event, not one of the bot's typed events.
  EventEmitter.prototype.on.call(scene.bot, "newListener", (event: string | symbol) => {
    if (event === "physicsTick") lastTickWaitAtMs = scene.clock.now();
  });
  // Before the wall bound this wait ended only with the caller's abort.
  scene.bot.physicsEnabled = false;
  const callerCancel = new AbortController();
  scene.clock.after(CALLER_CANCEL_MS, () => callerCancel.abort(new Error("the caller cancelled")));
  let arrivalEnd: unknown;
  let breakAttempts = 0;
  let arrivalOver = false;
  await runMine(scene, {
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    isSatisfied: () => arrivalOver,
    breakInPlace: async () => {
      breakAttempts += 1;
      return { status: "broken" };
    },
    route: async (options) => {
      const observation = { position: scene.bot.entity.position, entities: new Map() } as never;
      const node = { feet: scene.bot.entity.position.floored(), remainingScaffolds: 0, overlayId: "overlay:0" };
      try {
        await options.onArrival?.({ goalRevision: "test", node, observation, signal: callerCancel.signal });
      } catch (cause) {
        arrivalEnd = cause;
      }
      arrivalOver = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(breakAttempts, 0);
  assert.ok(lastTickWaitAtMs !== undefined && lastTickWaitAtMs < 3_000, `the dig wait gave up after ${lastTickWaitAtMs} ms`);
  // `waitForProcessTick` listens to the tick itself, so the caller's cancel ends it with physics stopped: a bare
  // `bot.waitForTicks(1)` here ended only at Mineflayer's own 5050 ms timeout (`physics.js:462`) with its own error.
  assert.match(String(arrivalEnd), /the caller cancelled/);
  assert.equal(scene.bot.listenerCount("physicsTick"), 0, "the cancelled wait left no tick listener");
});

/**
 * `collect/mixed-sand`: the bot walks onto the one-block stump of a column to take its drops, and that stump is the last
 * match. Standing on it is a problem of the stance, not of the block: the run steps off and mines it from the side.
 */
test("a bot standing on the only match steps off it and mines it from the side", async () => {
  const target = new Vec3(0, 63, 0);
  using scene = mineScene({ blocks: [target], solids: [new Vec3(1, 63, 0)], feet: new Vec3(0.5, 64, 0.5) });
  const stancesAtBreak: string[] = [];
  const result = await runMine(scene, {
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    isSatisfied: () => stancesAtBreak.length > 0,
    breakInPlace: async ({ position }) => {
      stancesAtBreak.push(`${Math.floor(scene.bot.entity.position.x)},${Math.floor(scene.bot.entity.position.z)}`);
      scene.world.setCell(cellAt(position), "air");
      return { status: "broken" };
    },
    route: async () => {
      scene.bot.entity.position = new Vec3(1.5, 64, 0.5);
      return { status: "completed", elapsedMs: 0 };
    },
  });

  assert.equal(result.status, "satisfied");
  assert.deepEqual(stancesAtBreak, ["1,0"]);
});

/**
 * `collect/coal-under-sand` (2026-11-16): the stance was judged at its cell centre, the body ended 0.1 into the next
 * column, and the coal's sand landed in cells it occupied. The last check before the swing now refuses that, and with
 * steering blocked (a body that cannot centre) the route replans from the observed body instead of digging.
 */
test("a coal swing refused for the sand column over the body replans from the observed body and never digs over that column", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  // The scenario's corridor (`collect/falling-column-trailing-edge`): a bedrock box round a one-wide corridor whose
  // coal, above head height, carries a sand column hidden behind it, so the plan digs the coal first.
  const cells: Record<string, string> = {};
  for (let x = -1; x <= 1; x++) for (let y = 63; y <= 70; y++) for (let z = -2; z <= 2; z++) cells[`${x},${y},${z}`] = "bedrock";
  for (let y = 63; y <= 64; y++) for (let z = -1; z <= 1; z++) cells[`0,${y},${z}`] = "air";
  cells["0,65,-1"] = "coal_ore";
  for (let y = 66; y <= 69; y++) cells[`0,${y},-1`] = "sand";
  const { bot, world } = createFakeBot({
    clock, simulatePhysics: true, position: new Vec3(0.5, 63, 0.5), groundY: 62, carried: { diamond_pickaxe: 1 }, cells,
  });
  const coal = new Vec3(0, 65, -1);
  const navigation = createNavigationRuntime(bot);
  const swings: { columnZ: number[]; z: number }[] = [];
  const dig = bot.dig.bind(bot);
  bot.dig = async (block, ...rest) => {
    if (block.position.equals(coal)) swings.push({ columnZ: [...footprintColumns(bot.entity.position)].map(({ z }) => z), z: bot.entity.position.z });
    return dig(block, ...rest);
  };
  // The body is pushed 0.1 into the next column once the plan exists, and it cannot steer back.
  let pushed = false;
  let searches = 0;
  navigation.onEvent((event) => {
    if (event.kind === "search_started") searches++;
    if (event.kind === "search_slice" && !pushed) { pushed = true; bot.entity.position.z = 0.10; bot.setControlState = () => undefined; }
  });
  const coalState = bot.registry.blocksByName.coal_ore!.defaultState!;
  const mining = mine(bot, {
    matches: (block) => block.name === "coal_ore",
    canMine: () => ({ kind: "mineable", routeMayBreak: true }),
    matchingStateIds: new Set([coalState]),
    collects: () => true,
    isSatisfied: () => world.blockAt(coal)?.name !== "coal_ore",
    observedInventoryGain: () => 0,
    movements: createMovementPolicy({ digTimeEstimator: { estimate: () => 1 } }),
    castSearchRadius: 64,
    explore: false,
    maximumBreaks: 2,
    route: (options) => navigation.navigate({ ...options }),
    breakInPlace: (options) => navigation.breakBlockInPlace(options),
    placeInto: async () => ({ kind: "failed", error: "the fake bot places nothing" }),
    cast: null,
  });
  try {
    const result = await clock.settle(mining, RUN_BOUND_MS);
    assert.equal(pushed, true, "the plan was made before the body moved");
    assert.deepEqual(swings.filter(({ columnZ }) => columnZ.includes(-1)), [], `a swing with the footprint over column z -1: ${JSON.stringify(swings)}`);
    assert.ok(searches >= 2, `the refused swing invalidated the route and a new search started from the observed body (${searches} searches)`);
    assert.equal(result.status, "unreachable", "the body can neither centre nor move to a clear stance: a bounded failure");
    assert.equal(swings.length, 0, "no swing at the coal at all");
    assert.equal(world.blockAt(coal)?.name, "coal_ore");
    assert.deepEqual(Object.entries(bot.controlState).filter(([, held]) => held), [], "no control is held");
    assert.equal(waterStancesHeld(bot), 0, "no stance hold outlives the run (checked before close() could release it)");
  } finally {
    await clock.settle(navigation.close(), 5_000);
  }
});

/**
 * D39/D40: a dig or seal that only this stance cannot do refuses the stance, after a re-read of the target, the body and
 * the sight line; the block stays a target. The target is beside the working cell west of it, a source face east of it.
 */
const STANCE_TARGET = new Vec3(1, 64, 0);
const STANCE_FACE = new Vec3(2, 64, 0);
const STANCE_CELL = new Vec3(0, 64, 0);
const STANCE_RATES = [[20, false], [10, false], [20, true]] as const;
const HIDDEN_DIG = "The required dig at 1,64,0 cannot be seen within reach from this position.";
const drainableTarget: MineRequest["canMine"] = () => ({ kind: "mineable", routeMayBreak: false, drained: { wetStances: [] } });
const dryStanceTarget: MineRequest["canMine"] = () => ({ kind: "mineable", routeMayBreak: false });
const plainStance = (feet: Vec3) => ({ feet, remainingScaffolds: 0, overlayId: "overlay:0" });

/** What the goal the route is handed says about each cell: whether standing there would finish the work. */
function acceptedStances(scene: MineScene, goal: Parameters<MineRequest["route"]>[0]["goal"], cells: readonly Vec3[]): boolean[] {
  const resolved = goal.resolve({ position: scene.bot.entity.position, entities: new Map() } as never);
  assert.equal(resolved.kind, "active", "the target is still in the goal");
  if (resolved.kind !== "active") throw new Error("the target left the goal");
  return cells.map((feet) => resolved.isSatisfied(plainStance(feet), goalTestWorld));
}

/** A plug that lands: the cell becomes cobblestone, then `afterPlug` changes what the server did next. */
function pluggingInto(scene: MineScene, plugs: string[], afterPlug: (cell: Vec3) => void): MineRequest["placeInto"] {
  return async (_bot, position) => {
    const cell = cellAt(position);
    plugs.push(cell.toString());
    scene.world.setCell(cell, "cobblestone");
    afterPlug(cell);
    return { kind: "placed", block: scene.bot.blockAt(cell)! };
  };
}

/** The lava face south of the target: the seal's cell. The second working cell is the one north of it. */
const STANCE_LAVA = new Vec3(1, 64, 1);
const OTHER_STANCE = new Vec3(1, 64, -1);

/** The drain tests' scene: the target, a water source face east of it and a lava face south of it, at a server rate. */
function drainScene(rate: number, stopped: boolean, extra: Partial<SceneOptions> = {}): MineScene {
  const scene = mineScene({ blocks: [STANCE_TARGET], water: [STANCE_FACE], lava: [STANCE_LAVA], feet: STANCE_CELL.offset(0.5, 0, 0.5), ...extra });
  scene.server.setTickRate(rate);
  if (stopped) scene.server.stop();
  return scene;
}

/**
 * The server's answer to a ray at a hidden block: it hits what hides it, and `visibleBlockAim` refuses a hit anywhere else
 * (`block-visibility.ts`). An eye's own cells cannot be filled, so the occluder is answered here, not laid by `setCell`.
 */
function hideTargetBehind(scene: MineScene, occluder: Vec3): void {
  scene.bot.world.raycast = () => scene.bot.blockAt(occluder) as never;
}

for (const [rate, stopped] of STANCE_RATES)
  test(`a drain that plugs the only ray refuses the live stance after a re-read, spends no seal and keeps the target (t00780, ${rate} tps, stopped ${stopped})`, async () => {
    using scene = drainScene(rate, stopped);
    const plugs: string[] = [];
    let swings = 0;
    let seen: boolean[] = [];
    const result = await runMine(scene, {
      canMine: drainableTarget,
      isSatisfied: () => seen.length > 0,
      placeInto: pluggingInto(scene, plugs, (plug) => hideTargetBehind(scene, plug)),
      breakInPlace: async () => { swings += 1; return { status: "failed", reason: HIDDEN_DIG }; },
      route: async ({ goal }) => {
        seen = acceptedStances(scene, goal, [STANCE_CELL, OTHER_STANCE]);
        return { status: "completed", elapsedMs: 0 };
      },
    });
    assert.deepEqual(plugs, [STANCE_FACE.toString()], "the drain's plug is the only block placed: the lava face is not sealed for a dig this stance cannot make");
    assert.equal(swings, 0);
    assert.deepEqual(seen, [false, true], "the live feet cell is refused and the target stays in the goal for another cell");
    assert.equal(result.status, "satisfied");
    assert.match(result.reason ?? "", /is occluded from 0,64,0/);
  });

test("a seal that hides the only ray refuses the live stance and the swing is never made", async () => {
  for (const [rate, stopped] of STANCE_RATES) {
    using scene = drainScene(rate, stopped, { water: [] });
    const placed: string[] = [];
    let swings = 0;
    let seen: boolean[] = [];
    await runMine(scene, {
      canMine: dryStanceTarget,
      isSatisfied: () => seen.length > 0,
      placeInto: pluggingInto(scene, placed, (cell) => hideTargetBehind(scene, cell)),
      breakInPlace: async () => { swings += 1; return { status: "failed", reason: HIDDEN_DIG }; },
      route: async ({ goal }) => {
        seen = acceptedStances(scene, goal, [STANCE_CELL, OTHER_STANCE]);
        return { status: "completed", elapsedMs: 0 };
      },
    });
    assert.deepEqual(placed, [STANCE_LAVA.toString()], `${rate} tps, stopped ${stopped}`);
    assert.equal(swings, 0, "the re-read after the seal ends the step before the swing");
    assert.deepEqual(seen, [false, true]);
  }
});

test("a body moved during the drain refuses no stance; one moved to another working cell refuses that cell", async () => {
  for (const [rate, stopped] of STANCE_RATES) for (const [name, moved, expected, refused] of [
    ["not a working cell", new Vec3(5.5, 64, 5.5), [true, true], false],
    ["another working cell", OTHER_STANCE.offset(0.5, 0, 0.5), [true, false], true],
  ] as const) {
    using scene = drainScene(rate, stopped);
    const plugs: string[] = [];
    const offered: string[] = [];
    let swings = 0;
    let seen: boolean[] = [];
    const result = await runMine(scene, {
      canMine: drainableTarget,
      isSatisfied: () => seen.length > 0,
      onTargets: (targets) => offered.push(...targets.map((target) => (target.kind === "block" ? [...target.excludedStances].join(";") : ""))),
      placeInto: pluggingInto(scene, plugs, (plug) => {
        scene.bot.entity.position = moved.clone();
        hideTargetBehind(scene, plug);
      }),
      breakInPlace: async () => { swings += 1; return { status: "failed", reason: HIDDEN_DIG }; },
      route: async ({ goal }) => {
        seen = acceptedStances(scene, goal, [STANCE_CELL, OTHER_STANCE]);
        return { status: "completed", elapsedMs: 0 };
      },
    });
    const label = `${name} (${rate} tps, stopped ${stopped})`;
    assert.deepEqual(plugs, [STANCE_FACE.toString()], label);
    assert.equal(swings, 0, label);
    assert.deepEqual(seen, expected, label);
    if (refused) assert.match(result.reason ?? "", /is occluded from 1,64,-1/, label);
    else {
      assert.doesNotMatch(result.reason ?? "", /occluded/, label);
      assert.deepEqual(offered.filter((avoid) => avoid !== ""), [], `${label}: no stance was refused`);
    }
  }
});

test("a target removed, replaced or unloaded between the drain and the seal ends the step with no refusal and no swing", async () => {
  for (const [rate, stopped] of STANCE_RATES) for (const after of ["air", "dirt", "void"] as const) {
    using scene = drainScene(rate, stopped);
    const plugs: string[] = [];
    let swings = 0;
    const result = await runMine(scene, {
      canMine: drainableTarget,
      placeInto: pluggingInto(scene, plugs, () => scene.world.setCell(STANCE_TARGET, after)),
      breakInPlace: async () => { swings += 1; return { status: "failed", reason: HIDDEN_DIG }; },
      route: noRouteNeeded,
    });
    const label = `${after} (${rate} tps, stopped ${stopped})`;
    assert.deepEqual(plugs, [STANCE_FACE.toString()], `${label}: no seal for a target that is gone`);
    assert.equal(swings, 0, label);
    assert.doesNotMatch(result.reason ?? "", /occluded|cannot be seen/, label);
    assert.equal(result.status, "no_targets", label);
  }
});

test("a seal cell that overlaps the bot's own body refuses the live stance; another body in the cell blacklists the target", async () => {
  const lava = new Vec3(1, 64, 1);
  const overlapped = "Placement cell (1, 64, 1) overlaps the bot's own body.";
  const occupied = "Placement cell (1, 64, 1) overlaps player Steve at (1.5, 64, 1.5): ask Steve to step out.";
  // The body straddles x 0.6-1.2, z 0.6-1.2, so the lava cell overlaps it; the other bot stands apart from the lava.
  {
    using own = mineScene({ blocks: [STANCE_TARGET], lava: [lava], feet: new Vec3(0.9, 64, 0.9) });
    let seen: boolean[] = [];
    let swings = 0;
    await runMine(own, {
      canMine: dryStanceTarget,
      isSatisfied: () => seen.length > 0,
      placeInto: async () => ({ kind: "failed", error: overlapped, cause: "entity" }),
      breakInPlace: async () => { swings += 1; return { status: "broken" }; },
      route: async ({ goal }) => {
        seen = acceptedStances(own, goal, [STANCE_CELL, new Vec3(1, 64, -1)]);
        return { status: "completed", elapsedMs: 0 };
      },
    });
    assert.deepEqual(seen, [false, true], "the body's own cell is refused, the target stays");
    assert.equal(swings, 0);
  }
  {
    using other = mineScene({ blocks: [STANCE_TARGET], lava: [lava], feet: STANCE_CELL.offset(0.5, 0, 0.5) });
    const result = await runMine(other, {
      canMine: dryStanceTarget,
      placeInto: async () => ({ kind: "failed", error: occupied, cause: "entity" }),
      breakInPlace: async () => { throw new Error("a seal that failed must not be followed by a swing"); },
      route: noRouteNeeded,
    });
    assert.equal(result.status, "unreachable");
    assert.match(result.reason ?? "", /could not be closed: Placement cell \(1, 64, 1\) overlaps player Steve/);
  }
});

test("a swing refused for the stance refuses the live cell, a policy refusal blacklists, a support one re-reads", async () => {
  const refusal = (cause: "stance" | "policy" | "support" | undefined) =>
    ({ status: "failed", reason: `the ${cause ?? "plain"} refusal`, ...(cause && { cause }) }) as const;
  {
    using scene = mineScene({ blocks: [STANCE_TARGET], feet: STANCE_CELL.offset(0.5, 0, 0.5) });
    let seen: boolean[] = [];
    const result = await runMine(scene, {
      canMine: dryStanceTarget,
      isSatisfied: () => seen.length > 0,
      breakInPlace: async () => refusal("stance"),
      route: async ({ goal }) => {
        seen = acceptedStances(scene, goal, [STANCE_CELL, new Vec3(1, 64, 1)]);
        return { status: "completed", elapsedMs: 0 };
      },
    });
    assert.deepEqual(seen, [false, true]);
    assert.match(result.reason ?? "", /the stance refusal/);
  }
  for (const cause of ["policy", undefined] as const) {
    using scene = mineScene({ blocks: [STANCE_TARGET], feet: STANCE_CELL.offset(0.5, 0, 0.5) });
    const result = await runMine(scene, { canMine: dryStanceTarget, breakInPlace: async () => refusal(cause), route: noRouteNeeded });
    assert.equal(result.status, "unreachable", String(cause));
    assert.match(result.reason ?? "", /the (policy|plain) refusal/);
  }
  {
    using scene = mineScene({ blocks: [STANCE_TARGET], feet: STANCE_CELL.offset(0.5, 0, 0.5) });
    let swings = 0;
    const result = await runMine(scene, {
      canMine: dryStanceTarget,
      isSatisfied: () => scene.bot.blockAt(STANCE_TARGET)?.name === "air",
      breakInPlace: async (options) => {
        swings += 1;
        if (swings === 1) return refusal("support");
        scene.world.setCell(cellAt(options.position), "air");
        return { status: "broken" };
      },
      route: noRouteNeeded,
    });
    assert.equal(swings, 2, "the support refusal re-reads and the same stance digs again");
    assert.equal(result.status, "satisfied");
    assert.deepEqual(result.broken, [STANCE_TARGET]);
  }
});

// A guard, not a red proof: the old code also rejects an abort raised in the plug (`throwIfAborted` after the drain).
test("an abort at the plug or in the swing rejects with no swing after the plug and no exclusion; the next call reads the world fresh", async () => {
  using scene = drainScene(20, false);
  const dead = new AbortController();
  const worldRay = scene.bot.world.raycast;
  const offered: string[] = [];
  let swings = 0;
  const observed = { onTargets: (targets: readonly MineTarget[]) => offered.push(...targets.map((target) => (target.kind === "block" ? [...target.excludedStances].join(";") : ""))) };
  await assert.rejects(
    runMine(scene, {
      canMine: drainableTarget,
      signal: dead.signal,
      ...observed,
      placeInto: pluggingInto(scene, [], (plug) => {
        hideTargetBehind(scene, plug);
        dead.abort(new Error("the bot died"));
      }),
      breakInPlace: async () => { swings += 1; return { status: "failed", reason: HIDDEN_DIG }; },
      route: noRouteNeeded,
    }),
    /the bot died/,
  );
  assert.equal(swings, 0);
  assert.deepEqual(offered.filter((avoid) => avoid !== ""), [], "no stance was refused after the abort");

  // An abort that lands in the swing, which answers a stance refusal: the refusal is not recorded.
  scene.bot.world.raycast = worldRay;
  const dying = new AbortController();
  offered.length = 0;
  await assert.rejects(
    runMine(scene, {
      canMine: dryStanceTarget,
      signal: dying.signal,
      ...observed,
      placeInto: pluggingInto(scene, [], () => {}),
      breakInPlace: async () => { dying.abort(new Error("died in the swing")); return { status: "failed", reason: HIDDEN_DIG, cause: "stance" }; },
      route: noRouteNeeded,
    }),
    /died in the swing/,
  );
  assert.deepEqual(offered.filter((avoid) => avoid !== ""), [], "no stance was refused after the abort in the swing");

  // The plug stays in the world; a new call reads it and credits only what it sees break.
  scene.bot.world.raycast = worldRay;
  assert.equal(scene.bot.blockAt(STANCE_FACE)?.name, "cobblestone");
  const next = await runMine(scene, {
    canMine: dryStanceTarget,
    isSatisfied: () => scene.bot.blockAt(STANCE_TARGET)?.name === "air",
    breakInPlace: breakingInPlace(scene, () => {}),
    route: noRouteNeeded,
  });
  assert.equal(next.status, "satisfied");
  assert.deepEqual(next.broken, [STANCE_TARGET]);
});

test("a scan refuses a target whose every working stance was refused, but keeps one the route may break", () => {
  for (const [routeMayBreak, kept] of [[false, 0], [true, 1]] as const) {
    using scene = mineScene({ blocks: [STANCE_TARGET], feet: STANCE_CELL.offset(0.5, 0, 0.5) });
    const targeting = new MineTargeting(scene.bot, request(scene, { exactTarget: STANCE_TARGET, canMine: () => ({ kind: "mineable", routeMayBreak }) }));
    const first = targeting.targets()[0];
    assert.ok(first?.kind === "block");
    for (const offset of WORKING_OFFSETS) {
      targeting.excludeBlockStance(first, cellAt({ x: STANCE_TARGET.x + offset.x, y: STANCE_TARGET.y + offset.y, z: STANCE_TARGET.z + offset.z }), "the swing refused it");
    }
    assert.equal(targeting.refresh().length, kept, `routeMayBreak ${routeMayBreak}`);
    assert.deepEqual([...targeting.rejections.keys()], routeMayBreak ? [] : ["every working stance was refused: the swing refused it"]);
    assert.equal(targeting.blacklisted, 0, "refused for the scan, not blacklisted");
  }
});

test("a target with no open working cell at all is refused in the scan with its own text, and no search is asked for it", async () => {
  using scene = mineScene({ blocks: [STANCE_TARGET], feet: STANCE_CELL.offset(0.5, 0, 0.5) });
  // Every working cell's head is in a chunk the server has not sent: `workingCells` offers none.
  for (const offset of WORKING_OFFSETS) scene.world.setCell(new Vec3(STANCE_TARGET.x + offset.x, STANCE_TARGET.y + offset.y + 1, STANCE_TARGET.z + offset.z), "void");
  const result = await runMine(scene, { canMine: dryStanceTarget, route: noRouteNeeded });
  assert.equal(result.status, "unreachable");
  assert.match(result.reason ?? "", /1 loaded matching block\(s\) cannot be mined: no working stance beside it is open/);
});

test("exhaustion of a lone target's stances ends an exploring request like any rejected target: unreachable, no branch search", async () => {
  using scene = mineScene({ blocks: [STANCE_TARGET], feet: STANCE_CELL.offset(0.5, 0, 0.5) });
  const moves: Vec3[] = [];
  const result = await runMine(scene, {
    canMine: dryStanceTarget,
    explore: true,
    breakInPlace: async () => ({ status: "failed", reason: "no face in view", cause: "stance" }),
    route: toNextAcceptedCell(scene, [STANCE_TARGET], moves),
  });
  assert.equal(result.status, "unreachable");
  assert.match(result.reason ?? "", /every working stance was refused: no face in view/);
});

/**
 * New end state: a target with its stance refused and a block over it. The real goal, rescan and route (the real
 * navigation on the fake) take another working cell, or, once the target is dry, its excavate route, and the dig lands.
 */
for (const dry of [false, true])
  test(`a stance-refused target is broken from its next approach (${dry ? "dry, the route may break it" : "another working cell"})`, async () => {
    const target = new Vec3(2, 64, 0);
    const floor = Array.from({ length: 9 * 7 }, (_, index) => new Vec3((index % 9) - 3, 63, Math.floor(index / 9) - 3));
    using scene = mineScene({ blocks: [target], solids: [...floor, new Vec3(2, 65, 0)], physics: true, feet: new Vec3(0.5, 64, 0.5) });
    const navigation = createNavigationRuntime(scene.bot);
    const refused: string[] = [];
    let mayBreak = false;
    try {
      const result = await runMine(scene, {
        canMine: () => ({ kind: "mineable", routeMayBreak: mayBreak }),
        movements: createMovementPolicy({ digTimeEstimator: { estimate: () => 1 } }),
        isSatisfied: () => scene.bot.blockAt(target)?.name === "air",
        route: (options) => navigation.navigate({ ...options }),
        breakInPlace: async (options) => {
          if (refused.length > 0) return navigation.breakBlockInPlace(options);
          refused.push(scene.bot.entity.position.floored().toString());
          mayBreak = dry;
          return { status: "failed", reason: "No face of the block is in view from here.", cause: "stance" };
        },
      });
      assert.equal(result.status, "satisfied");
      assert.equal(refused.length, 1, "the refused stance was asked once");
      assert.equal(scene.bot.blockAt(target)?.name, "air");
      assert.ok(scene.server.packets.some((packet) => packet.name === "block_dig"), "a dig packet was sent");
      // A target the route may break is dug by the route's own excavation, which owns its stance; otherwise by the next cell.
      if (!dry) assert.notEqual(scene.bot.entity.position.floored().toString(), refused[0], "another working cell dug it");
    } finally {
      await scene.clock.settle(navigation.close(), 5_000);
    }
  });

/** A route that walks the body to the first working cell its goal still accepts, as the real route does. */
function toNextAcceptedCell(scene: MineScene, targets: readonly Vec3[], moves: Vec3[]): MineRequest["route"] {
  return async ({ goal, onArrival }) => {
    const cells = targets.flatMap((target) => WORKING_OFFSETS.map((o) => new Vec3(target.x + o.x, target.y + o.y, target.z + o.z)));
    const accepted = acceptedStances(scene, goal, cells);
    const cell = cells.find((_, index) => accepted[index]);
    assert.ok(cell, "the goal always holds a working cell: an empty goal never reaches the search");
    moves.push(cell);
    scene.bot.entity.position = cell.offset(0.5, 0, 0.5);
    await onArrival?.(arrival(scene));
    return { status: "completed", elapsedMs: 0 };
  };
}

test("every working stance refused in turn leaves the scan: a second target is mined, a lone one ends the request", async () => {
  const other = new Vec3(-4, 64, 0);
  {
    using scene = mineScene({ blocks: [STANCE_TARGET], feet: STANCE_CELL.offset(0.5, 0, 0.5) });
    const moves: Vec3[] = [];
    let swings = 0;
    const result = await runMine(scene, {
      canMine: dryStanceTarget,
      breakInPlace: async () => { swings += 1; return { status: "failed", reason: "no face in view", cause: "stance" }; },
      route: toNextAcceptedCell(scene, [STANCE_TARGET], moves),
    });
    assert.equal(result.status, "unreachable");
    assert.match(result.reason ?? "", /every working stance was refused: no face in view/);
    // One refused dig per working cell at most. The cell on top of the target is the scan's temporary exclusion (only
    // while the body stands on it, 2026-11-15), so each refusal may be followed by one step-off visit there.
    assert.ok(swings <= WORKING_OFFSETS.length, `${swings} swings: one refusal per working cell at most`);
    assert.ok(moves.length <= 2 * WORKING_OFFSETS.length, `${moves.length} moves ${moves.join(" ")}`);
  }
  {
    using scene = mineScene({ blocks: [STANCE_TARGET, other], feet: STANCE_CELL.offset(0.5, 0, 0.5) });
    const moves: Vec3[] = [];
    let swings = 0;
    const result = await runMine(scene, {
      canMine: dryStanceTarget,
      isSatisfied: () => scene.bot.blockAt(other)?.name === "air",
      breakInPlace: async ({ position }) => {
        swings += 1;
        if (!cellAt(position).equals(other)) return { status: "failed", reason: "no face in view", cause: "stance" };
        scene.world.setCell(other, "air");
        return { status: "broken" };
      },
      route: toNextAcceptedCell(scene, [STANCE_TARGET, other], moves),
    });
    assert.equal(result.status, "satisfied");
    assert.deepEqual(result.broken, [other]);
    assert.ok(swings <= WORKING_OFFSETS.length + 1, `${swings} swings`);
  }
});
