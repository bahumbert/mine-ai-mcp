import { bucketDropTotals } from "../../navigation/mineflayer/water-landing.js";
import { navigateCheckpointSchema } from "../checkpoint-schemas.js";
/** Navigate once, then report the position the world actually yielded. */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import {
  canOccupyWater,
  isWater,
  liveBlockReader,
  createMovements,
  nearGoal,
  nearXzGoal,
  RELAXED_DIG_STRAIGHT_DOWN,
  RELAXED_FLOWING_WATER,
  type Goal,
  type Navigate,
  type NavigationResult,
  type NavigationRuntime,
} from "../../navigation/index.js";
import { DEFAULT_MAXIMUM_DROP, fallbackScaffoldItem, preferredScaffoldItem, scaffoldBlockNames } from "../../navigation/mineflayer/movement-policy.js";
import { navigationFeet } from "../../navigation/world/block-geometry.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import type { ObserveRequest } from "../../session/request.js";
import { asVec3, type Position3 } from "../../utils/index.js";
import { defineAction, type ActionContext } from "../action.js";
import { observeToolTierLoss } from "../../world/tool-loss.js";
import { carriesBoat, crossByBoat, deepWaterOnTheWay, launchSpot } from "./boat-crossing.js";
import { standsAtSea, watchSwim } from "./swim-watch.js";
import { groundBelow, highestFloor, LAND_SEARCH, SHORE_SEARCH_RADIUS, shoreNear, standable, surfaceAt, targetSupported } from "./target-ground.js";

/** Deep-water crossings one request makes by boat: there and on to the far side, then once more at most. */
const MAX_CROSSINGS = 2;
/** Deep open water in a row on the straight way that a bot with a boat crosses by boat before trying a way round. */
const BOAT_FIRST_LENGTH = 24;
import {
  navigateOutcomes,
  parseNavigateRequest,
  NAVIGATE,
  NAVIGATE_DESCRIPTION,
  navigateInputSchema,
  navigateResultSchema,
  type NavigationEvidence,
  type NavigateRequest,
  type NavigateResult,
} from "./contract.js";

export interface NavigateDependencies {
  readonly createMovements: typeof createMovements;
  readonly navigate: Navigate;
}

function productionDependencies(navigate: Navigate): NavigateDependencies {
  return { createMovements, navigate };
}

function position(value: Position3): Position3 {
  return { x: value.x, y: value.y, z: value.z };
}

function scaffoldStocks(bot: Bot, before: ReadonlyMap<string, number>) {
  return [...before.keys()].map((item) => {
    const itemId = bot.registry.itemsByName[item]?.id;
    const inventoryBefore = before.get(item) ?? 0;
    const inventoryAfter = itemId === undefined ? 0 : bot.inventory.count(itemId, null);
    return { item, inventoryBefore, inventoryAfter, consumed: Math.max(0, inventoryBefore - inventoryAfter) };
  });
}

function navigationEvidence(
  bot: Bot,
  request: NavigateRequest,
  start: Position3,
  startDimension: string,
  elapsedMs: number,
  scaffoldInventoryBefore: ReadonlyMap<string, number>,
  bucketBefore: ReturnType<typeof bucketDropTotals>,
): NavigationEvidence {
  const target = { x: request.x, y: request.y, z: request.z };
  // GoalNear settles integral path nodes rather than the entity's fractional
  // centre, so the postcondition measures that same node. An unresolved
  // surface has only a horizontal distance and can never report success.
  const endBlock = asVec3(navigationFeet(bot.entity.position, bot.entity.onGround));
  const remainingDistance =
    bot.game.dimension !== startDimension
      ? null
      : request.y === null
        ? Math.hypot(endBlock.x - request.x, endBlock.z - request.z)
        : endBlock.distanceTo(asVec3({ x: request.x, y: request.y, z: request.z }));
  return {
    startDimension,
    endDimension: bot.game.dimension,
    target,
    range: request.range,
    start,
    end: position(bot.entity.position),
    remainingDistance,
    elapsedMs,
    scaffolding: scaffoldStocks(bot, scaffoldInventoryBefore),
    bucketDrops: { count: bucketDropTotals(bot).count - bucketBefore.count, waterRecovered: bucketDropTotals(bot).waterRecovered - bucketBefore.waterRecovered },
    missingDigTools: request.dig
      ? (["shovel", "pickaxe", "axe"] as const).filter(
          (tool) => !bot.inventory.items().some((item) => item.name.endsWith(`_${tool}`)),
        )
      : [],
  };
}

