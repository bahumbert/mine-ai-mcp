// Loaded endpoint sight and the navigation runs that consume it.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { cellsWithin, createMovements, liveBlockReader, nearGoal, type BlockPosition, type NavigationEvent, type RouteAdmission, type WorldView } from "../../navigation/index.js";
// Task 12b exercises the navigator seam with the shared actuator.
import { createNavigator } from "../../navigation/orchestration/navigator.js";
import { createFakeBot, type FakeCell } from "../../test-support/fake-bot/index.js";
import { FakeNavigationBot, movementStep, observation, onEvent, settle } from "../../test-support/navigation.js";
import { entityDimensions } from "../../world/entity-dimensions.js";
import { DEFAULT_COMBAT_POLICY } from "../policy/combat/contract.js";
import { DEFAULT_NAVIGATION_POLICY } from "../policy/contract.js";
import { createHostileStepFieldProvider, HIDE_EXPOSURE_PENALTY } from "../positioning/combat/hostile-field.js";
import { coverAdmission, type CoverObligation } from "./cover-obligation.js";

const BLOCKS = ["air", "grass_block", "bedrock", "water", "stone_slab", "oak_door", "oak_fence_gate"] as const;
type TerrainBlock = typeof BLOCKS[number];
type Lookup = (x: number, y: number, z: number) => TerrainBlock | "unloaded" | undefined;
type EndpointPlan = Parameters<NonNullable<RouteAdmission["refuteEndpoints"]>>[0];

/** Cache each shape from the shared fake's registry outside the search arena. */
function sampleBlocks(cells: Record<string, FakeCell>, lane: number) {
  const at = (index: number) => new Vec3(160 + index, -60, lane);
  BLOCKS.forEach((name, index) => {
    const position = at(index);
    cells[`${position.x},${position.y},${position.z}`] = name === "oak_fence_gate"
      ? { name, properties: { open: true } } : name;
  });
  return (read: WorldView["blockAt"]) => new Map(BLOCKS.map((name, index) => {
    const { x, y, z } = at(index);
    return [name, read(x, y, z)] as const;
  }));
}

/** T9's measured shooter body and the flat arena from the search probe, including the grass floor. */
function arena(lane = 0, wallEnd = 2, extra?: Lookup) {
  const start = { x: 4, y: -60, z: lane + (wallEnd === 2 ? 2 : -2) };
  const target = { x: 4, y: -60, z: lane + 12 };
  const position = new Vec3(4.60467, -60, lane + (wallEnd === 2 ? 2.44745 : -1.459));
  const shooter = new Vec3(-5.5, -60, lane + 0.5);
  const cells: Record<string, FakeCell> = {};
  for (let z = -2; z <= wallEnd; z++)
    for (let y = -60; y <= -58; y++) cells[`3,${y},${lane + z}`] = "bedrock";
  const samples = sampleBlocks(cells, lane);
  const { bot } = createFakeBot({ position, health: 7, groundY: -61,
    cells,
    entities: { 2: { name: "skeleton", position: shooter } } });
  const owed: CoverObligation = { requestId: "resume", generation: 0, threatId: 2, name: "skeleton", safeRange: 36,
    body: { position: shooter, ...entityDimensions(bot, bot.entities[2]!) } };

  const byName = samples(liveBlockReader(bot));
  const air = byName.get("air")!;
  const grass = byName.get("grass_block")!;
  const bedrock = byName.get("bedrock")!;
  const unloaded = { kind: "unloaded", bits: 0 } as const;
  const world: WorldView = {
    revision: 1,
    blockAt(x, y, z) {
      const relativeZ = z - lane;
      const override = extra?.(x, y, relativeZ);
      if (override === "unloaded" || x < -144 || x > 159 || relativeZ < -144 || relativeZ > 159 || y < -64 || y > -48) return unloaded;
      if (override === "bedrock" || y < -61) return bedrock;
      if (override) return byName.get(override)!;
      if (y === -61) return grass;
      if (x === 3 && y <= -58 && relativeZ >= -2 && relativeZ <= wallEnd) return bedrock;
      return air;
    },
    subscribe: () => () => undefined,
  };
  return { bot, owed, world, start, target, position };
}

/** The six range-one candidates left after navigation excludes the grass floor cell. */
function endpointPlan({ start, target }: Pick<ReturnType<typeof arena>, "start" | "target">): EndpointPlan {
  return { start, endpoints: cellsWithin(target, 1)!.filter((cell) => cell.y >= target.y) };
}

/** The registered admission's endpoint result, with a lower budget only in the budget test. */
function prove(scene: ReturnType<typeof arena>, plan = endpointPlan(scene), obligations = [scene.owed], maxReads?: number) {
  return coverAdmission(scene.bot, obligations, maxReads).refuteEndpoints(plan, scene.world);
}

test("all six seen endpoints prove a cover refusal and name the nearest cell", () => {
  const scene = arena();
  assert.equal(prove(scene), "[COVER_ROUTE_REFUSED] every end of this route (6 cells) is in sight of skeleton#2; " +
    "the nearest, 4 -60 11, is 14.9 blocks from skeleton#2; no committed route keeps cover. " +
    "The reflex still protects the body; choose the next action.");
});

