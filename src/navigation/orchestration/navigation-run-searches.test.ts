// navigation run: what each search plans with after a movement failure, the step field snapshot and a caged bot.
import { exactBlockGoal, nearGoal } from "../goals/index.js";
import type { PlannedStep } from "../movements/movement.js";
import { createMovementPolicy } from "../movements/policy.js";
import { createNavigator } from "./navigator.js";
import assert from "node:assert/strict";
import test from "node:test";
import { FakeNavigationBot, flatWorld, observation, onEvent, settle } from "../../test-support/navigation.js";
import { type FakeBot, createFakeBot } from "../../test-support/fake-bot/index.js";
import { setProtectedRegionsProvider, type ProtectedRegion } from "../../world/protected-regions.js";
import { blockClass, observeMineflayerBlock } from "../mineflayer/world.js";
import { createMovements } from "../runtime.js";
import type { NavigationEvent } from "../telemetry/index.js";
import { MemoryWorld } from "../world/memory-world.js";
import { Vec3 } from "vec3";
import { walking, EARLY_COMMIT, OvershootingBot } from "./navigation-run-fixtures.test.js";

// ── Movement that does not go to plan ────────────────────────────────────────

const attempts = (outcome: { evidence: { movementAttempts: Readonly<Partial<Record<string, number>>> } }) =>
  Object.values(outcome.evidence.movementAttempts).reduce((total: number, count) => total + (count ?? 0), 0);

/** A region over a one-cell cage at the origin: dirt walls two high on all eight sides, over a stone floor. */
const CAGE: ProtectedRegion = { regionId: 1, dimension: "overworld", min: { x: -1, y: 62, z: -1 }, max: { x: 1, y: 66, z: 1 }, owner: "Theo", label: "house" };

function cagedBot(regions: readonly ProtectedRegion[]): FakeBot {
  const { bot } = createFakeBot({ username: "Theo", position: new Vec3(0.5, 63, 0.5), carried: { dirt: 16 } });
  setProtectedRegionsProvider(bot, () => regions);
  return bot;
}

function cageWorld(bot: FakeBot): MemoryWorld {
  const world = new MemoryWorld();
  const Block = blockClass(bot);
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) for (let y = 62; y <= 66; y++) {
    const name = y === 62 ? "stone" : Math.max(Math.abs(x), Math.abs(z)) === 1 && y <= 64 ? "dirt" : "air";
    const block = observeMineflayerBlock(Block.fromStateId(bot.registry.blocksByName[name]!.defaultState, 0));
    if (block.kind !== "loaded") throw new Error(name);
    world.load({ x, y, z }, { stateId: block.stateId, collisionShapes: block.collisionShapes, traits: block.traits });
  }
  return world;
}

/** One run out of the cage. The fake bot cannot dig, so a route that is found still fails to be walked. */
async function leaveCage(bot: FakeBot, policy = createMovements(bot)) {
  const events: NavigationEvent[] = [];
  const navigator = createNavigator({ world: cageWorld(bot), bot: new FakeNavigationBot(), telemetry: onEvent((event) => events.push(event)) });
  const outcome = await settle(navigator, { goal: exactBlockGoal({ x: 4, y: 63, z: 0 }), policy });
  const opened = events.findIndex((event) => event.kind === "own_regions_opened");
  return {
    outcome,
    openings: events.filter((event) => event.kind === "own_regions_opened").length,
    routeAfterOpening: events.slice(Math.max(0, opened)).some((event) => event.kind === "route_committed"),
  };
}

test("a movement failure that reaches a new checkpoint stabilizes through a replacement search", async () => {
  class RecoveringBot extends FakeNavigationBot {
    failedOnce = false;
    override async prepareMovement(step: PlannedStep) {
      this.arrive(step.to);
      if (!this.failedOnce) {
        this.failedOnce = true;
        return {
          kind: "failed",
          observation: "The first movement stopped at its planned cell without settling.",
        } as const;
      }
      return { kind: "completed", arrival: step.to } as const;
    }
  }
  const outcome = await settle(
    createNavigator({ world: flatWorld(), bot: new RecoveringBot(), createId: () => "recovering-run" }),
    {
      goal: exactBlockGoal({ x: 3, y: 63, z: 0 }),
      policy: walking(),
    },
  );
  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.evidence.searches, 2);
  assert.equal(outcome.evidence.replans, 1);
  assert.equal(attempts(outcome), 3);
});

