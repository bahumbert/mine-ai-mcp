// Route and build regressions replaying the retained first-entry-64510673 tower.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createMovements, createNavigationRuntime, exactBlockGoal, liveBlockReader, packKey,
  type BlockPosition, type Goal, type MovementPolicy, type NavigationRuntime } from "../../../navigation/index.js";
import { createMovementCatalogue } from "../../../navigation/movements/catalogue.js";
import { BuildTargeting, type BuildRequest, type CellKeys } from "../../../navigation/processes/building/build-process.js";
import { IncrementalSearch } from "../../../navigation/search/search.js";
import { closeShelter, FIRST_ASCENT, fixtureCell, MISSING_TREADS } from "../../../test-support/crystal-shelter-scene.js";
import { createFakeBot, createFakeClock } from "../../../test-support/fake-bot/index.js";
import { confirmFakeDigs } from "../../../test-support/life-saving-placements.js";
import { observation, planningStart, WELL_FED } from "../../../test-support/navigation.js";
import { cloudExposure, readDragonCloudHazards } from "../../../world/dragon-hazards.js";
import { DEFAULT_SURVIVAL_POLICY } from "../../policy/contract.js";
import { enclosedInPlace, shelterFeet } from "../../responses/shelter-cells.js";
import * as staircase from "./crystal-staircase.js";
import fixture from "./first-entry-64510673-tower.fixture.json" with { type: "json" };

type Scene = ReturnType<typeof towerScene>;
type SavedTower = { readonly position: BlockPosition; readonly crystal: BlockPosition; readonly cells: Readonly<Record<string, string>> };

// The two qualified cut searches each exhaust their frontier in 264 visits.
const CAP = 2 * 264;

/** A fresh bot standing on the saved staircase, with the recorded blocks and the right supplies. */
function towerScene(saved: SavedTower = fixture, ticksPerSecond = 20) {
  const scene = createFakeBot({
    cells: Object.fromEntries(Object.entries(saved.cells).map(([key, state]) => [key, fixtureCell(state)])),
    position: new Vec3(saved.position.x, saved.position.y, saved.position.z),
    dimension: "the_end", groundY: null, carried: { end_stone: 64, stone_pickaxe: 1 },
    simulatePhysics: true, clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond },
  });
  const plan = staircase.planCrystalStaircase(scene.bot, new Vec3(saved.crystal.x, saved.crystal.y, saved.crystal.z));
  return { ...scene, plan };
}

/** Pause the saved build goal after giving up its named lower targets, as in the qualification probe. */
function startWorkSearch(scene: Scene, policy: (protectedCells: CellKeys) => MovementPolicy, refused = 0,
  { goalOverride, feet = fixture.feet, digsInSight = false }: { goalOverride?: Goal; feet?: BlockPosition; digsInSight?: boolean } = {}) {
  const { bot, plan } = scene;
  // `digsInSight`: a diggable target is workable from any stand; the search measured here is the route, and the line of
  // sight of a real dig (`canSeeClearance`) is exercised by the build cases below.
  const targeting = new BuildTargeting(bot, { cells: plan.cells, removeWrongBlocks: true,
    ...(digsInSight && { canSeeDig: () => true }) } as Partial<BuildRequest> as BuildRequest);
  for (const target of targeting.targets().slice(0, refused)) targeting.refuse(target, "lower work refused", "route");
  const { x, y, z } = feet;
  const observedStart = { ...observation(x, y, z), position: bot.entity.position.clone() };
  const goal = (goalOverride ?? targeting.goal()).resolve(observedStart);
  assert.equal(goal.kind, "active");
  const catalogue = createMovementCatalogue();
  let batches = 0;
  return new IncrementalSearch({
    id: "retained staircase",
    start: planningStart(feet, 0), goal, observedStart,
    now: () => batches / 30,
    limits: { primaryTimeoutMs: 500, failureTimeoutMs: 2_000 },
    context: {
      world: { revision: 0, subscribe: () => () => {}, blockAt: liveBlockReader(bot) },
      player: WELL_FED, policy: policy(targeting.protectedCells),
      catalogue: { ...catalogue, generate: (...args) => { batches++; return catalogue.generate(...args); } },
    },
  });
}

