import { MemoryWorld as GoalTestWorld } from "../../navigation/world/memory-world.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { NavigationRuntime } from "../../navigation/index.js";
import type { Bot } from "mineflayer";
import { createMovements, type NavigationResult } from "../../navigation/index.js";
import { createMovementPolicy } from "../../navigation/movements/policy.js";
import { ActionRunner } from "../../session/action-runner.js";
import { parseNavigateRequest } from "./contract.js";
import { createNavigateAction, formatNavigateResult, navigate, toolLossObserverOf, type NavigateDependencies } from "./navigate.js";
import { createFakeBot, createFakeClock, type FakeBotOptions, type FakeCell } from "../../test-support/fake-bot/index.js";

const goalTestWorld = new GoalTestWorld();

/** Every cell of the box from `from` to `to` (corners included) holding `block`. */
function cellsIn(from: readonly [number, number, number], to: readonly [number, number, number], block: FakeCell): Record<string, FakeCell> {
  const cells: Record<string, FakeCell> = {};
  for (let x = from[0]; x <= to[0]; x++) for (let y = from[1]; y <= to[1]; y++) for (let z = from[2]; z <= to[2]; z++) cells[`${x},${y},${z}`] = block;
  return cells;
}

interface Scene {
  readonly cells?: Record<string, FakeCell>;
  /** Item name to count; 4 dirt and 11 cobblestone when neither this nor `slots` is given. */
  readonly carried?: Record<string, number>;
  readonly slots?: FakeBotOptions["slots"];
  readonly clock?: FakeBotOptions["clock"];
}

/** A bot at (0.5, 64, 0.5) on flat ground whose standing cells are at `groundY`: stone below, air from there up. */
function flatGroundBot(groundY = 64, scene: Scene = {}) {
  const harness = createFakeBot({
    groundY: groundY - 1,
    cells: scene.cells,
    carried: scene.carried ?? (scene.slots === undefined ? { dirt: 4, cobblestone: 11 } : undefined),
    slots: scene.slots,
    clock: scene.clock,
  });
  /** Lower the count of `name` carried to `count`, as a route that placed some leaves it. */
  const useUntil = (name: string, count: number) => {
    const type = harness.bot.registry.itemsByName[name]!.id;
    harness.inventory.toss(type, harness.inventory.count(type, null) - count);
  };
  return { ...harness, useUntil };
}

function dependencies(
  run: NavigateDependencies["navigate"],
  movementOptions: unknown[] = [],
): NavigateDependencies {
  return {
    createMovements: ((_bot: Bot, options: unknown) => {
      movementOptions.push(options);
      return { name: "standard" };
    }) as unknown as typeof createMovements,
    navigate: run,
  };
}

const fakeNavigation = { cancel: () => undefined } as unknown as NavigationRuntime;

test("dig navigation safely settles partial when its best pickaxe capability drops", async () => {
  const { bot, inventory } = flatGroundBot(64, { slots: { 36: { name: "diamond_pickaxe" }, 9: { name: "stone_pickaxe" } } });
  inventory.slots[36]!.durabilityUsed = 1560;
  const run: NavigateDependencies["navigate"] = async ({ stopSignal, onToolSelected }) => {
    onToolSelected?.(bot.registry.itemsByName.diamond_pickaxe!.id);
    // The last use broke it: the server empties its slot.
    inventory.tossStack(inventory.slots[36]!);
    await Promise.resolve();
    assert.equal(stopSignal?.aborted, true);
    return { status: "stopped", reason: String(stopSignal?.reason), elapsedMs: 1 };
  };
  const deps: NavigateDependencies = { navigate: run, createMovements: (() => createMovementPolicy({
    priceBreak: () => ({ decision: { kind: "allowed" },
      tool: { itemType: bot.registry.itemsByName.diamond_pickaxe!.id, expectedTicks: 1 } }),
  })) as never };
  const action = createNavigateAction(bot, fakeNavigation, deps);
  const output = await new ActionRunner().run(action, { x: 10, y: 64, z: 0, dig: true });
  assert.equal(output.result.status, "partial");
  assert.match("error" in output.result ? output.result.error : "", /TOOL_TIER_LOST.*stone pickaxe remains/);
});

test("a midwater arrival records current completion without claiming grounded footing", async () => {
  const { bot } = flatGroundBot(59, { cells: cellsIn([-8, 59, -8], [12, 63, 8], "water") });
  const action = createNavigateAction(bot, fakeNavigation, dependencies(async () => {
    bot.entity.position.set(3.5, 61.2, 0.5);
    bot.entity.onGround = false;
    return { status: "completed", elapsedMs: 1 };
  }));
  const output = await new ActionRunner().run(action, { x: 3, y: 61, z: 0, range: 0 });
  assert.equal(output.result.status, "succeeded");
  assert.equal(output.request?.evidence?.completion.observed, true);
});