test("an observed overshoot skips the movement-only edge it already completed", async () => {
  const outcome = await settle(
    createNavigator({ world: flatWorld(), bot: new OvershootingBot(), createId: () => "overshoot-run" }),
    {
      goal: exactBlockGoal({ x: 3, y: 63, z: 0 }),
      policy: walking(),
    },
  );
  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.evidence.searches, 1);
  assert.equal(outcome.evidence.replans, 0);
  assert.equal(attempts(outcome), 2);
});

test("a calculation that fails after a movement failure reports what it was replanning around", async () => {
  let sealed = false;
  const observation_ = "The route planned to break with iron_pickaxe, which is not in the inventory.";
  class ToollessBot extends FakeNavigationBot {
    override async prepareMovement(step: PlannedStep) {
      this.arrive(step.to);
      sealed = true;
      return { kind: "failed", observation: observation_ } as const;
    }
  }
  const outcome = await settle(
    createNavigator({ world: flatWorld(), bot: new ToollessBot(), createId: () => "replan-after-failure" }),
    {
      goal: exactBlockGoal({ x: 3, y: 63, z: 0 }),
      // Once the tool is gone, no step is affordable: the replan has nowhere to go.
      policy: createMovementPolicy({
        allowSprinting: false,
        decideStep: () =>
          sealed ? { kind: "prohibited", reason: "sealed in after the failure" } : { kind: "allowed" },
      }),
    },
  );
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.failure.kind, "no_path");
  if (outcome.failure.kind !== "no_path") return;
  assert.equal(outcome.failure.after?.observation, observation_);
});

test("each search plans with the scaffold the policy offers when that search starts", async () => {
  const world = flatWorld();
  // A four-block chasm across the whole world: no jump, drop, dig, or detour crosses it, only a bridge.
  for (const x of [1, 2, 3, 4])
    for (let z = -5; z <= 5; z += 1) for (const y of [59, 60, 61, 62]) world.load({ x, y, z }, { stateId: 0 });
  const bot = new FakeNavigationBot();
  bot.current = { ...observation(), inventory: new Map([[2, 4]]) };
  // The production policy reads its scaffold from the live inventory; the run
  // must read it when a search starts, not when the policy was made.
  let offered: { itemType: number; stateId: number } | null = null;
  const policy = Object.freeze({
    ...createMovementPolicy({ allowSprinting: false, allowParkour: false }),
    get scaffold() {
      return offered;
    },
  });
  const plans: (readonly PlannedStep[])[] = [];
  const navigator = createNavigator({
    world,
    bot,
    createId: () => "live-scaffold",
    telemetry: onEvent((event) => {
      if (event.kind === "route_committed") plans.push(event.plan.steps);
    }),
  });
  offered = { itemType: 2, stateId: 1 };
  await settle(navigator, { goal: exactBlockGoal({ x: 5, y: 63, z: 0 }), policy });
  const placements =
    plans[0]?.flatMap((step) => step.operations.filter((operation) => operation.kind === "place")) ?? [];
  assert.equal(placements.length, 4);
  for (const operation of placements) if (operation.kind === "place") assert.equal(operation.placement.itemType, 2);
});

test("a run pushed back to where it began reports no progress after three routes", async () => {
  let executed = 0;
  // Every route walks to its cell and completes, and something moves the bot
  // back before the next observation, as water flow did beside a drop. The
  // inventory changes each time, so this is not the same search twice.
  class PushedBackBot extends FakeNavigationBot {
    override async prepareMovement(step: PlannedStep) {
      executed += 1;
      this.arrive({ x: 0, y: 63, z: 0 }, { ...observation(0, 63, 0), resourceRevision: `pushed:${executed}` });
      return { kind: "completed", arrival: { x: 0, y: 63, z: 0 } } as const;
    }
  }
  const outcome = await settle(
    createNavigator({ world: flatWorld(), bot: new PushedBackBot(), createId: () => "pushed-back" }),
    {
      goal: exactBlockGoal({ x: 1, y: 63, z: 0 }),
      policy: walking(),
    },
  );
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.failure.kind, "no_progress");
  if (outcome.failure.kind !== "no_progress") return;
  assert.equal(outcome.failure.reason, "repeated_execution_checkpoint");
  assert.match(outcome.failure.observation, /3 executed routes in a row/);
  assert.equal(executed, 3);
});