/** Matching the executor's stance/return policy lets a pillar use and remove its own scaffold. */
function stanceMovements(scene: Scene) {
  const { bot, plan } = scene;
  return createMovements(bot, { allowDigging: true, scaffolding: false, protectedCells: new Set([
    packKey(plan.pedestal.x, plan.pedestal.y, plan.pedestal.z),
    ...plan.tower.map(p => packKey(p.x, p.y, p.z)),
    ...plan.cells.filter(cell => cell.blockName !== "air").map(({ position: p }) => packKey(p.x, p.y, p.z)),
  ]) });
}

test("a cut first ascent ends the work search under the cap", () => {
  const scene = towerScene();
  // Continue the saved flat island edge past the crop so removing the box gate can exhaust the cap.
  for (let x = -65; x < -52; x++) for (let z = -14; z <= 14; z++) {
    scene.world.setCell(new Vec3(x, 61, z), "end_stone");
  }
  const search = startWorkSearch(scene, protectedCells => {
    const movements = staircase.crystalWorkRoutePolicy(scene.bot, scene.plan, protectedCells);
    return { ...movements, decideStep: (x, y, z, view) =>
      x === FIRST_ASCENT.x && y === FIRST_ASCENT.y && z === FIRST_ASCENT.z
        ? { kind: "prohibited", reason: "Cut first ascent" } : movements.decideStep(x, y, z, view) };
  });
  const step = search.advance({ maximumExpansions: CAP, maximumMilliseconds: Infinity });
  assert.equal(step.kind, "no_path", `cut ascent after ${step.evidence.visited} visits`);
  assert.ok(step.evidence.visited < CAP);
});

test("the last target alone never schedules a tower break", () => {
  const scene = towerScene();
  const search = startWorkSearch(scene, () => stanceMovements(scene), 3);
  let result = search.advance();
  while (result.kind === "progress") result = search.advance();
  const breaks = "plan" in result ? result.plan.steps.flatMap(step => step.effects)
    .filter(effect => effect.kind === "break").map(({ position }) => scene.bot.blockAt(new Vec3(position.x, position.y, position.z))?.name === "obsidian" ?
      [position.x, position.y, position.z] : null).filter(position => position !== null) : [];
  assert.deepEqual(breaks, []);
});

/** Run construction against the real navigation runtime and the shared server's placement answers. */
function build(scene: Scene, navigation: NavigationRuntime, signal = new AbortController().signal, policy = DEFAULT_SURVIVAL_POLICY,
  startEnclosed?: () => boolean) {
  return scene.clock.settle(
    staircase.buildCrystalStaircase(scene.bot, navigation, policy, scene.plan, signal, startEnclosed), 45_000,
  );
}

test("the open ascent completes, keeps the tower and reaches the stance", async () => {
  const scene = towerScene();
  const { bot, clock, plan, server } = scene;
  using _timers = clock.install();
  await using navigation = createNavigationRuntime(bot);
  const tower = plan.tower.map(position => bot.blockAt(position)?.stateId);
  assert.equal(await build(scene, navigation), null);
  assert.deepEqual(MISSING_TREADS.map(position => bot.blockAt(position)?.name), MISSING_TREADS.map(() => "end_stone"));
  const arrived = await clock.settle(navigation.navigate({ goal: exactBlockGoal(plan.stance), movements: stanceMovements(scene) }), 15_000);
  assert.equal(arrived.status, "completed", JSON.stringify(arrived));
  assert.deepEqual(bot.entity.position.floored(), plan.stance);
  assert.deepEqual(plan.tower.map(position => bot.blockAt(position)?.stateId), tower);
  assert.equal(server.packets.filter(packet => packet.name === "block_dig").length, 0);
});

const CAGE_PREVIOUS_TAKEOFF = new Vec3(42, 78, -3);
const CAGE_TAKEOFF = new Vec3(43, 79, -3);
const CAGE_BAR = new Vec3(44, 79, -2);
type DigPacket = { readonly status: number; readonly location: Vec3 };