test("one endpoint behind bedrock makes a mixed proof uncertain", () => {
  const scene = arena(0, 2, (x, y, z) => x === 3 && y >= -60 && y <= -57 && z === 12 ? "bedrock" : undefined);
  const plan = endpointPlan(scene);
  assert.match(prove(scene, { ...plan, endpoints: [{ x: 4, y: -60, z: 11 }] }) ?? "", /skeleton#2/);
  assert.equal(prove(scene, { ...plan, endpoints: [{ x: 4, y: -60, z: 13 }] }), null);
  assert.equal(prove(scene, plan), null);
});

test("an unloaded ray cell makes proof uncertain but replay still refuses", () => {
  const scene = arena(0, 2, (x, _y, z) => x === 2 && z > 5 ? "unloaded" : undefined);
  assert.equal(prove(scene), null);
  const step = movementStep("walk", { x: 4, y: -60, z: 10 }, { x: 4, y: -60, z: 11 });
  assert.match(coverAdmission(scene.bot, [scene.owed]).check({ start: scene.start, steps: [step] }, scene.world) ?? "",
    /\[COVER_ROUTE_REFUSED\].*skeleton#2/);
});

const VISIBLE_ENDPOINT = { x: 4, y: -60, z: 11 };
const endpointHead = (x: number, y: number, z: number) => x === 4 && y === -59 && z === 11;
const endpointFeet = (x: number, y: number, z: number) => x === 4 && y === -60 && z === 11;
const rayBetween = (x: number, _y: number, z: number) => x === 2 && z > 5;

test("uncertain endpoint body or ray geometry leaves the search to decide", () => {
  const clear = arena();
  const plan = { start: clear.start, endpoints: [VISIBLE_ENDPOINT] };
  assert.match(prove(clear, plan) ?? "", /skeleton#2/);
  const uncertain = [
    [endpointHead, "unloaded"], [endpointFeet, "water"], [endpointFeet, "stone_slab"], [endpointFeet, "oak_door"],
    [rayBetween, "water"], [rayBetween, "stone_slab"], [rayBetween, "oak_fence_gate"],
  ] as const;
  const refusals = uncertain.flatMap(([cell, block]) => {
    const scene = arena(0, 2, (x, y, z) => cell(x, y, z) ? block : undefined);
    return prove(scene, plan) === null ? [] : [`${block} at ${cell.name}`];
  });
  assert.deepEqual(refusals, []);
});

test("a shooter seeing the start is waived while a second owed shooter still refutes", () => {
  const scene = arena();
  const alreadySees = { ...scene.owed, threatId: 3, body: { ...scene.owed.body, position: new Vec3(8.5, -60, 2.5) } };
  assert.equal(prove(scene, endpointPlan(scene), [alreadySees]), null);
  assert.match(prove(scene, endpointPlan(scene), [alreadySees, scene.owed]) ?? "", /in sight of skeleton#2;/);
});

test("a shooter can witness an endpoint at the safe range and no farther", () => {
  const scene = arena();
  const plan = { start: scene.start, endpoints: [VISIBLE_ENDPOINT] };
  const range = Math.sqrt(221);
  assert.match(prove(scene, plan, [{ ...scene.owed, safeRange: range }]) ?? "", /skeleton#2/);
  assert.equal(prove(scene, plan, [{ ...scene.owed, safeRange: range - 2 ** -49 }]), null);
});

test("different endpoints can be seen by different owed shooters, named in obligation order", () => {
  const scene = arena();
  const plan = { start: scene.start, endpoints: [{ x: 4, y: -60, z: 13 }, { x: 4, y: -60, z: 11 }] };
  const closerOnly = { ...scene.owed, threatId: 3, safeRange: 16 };
  assert.match(prove(scene, plan, [closerOnly, scene.owed]) ?? "",
    /\(2 cells\) is in sight of skeleton#3, skeleton#2; the nearest, 4 -60 11, is 14\.9 blocks from skeleton#3/);
});

test("the budget covers both start waiver and endpoint reads, including its last read", () => {
  let reads = 0;
  const scene = arena(0, 2, () => { reads++; });
  const plan = { start: scene.start, endpoints: [VISIBLE_ENDPOINT] };
  assert.equal(prove(scene, plan, [scene.owed], 50), null);
  assert.equal(reads, 52, "two start body cells and at most 50 ray cells were read");
  assert.equal(prove(scene, plan, [scene.owed], 312), null);
  assert.match(prove(scene, plan, [scene.owed], 313) ?? "", /skeleton#2/);
});

/** Exercise real search, pricing and route admission with the shared fake navigation actuator. */
async function navigateArena(lane: number, wallEnd: number, allowPlacing = false) {
  const scene = arena(lane, wallEnd);
  const actuator = new FakeNavigationBot();
  const { x, y, z } = scene.start;
  actuator.arrive(scene.start, { ...observation(x, y, z), position: scene.position });
  const events: NavigationEvent[] = [];
  const control = new AbortController();
  const navigator = createNavigator({ world: scene.world, bot: actuator, telemetry: onEvent((event) => {
    events.push(event);
    if (allowPlacing && event.kind === "search_started") control.abort("The placing control reached search");
  }) });
  const field = createHostileStepFieldProvider(scene.bot, {
    policy: { ...DEFAULT_COMBAT_POLICY, hide: "never" }, resolvedIds: new Set(), attackerIds: new Set(),
  }, () => null, () => DEFAULT_NAVIGATION_POLICY, () => [scene.owed]);
  if (wallEnd === 2) {
    const price = field();
    assert.ok(price && price.costAt(x, y, z) < HIDE_EXPOSURE_PENALTY, "pricing sees the lee as covered");
    assert.ok(price.costAt(scene.target.x, scene.target.y, scene.target.z) >= HIDE_EXPOSURE_PENALTY, "pricing sees the endpoint as exposed");
  }
  navigator.setStepFieldProvider(field);
  const admission = coverAdmission(scene.bot, [scene.owed]);
  let proofCalls = 0;
  navigator.setRouteAdmissionProvider(() => ({ ...admission,
    refuteEndpoints(plan, world) {
      proofCalls++;
      return admission.refuteEndpoints(plan, world);
    },
  }));
  const outcome = await settle(navigator, { goal: nearGoal(scene.target, 1),
    policy: createMovements(scene.bot, { allowDigging: false, scaffolding: allowPlacing }), signal: control.signal });
  return { outcome, events, proofCalls, actuator, target: scene.target };
}

/** Last slice per search, since counts accumulate within a search ID. */
function lastSlices(events: readonly NavigationEvent[]) {
  const last = new Map<string, { visited: number; computeMs: number }>();
  for (const event of events) if (event.kind === "search_slice")
    last.set(event.searchId, { visited: event.visited, computeMs: event.computeMs });
  return last;
}

for (const lane of [0, 512]) {
  test(`the short wall's resume is refused before any search (lane ${lane})`, async () => {
    const { events, outcome } = await navigateArena(lane, 2);
    const searches = events.filter((event) => event.kind === "search_started");
    assert.equal(searches.length, 0, JSON.stringify([...lastSlices(events)]));
    const refused = events.filter((event) => event.kind === "route_refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0]!.planId, null);
    assert.ok(outcome.kind === "failed" && outcome.failure.kind === "no_progress");
    assert.equal(outcome.failure.reason, "route_refused");
    assert.match(outcome.failure.observation, /\[COVER_ROUTE_REFUSED\].*skeleton#2/);
  });
}

test("the long wall's covered route is searched and walked", async () => {
  const { outcome, events, actuator, target } = await navigateArena(512, 14);
  assert.equal(events.filter((event) => event.kind === "route_refused").length, 0);
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  const slices = [...lastSlices(events).values()];
  console.log("covered long wall last slice", slices.at(-1));
  assert.ok(slices.length > 0 && slices.at(-1)!.visited < 2_000, JSON.stringify(slices));
  const { x, y, z } = actuator.current.position;
  assert.ok(Math.hypot(x - target.x - 0.5, y - target.y, z - target.z - 0.5) <= 1);
});

test("a policy that may place keeps the search", async () => {
  const { events, proofCalls } = await navigateArena(0, 2, true);
  assert.equal(proofCalls, 0);
  assert.equal(events.filter((event) => event.kind === "search_started").length, 1);
});

/** All 123 endpoints are above the floor; the first five shooters of the exhaustion case are screened at x=-15. */
function measurement(exhaust: boolean) {
  const scene = arena(0, 2, (x, y) => exhaust && x === -15 && y >= -60 ? "bedrock" : undefined);
  const endpoints: readonly BlockPosition[] = cellsWithin({ ...scene.target, y: -57, z: 22 }, 3)!;
  const plan = { start: scene.start, endpoints };
  const screened = Array.from({ length: 5 }, (_, index) => ({ ...scene.owed, threatId: index + 3, safeRange: 64,
    body: { ...scene.owed.body, position: new Vec3(-20.5, -60, 0.5) } }));
  const obligations = exhaust ? [...screened, scene.owed] : [scene.owed];
  const admission = coverAdmission(scene.bot, obligations);
  const verdict = admission.refuteEndpoints(plan, scene.world);
  if (exhaust) {
    assert.equal(verdict, null);
    assert.match(prove(scene, plan, obligations, 200_000) ?? "", /\(123 cells\)/);
  } else {
    assert.match(verdict ?? "", /\(123 cells\)/);
  }
  const ms = Array.from({ length: 50 }, () => {
    const start = performance.now();
    admission.refuteEndpoints(plan, scene.world);
    return performance.now() - start;
  }).sort((a, b) => a - b);
  console.log(`endpoint proof ${exhaust ? "budget exhaustion" : "all seen"} (${endpoints.length} cells):`,
    { n: ms.length, minMs: ms[0], medianMs: (ms[24]! + ms[25]!) / 2, maxMs: ms.at(-1) });
}

test("measure endpoint proof cost without a wall-time assertion", () => {
  measurement(false);
  measurement(true);
});