/** Execute one standard Pathfinder route without imposing an arbitrary distance timeout. */
export async function navigate(
  bot: Bot,
  request: NavigateRequest,
  context: ActionContext,
  dependencies: NavigateDependencies,
): Promise<NavigateResult> {
  const lifetime = new AbortController();
  try {
    return await beginNavigate(bot, request, dependencies, lifetime.signal)(context);
  } finally {
    lifetime.abort("Navigation request settled.");
  }
}

/** How far above the bot the way on must lie before a stalled route climbs straight up first. */
const CLIMB_OUT_HEIGHT = 12;

const toolLossObservers = new WeakMap<AbortSignal, ReturnType<typeof observeToolTierLoss>>();

/** The one tool-loss observer of a navigate call: its legs (boat crossings, climbs, landings) share it and its listeners. */
export function toolLossObserverOf(bot: Bot, lifetime: AbortSignal): ReturnType<typeof observeToolTierLoss> {
  const known = toolLossObservers.get(lifetime);
  if (known !== undefined) return known;
  const observer = observeToolTierLoss(bot);
  toolLossObservers.set(lifetime, observer);
  lifetime.addEventListener("abort", observer.close, { once: true });
  return observer;
}

/** What a further leg of the same navigate call carries over: the crossings and climb already made, the swim rule. */
interface LegOptions {
  readonly observe?: ObserveRequest;
  readonly crossings?: number;
  readonly climbed?: boolean;
  /** The swim to land and a swim that started with no land in reach are not held to the swim budget. */
  readonly unbudgeted?: boolean;
}

/** One navigate leg: what it started from, and what its route has done so far (the mutable fields). */
interface NavigateLeg {
  readonly bot: Bot;
  readonly request: NavigateRequest;
  readonly dependencies: NavigateDependencies;
  readonly lifetime: AbortSignal;
  readonly crossings: number;
  readonly climbed: boolean;
  readonly toolLoss: ReturnType<typeof observeToolTierLoss> | null;
  readonly start: Position3;
  readonly startDimension: string;
  readonly bucketBefore: ReturnType<typeof bucketDropTotals>;
  readonly scaffoldInventoryBefore: Map<string, number>;
  /** Route time this leg has spent so far. */
  elapsedMs: number;
  /** The destination once known: the target's own height, or the surface, floor or shore it resolved to. */
  destination: { x: number; y: number; z: number } | null;
  /** The route is not held to the swim budget (see {@link LegOptions.unbudgeted}). */
  swimFree: boolean;
}

function beginNavigate(
  bot: Bot,
  request: NavigateRequest,
  dependencies: NavigateDependencies,
  lifetime: AbortSignal,
  options: LegOptions = {},
) {
  const leg = startLeg(bot, request, dependencies, lifetime, options);
  observeNavigateProgress(leg, options.observe ?? (() => {}));
  return (context: ActionContext) => navigateLeg(leg, context);
}

/** A further leg of the same call (a crossing, a climb, a landing, or the way on from one), sharing its lifetime. */
function nextLeg(leg: NavigateLeg, request: NavigateRequest, options: LegOptions, context: ActionContext): Promise<NavigateResult> {
  return beginNavigate(leg.bot, request, leg.dependencies, leg.lifetime, options)(context);
}

/** The leg's baseline, taken before anything moves: position, dimension, scaffold and bucket stocks. */
function startLeg(
  bot: Bot,
  request: NavigateRequest,
  dependencies: NavigateDependencies,
  lifetime: AbortSignal,
  options: LegOptions,
): NavigateLeg {
  const toolLoss = request.dig ? toolLossObserverOf(bot, lifetime) : null;
  return {
    bot,
    request,
    dependencies,
    lifetime,
    crossings: options.crossings ?? 0,
    climbed: options.climbed ?? false,
    toolLoss,
    start: position(bot.entity.position),
    startDimension: bot.game.dimension,
    bucketBefore: bucketDropTotals(bot),
    scaffoldInventoryBefore: new Map(
      scaffoldBlockNames(bot).map((item) => [item, bot.inventory.count(bot.registry.itemsByName[item]?.id ?? -1, null)]),
    ),
    elapsedMs: 0,
    destination: request.y === null ? null : { x: request.x, y: request.y, z: request.z },
    swimFree: options.unbudgeted ?? false,
  };
}