for (const mode of ["overhang", "constrained", "active cancel", "late cancel"] as const) {
  test(`the retained cage clears its connected bar in place (${mode})`, async () => {
    const scene = towerScene(fixture.cage);
    const { bot, clock, plan, server, world } = scene;
    assert.equal(bot.blockAt(CAGE_TAKEOFF)?.name, "end_stone");
    assert.equal(bot.blockAt(CAGE_BAR)?.shapes.length, 2, "retain the native bar's connected collision");
    if (mode !== "overhang") {
      world.setCell(CAGE_PREVIOUS_TAKEOFF, "air");
      world.setCell(CAGE_TAKEOFF, "air");
    }
    confirmFakeDigs(scene);
    using _timers = clock.install();
    await using navigation = createNavigationRuntime(bot);
    using listeners = new DisposableStack();
    listeners.defer(navigation.onEvent(event => {
      if (event.kind === "route_committed")
        assert.equal(event.plan.steps.some(step => step.effects.some(effect => effect.kind === "break")), false);
    }));
    const stop = new AbortController();
    const digs: DigPacket[] = [];
    listeners.defer(server.onPacket("block_dig", data => {
      const packet = data as DigPacket;
      digs.push(packet);
      if (mode === "active cancel" && packet.status === 0 && CAGE_BAR.equals(packet.location))
        queueMicrotask(() => stop.abort(new Error("active corner dig interrupted")));
    }));
    if (mode === "late cancel") {
      const abortAfterDig = () => stop.abort(new Error("late corner dig interrupted"));
      bot.once("diggingCompleted", abortAfterDig);
      listeners.defer(() => bot.off("diggingCompleted", abortAfterDig));
    }
    if (mode === "active cancel" || mode === "late cancel") {
      await assert.rejects(build(scene, navigation, stop.signal), /corner dig interrupted/);
      assert.equal(navigation.active, false);
      assert.equal(bot.blockAt(CAGE_BAR)?.name, mode === "active cancel" ? "iron_bars" : "air");
      assert.deepEqual(digs.map(packet => packet.status), mode === "active cancel" ? [0, 1] : [0, 2]);
    }
    if (mode === "constrained") {
      const policy = { ...DEFAULT_SURVIVAL_POLICY, combat: {
        ...DEFAULT_SURVIVAL_POLICY.combat, terrain: { dig: false, place: true },
      } };
      assert.match(await build(scene, navigation, undefined, policy) ?? "", /CRYSTAL_STAIRCASE_INCOMPLETE.*refused/);
      assert.equal(bot.blockAt(CAGE_BAR)?.name, "iron_bars");
      assert.deepEqual(digs, []);
      assert.equal(navigation.active, false);
    }
    const tower = plan.tower.map(position => bot.blockAt(position)?.stateId);
    assert.equal(await build(scene, navigation), null);
    assert.equal(bot.blockAt(CAGE_TAKEOFF)?.name, "air");
    assert.equal(bot.blockAt(CAGE_BAR)?.name, "air");
    const edited = digs.filter(packet => packet.status === 2).map(packet => packet.location);
    assert.deepEqual(edited, mode === "overhang" ? [CAGE_PREVIOUS_TAKEOFF, CAGE_TAKEOFF, CAGE_BAR] : [CAGE_BAR]);
    if (mode === "overhang") {
      const arrived = await clock.settle(navigation.navigate({ goal: exactBlockGoal(plan.stance),
        movements: stanceMovements(scene) }), 15_000);
      assert.equal(arrived.status, "completed", JSON.stringify(arrived));
      assert.deepEqual(bot.entity.position.floored(), plan.stance);
      assert.deepEqual(plan.tower.map(position => bot.blockAt(position)?.stateId), tower);
    }
  });
}

/** The saved-world cloud control covers the next step while the current feet remain outside its damage slab. */
function spawnCloud(scene: Scene): void {
  const { bot, entities } = scene;
  const keys = bot.registry.entitiesByName.area_effect_cloud!.metadataKeys!;
  const metadata: unknown[] = [];
  metadata[keys.indexOf("particle")] = { type: "dragon_breath" };
  metadata[keys.indexOf("radius")] = 7;
  entities.spawn({ id: 51, name: "area_effect_cloud", position: new Vec3(-45.5, 80, -2.5), metadata });
  const [cloud] = readDragonCloudHazards(bot);
  assert.ok(cloud);
  assert.equal(cloudExposure(cloud, bot.entity.position), 0);
  assert.ok(cloudExposure(cloud, FIRST_ASCENT.offset(0.5, 0, 0.5)) > 0);
}