test("resumed navigation retains the request origin and stocks and sums only route elapsed time", async () => {
  const { bot, useUntil } = flatGroundBot();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let attempts = 0;
  const action = createNavigateAction(
    bot,
    fakeNavigation,
    dependencies(async ({ signal }) => {
      attempts++;
      if (attempts === 1) {
        bot.entity.position.set(2.5, 64, 0.5);
        useUntil("cobblestone", 8);
        entered();
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
        return { status: "stopped", reason: "reflex", elapsedMs: 100 };
      }
      bot.entity.position.set(4.5, 64, 0.5);
      useUntil("cobblestone", 6);
      return { status: "completed", elapsedMs: 200 };
    }),
  );
  const runner = new ActionRunner();
  const pending = runner.run(action, { x: 4, y: 64, z: 0, range: 0 });
  await started;
  runner.claim("hunger_reflex", "ate bread", async () => ({ value: null, continuation: { kind: "resume" as const } }));
  const output = await pending;
  assert.equal(output.result.status, "succeeded");
  if (!("navigation" in output.result)) throw new Error("expected navigation evidence");
  assert.deepEqual(output.result.navigation.start, { x: 0.5, y: 64, z: 0.5 });
  assert.equal(output.result.navigation.elapsedMs, 300);
  assert.deepEqual(
    output.result.navigation.scaffolding.find((stock) => stock.item === "cobblestone"),
    {
      item: "cobblestone",
      inventoryBefore: 11,
      inventoryAfter: 6,
      consumed: 5,
    },
  );
});

test("a soul-sand destination is supported and its fractional physical height satisfies the exact node receipt", async () => {
  const { bot } = flatGroundBot(64, { cells: cellsIn([-8, 63, -8], [12, 63, 8], "soul_sand") });
  const run: NavigateDependencies["navigate"] = async () => {
    bot.entity.position.set(3.5, 63.875, 0.5);
    bot.entity.onGround = true;
    return { status: "completed", elapsedMs: 1 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 3, y: 64, z: 0, range: 0 },
  );
  assert.equal(output.result.status, "succeeded");
  if (!("navigation" in output.result)) throw new Error("expected navigation evidence");
  assert.equal(output.result.navigation.remainingDistance, 0);
  assert.equal(output.result.navigation.end.y, 63.875);
});

test("surface navigation cannot succeed on a cave floor 122 blocks below the target", async () => {
  const { bot } = flatGroundBot(71);
  bot.entity.position.set(-120, -55, 30);
  const run: NavigateDependencies["navigate"] = async ({ goal }) => {
    const resolved = goal.resolve(undefined as never);
    assert.equal(resolved.kind, "active");
    if (resolved.kind === "active") {
      assert.equal(
        resolved.isSatisfied({ feet: { x: -114, y: -51, z: 8 }, remainingScaffolds: 0, overlayId: "" }, goalTestWorld),
        false,
      );
    }
    bot.entity.position.set(-113.42, -51, 9.49);
    return { status: "completed", elapsedMs: 1 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: -114, z: 8 },
  );
  assert.equal(output.result.status, "failed");
  if (!("navigation" in output.result)) throw new Error("expected navigation evidence");
  assert.equal(output.result.navigation.target.y, 71);
  assert.ok(output.result.navigation.remainingDistance !== null && output.result.navigation.remainingDistance >= 122);
});

test("omitted height refuses a canopy, overhang, or Nether roof instead of choosing its top", async () => {
  for (const roof of ["oak_leaves", "stone", "bedrock"]) {
    const { bot } = flatGroundBot(64, { cells: cellsIn([-8, 70, -8], [12, 70, 8], roof) });
    if (roof === "bedrock") bot.game.dimension = "the_nether";
    const run: NavigateDependencies["navigate"] = async ({ goal }) => {
      const resolved = goal.resolve(undefined as never);
      assert.equal(resolved.kind, "invalid");
      if (resolved.kind !== "invalid") throw new Error("Expected height refusal");
      assert.match(resolved.observation, /NAVIGATION_HEIGHT_REQUIRED.*71, 64/);
      return { status: "stopped", reason: resolved.observation, elapsedMs: 0 };
    };
    const output = await new ActionRunner().run(
      createNavigateAction(bot, fakeNavigation, dependencies(run)),
      { x: 3, z: 0 },
    );
    assert.equal(output.result.status, "failed");
    assert.match(output.result.error ?? "", /Supply y/);
  }
});

test("with near_y, a column under a canopy resolves to the floor nearest that height in one call", async () => {
  // Live 2026-10-07: each explore leg under trees was refused, then asked again with y (two calls, one shown failed).
  const { bot } = flatGroundBot(64, { cells: cellsIn([-8, 70, -8], [12, 70, 8], "oak_leaves") });
  const run: NavigateDependencies["navigate"] = async ({ goal }) => {
    const resolved = goal.resolve(undefined as never);
    assert.equal(resolved.kind, "active");
    bot.entity.position.set(3.5, 64, 0.5);
    return { status: "completed", elapsedMs: 1 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 3, z: 0, near_y: 63 },
  );
  assert.equal(output.result.status, "succeeded", "error" in output.result ? output.result.error : "");
  if (!("navigation" in output.result)) throw new Error("expected navigation evidence");
  assert.equal(output.result.navigation.target.y, 64);
});