/** The progress a resumable navigate reports: its baseline, its current destination and whether it is there. */
function observeNavigateProgress(leg: NavigateLeg, observe: ObserveRequest): void {
  const { bot, request, start, startDimension } = leg;
  observe(() => ({
    baseline: { dimension: startDimension, position: { ...start } },
    checkpoint: {
      destination: leg.destination,
      remainingDistance: leg.destination && bot.game.dimension === startDimension
        ? bot.entity.position.distanceTo(asVec3(leg.destination)) : null,
      dimension: bot.game.dimension,
      positionedDimension: startDimension,
      died: false,
      portal: null,
    },
    completion: {
      kind: "current",
      observed:
        leg.destination !== null &&
        bot.game.dimension === startDimension &&
        asVec3(navigationFeet(bot.entity.position, bot.entity.onGround)).distanceTo(asVec3(leg.destination)) <=
          request.range &&
        (bot.entity.onGround || canOccupyWater(bot, navigationFeet(bot.entity.position, bot.entity.onGround))),
      owes: "Current destination distance and supported footing or admitted water.",
    },
  }));
}

/** The evidence of the leg as it stands, measured against its resolved destination once there is one. */
function legEvidence(leg: NavigateLeg): NavigationEvidence {
  const request = leg.destination ? { ...leg.request, ...leg.destination } : leg.request;
  return navigationEvidence(leg.bot, request, leg.start, leg.startDimension, leg.elapsedMs, leg.scaffoldInventoryBefore, leg.bucketBefore);
}

/** Why the destination itself refuses entry: an active portal is entered by its own action. */
function portalProblem(leg: NavigateLeg): string | null {
  const { bot, destination, startDimension } = leg;
  if (!destination || bot.game.dimension !== startDimension) return null;
  const cell = asVec3(destination);
  const block = bot.blockAt(cell);
  return block?.name === "end_portal" || block?.name === "nether_portal"
    ? `[NAVIGATION_PORTAL_INTENT_REQUIRED] Use ${block.name === "end_portal" ? "enter_end_portal" : "enter_nether_portal"} to enter this active portal.`
    : null;
}

/** What the swim to land before the asked route came to. */
type LandLegOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "reached"; readonly spot: Vec3; readonly elapsedMs: number }
  | { readonly kind: "failed"; readonly result: NavigateResult };

/** The route, led by a swim to the nearest land when the bot starts at sea with no boat. */
async function navigateLeg(leg: NavigateLeg, context: ActionContext): Promise<NavigateResult> {
  const land = await swimToLandFirst(leg, context);
  if (land.kind === "failed") return land.result;
  const result = await routeToDestination(leg, context);
  if (land.kind === "none") return result;
  const swam = `swam to land at ${land.spot.x}, ${land.spot.y}, ${land.spot.z} first`;
  const navigation = { ...result.navigation, start: leg.start, landLeg: { x: land.spot.x, y: land.spot.y, z: land.spot.z }, elapsedMs: result.navigation.elapsedMs + land.elapsedMs };
  return result.status === "failed" || result.status === "partial"
    ? { ...result, error: `${result.error} (${swam})`, navigation }
    : { ...result, navigation };
}