for (const liftsDuringCall of [false, true]) {
  test(liftsDuringCall ? "the cloud lifting during the call reconsiders the low tread" :
    "a cloud over the next tread hands back a named block, and a fresh call completes once it lifts", async () => {
    const scene = towerScene();
    const { bot, clock, entities } = scene;
    spawnCloud(scene);
    using _timers = clock.install();
    await using navigation = createNavigationRuntime(bot);
    const stop = new AbortController();
    const visits = new Map<string, number>();
    let failures = 0;
    const off = navigation.onEvent(event => {
      if (event.kind === "calculation_failed") {
        if (++failures === 1 && liftsDuringCall) entities.remove(51);
      }
      if (event.kind === "search_slice") {
        visits.set(event.searchId, Math.max(visits.get(event.searchId) ?? 0, event.visited));
        if (event.visited >= 2 * CAP) stop.abort(new Error("Cut staircase search passed its visit cap"));
      }
    });
    try {
      const result = await build(scene, navigation, stop.signal).catch(error => {
        if (!stop.signal.aborted) throw error;
        assert.fail(`cut staircase search reached ${Math.max(...visits.values())} visits`);
      });
      assert.ok(visits.size > 0 && Math.max(...visits.values()) < CAP);
      assert.ok(failures > 0);
      if (liftsDuringCall) {
        assert.equal(result, null);
      } else {
        assert.match(result ?? "", /CRYSTAL_STAIRCASE_INCOMPLETE.*refused at .*no path.*clouds near the build/i);
        assert.ok(result?.includes(JSON.stringify(MISSING_TREADS[0])));
        assert.notEqual(bot.blockAt(MISSING_TREADS[0]!)?.name, "end_stone");
        entities.remove(51);
        assert.equal(await build(scene, navigation), null);
      }
      assert.deepEqual(MISSING_TREADS.map(position => bot.blockAt(position)?.name), MISSING_TREADS.map(() => "end_stone"));
      assert.equal(stop.signal.aborted, false);
    } finally { off(); }
  });
}

const OUTSIDE = new Vec3(-25.5, 62, 0.5);

/** Leave safe walking terrain between the box and a position twelve cells beyond the foot. */
function extendIsland(scene: Scene): void {
  for (let x = -37; x <= -24; x++) for (let z = -1; z <= 1; z++) {
    scene.world.setCell(new Vec3(x, 61, z), "end_stone");
    scene.world.setCell(new Vec3(x, 62, z), "air");
    scene.world.setCell(new Vec3(x, 63, z), "air");
  }
}