test("a timed-out calculation carries its actual search statistics to the caller", async () => {
  const result = await settle(createNavigator({ world: flatWorld(), bot: new FakeNavigationBot() }), {
    goal: exactBlockGoal({ x: 100, y: 63, z: 0 }),
    policy: createMovementPolicy(),
    searchLimits: { failureTimeoutMs: 0 },
  });
  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.equal(result.failure.kind, "search_limit");
  if (result.failure.kind !== "search_limit") return;
  assert.equal(result.failure.search.visited, 1);
  assert.equal(result.failure.search.generated, 1);
  assert.equal(result.failure.search.slices, 1);
  assert.ok(result.failure.search.computeMs >= 0);
});

// ── The registered step field ────────────────────────────────────────────────

test("each search freezes one step field snapshot, and a request may opt out of the field altogether", async () => {
  // Every search's reads land in the bucket opened when it started, so a
  // snapshot leaking from one search into another shows up as two fingerprints
  // in one bucket.
  const buckets: Array<Set<string>> = [];
  let snapshots = 0;
  const navigator = createNavigator({
    world: flatWorld(),
    bot: new FakeNavigationBot(),
    createId: () => "field-freeze",
    telemetry: onEvent((event) => {
      if (event.kind === "search_started") buckets.push(new Set());
    }),
  });
  navigator.setStepFieldProvider(() => {
    snapshots += 1;
    const fingerprint = `snapshot-${snapshots}`;
    return {
      costAt: () => {
        buckets.at(-1)?.add(fingerprint);
        return 0;
      },
      fingerprint,
    };
  });
  const outcome = await settle(navigator, {
    goal: nearGoal({ x: 5, y: 63, z: 0 }, 0),
    policy: walking(),
    searchLimits: EARLY_COMMIT,
  });
  assert.equal(outcome.kind, "completed");
  if (outcome.kind !== "completed") return;
  assert.ok(outcome.evidence.searches > 1, `expected several searches, saw ${outcome.evidence.searches}`);
  // Asked once per search: not once per run, which two live searches would
  // share, and not once per cell, which would let a mob move mid-search.
  assert.equal(snapshots, outcome.evidence.searches);
  for (const [index, used] of buckets.entries()) {
    assert.ok(used.size <= 1, `search ${index} read ${used.size} snapshots: ${[...used].join(", ")}`);
  }

  // What combat's approach, cover, and evade routes say. They walk toward the
  // thing the field prices, so the provider is never consulted for them.
  const asked = snapshots;
  await settle(navigator, { goal: nearGoal({ x: 3, y: 63, z: 0 }, 0), policy: walking(), stepField: null });
  assert.equal(snapshots, asked);
});

test("the step field's fingerprint is part of a search's identity", async () => {
  const navigator = createNavigator({
    world: flatWorld(),
    bot: new FakeNavigationBot(),
    createId: () => "field-identity",
  });
  navigator.setStepFieldProvider(() => ({ costAt: () => 0, fingerprint: "zombie@2,63,0" }));
  const outcome = await settle(navigator, {
    // A cell outside the loaded world, so the search reports no path, and a
    // process that asks to carry on regardless: the run then plans the very
    // same question a second time, which is the repeat the identity catches.
    goal: exactBlockGoal({ x: 20, y: 63, z: 0 }),
    policy: walking(),
    onCalculationFailure: () => ({ kind: "continue" }),
  });

  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.failure.kind, "no_progress");
  if (outcome.failure.kind !== "no_progress") return;
  assert.equal(outcome.failure.reason, "repeated_search");
  // A field that has moved is a different question, not the run going in
  // circles, so the fingerprint has to be in the identity that says so.
  assert.match(outcome.failure.observation, /\|field:zombie@2,63,0$/);
});

// ── The bot is not where the search thought ──────────────────────────────────