test("parses one absolute destination and defaults its reached range", () => {
  assert.deepEqual(parseNavigateRequest({ x: 12, y: 65, z: -4 }), {
    x: 12,
    y: 65,
    z: -4,
    nearY: null,
    range: 1,
    scaffold: true,
    dig: true,
    build: false,
  });
  assert.deepEqual(parseNavigateRequest({ x: 12, z: -4, scaffold: false, dig: false }), {
    x: 12,
    y: null,
    z: -4,
    nearY: null,
    range: 1,
    scaffold: false,
    dig: false,
    build: false,
  });
  for (const input of [
    {},
    { x: 1, y: 2 },
    { x: 1.5, y: 2, z: 3 },
    { x: 1, y: 2, z: 3, range: -1 },
    { x: 1, y: 2, z: 3, mode: "safe" },
    { x: 1, y: 2, z: 3, dig: "false" },
    { x: 1, y: 2, z: 3, combat: "off" },
  ]) {
    assert.throws(() => parseNavigateRequest(input));
  }
});

test("uses standard movements without an arbitrary route timeout and verifies the final position", async () => {
  const { bot, useUntil } = flatGroundBot();
  const run: NavigateDependencies["navigate"] = async (options): Promise<NavigationResult> => {
    assert.equal("timeoutMs" in options, false);
    assert.equal(Reflect.get(options.movements, "name"), "standard");
    useUntil("cobblestone", 0);
    bot.entity.position.set(9.5, 64, 0.5);
    return { status: "completed", elapsedMs: 31_000 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    {
      x: 10,
      y: 64,
      z: 0,
      range: 1,
    },
  );

  assert.equal(output.result.status, "succeeded");
  assert.equal("navigation" in output.result ? output.result.navigation.elapsedMs : null, 31_000);
  assert.equal("navigation" in output.result ? output.result.navigation.remainingDistance : null, 1);
  assert.deepEqual("navigation" in output.result ? output.result.navigation.scaffolding : null, [
    { item: "dirt", inventoryBefore: 4, inventoryAfter: 4, consumed: 0 },
    { item: "cobblestone", inventoryBefore: 11, inventoryAfter: 0, consumed: 11 },
    { item: "cobbled_deepslate", inventoryBefore: 0, inventoryAfter: 0, consumed: 0 },
    { item: "netherrack", inventoryBefore: 0, inventoryAfter: 0, consumed: 0 },
    { item: "basalt", inventoryBefore: 0, inventoryAfter: 0, consumed: 0 },
    { item: "end_stone", inventoryBefore: 0, inventoryAfter: 0, consumed: 0 },
  ]);
});

test("uses the same feet-block distance as Pathfinder when verifying completion", async () => {
  const { bot } = flatGroundBot(-59);
  const run: NavigateDependencies["navigate"] = async (): Promise<NavigationResult> => {
    // This is the real regression: entity-centre distance is 2.55, while the
    // final Pathfinder node (2, -59, 8) validly satisfies GoalNear range 2.
    bot.entity.position.set(2.5, -59, 8.5);
    return { status: "completed", elapsedMs: 100 };
  };

  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    {
      x: 0,
      y: -59,
      z: 8,
      range: 2,
    },
  );

  assert.equal(output.result.status, "succeeded");
  assert.equal("navigation" in output.result ? output.result.navigation.remainingDistance : null, 2);
  assert.equal("navigation" in output.result ? output.result.navigation.end.x : null, 2.5);
});

test("reports a Pathfinder stop with the observed partial route", async () => {
  const { bot } = flatGroundBot();
  const run: NavigateDependencies["navigate"] = async (routeBot) => {
    bot.entity.position.set(4, 64, 0);
    return { status: "stopped", reason: "No path to the goal", elapsedMs: 200 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    {
      x: 10,
      y: 64,
      z: 0,
    },
  );

  assert.equal(output.result.status, "failed");
  assert.match("error" in output.result ? output.result.error : "", /NAVIGATION_STOPPED.*No path/);
  assert.equal("navigation" in output.result ? output.result.navigation.end.x : null, 4);
});

test("keeps caller cancellation as a runtime outcome", async () => {
  const { bot } = flatGroundBot();
  const controller = new AbortController();
  const run: NavigateDependencies["navigate"] = async () => {
    controller.abort("stop navigation");
    throw new Error("stop navigation");
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 10, y: 64, z: 0 },
    controller.signal,
  );

  assert.equal(output.result.status, "cancelled");
});

test("an unexpected dimension change on an ordinary route still fails without a cross-world distance", async () => {
  const { bot } = flatGroundBot();
  const run: NavigateDependencies["navigate"] = async () => {
    bot.game.dimension = "the_end";
    bot.entity.position.set(100.5, 49, 0.5);
    return { status: "stopped", reason: "dimension changed to the_end", elapsedMs: 20 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 10, y: 64, z: 0 },
  );
  assert.equal(output.result.status, "failed");
  assert.ok("navigation" in output.result);
  assert.equal(output.result.navigation.remainingDistance, null);
  assert.match(output.result.error, /NAVIGATION_DIMENSION_CHANGED/);
  assert.match(formatNavigateResult(output.result), /distance to the source-world target does not apply/);
});