for (const displaced of ["before build", "after placement", "before placement", "foot blocked"] as const) {
  test(`a bot outside the work box ${displaced} gets only the foot travel its progress permits`, async () => {
    const scene = towerScene();
    const { bot, clock, server } = scene;
    extendIsland(scene);
    using _timers = clock.install();
    await using runtime = createNavigationRuntime(bot);
    let footLegs = 0, workLegs = 0;
    let refuseTravel = displaced === "foot blocked";
    let knocked = false;
    runtime.setRouteAdmissionProvider(() => ({
      check() {
        if (displaced === "before placement" && workLegs > 0 && !knocked) {
          knocked = true;
          server.sendPosition(OUTSIDE);
          return "the body was moved before the work route could start";
        }
        return refuseTravel ? "test obstruction" : null;
      },
    }));
    const startedOutside = displaced !== "before placement";
    if (startedOutside) server.sendPosition(OUTSIDE);
    const knockAfterPlacement = (_previous: unknown, next: ReturnType<typeof bot.blockAt>) => {
      if (next?.name !== "end_stone" || !next.position.equals(MISSING_TREADS[0]!)) return;
      bot.off("blockUpdate", knockAfterPlacement);
      server.sendPosition(OUTSIDE);
    };
    if (displaced === "after placement") bot.on("blockUpdate", knockAfterPlacement);
    const navigate: NavigationRuntime["navigate"] = options => {
      const step = options.movements.decideStep(-26, 62, 0, runtime.world);
      if (options.onArrival) {
        workLegs++;
        assert.equal(step.kind, "prohibited", "keep all work routes inside the box");
        assert.equal(options.movements.allowDigging, false);
      } else {
        const goal = options.goal.resolve(observation(-26, 62, 0));
        assert.equal(goal.kind, "active");
        if (goal.kind === "active" && goal.revision === "near:-38,62,0:4") {
          footLegs++;
          assert.notEqual(step.kind, "prohibited");
          assert.equal(options.movements.allowDigging, true);
          const block = runtime.world.blockAt(-43, 84, -4);
          assert.equal(options.movements.evaluateBreak(block, new Vec3(-43, 84, -4), runtime.world).decision.kind, "prohibited");
        }
      }
      return runtime.navigate(options);
    };
    try {
      const result = await build(scene, { ...runtime, navigate });
      assert.equal(footLegs, displaced === "after placement" ? 2 : displaced === "before placement" ? 0 : 1);
      if (displaced === "foot blocked" || displaced === "before placement") {
        assert.match(result ?? "", displaced === "foot blocked"
          ? /CRYSTAL_STAIRCASE_INCOMPLETE.*foot failed:.*test obstruction/ : /CRYSTAL_STAIRCASE_INCOMPLETE/);
        if (displaced === "foot blocked") assert.equal(workLegs, 0);
        else assert.ok(knocked && workLegs > 0);
        assert.equal(bot.blockAt(MISSING_TREADS[0]!)?.name, "air");
        assert.deepEqual(bot.entity.position.floored(), OUTSIDE.floored());
        assert.equal(bot.blockAt(OUTSIDE.offset(0, -1, 0).floored())?.name, "end_stone");
        assert.equal(runtime.active, false);
        const previousFootLegs = footLegs;
        refuseTravel = false;
        assert.equal(await build(scene, { ...runtime, navigate }), null);
        assert.equal(footLegs, previousFootLegs + 1);
      } else {
        assert.ok(workLegs > 0);
        assert.equal(result, null);
      }
      assert.equal(bot.blockAt(MISSING_TREADS.at(-1)!)?.name, "end_stone");
      assert.equal(runtime.active, false);
    } finally {
      bot.off("blockUpdate", knockAfterPlacement);
    }
  });
}

type Leg = { readonly leave: boolean; readonly allowDigging: boolean; readonly work: boolean };

/** Wrap `navigate` to record each leg: an exit leg is a goal named `leave:`, a work leg carries `onArrival`. */
function recordLegs(runtime: NavigationRuntime, legs: Leg[], onLeg?: (leg: Leg) => void): NavigationRuntime {
  const navigate: NavigationRuntime["navigate"] = options => {
    const work = options.onArrival !== undefined;
    const resolved = work ? null : options.goal.resolve(observation(0, 0, 0));
    const leg = { work, allowDigging: options.movements.allowDigging,
      leave: resolved?.kind === "active" && resolved.revision.startsWith("leave:") };
    legs.push(leg);
    onLeg?.(leg);
    return runtime.navigate(options);
  };
  return { ...runtime, navigate };
}