/** At sea with no boat, the swim to the nearest land within {@link LAND_SEARCH}; with none in reach the route swims free. */
async function swimToLandFirst(leg: NavigateLeg, context: ActionContext): Promise<LandLegOutcome> {
  const { bot, request } = leg;
  if (leg.crossings !== 0 || carriesBoat(bot) || !standsAtSea(bot)) return { kind: "none" };
  const land = shoreNear(bot, bot.entity.position.floored(), LAND_SEARCH);
  const ground = land === null ? null : surfaceAt(bot, land.x, land.z);
  if (land === null || ground?.kind !== "surface") {
    leg.swimFree = true;
    return { kind: "none" };
  }
  const spot = new Vec3(land.x, ground.y + 1, land.z);
  const swim = await nextLeg(leg, { ...request, ...spot, range: 1 }, { crossings: MAX_CROSSINGS, unbudgeted: true }, context);
  if (swim.status !== "succeeded") {
    return { kind: "failed", result: { ...swim, error: `${swim.error} (the swim to land at ${spot.x}, ${spot.y}, ${spot.z} came first)`, navigation: { ...swim.navigation, start: leg.start } } };
  }
  return { kind: "reached", spot, elapsedMs: swim.navigation.elapsedMs };
}

/** The asked route: refused before it starts, crossed by boat first, or planned, walked and judged. */
async function routeToDestination(leg: NavigateLeg, context: ActionContext): Promise<NavigateResult> {
  const startedAt = Date.now();
  context.signal?.throwIfAborted();
  const refused = refusalBeforeRoute(leg);
  if (refused) return refused;
  const byBoat = await crossByBoatFirst(leg, context);
  if (byBoat) return byBoat;
  const planned = await planRoute(leg, context, startedAt);
  if (planned.kind === "ended") return planned.result;
  return judgeRoute(leg, planned.route, planned.swim, context);
}

/** A destination the route must not try: an active portal, another dimension, or a mid-air target. */
function refusalBeforeRoute(leg: NavigateLeg): NavigateResult | null {
  const { bot, request, startDimension } = leg;
  const problem = portalProblem(leg);
  if (problem) return { status: "failed", error: problem, navigation: legEvidence(leg) };
  if (bot.game.dimension !== startDimension) {
    return { status: "failed", error: navigateOutcomes.dimensionChanged(startDimension, bot.game.dimension), navigation: legEvidence(leg) };
  }
  if (request.y !== null && !request.build && !targetSupported(bot, { x: request.x, y: request.y, z: request.z }, request.range)) {
    const target = { x: request.x, y: request.y, z: request.z };
    return {
      status: "failed",
      error: navigateOutcomes.unsupportedTarget(target, request.range, groundBelow(bot, target)),
      navigation: legEvidence(leg),
    };
  }
  return null;
}

/**
 * The goal of the asked route. Keep an unloaded surface unresolved while approaching its column. Once observed, freeze
 * the actual destination, including height, for both search and the final receipt. Horizontal proximity alone never
 * completes it.
 */
function destinationGoal(leg: NavigateLeg): Goal {
  const { request } = leg;
  return {
    resolve(observation) {
      if (leg.destination === null) {
        const surface = surfaceAt(leg.bot, request.x, request.z);
        if (surface === null) {
          const approach = nearXzGoal(request, request.range).resolve(observation);
          return approach.kind === "active" ? { ...approach, isSatisfied: () => false } : approach;
        }
        const resolved = resolveSurfaceDestination(leg, surface);
        if (resolved !== null) return resolved;
      }
      const problem = portalProblem(leg);
      if (problem) return { kind: "invalid", observation: problem };
      return nearGoal(leg.destination!, request.range).resolve(observation);
    },
  };
}

/** Sets the destination from the observed surface of the target's column; the refusal when it cannot. */
function resolveSurfaceDestination(leg: NavigateLeg, surface: NonNullable<ReturnType<typeof surfaceAt>>): ReturnType<Goal["resolve"]> | null {
  const { bot, request } = leg;
  if (surface.kind === "ambiguous") {
    // The caller named the height it means (its own feet): the floor nearest it, neither the canopy nor a cave.
    const nearY = request.nearY ?? null;
    if (nearY === null || surface.floors.length === 0) return { kind: "invalid", observation: surface.observation };
    const floor = [...surface.floors].sort((a, b) => Math.abs(a - nearY) - Math.abs(b - nearY))[0]!;
    leg.destination = { x: request.x, y: floor, z: request.z };
    return null;
  }
  const shore = shoreNear(bot, request);
  if (!shore) return { kind: "invalid", observation: navigateOutcomes.targetOnWater(request, SHORE_SEARCH_RADIUS) };
  const ground = surfaceAt(bot, shore.x, shore.z);
  if (!ground || ground.kind === "ambiguous" || !standable(bot, new Vec3(shore.x, ground.y + 1, shore.z))) {
    return { kind: "invalid", observation: "No standable surface was observed in the destination column." };
  }
  leg.destination = { x: shore.x, y: ground.y + 1, z: shore.z };
  return null;
}