test("formats the observed route rather than only its status", () => {
  const markdown = formatNavigateResult({
    status: "succeeded",
    navigation: {
      startDimension: "overworld",
      endDimension: "overworld",
      target: { x: 10, y: 64, z: 0 },
      range: 1,
      start: { x: 0.5, y: 64, z: 0.5 },
      end: { x: 9.5, y: 64, z: 0.5 },
      remainingDistance: Math.sqrt(0.5),
      elapsedMs: 31_000,
      missingDigTools: ["shovel"],
      bucketDrops: { count: 0, waterRecovered: 0 },
      scaffolding: [
        { item: "dirt", inventoryBefore: 4, inventoryAfter: 4, consumed: 0 },
        { item: "cobblestone", inventoryBefore: 11, inventoryAfter: 0, consumed: 11 },
      ],
    },
  });

  assert.match(markdown, /0\.71 blocks/);
  assert.match(markdown, /31000 ms/);
  assert.match(markdown, /cobblestone: 11 → 0 \(used 11\)/);
  assert.match(markdown, /\*\*Warning:\*\* Missing shovel\. Navigation may be slow and inefficient\./);
});

test("omitting y resolves the surface height and measures arrival in three dimensions", async () => {
  const { bot } = flatGroundBot(71);
  let goalName = "";
  const run: NavigateDependencies["navigate"] = async (options): Promise<NavigationResult> => {
    goalName =
      options.goal.resolve(undefined as never).kind === "active"
        ? (options.goal.resolve(undefined as never) as { revision: string }).revision
        : "invalid";
    bot.entity.position.set(10.5, 71, 0.5);
    return { status: "completed", elapsedMs: 5 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 10, z: 0 },
  );

  assert.match(goalName, /^near:/);
  assert.equal(output.result.status, "succeeded");
  if (!("navigation" in output.result)) throw new Error("expected navigation evidence");
  assert.equal(output.result.navigation.target.y, 71);
  assert.equal(output.result.navigation.remainingDistance, 0);
});

test("dig=false and scaffold=false reach the movement policy", async () => {
  const { bot } = flatGroundBot();
  const movementOptions: unknown[] = [];
  const run: NavigateDependencies["navigate"] = async (): Promise<NavigationResult> => {
    bot.entity.position.set(10.5, 64, 0.5);
    return { status: "completed", elapsedMs: 5 };
  };
  await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run, movementOptions)),
    { x: 10, y: 64, z: 0, scaffold: false, dig: false },
  );

  assert.deepEqual(movementOptions, [{ scaffolding: false, allowDigging: false }]);
});

test("refuses a mid-air target instead of building up to it, and names the ground", async () => {
  const { bot } = flatGroundBot();
  let navigated = false;
  const run: NavigateDependencies["navigate"] = async (): Promise<NavigationResult> => {
    navigated = true;
    return { status: "completed", elapsedMs: 5 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 120, y: 99, z: -36, range: 2 },
  );

  assert.equal(navigated, false);
  assert.equal(output.result.status, "failed");
  assert.match(output.result.error ?? "", /NAVIGATION_TARGET_UNSUPPORTED/);
  assert.match(output.result.error ?? "", /ground in that column is at y=64/);
  assert.match(output.result.error ?? "", /the standable cell there is 120, 64, -36/);
  assert.match(output.result.error ?? "", /Choose an observed supported height/);
  assert.match(output.result.error ?? "", /build: true/);
});

test("a nearby unsupported explicit height is refused without substituting the ground in its receipt", async () => {
  const { bot } = flatGroundBot(62);
  bot.entity.position.set(29.5, 62, -46.5);
  let navigated = false;
  const output = await new ActionRunner().run(
    createNavigateAction(
      bot,
      fakeNavigation,
      dependencies(async () => {
        navigated = true;
        return { status: "completed", elapsedMs: 5 };
      }),
    ),
    { x: 29, y: 63, z: -47, range: 0, dig: true, scaffold: true },
  );
  assert.equal(navigated, false);
  assert.equal(output.result.status, "failed");
  assert.match(output.result.error ?? "", /NAVIGATION_TARGET_UNSUPPORTED/);
  assert.match(output.result.error ?? "", /ground in that column is at y=62/);
  if (!("navigation" in output.result)) throw new Error("expected navigation evidence");
  assert.deepEqual(output.result.navigation.target, { x: 29, y: 63, z: -47 });
  assert.equal(output.result.navigation.remainingDistance, 1);
  assert.match(formatNavigateResult(output.result), /Target: `29, 63, -47`/);
});

test("build: true accepts a mid-air target on purpose and routes to it", async () => {
  const { bot } = flatGroundBot();
  let navigated = false;
  const run: NavigateDependencies["navigate"] = async (): Promise<NavigationResult> => {
    navigated = true;
    bot.entity.position.set(120.5, 99, -35.5);
    return { status: "completed", elapsedMs: 5 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 120, y: 99, z: -36, range: 2, build: true },
  );

  assert.equal(navigated, true);
  assert.equal(output.result.status, "succeeded");
});