test("an attempt that starts in a closed cell steps out of it: the exit leg finds a way where the no-dig work search finds none", () => {
  const scene = towerScene();
  closeShelter(scene);
  const feet = shelterFeet(scene.bot);
  const shut = startWorkSearch(scene, protectedCells => staircase.crystalWorkRoutePolicy(scene.bot, scene.plan, protectedCells), 0,
    { feet, digsInSight: true }).advance({ maximumExpansions: CAP, maximumMilliseconds: Infinity });
  assert.equal(shut.kind, "no_path");
  assert.ok(shut.evidence.visited < 5, `the work search is shut in at the start after ${shut.evidence.visited} visits`);
  const exit = startWorkSearch(scene, protectedCells => staircase.crystalWorkRoutePolicy(scene.bot, scene.plan, protectedCells,
    { allowDigging: true }), 0, { feet, digsInSight: true, goalOverride: staircase.leaveCellGoal(feet, scene.plan.box) })
    .advance({ maximumExpansions: CAP, maximumMilliseconds: Infinity });
  assert.ok(exit.kind === "complete" || exit.kind === "segment_ready", `the exit leg ends ${exit.kind} after ${exit.evidence.visited} visits`);
  assert.ok(exit.evidence.visited < CAP);
  // T10: the level bound of `leaveCellGoal`: the cell under the start (the pit a dig straight down opens) is no way out.
  const goal = staircase.leaveCellGoal(feet, scene.plan.box).resolve(observation(feet.x, feet.y, feet.z));
  assert.equal(goal.kind, "active");
  const world = { revision: 0, subscribe: () => () => {}, blockAt: liveBlockReader(scene.bot) };
  const accepts = (dy: number) => goal.kind === "active" && goal.isSatisfied(planningStart({ x: feet.x + 1, y: feet.y + dy, z: feet.z }, 0).node, world);
  assert.deepEqual([accepts(-1), accepts(0), accepts(1)], [false, true, true]);
});

// T13 and T4: the exit leg is a dig the server answers, cancelled and run at both rates.
for (const ticksPerSecond of [20, 10]) {
  // The old code's receipt for this scene (the exit leg switched off): "[CRYSTAL_STAIRCASE_INCOMPLETE] 1 cells remain;
  // refused at {"x":-46,"y":79,"z":-3}: no path found after 0 ms compute; visited 1 nodes, generated 1; ... shut in at the
  // start: 10 not dug because this request has digging off; ...".
  test(`an attempt that starts in a closed cell breaks only its shell and the planned block, then digs that block and keeps the tower at ${ticksPerSecond} tps`, async () => {
    const scene = towerScene(fixture, ticksPerSecond);
    const { bot, clock, plan, server } = scene;
    const { shell, wrong } = closeShelter(scene);
    confirmFakeDigs(scene);
    using _timers = clock.install();
    await using navigation = createNavigationRuntime(bot);
    const broken: Vec3[] = [];
    using listeners = new DisposableStack();
    listeners.defer(server.onPacket("block_dig", data => {
      const packet = data as DigPacket;
      if (packet.status === 2) broken.push(packet.location);
    }));
    const tower = plan.tower.map(position => bot.blockAt(position)?.stateId);
    const result = await build(scene, navigation, undefined, undefined, () => enclosedInPlace(bot));
    assert.equal(result, null, "the way out of the closed cell lets the work legs run");
    assert.equal(bot.blockAt(wrong)?.name, "air");
    assert.deepEqual(plan.tower.map(position => bot.blockAt(position)?.stateId), tower);
    assert.ok(broken.some(cell => shell.some(part => part.equals(cell))), "the exit leg broke a side of the shell");
    for (const cell of broken) assert.ok([...shell, wrong].some(part => part.equals(cell)), `broken ${cell} is a shell cell or the planned block`);
  });
}

test("an abort during the exit leg leaves nothing active, and a fresh call leaves the cell and completes", async () => {
  const scene = towerScene();
  const { bot, clock, server } = scene;
  closeShelter(scene);
  confirmFakeDigs(scene);
  using _timers = clock.install();
  await using navigation = createNavigationRuntime(bot);
  const stop = new AbortController();
  using listeners = new DisposableStack();
  const digs: number[] = [];
  listeners.defer(server.onPacket("block_dig", data => {
    const status = (data as DigPacket).status;
    digs.push(status);
    if (status === 0 && digs.length === 1) queueMicrotask(() => stop.abort(new Error("exit dig interrupted")));
  }));
  await assert.rejects(build(scene, navigation, stop.signal, undefined, () => enclosedInPlace(bot)), /exit dig interrupted/);
  assert.equal(navigation.active, false);
  assert.deepEqual(digs, [0, 1], "the dig was started then cancelled: nothing half-dug");
  assert.equal(await build(scene, navigation, undefined, undefined, () => enclosedInPlace(bot)), null);
});