for (const displacement of ["airborne", "different_cell", "within_cell"] as const) {
  test(`stationary search revalidates its start after ${displacement} motion`, async () => {
    const bot = new FakeNavigationBot();
    let searches = 0;
    let stabilized = 0;
    const starts: number[] = [];
    bot.stabilize = async () => {
      stabilized++;
      bot.current = observation();
      return { kind: "stable" };
    };
    const navigator = createNavigator({
      world: flatWorld(),
      bot,
      telemetry: onEvent((event) => {
        if (event.kind === "search_started" && ++searches === 1) {
          bot.current =
            displacement === "airborne"
              ? { ...observation(), stance: "airborne" }
              : displacement === "different_cell"
                ? observation(1)
                : { ...observation(), position: { x: 0.8, y: 63, z: 0.5 } };
        }
        if (event.kind === "route_committed") {
          assert.notEqual(bot.current.stance, "airborne");
          assert.equal(event.plan.start.x, Math.floor(bot.current.position.x));
          starts.push(event.plan.start.x);
        }
      }),
    });
    const outcome = await settle(navigator, {
      goal: nearGoal({ x: 4, y: 63, z: 0 }, 0),
      policy: createMovementPolicy(),
    });
    assert.equal(outcome.kind, "completed");
    assert.equal(stabilized, displacement === "airborne" ? 1 : 0);
    assert.equal(searches, displacement === "within_cell" ? 1 : 2);
    assert.deepEqual(starts, [displacement === "different_cell" ? 1 : 0]);
  });
}

for (const displacement of ["airborne", "different_cell"] as const) {
  test(`a continuation rechecks ${displacement} after waiting for its search`, async () => {
    const bot = new FakeNavigationBot();
    bot.current = observation(-5);
    bot.stabilize = async () => {
      bot.current = { ...bot.current, stance: "supported" };
      return { kind: "stable" };
    };
    let continuation: string | null = null;
    let displaced = false;
    const navigator = createNavigator({
      world: flatWorld(),
      bot,
      telemetry: onEvent((event) => {
        if (event.kind === "search_started" && event.reason === "segment_continuation" && !continuation)
          continuation = event.searchId;
        if (event.kind === "search_slice" && event.searchId === continuation && !displaced) {
          displaced = true;
          bot.current =
            displacement === "airborne"
              ? { ...bot.current, stance: "airborne" }
              : observation(Math.floor(bot.current.position.x) + 1);
        }
        if (event.kind === "route_committed") {
          assert.notEqual(bot.current.stance, "airborne");
          assert.equal(
            event.plan.start.x,
            Math.floor(bot.current.position.x),
            "committed start must still match after waiting",
          );
        }
      }),
    });
    const outcome = await settle(navigator, {
      goal: nearGoal({ x: 5, y: 63, z: 0 }, 0),
      policy: walking(),
      searchLimits: EARLY_COMMIT,
    });
    assert.equal(outcome.kind, "completed");
    assert.equal(displaced, true);
  });
}

test("a bot shut in inside its own protected region opens its own regions once, and a route follows", async () => {
  const run = await leaveCage(cagedBot([CAGE]));
  assert.equal(run.openings, 1);
  assert.ok(run.routeAfterOpening);
});

test("a region another player owns is never opened: the run fails without a route", async () => {
  const run = await leaveCage(cagedBot([{ ...CAGE, owner: "Tester" }]));
  assert.equal(run.openings, 0);
  assert.equal(run.routeAfterOpening, false);
  assert.equal(run.outcome.kind, "failed");
});

test("a bot whose own regions lie elsewhere digs out without opening them", async () => {
  const run = await leaveCage(cagedBot([{ ...CAGE, min: { x: 20, y: 62, z: 20 }, max: { x: 22, y: 66, z: 22 } }]));
  assert.equal(run.openings, 0);
  assert.ok(run.routeAfterOpening);
});

test("the opening lasts one run: the same policy refuses its own region again, and a second run opens it again", async () => {
  const bot = cagedBot([CAGE]);
  const policy = createMovements(bot);
  const world = cageWorld(bot);
  const wall = { x: 1, y: 63, z: 0 };
  const refuses = () => policy.evaluateBreak(world.blockAt(wall.x, wall.y, wall.z), wall, world).decision.kind === "prohibited";
  assert.ok(refuses(), "refused before");
  assert.equal((await leaveCage(bot, policy)).openings, 1);
  assert.ok(refuses(), "refused again after the run");
  assert.equal((await leaveCage(bot, policy)).openings, 1, "opened again by the second run");
});