test("a supported target inside solid terrain is left to excavation policy", async () => {
  const { bot } = flatGroundBot();
  let navigated = false;
  const run: NavigateDependencies["navigate"] = async () => {
    navigated = true;
    bot.entity.position.set(0.5, 60, 0.5);
    return { status: "completed", elapsedMs: 5 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 0, y: 60, z: 0, range: 0 },
  );
  assert.equal(navigated, true);
  assert.equal(output.result.status, "succeeded");
});

test("a target on a ledge within range is a place the bot can be", async () => {
  const { bot } = flatGroundBot(64, { cells: { "120,96,-36": "dirt" } });
  const run: NavigateDependencies["navigate"] = async (): Promise<NavigationResult> => {
    bot.entity.position.set(120.5, 97, -35.5);
    return { status: "completed", elapsedMs: 5 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 120, y: 98, z: -36, range: 2 },
  );

  assert.equal(output.result.status, "succeeded");
});

test("a route stopped at the shore of deep open water, with no boat carried, says the way crosses it", async () => {
  // Sea from x 10 to 40 (water y 50 to 63, its surface at 63); stone up to 63 elsewhere.
  const { bot } = flatGroundBot(64, { cells: seaCells(10, 40) });
  const action = createNavigateAction(
    bot,
    fakeNavigation,
    dependencies(async () => {
      bot.entity.position.set(9.5, 64, 0.5);
      return { status: "stopped", reason: "no path found", elapsedMs: 5 };
    }),
  );
  const output = await new ActionRunner().run(action, { x: 60, y: 64, z: 0 });
  assert.equal(output.result.status, "failed");
  assert.match(
    "error" in output.result ? String(output.result.error) : "",
    /^\[NAVIGATION_DEEP_WATER\] The way to 60, 0 crosses deep open water from about 10, 0 \(31\+ blocks of it seen\); no boat is carried/u,
  );
});

test("a route with no path is planned once more with the common block the bot carries when the policy list holds none", async () => {
  const { bot, useUntil } = flatGroundBot(64, { carried: { stone: 80 } });
  const movementOptions: unknown[] = [];
  let attempts = 0;
  const action = createNavigateAction(bot, fakeNavigation, dependencies(async () => {
    attempts++;
    if (attempts === 1) return { status: "stopped", reason: "no path found", elapsedMs: 1, calculationFailed: true };
    bot.entity.position.set(5.5, 64, 0.5);
    useUntil("stone", 74);
    return { status: "completed", elapsedMs: 1 };
  }, movementOptions));
  const output = await new ActionRunner().run(action, { x: 5, y: 64, z: 0, range: 1 });
  assert.equal(output.result.status, "succeeded");
  assert.deepEqual(movementOptions.map((options) => (options as { scaffoldFallback?: boolean }).scaffoldFallback), [undefined, true]);
  assert.match(formatNavigateResult(output.result as never), /stone: 80 → 74 \(used 6\)/);
});

test("a route with no path is not replanned with a fallback when the policy list already holds a scaffold block", async () => {
  const { bot } = flatGroundBot(64, { carried: { dirt: 4, stone: 80 } });
  const movementOptions: unknown[] = [];
  const action = createNavigateAction(bot, fakeNavigation, dependencies(async () => (
    { status: "stopped", reason: "no path found", elapsedMs: 1, calculationFailed: true }
  ), movementOptions));
  await new ActionRunner().run(action, { x: 5, y: 64, z: 0, range: 1 });
  assert.equal(movementOptions.length, 1);
});

/**
 * Water from y 50 to its surface at 63, from x `seaFrom` to `seaTo`, across the lane z -8 to 8 the routes here keep to.
 * The lane's side land (z ±9) lies just past the shore search (`SHORE_SEARCH_RADIUS` 8, `target-ground.ts`): widen it with that radius.
 */
function seaCells(seaFrom: number, seaTo: number, extra: Record<string, FakeCell> = {}): Record<string, FakeCell> {
  return { ...cellsIn([seaFrom, 50, -8], [seaTo, 63, 8], "water"), ...extra };
}

/** A wide sea (water y 50 to 63, surface 63) from x -30 to 9, land (stone up to 63) beyond it on both sides. */
function wideSeaBot(seaFrom = -30, seaTo = 9, scene: Scene = {}) {
  const harness = flatGroundBot(64, { ...scene, cells: seaCells(seaFrom, seaTo, scene.cells) });
  harness.bot.entity.position.set(0.5, 63, 0.5);
  return harness;
}

test("at sea with no boat the bot swims to the nearest land first, then the deep-water guard refuses the crossing", async () => {
  const { bot } = wideSeaBot();
  const goals: Array<{ x: number; z: number }> = [];
  let calls = 0;
  const action = createNavigateAction(bot, fakeNavigation, dependencies(async ({ goal }) => {
    calls++;
    goals.push(goal as unknown as { x: number; z: number });
    if (calls === 1) {
      bot.entity.position.set(10.5, 64, 0.5);
      return { status: "completed", elapsedMs: 5 };
    }
    return { status: "stopped", reason: "no path found", elapsedMs: 5 };
  }));
  const output = await new ActionRunner().run(action, { x: -60, y: 64, z: 0 });
  assert.equal(calls, 2);
  assert.equal(output.result.status, "failed");
  const error = "error" in output.result ? String(output.result.error) : "";
  assert.match(error, /\[NAVIGATION_DEEP_WATER\]/u);
  assert.match(error, /swam to land at 10, 64, 0 first/u);
});