/**
 * With a boat carried, a long stretch of deep open water on the straight way is crossed by boat at once, as a player
 * does, rather than walked round (live 2026-10-04: two and a half minutes round a bay 380 blocks across).
 */
async function crossByBoatFirst(leg: NavigateLeg, context: ActionContext): Promise<NavigateResult | null> {
  const { bot, request } = leg;
  if (leg.crossings !== 0 || !carriesBoat(bot)) return null;
  const ahead = deepWaterOnTheWay(bot, bot.entity.position, request);
  // Not from high above the water (live 2026-10-10: Lena, 23 blocks up, crashed here): no boat goes in from a
  // cliff; the route is planned first, and from a perch it falls into the water before crossing.
  const nearTheWater = ahead !== null && bot.entity.position.y - ahead.start.y <= DEFAULT_MAXIMUM_DROP + 1;
  if (ahead === null || !nearTheWater || ahead.shore === null || ahead.length < BOAT_FIRST_LENGTH) return null;
  return crossDeepWater(leg, {
    status: "failed",
    error: navigateOutcomes.deepWater(request, ahead.start, ahead.length),
    navigation: legEvidence(leg),
  }, undefined, context);
}

/** A planned and walked route, or the result that ended the leg before one (a lost tool, a failed execution). */
type PlannedRoute =
  | { readonly kind: "routed"; readonly route: NavigationResult; readonly swim: ReturnType<typeof watchSwim> | null }
  | { readonly kind: "ended"; readonly result: NavigateResult };

/** Plans and walks the route under the swim watch, once more with a fallback scaffold when none of the policy's is carried. */
async function planRoute(leg: NavigateLeg, context: ActionContext, startedAt: number): Promise<PlannedRoute> {
  const { bot, request, toolLoss } = leg;
  const goal = destinationGoal(leg);
  const swim = leg.swimFree || carriesBoat(bot) ? null : watchSwim(bot);
  try {
    const stopSignals = [toolLoss?.signal, swim?.signal].filter((signal) => signal !== undefined);
    const stopSignal = stopSignals.length > 0 ? AbortSignal.any(stopSignals) : undefined;
    let route = await attemptRoute(leg, goal, context, stopSignal, false);
    // No path and none of the policy's scaffold blocks carried (a bot stranded on a perch with only stone): plan
    // once more with the common block it holds the most of, and report the stock it spends beside the others.
    if (route.status === "stopped" && route.calculationFailed && request.scaffold && preferredScaffoldItem(bot) === null) {
      const fallback = fallbackScaffoldItem(bot);
      if (fallback !== null) {
        leg.scaffoldInventoryBefore.set(fallback.name, bot.inventory.count(fallback.type, null));
        const firstElapsedMs = route.elapsedMs;
        route = await attemptRoute(leg, goal, context, stopSignal, true);
        route = { ...route, elapsedMs: route.elapsedMs + firstElapsedMs };
      }
    }
    const lost = toolLoss?.loss();
    if (lost) {
      leg.elapsedMs += Date.now() - startedAt;
      return { kind: "ended", result: { status: "partial", error: lost.reason, navigation: legEvidence(leg) } };
    }
    return { kind: "routed", route, swim };
  } catch (cause) {
    leg.elapsedMs += Date.now() - startedAt;
    // Navigation settles its controls and can report an unrestored doorway.
    // Preserve that evidence when propagating the action's cancellation.
    if (context.signal?.aborted) throw cause;
    return { kind: "ended", result: { status: "failed", error: navigateOutcomes.executionFailed(cause), navigation: legEvidence(leg) } };
  } finally {
    swim?.close();
  }
}