test("an exit leg that stops gives a receipt naming the cell and the next step, and the next call gives it again with no work leg run", async () => {
  const scene = towerScene();
  const { bot, clock } = scene;
  closeShelter(scene);
  using _timers = clock.install();
  await using runtime = createNavigationRuntime(bot);
  const legs: Leg[] = [];
  const recorded = recordLegs(runtime, legs);
  const refusing: NavigationRuntime = { ...recorded, navigate: options => {
    const goal = options.goal.resolve(observation(0, 0, 0));
    return goal.kind === "active" && goal.revision.startsWith("leave:") ? Promise.resolve({ status: "stopped", reason: "No way out found.", elapsedMs: 0 } as const)
      : recorded.navigate(options);
  } };
  const receipt = /CRYSTAL_STAIRCASE_INCOMPLETE.*way out of the closed cell at .*failed: No way out found\. Open a side of the cell or choose another approach\./;
  assert.match(await build(scene, refusing, undefined, undefined, () => enclosedInPlace(bot)) ?? "", receipt);
  assert.match(await build(scene, refusing, undefined, undefined, () => enclosedInPlace(bot)) ?? "", receipt);
  assert.equal(legs.some(leg => leg.work), false);
  assert.equal(enclosedInPlace(bot), true, "the bot is still shut in");
});

test("a stopped server ends the exit leg's dig with a bounded receipt", async () => {
  const scene = towerScene();
  const { bot, clock, server } = scene;
  closeShelter(scene);
  confirmFakeDigs(scene);
  using _timers = clock.install();
  await using navigation = createNavigationRuntime(bot);
  server.stop();
  const result = await build(scene, navigation, undefined, undefined, () => enclosedInPlace(bot));
  assert.match(result ?? "", /CRYSTAL_STAIRCASE_INCOMPLETE/);
  assert.equal(navigation.active, false);
});

for (const [name, closed, dig, expected] of [
  ["a closed start with digging off", true, false, /not dug because this request has digging off/],
  ["a free start", false, true, null],
] as const) test(`${name} gets no exit leg and its work legs dig nothing`, async () => {
  const scene = towerScene();
  const { bot, clock } = scene;
  if (closed) closeShelter(scene);
  using _timers = clock.install();
  await using runtime = createNavigationRuntime(bot);
  const legs: Leg[] = [];
  const policy = { ...DEFAULT_SURVIVAL_POLICY, combat: { ...DEFAULT_SURVIVAL_POLICY.combat, terrain: { dig, place: true } } };
  assert.equal(enclosedInPlace(bot), closed);
  const result = await build(scene, recordLegs(runtime, legs), undefined, policy, () => enclosedInPlace(bot));
  if (expected) assert.match(result ?? "", expected); else assert.equal(result, null);
  assert.equal(legs.some(leg => leg.leave), false);
  assert.ok(legs.every(leg => !leg.allowDigging));
});

for (const ticksPerSecond of [20, 10]) test(`after the exit leg a cloud over the first ascent keeps every later search under the cap at ${ticksPerSecond} tps`, async () => {
  const scene = towerScene(fixture, ticksPerSecond);
  const { bot, clock } = scene;
  closeShelter(scene);
  confirmFakeDigs(scene);
  spawnCloud(scene);
  using _timers = clock.install();
  await using runtime = createNavigationRuntime(bot);
  const legs: Leg[] = [];
  let afterExit = false, laterVisits = 0;
  const off = runtime.onEvent(event => {
    if (event.kind === "search_slice" && afterExit) laterVisits = Math.max(laterVisits, event.visited);
  });
  const recorded = recordLegs(runtime, legs, leg => { if (!leg.leave && legs.some(earlier => earlier.leave)) afterExit = true; });
  try {
    await build(scene, recorded, undefined, undefined, () => enclosedInPlace(bot));
    assert.equal(legs.filter(leg => leg.leave).length, 1);
    assert.equal(legs.find(leg => leg.leave)?.allowDigging, true);
    assert.ok(legs.some(leg => leg.work) && legs.filter(leg => leg.work).every(leg => !leg.allowDigging));
    assert.ok(laterVisits > 0 && laterVisits < CAP, `the work legs after the exit leg reached ${laterVisits} visits`);
  } finally { off(); }
});