/** A kelp column in the sea at x, z, from the floor to the surface (run 16, Yuki: kelp beside her at sea). */
function kelpColumn(x: number, z: number): Record<string, FakeCell> {
  return { ...cellsIn([x, 50, z], [x, 62, z], "kelp_plant"), [`${x},63,${z}`]: "kelp" };
}

test("a kelp column beside a bot at sea is not land: the swim goes to the real shore", async () => {
  const { bot } = wideSeaBot(-30, 9, { cells: kelpColumn(1, 0) });
  let calls = 0;
  const action = createNavigateAction(bot, fakeNavigation, dependencies(async () => {
    calls++;
    if (calls === 1) {
      bot.entity.position.set(10.5, 64, 0.5);
      return { status: "completed", elapsedMs: 5 };
    }
    return { status: "stopped", reason: "no path found", elapsedMs: 5 };
  }));
  const output = await new ActionRunner().run(action, { x: -60, y: 64, z: 0 });
  assert.match("error" in output.result ? String(output.result.error) : "", /swam to land at 10, 64, 0 first/u);
});

test("a target column topped by kelp resolves to the shore, not to the sea floor under the kelp", async () => {
  const { bot } = wideSeaBot(-30, 9, { cells: kelpColumn(3, 0) });
  bot.entity.position.set(20.5, 64, 0.5);
  let revision = "";
  const action = createNavigateAction(bot, fakeNavigation, dependencies(async (options) => {
    const resolved = options.goal.resolve(undefined as never);
    revision = resolved.kind === "active" ? resolved.revision : resolved.observation;
    return { status: "completed", elapsedMs: 5 };
  }));
  await new ActionRunner().run(action, { x: 3, z: 0 });
  assert.match(revision, /^near:10,64,0/u);
});

test("a target on the top of a kelp column is admitted water, not a mid-air target", async () => {
  const { bot } = wideSeaBot(-30, 9, { cells: kelpColumn(3, 0) });
  bot.entity.position.set(20.5, 64, 0.5);
  let routes = 0;
  const action = createNavigateAction(bot, fakeNavigation, dependencies(async () => {
    routes++;
    return { status: "completed", elapsedMs: 5 };
  }));
  const output = await new ActionRunner().run(action, { x: 3, y: 63, z: 0, range: 0 });
  assert.doesNotMatch("error" in output.result ? String(output.result.error) : "", /NAVIGATION_TARGET_UNSUPPORTED/u);
  assert.equal(routes, 1);
});

test("from a seagrass shallow, the next navigate goes straight to dry land: no swim to land first", async () => {
  const { bot } = flatGroundBot(64, { cells: { "0,64,0": "seagrass" } });
  let routes = 0;
  const action = createNavigateAction(bot, fakeNavigation, dependencies(async () => {
    routes++;
    bot.entity.position.set(10.5, 64, 0.5);
    return { status: "completed", elapsedMs: 5 };
  }));
  const output = await new ActionRunner().run(action, { x: 10, y: 64, z: 0 });
  assert.equal(output.result.status, "succeeded");
  assert.equal(routes, 1);
});

test("from a sandbar one deep in the sea, with no boat, the bot swims to the nearest land first (reef start, owner 2026-10-19)", async () => {
  const { bot } = wideSeaBot(-30, 9, { cells: cellsIn([0, 50, 0], [0, 62, 0], "stone") });
  let calls = 0;
  const action = createNavigateAction(bot, fakeNavigation, dependencies(async () => {
    calls++;
    if (calls === 1) {
      bot.entity.position.set(10.5, 64, 0.5);
      return { status: "completed", elapsedMs: 5 };
    }
    return { status: "stopped", reason: "no path found", elapsedMs: 5 };
  }));
  const output = await new ActionRunner().run(action, { x: -60, y: 64, z: 0 });
  assert.equal(calls, 2);
  assert.match("error" in output.result ? String(output.result.error) : "", /swam to land at 10, 64, 0 first/u);
});

test("at sea with no land found by the land search the asked route runs next, with no swim budget (the leg is a search, W7)", async () => {
  const { bot } = wideSeaBot(-200, 200);
  let calls = 0;
  const action = createNavigateAction(bot, fakeNavigation, dependencies(async () => {
    calls++;
    return { status: "stopped", reason: "no path found", calculationFailed: true, elapsedMs: 5 };
  }));
  const output = await new ActionRunner().run(action, { x: -300, y: 64, z: 0 });
  assert.equal(calls, 2, "the land search, then the asked route");
  assert.equal(output.result.status, "failed");
  assert.doesNotMatch("error" in output.result ? String(output.result.error) : "", /swam to land|swim to land first/u);
});