/** One planned and walked route to the goal with the request's movement rules. */
function attemptRoute(
  leg: NavigateLeg,
  goal: Goal,
  context: ActionContext,
  stopSignal: AbortSignal | undefined,
  scaffoldFallback: boolean,
): Promise<NavigationResult> {
  const { bot, request, dependencies, toolLoss } = leg;
  return dependencies.navigate({
    movements: dependencies.createMovements(bot, {
      scaffolding: request.scaffold,
      allowDigging: request.dig,
      ...(scaffoldFallback && { scaffoldFallback }),
    }),
    goal,
    signal: context.signal,
    ...(stopSignal && { stopSignal }),
    ...(toolLoss && { onToolSelected: toolLoss.select }),
  });
}

/** What the walked route came to: arrived, too far, stopped (then a climb out or a crossing), or out of swim budget. */
async function judgeRoute(
  leg: NavigateLeg,
  route: NavigationResult,
  swim: ReturnType<typeof watchSwim> | null,
  context: ActionContext,
): Promise<NavigateResult> {
  const { request } = leg;
  leg.elapsedMs += route.elapsedMs;
  const evidence = legEvidence(leg);
  if (evidence.endDimension !== evidence.startDimension) {
    return { status: "failed", error: navigateOutcomes.dimensionChanged(evidence.startDimension, evidence.endDimension), navigation: evidence };
  }
  if (route.escapeRelaxed?.length) evidence.escapeRelaxed = [...route.escapeRelaxed];
  const swum = swim?.exceeded();
  if (swum && route.status === "stopped") {
    return { status: "failed", error: navigateOutcomes.deepWater(request, swum.start, swum.blocks), navigation: evidence };
  }
  if (route.status === "stopped") {
    const stopped: NavigateResult = { status: "failed", error: navigateOutcomes.stopped(route.reason), navigation: evidence };
    return (await climbOutFirst(leg, stopped, context)) ?? crossDeepWater(leg, stopped, route, context);
  }
  if (leg.destination === null) {
    return crossDeepWater(leg, {
      status: "failed",
      error: "[NAVIGATION_SURFACE_UNOBSERVED] The destination surface was not observed; horizontal proximity is not arrival.",
      navigation: evidence,
    }, route, context);
  }
  if (evidence.remainingDistance !== null && evidence.remainingDistance > request.range) {
    return crossDeepWater(leg, {
      status: "failed",
      error: navigateOutcomes.incomplete(evidence.remainingDistance, request.range),
      navigation: evidence,
    }, route, context);
  }
  return { status: "succeeded", navigation: evidence };
}

/**
 * Deep under the ground with the way on far above, a route through the rock stalls (live 2026-10-04: Ayla, at y 1,
 * saw every route to the surface 30 blocks off stop "planning_stalled" for 15 minutes; one straight up worked):
 * the surface straight above first, digging up to it, then the way on from there. Null when that does not apply.
 */
async function climbOutFirst(leg: NavigateLeg, stopped: NavigateResult, context: ActionContext): Promise<NavigateResult | null> {
  const { bot, request } = leg;
  if (leg.climbed || !request.dig || context.signal?.aborted) return null;
  const feet = bot.entity.position;
  const above = highestFloor(bot, Math.floor(feet.x), Math.floor(feet.z));
  const goal = leg.destination?.y ?? request.y;
  if (above === null || above - feet.y < CLIMB_OUT_HEIGHT || (goal !== null && goal - feet.y < CLIMB_OUT_HEIGHT)) return null;
  const up = { ...request, x: Math.floor(feet.x), y: above, z: Math.floor(feet.z), range: 1 };
  const climb = await nextLeg(leg, up, { crossings: MAX_CROSSINGS, climbed: true }, context);
  if (climb.status !== "succeeded") return null;
  const onward = await nextLeg(leg, request, { crossings: leg.crossings, climbed: true }, context);
  return { ...onward, navigation: { ...onward.navigation, start: stopped.navigation.start } };
}

/**
 * A route never sets off across deep open water (movement policy). Stopped short with deep water on the straight way
 * on, it says so, or crosses by boat with one carried and goes on from the far side (spec 2026-10-04).
 */
