import { MemoryWorld as GoalTestWorld } from "../../world/memory-world.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { occupyGoal } from "../../index.js";
import { setCarriedCount } from "../../../test-support/carried-counts.js";
import { type FakeHarness, createFakeBot, createFakeClock } from "../../../test-support/fake-bot/index.js";
import { DROP_PICKUP_TIMEOUT_MS } from "./mine-drops.js";
import { mine, type MineRequest } from "./mine-process.js";

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

test("occupying a target means standing in its cell", () => {
  assert.equal(satisfiedAt(new Vec3(5, 64, -2), new Vec3(5, 64, -2), 3), true);
});

test("a player standing below a target occupies it, because it is two blocks tall", () => {
  assert.equal(satisfiedAt(new Vec3(5, 63, -2), new Vec3(5, 64, -2), 3), true);
  assert.equal(satisfiedAt(new Vec3(5, 62, -2), new Vec3(5, 64, -2), 3), true);
});

test("two-level occupancy excludes the cell two below the target", () => {
  assert.equal(satisfiedAt(new Vec3(5, 63, -2), new Vec3(5, 64, -2), 2), true);
  assert.equal(satisfiedAt(new Vec3(5, 62, -2), new Vec3(5, 64, -2), 2), false);
});

test("a target in another column is never occupied", () => {
  assert.equal(satisfiedAt(new Vec3(0, 64, 0), new Vec3(5, 64, -2), 3), false);
});

/**
 * The consequence worth stating, because it is a trap rather than a bug: a
 * target in the bot's own column at head height is *already* occupied, so the
 * planner reports the goal reached without moving or breaking anything.
 * Baritone answers this in `MineProcess.onTick`, which breaks a known location
 * directly above or below the player itself rather than pathing to it.
 */
test("a target at head height is already occupied, so pathing to it does nothing", () => {
  assert.equal(satisfiedAt(new Vec3(5, 64, -2), new Vec3(5, 65, -2), 3), true);
  assert.equal(satisfiedAt(new Vec3(5, 66, -2), new Vec3(5, 66, -2), 3), true);
});

/** Ticks a drop waits before the server lets the bot take it: the scene's item stays on the ground. */
const STAYS_ON_THE_GROUND_TICKS = 1_000_000;
/** Clock the process may use in one test, ms; every wait of a run is a tick or a timer of this clock. */
const RUN_BOUND_MS = 60_000;

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
  let groundedAtDig: boolean | undefined;
  const result = await runMine(scene, {
    canMine: () => ({ kind: "mineable", routeMayBreak: false }),
    isSatisfied: () => groundedAtDig !== undefined,
    breakInPlace: async () => {
      groundedAtDig = scene.bot.entity.onGround;
      scene.world.setCell(target, "air");
      return { status: "broken" };
    },
    route: async () => {
      throw new Error("The working stance is already in reach.");
    },
  });
  assert.equal(result.status, "satisfied");
  assert.equal(groundedAtDig, true, "the dig waited for the floor: off the ground it is x5 slower");
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

test("an unreachable target is reported as found-but-unreachable, not as absent", async () => {
  using scene = mineScene({ blocks: [new Vec3(5, 64, 0)] });
  const result = await runMine(scene, { route: async () => ({ status: "stopped", reason: "no path", elapsedMs: 0 }) });

  assert.notEqual(result.status, "no_targets");
  assert.equal(result.status, "unreachable");
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

test("an unreachable live drop does not wait forever for a packet transition", async () => {
  using scene = mineScene({
    drops: [new Vec3(3, 61, 0)],
    onWaitForTicks: () => {
      throw new Error("a live unreachable drop must not loiter");
    },
  });
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

test("a moving drop in lava does not receive the free-flight wait", async () => {
  const cell = new Vec3(3, 61, 0);
  using scene = mineScene({
    drops: [cell],
    lava: [cell],
    onWaitForTicks: () => {
      throw new Error("lava is not free flight");
    },
  });
  scene.bot.entities[dropId(0)]!.velocity = new Vec3(0, -0.2, 0);
  const result = await runMine(scene, {
    route: async (options) => {
      const resolution = await options.onCalculationFailure?.(noPath(scene, { x: 0, y: 64, z: 0 }, 3));
      assert.equal(resolution?.kind, "completed");
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(result.status, "unreachable");
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

test("an old item does not hide a later item entering the same cell", async () => {
  const outcome = await arrivalsAcrossSlowTick(({ entities, dropAt }, cell) => {
    entities.remove(dropId(0));
    dropAt(1, cell);
  });

  assert.equal(outcome.status, "satisfied");
  assert.equal(outcome.ticks, 2);
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

test("a live drop remains a target after the vanished-item settlement window", async () => {
  const outcome = await arrivalsAcrossSlowTick(() => undefined);

  assert.equal(outcome.status, "satisfied");
  assert.equal(outcome.ticks, 2);
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
  // The first tick the process waits for comes after the settle wait gave up on the dig.
  let tickWaitAtMs: number | undefined;
  using scene = mineScene({
    blocks: [target],
    // The eye cell: the eyes rule reads whole cells.
    water: [feet.offset(0, 1.62, 0).floored()],
    feet,
    onGround: false,
    isInWater: true,
    onWaitForTicks: ({ clock }) => {
      tickWaitAtMs ??= clock.now();
    },
  });
  // Before the wall bound this wait ended only with the caller's abort.
  scene.bot.physicsEnabled = false;
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
        await options.onArrival?.({ goalRevision: "test", node, observation, signal: new AbortController().signal });
      } catch {
        // Known code bug, not asserted: `waitForProcessTick` waits on a bare `bot.waitForTicks(1)`, which Mineflayer
        // rejects at 5050 ms when physics sends no tick (`physics.js:456-475`, facts runtime-pitfalls.md "waitForTicks").
        // The old fake resolved that wait at once; this test is about the dig wait before it.
      }
      arrivalOver = true;
      return { status: "completed", elapsedMs: 0 };
    },
  });
  assert.equal(breakAttempts, 0);
  assert.ok(tickWaitAtMs !== undefined && tickWaitAtMs < 3_000, `the dig wait gave up after ${tickWaitAtMs} ms`);
});