test("a land leg that fails on the way still tries the asked route, and the failure names both (backlog 50)", async () => {
  const { bot } = wideSeaBot();
  const revisions: string[] = [];
  const action = createNavigateAction(bot, fakeNavigation, dependencies(async ({ goal }) => {
    const resolved = goal.resolve(undefined as never);
    revisions.push(resolved.kind === "active" ? resolved.revision : "invalid");
    return revisions.length === 1
      ? { status: "stopped", reason: "the swim stalled at 3, 63, 0", routeFailed: true, elapsedMs: 5 }
      : { status: "stopped", reason: "no path found", elapsedMs: 5 };
  }));
  const output = await new ActionRunner().run(action, { x: -60, y: 64, z: 0 });
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0], "dry-land");
  assert.match("error" in output.result ? String(output.result.error) : "", /the swim to land first stopped: the swim stalled at 3, 63, 0/u);
});

test("after a failed land leg, the next navigate from the sea searches for land again", async () => {
  const { bot } = wideSeaBot();
  const revisions: string[] = [];
  const action = createNavigateAction(bot, fakeNavigation, dependencies(async ({ goal }) => {
    const resolved = goal.resolve(undefined as never);
    revisions.push(resolved.kind === "active" ? resolved.revision : "invalid");
    return { status: "stopped", reason: "the swim stalled", routeFailed: true, elapsedMs: 5 };
  }));
  await new ActionRunner().run(action, { x: -60, y: 64, z: 0 });
  await new ActionRunner().run(action, { x: -60, y: 64, z: 0 });
  assert.deepEqual(revisions.filter((revision) => revision === "dry-land").length, 2);
});

test("a cancel while a stopped route is judged ends the navigate with the cancel, not a stopped result (ACT-09)", async () => {
  const { bot } = flatGroundBot(64);
  const controller = new AbortController();
  const deps = dependencies(async () => {
    controller.abort(new Error("cancelled by the runner"));
    return { status: "stopped", reason: "cancelled", elapsedMs: 0 };
  });
  await assert.rejects(
    navigate(bot, parseNavigateRequest({ x: 10, y: 64, z: 0, dig: true }), { signal: controller.signal } as never, deps),
    /cancelled by the runner/,
  );
});

test("at sea with a boat carried the route is unchanged: no land leg", async () => {
  // The boat is put down, ridden and taken back on the shared fake's server (the crossing waits on the wall clock: a mocked one).
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { bot } = wideSeaBot(-30, 9, { carried: { oak_boat: 1 }, clock });
  const startedAtX: number[] = [];
  const action = createNavigateAction(bot, fakeNavigation, dependencies(async () => {
    startedAtX.push(bot.entity.position.x);
    return { status: "stopped", reason: "no path found", elapsedMs: 5 };
  }));
  await clock.settle(new ActionRunner().run(action, { x: -60, y: 64, z: 0 }), 120_000);
  assert.equal(startedAtX[0], 0.5, "the first leg starts where she is: no swim to land first");
  assert.ok(startedAtX.length > 1 && startedAtX.at(-1)! < -28, "the boat took her over the sea, and the planner went on from the far bank");
});

test("a bot on land is not sent to land first", async () => {
  const { bot } = wideSeaBot();
  bot.entity.position.set(20.5, 64, 0.5);
  let calls = 0;
  const action = createNavigateAction(bot, fakeNavigation, dependencies(async () => {
    calls++;
    return { status: "stopped", reason: "no path found", elapsedMs: 5 };
  }));
  await new ActionRunner().run(action, { x: -60, y: 64, z: 0 });
  assert.equal(calls, 1);
});

/** A sea from x 0 to `seaTo` (water y 50 to 63), land either side; the bot on the west shore. */
function swimBot(seaTo = 60, scene: Scene = {}) {
  const { bot } = wideSeaBot(0, seaTo, scene);
  bot.entity.position.set(-5.5, 64, 0.5);
  return bot;
}

/** A walk that swims east `blocks` blocks from the bot's place, one block per move, until told to stop. */
function swimming(bot: Bot, blocks: number, seaTo = 60) {
  const walk = { stoppedAt: null as number | null };
  const navigate: NavigateDependencies["navigate"] = async ({ stopSignal }) => {
    for (let moved = 0; moved < blocks; moved++) {
      const x = bot.entity.position.x + 1;
      bot.entity.position.set(x, x > seaTo + 1 ? 64 : 63, 0.5);
      bot.emit("move", bot.entity.position);
      if (stopSignal?.aborted) {
        walk.stoppedAt = x;
        return { status: "stopped", reason: String(stopSignal.reason), elapsedMs: 5 };
      }
    }
    return { status: "completed", elapsedMs: 5 };
  };
  return { navigate, walk };
}