async function crossDeepWater(
  leg: NavigateLeg,
  stopped: NavigateResult,
  route: NavigationResult | undefined,
  context: ActionContext,
): Promise<NavigateResult> {
  const { bot, request } = leg;
  if (leg.crossings >= MAX_CROSSINGS || context.signal?.aborted) return stopped;
  const here = bot.entity.position.clone();
  const water = deepWaterOnTheWay(bot, here, request);
  if (water === null) return stopped;
  const fell = await fallIntoTheWaterFirst(leg, stopped, route, here, context);
  if (fell !== null) return fell;
  if (!carriesBoat(bot)) {
    return { ...stopped, status: "failed", error: navigateOutcomes.deepWater(request, water.start, water.length) };
  }
  return crossByBoatFromHere(leg, stopped, water, context);
}

/**
 * Perched high over deep water with no way down but the fall into it (live 2026-10-10: Lena, on a furnace 23 blocks
 * up): the planner offers the landing but never plans on from it, because swimming deep water is for a bot already
 * out on it. So the fall is made first, to the node the search reached, and the way on is planned from the sea.
 * Null when that does not apply or the fall did not succeed.
 */
async function fallIntoTheWaterFirst(
  leg: NavigateLeg,
  stopped: NavigateResult,
  route: NavigationResult | undefined,
  here: Vec3,
  context: ActionContext,
): Promise<NavigateResult | null> {
  const { bot, request } = leg;
  const landing = route?.status === "stopped" ? route.closest : undefined;
  if (landing === undefined || landing.y >= Math.floor(here.y) - DEFAULT_MAXIMUM_DROP ||
    !isWater(liveBlockReader(bot)(landing.x, landing.y, landing.z))) return null;
  const fell = await nextLeg(leg, { ...request, x: landing.x, y: landing.y, z: landing.z, range: 0 }, { crossings: MAX_CROSSINGS }, context);
  if (fell.status !== "succeeded") return null;
  const onward = await nextLeg(leg, request, { crossings: leg.crossings + 1 }, context);
  return { ...onward, navigation: { ...onward.navigation, start: stopped.navigation.start } };
}

/**
 * Already out on the water. Just off the boat by the far bank (live 2026-10-04), the way on is ashore: no boat goes back
 * in. Out at sea otherwise (live 2026-10-04: Vex, swimming at sea, was told "no shore at the water's level" ten times in
 * a row), the boat goes in where she is.
 */
async function crossByBoatFromHere(
  leg: NavigateLeg,
  stopped: NavigateResult,
  water: NonNullable<ReturnType<typeof deepWaterOnTheWay>>,
  context: ActionContext,
): Promise<NavigateResult> {
  const { bot, request } = leg;
  const atSea = water.shore === null;
  if (atSea && leg.crossings > 0) return nextLeg(leg, request, { crossings: leg.crossings + 1 }, context);
  // To the water's edge, at the water's level: from a cliff the water is out of reach for a boat.
  const spot = atSea ? bot.entity.position.floored() : launchSpot(bot, water.start);
  if (spot === null) return { ...stopped, status: "failed", error: navigateOutcomes.boatCrossingFailed("no shore at the water's level near where the deep water starts") };
  if (!atSea && bot.entity.position.distanceTo(spot.offset(0.5, 0, 0.5)) > 1.5) {
    const shore = { ...request, x: spot.x, y: spot.y, z: spot.z, range: 0 };
    const atShore = await nextLeg(leg, shore, { crossings: MAX_CROSSINGS }, context);
    if (atShore.status !== "succeeded") return { ...stopped, status: "failed", error: navigateOutcomes.boatCrossingFailed(`could not reach the water's edge at ${spot.x} ${spot.y} ${spot.z}: ${atShore.status === "failed" ? atShore.error : atShore.status}`) };
  }
  const from = bot.entity.position;
  const length = Math.hypot(request.x - from.x, request.z - from.z);
  // At most to the target: across to it, not on over open sea; with no land by then she stays there, in her boat.
  const crossed = await crossByBoat(bot, { x: (request.x - from.x) / length, z: (request.z - from.z) / length }, context.signal, length);
  if (context.signal?.aborted) return stopped;
  if (crossed.status !== "crossed") {
    // Where the ride left her, not where the route had stopped before it.
    const navigation = { ...stopped.navigation, end: position(bot.entity.position), boatBlocks: crossed.blocks };
    // A target on open water is reached by the ride itself: she floats there in her boat, which is where she was sent.
    const left = Math.hypot(request.x - bot.entity.position.x, request.z - bot.entity.position.z);
    if (crossed.atSea && left <= Math.max(request.range, 1)) {
      return { status: "succeeded", navigation: { ...navigation, remainingDistance: left, afloat: true } };
    }
    return { ...stopped, navigation, status: "failed", error: navigateOutcomes.boatCrossingFailed(crossed.detail) };
  }
  const onward = await nextLeg(leg, request, { crossings: leg.crossings + 1 }, context);
  const boatBlocks = crossed.blocks + (onward.navigation.boatBlocks ?? 0);
  return { ...onward, navigation: { ...onward.navigation, start: stopped.navigation.start, boatBlocks } };
}