test("a route swimming more than the swim budget through deep open water with no boat stops with the deep-water outcome", async () => {
  const bot = swimBot();
  const { navigate, walk } = swimming(bot, 40);
  const output = await new ActionRunner().run(createNavigateAction(bot, fakeNavigation, dependencies(navigate)), { x: 80, y: 64, z: 0 });
  assert.equal(output.result.status, "failed");
  const error = "error" in output.result ? String(output.result.error) : "";
  assert.match(error, /^\[NAVIGATION_DEEP_WATER\] The way to 80, 0 crosses deep open water from about \d+, 0 \(33\+ blocks of it seen\)/u);
  assert.ok(walk.stoppedAt !== null && walk.stoppedAt < 36, `stopped at ${walk.stoppedAt}`);
});

test("a swim of 20 blocks through deep water is within the budget", async () => {
  const bot = swimBot(19);
  const { navigate, walk } = swimming(bot, 26, 19);
  const output = await new ActionRunner().run(createNavigateAction(bot, fakeNavigation, dependencies(navigate)), { x: 20, y: 64, z: 0 });
  assert.equal(output.result.status, "succeeded", "error" in output.result ? String(output.result.error) : "");
  assert.equal(walk.stoppedAt, null);
});

test("the swim budget does not apply with a boat carried", async () => {
  const bot = swimBot(60, { carried: { oak_boat: 1 } });
  const { navigate, walk } = swimming(bot, 40);
  await new ActionRunner().run(createNavigateAction(bot, fakeNavigation, dependencies(navigate)), { x: 80, y: 64, z: 0 });
  assert.equal(walk.stoppedAt, null);
});

test("the swim to land and a swim with no land in reach are not stopped by the budget", async () => {
  // Land leg: land 40 blocks east; the leg's search swims there with no budget, and the asked route goes on from land.
  const near = wideSeaBot(-39, 39);
  near.bot.entity.position.set(0.5, 63, 0.5);
  const leg = swimming(near.bot, 40, 39);
  await new ActionRunner().run(createNavigateAction(near.bot, fakeNavigation, dependencies(leg.navigate)), { x: 80, y: 64, z: 0 });
  assert.equal(leg.walk.stoppedAt, null);
  // The open sea: the land search finds none, and the asked route swims free, as today.
  const open = wideSeaBot(-200, 200);
  const sea = swimming(open.bot, 40);
  let searched = false;
  const noLandThenSwim: NavigateDependencies["navigate"] = async (options) => {
    if (searched) return sea.navigate(options);
    searched = true;
    return { status: "stopped", reason: "no path found", calculationFailed: true, elapsedMs: 5 };
  };
  await new ActionRunner().run(createNavigateAction(open.bot, fakeNavigation, dependencies(noLandThenSwim)), { x: 210, y: 64, z: 0 });
  assert.equal(sea.walk.stoppedAt, null);
});

test("the legs of one navigate share one tool-loss observer, whose listeners go with the call (C14)", () => {
  const { bot } = flatGroundBot(64, { carried: {} });
  const lifetime = new AbortController();
  const listeners = () => bot.listenerCount("heldItemChanged");
  const first = toolLossObserverOf(bot, lifetime.signal);
  assert.equal(toolLossObserverOf(bot, lifetime.signal), first);
  assert.equal(toolLossObserverOf(bot, lifetime.signal), first);
  assert.equal(listeners(), 1, "three legs, one observer");
  lifetime.abort();
  assert.equal(listeners(), 0);
  assert.notEqual(toolLossObserverOf(bot, new AbortController().signal), first, "another call has its own");
});

/** A settled route out of a pocket whose evidence names the rules it used. */
function escapedResult(escapeRelaxed: readonly string[] | undefined): Parameters<typeof formatNavigateResult>[0] {
  return {
    status: "succeeded", navigation: {
      startDimension: "overworld", endDimension: "overworld", target: { x: 0, y: 55, z: 0 }, range: 1,
      start: { x: 0, y: 57, z: 0 }, end: { x: 0, y: 55, z: 0 }, remainingDistance: 0, elapsedMs: 10, scaffolding: [],
      bucketDrops: { count: 0, waterRecovered: 0 }, missingDigTools: [], escapeRelaxed,
    },
  } as unknown as Parameters<typeof formatNavigateResult>[0];
}

test("a route that dug down and beside flowing water to leave a pocket says both in its result text", () => {
  const text = formatNavigateResult(escapedResult(["dig_straight_down", "dig_next_to_flowing_water"]));
  assert.match(text, /Dug down out of a pocket: your rule against digging straight down was set aside once and a dig next to flowing water was allowed/);
  assert.doesNotMatch(formatNavigateResult(escapedResult(undefined)), /out of a pocket/);
});

test("a route that only dug down says nothing of flowing water", () => {
  const text = formatNavigateResult(escapedResult(["dig_straight_down"]));
  assert.match(text, /Dug down out of a pocket: your rule against digging straight down was set aside once\./);
  assert.doesNotMatch(text, /flowing water/);
});

test("a route that only dug beside flowing water does not claim to have dug down", () => {
  const text = formatNavigateResult(escapedResult(["dig_next_to_flowing_water"]));
  assert.match(text, /Dug out of a pocket beside flowing water: a dig that lets in flowing water was allowed once \(a water source and lava still refuse\)\./);
  assert.doesNotMatch(text, /Dug down|digging straight down/);
});