/** The line that tells the model which rule of its own was set aside once to get it out of a pocket, and what that dug. */
function describeEscape(relaxed: readonly string[]): string {
  const flowing = relaxed.includes(RELAXED_FLOWING_WATER);
  if (!relaxed.includes(RELAXED_DIG_STRAIGHT_DOWN))
    return "- Dug out of a pocket beside flowing water: a dig that lets in flowing water was allowed once (a water source and lava still refuse).";
  return `- Dug down out of a pocket: your rule against digging straight down was set aside once${flowing ? " and a dig next to flowing water was allowed" : ""}.`;
}

export function formatNavigateResult(result: NavigateResult): string {
  const { navigation } = result;
  const evidence = [
    navigation.remainingDistance === null
      ? `Dimension changed from \`${navigation.startDimension}\` to \`${navigation.endDimension}\`; distance to the source-world target does not apply.`
      : `Final Pathfinder node is **${navigation.remainingDistance.toFixed(2)} blocks** from the target; requested range is **${navigation.range} blocks** in \`${navigation.endDimension}\`.`,
    `- Target: \`${navigation.target.x}, ${navigation.target.y ?? "ground"}, ${navigation.target.z}\``,
    `- Start: \`${navigation.start.x.toFixed(2)}, ${navigation.start.y.toFixed(2)}, ${navigation.start.z.toFixed(2)}\``,
    `- End: \`${navigation.end.x.toFixed(2)}, ${navigation.end.y.toFixed(2)}, ${navigation.end.z.toFixed(2)}\``,
    ...(navigation.afloat ? ["- Arrived, afloat in its boat at " + Math.round(navigation.end.x) + " " + Math.round(navigation.end.z)] : []),
    ...(navigation.escapeRelaxed?.length ? [describeEscape(navigation.escapeRelaxed)] : []),
    ...(navigation.landLeg ? [`- Swam to land first: \`${navigation.landLeg.x}, ${navigation.landLeg.y}, ${navigation.landLeg.z}\``] : []),
    `- Pathfinder elapsed: ${navigation.elapsedMs} ms`,
    "- Scaffold stocks:",
    ...navigation.scaffolding.map(
      ({ item, inventoryBefore, inventoryAfter, consumed }) =>
        `  - ${item}: ${inventoryBefore} → ${inventoryAfter} (used ${consumed})`,
    ),
  ].join("\n");
  const outcome = result.status === "succeeded" ? evidence : `${evidence}\n\n**Observed stop:** ${result.error}`;
  return navigation.missingDigTools.length === 0
    ? outcome
    : `${outcome}\n\n**Warning:** Missing ${navigation.missingDigTools.join(", ")}. Navigation may be slow and inefficient.`;
}

export function createNavigateAction(
  bot: Bot,
  navigation: NavigationRuntime,
  dependencies: NavigateDependencies = productionDependencies(navigation.navigate),
) {
  return defineAction({
    checkpointSchema: navigateCheckpointSchema,
    name: NAVIGATE,
    description: NAVIGATE_DESCRIPTION,
    inputSchema: navigateInputSchema,
    resultSchema: navigateResultSchema,
    formatResult: formatNavigateResult,
    movement: "travel",
    execution: { kind: "resumable_task", prepare: (signal) => prepareBotForMovement(bot, navigation, signal) },
    annotations: {
      title: NAVIGATE,
      destructiveHint: true,
      openWorldHint: true,
    },
    parse: parseNavigateRequest,
    begin: (request, lifetime, observe) => beginNavigate(bot, request, dependencies, lifetime, { observe }),
  });
}
