import { bucketDropTotals } from "../../navigation/mineflayer/water-landing.js";
import { navigateCheckpointSchema } from "../checkpoint-schemas.js";
/** Navigate once, then report the position the world actually yielded. */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import {
  canOccupyWater,
  createMovements,
  nearGoal,
  nearXzGoal,
  type Goal,
  type Navigate,
  type NavigationResult,
  type NavigationRuntime,
} from "../../navigation/index.js";
import { DEFAULT_MAXIMUM_DROP, fallbackScaffoldItem, preferredScaffoldItem, scaffoldBlockNames } from "../../navigation/mineflayer/movement-policy.js";
import { observeMineflayerBlock } from "../../navigation/mineflayer/world.js";
import { isSafeSupport, navigationFeet } from "../../navigation/world/block-geometry.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import type { ObserveRequest } from "../../session/request.js";
import { asVec3, type Position3 } from "../../utils/index.js";
import { defineAction, type ActionContext } from "../action.js";
import { observeToolTierLoss } from "../../world/tool-loss.js";
import { feetAtSea } from "../../navigation/mineflayer/movement-policy.js";
import { holdsWater } from "../../navigation/world/deep-water.js";
import { carriesBoat, crossByBoat, deepWaterOnTheWay, launchSpot } from "./boat-crossing.js";

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

/** How far below a target to look for ground when refusing it, so the refusal can name the height instead. */
const GROUND_SEARCH_DEPTH = 64;

function passable(bot: Bot, cell: Vec3): boolean {
  const block = bot.blockAt(cell);
  return block !== null && block.boundingBox === "empty" && block.name !== "water" && block.name !== "lava";
}

function supported(bot: Bot, feet: Vec3): boolean {
  const block = bot.blockAt(feet.offset(0, -1, 0));
  return block !== null && isSafeSupport(observeMineflayerBlock(block));
}

/** Feet and head clear, and something solid to stand on. Unloaded cells are not standable. */
function standable(bot: Bot, feet: Vec3): boolean {
  return passable(bot, feet) && passable(bot, feet.offset(0, 1, 0)) && supported(bot, feet);
}

/**
 * Reject unsupported mid-air destinations unless building was requested.
 * Existing footing is enough: movement policy owns whether feet and head
 * cells can be excavated. Unloaded targets must be judged during the route.
 */
function targetSupported(bot: Bot, target: { x: number; y: number; z: number }, range: number): boolean {
  const centre = new Vec3(target.x, target.y, target.z);
  if (bot.blockAt(centre) === null) return true;
  const reach = Math.ceil(range);
  for (let dx = -reach; dx <= reach; dx += 1) {
    for (let dy = -reach; dy <= reach; dy += 1) {
      for (let dz = -reach; dz <= reach; dz += 1) {
        const feet = centre.offset(dx, dy, dz);
        if (feet.distanceTo(centre) <= range && (supported(bot, feet) || canOccupyWater(bot, feet))) return true;
      }
    }
  }
  return false;
}

/** How far around a watery target the existing shore search looks. */
const SHORE_SEARCH_RADIUS = 8;

/**
 * How far from a bot at sea, without a boat, dry land is looked for before the asked route (run 10: Ayla, left
 * standing in the water, swam ~1500 blocks because the planner allows deep water for a bot already out on it).
 */
const LAND_SEARCH = 32;

type SurfaceObservation =
  | { readonly kind: "surface"; readonly y: number; readonly name: string; readonly solid: boolean }
  | { readonly kind: "ambiguous"; readonly observation: string; readonly floors: readonly number[] };

/** Omitted height may resolve only an unambiguous outdoor column, never choose among floors. */
function surfaceAt(bot: Bot, x: number, z: number): SurfaceObservation | null {
  // The game plugin supplies these dimension bounds; Mineflayer's type omits them.
  const dimension = bot.game as typeof bot.game & { minY: number; height: number };
  const bottom = dimension.minY;
  const top = bottom + dimension.height - 1;
  let highest: Extract<SurfaceObservation, { kind: "surface" }> | null = null;
  const floors: number[] = [];
  for (let y = top; y >= bottom; y--) {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) return null;
    if (block.boundingBox !== "block" && block.name !== "water" && block.name !== "lava") continue;
    highest ??= { kind: "surface", y, name: block.name, solid: block.boundingBox === "block" };
    if (y + 2 <= top && standable(bot, new Vec3(x, y + 1, z))) floors.push(y + 1);
  }
  if (highest && (highest.name.endsWith("_leaves") || highest.name === "bedrock" || floors.length > 1)) {
    return {
      kind: "ambiguous",
      observation: `[NAVIGATION_HEIGHT_REQUIRED] Column ${x}, ${z} has highest block ${highest.name} at y=${highest.y}; observed standable feet heights: ${floors.join(", ") || "none"}. Supply y (or near_y) to choose a floor.`,
      floors,
    };
  }
  return highest;
}

/**
 * Where a ground target on water is really going: the nearest column within
 * a few blocks whose surface is solid ground the bot can stand on. Both
 * bucket deaths in the playthroughs began with a walk to "the water at x,z",
 * which the ground goal resolved to the lake bed.
 */
function shoreNear(bot: Bot, target: { x: number; z: number }, reach = SHORE_SEARCH_RADIUS): { x: number; z: number } | null {
  const surface = surfaceAt(bot, target.x, target.z);
  if (!surface || surface.kind === "ambiguous" || surface.solid) return target;
  for (let radius = 1; radius <= reach; radius += 1) {
    let nearest: { x: number; z: number } | null = null;
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const x = target.x + dx;
        const z = target.z + dz;
        const candidate = surfaceAt(bot, x, z);
        if (candidate?.kind === "surface" && candidate.solid && standable(bot, new Vec3(x, candidate.y + 1, z)) &&
          (nearest === null || Math.hypot(dx, dz) < Math.hypot(nearest.x - target.x, nearest.z - target.z))) nearest = { x, z };
      }
    }
    if (nearest !== null) return nearest;
  }
  return null;
}

/** The highest standable feet cell at or below the target in its column, if one is loaded. */
function groundBelow(bot: Bot, target: { x: number; y: number; z: number }): number | null {
  for (let y = target.y; y >= target.y - GROUND_SEARCH_DEPTH; y -= 1) {
    if (standable(bot, new Vec3(target.x, y, target.z))) return y;
  }
  return null;
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

/** The feet height of the highest place to stand in a column (its surface, above any caves); null when not loaded. */
function highestFloor(bot: Bot, x: number, z: number): number | null {
  const dimension = bot.game as typeof bot.game & { minY: number; height: number };
  for (let y = dimension.minY + dimension.height - 3; y >= dimension.minY; y--) {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) return null;
    if (block.boundingBox === "block" && standable(bot, new Vec3(x, y + 1, z))) return y + 1;
  }
  return null;
}

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

function beginNavigate(
  bot: Bot,
  request: NavigateRequest,
  dependencies: NavigateDependencies,
  lifetime: AbortSignal,
  observe: ObserveRequest = () => {},
  crossings = 0,
  climbed = false,
  unbudgeted = false,
) {
  const toolLoss = request.dig ? toolLossObserverOf(bot, lifetime) : null;
  const start = position(bot.entity.position);
  const startDimension = bot.game.dimension;
  const bucketBefore = bucketDropTotals(bot);
  const scaffoldInventoryBefore = new Map(
    scaffoldBlockNames(bot).map((item) => [item, bot.inventory.count(bot.registry.itemsByName[item]?.id ?? -1, null)]),
  );
  let elapsedMs = 0;
  let destination = request.y === null ? null : { x: request.x, y: request.y, z: request.z };
  observe(() => ({
    baseline: { dimension: startDimension, position: { ...start } },
    checkpoint: {
      destination,
      remainingDistance: destination && bot.game.dimension === startDimension
        ? bot.entity.position.distanceTo(asVec3(destination)) : null,
      dimension: bot.game.dimension,
      positionedDimension: startDimension,
      died: false,
      portal: null,
    },
    completion: {
      kind: "current",
      observed:
        destination !== null &&
        bot.game.dimension === startDimension &&
        asVec3(navigationFeet(bot.entity.position, bot.entity.onGround)).distanceTo(asVec3(destination)) <=
          request.range &&
        (bot.entity.onGround || canOccupyWater(bot, navigationFeet(bot.entity.position, bot.entity.onGround))),
      owes: "Current destination distance and supported footing or admitted water.",
    },
  }));
  const portalProblem = (): string | null => {
    if (!destination || bot.game.dimension !== startDimension) return null;
    const cell = asVec3(destination);
    const block = bot.blockAt(cell);
    return block?.name === "end_portal" || block?.name === "nether_portal"
      ? `[NAVIGATION_PORTAL_INTENT_REQUIRED] Use ${block.name === "end_portal" ? "enter_end_portal" : "enter_nether_portal"} to enter this active portal.`
      : null;
  };
  // The swim to land and a swim that started with no land in reach are not held to the swim budget.
  let swimFree = unbudgeted;
  let landLeg: Vec3 | null = null;
  let landLegMs = 0;
  /** The route, led by a swim to the nearest land when the bot starts at sea with no boat. */
  return async (context: ActionContext): Promise<NavigateResult> => {
    if (crossings === 0 && !carriesBoat(bot) && standsAtSea(bot)) {
      const land = shoreNear(bot, bot.entity.position.floored(), LAND_SEARCH);
      const ground = land === null ? null : surfaceAt(bot, land.x, land.z);
      if (land !== null && ground?.kind === "surface") {
        const spot = new Vec3(land.x, ground.y + 1, land.z);
        const leg = await beginNavigate(bot, { ...request, ...spot, range: 1 }, dependencies, lifetime, () => {}, MAX_CROSSINGS, false, true)(context);
        if (leg.status !== "succeeded") {
          return { ...leg, error: `${leg.error} (the swim to land at ${spot.x}, ${spot.y}, ${spot.z} came first)`, navigation: { ...leg.navigation, start } };
        }
        landLeg = spot;
        landLegMs = leg.navigation.elapsedMs;
      } else swimFree = true;
    }
    const result = await route0(context);
    if (landLeg === null) return result;
    const swam = `swam to land at ${landLeg.x}, ${landLeg.y}, ${landLeg.z} first`;
    const navigation = { ...result.navigation, start, landLeg: { x: landLeg.x, y: landLeg.y, z: landLeg.z }, elapsedMs: result.navigation.elapsedMs + landLegMs };
    return result.status === "failed" || result.status === "partial"
      ? { ...result, error: `${result.error} (${swam})`, navigation }
      : { ...result, navigation };
  };

  async function route0(context: ActionContext): Promise<NavigateResult> {
    const startedAt = Date.now();
    context.signal?.throwIfAborted();
    const problem = portalProblem();
    if (problem)
      return {
        status: "failed",
        error: problem,
        navigation: navigationEvidence(bot, request, start, startDimension, elapsedMs, scaffoldInventoryBefore, bucketBefore),
      };
    if (bot.game.dimension !== startDimension) {
      const evidence = navigationEvidence(bot, request, start, startDimension, elapsedMs, scaffoldInventoryBefore, bucketBefore);
      return {
        status: "failed",
        error: navigateOutcomes.dimensionChanged(startDimension, bot.game.dimension),
        navigation: evidence,
      };
    }
    if (
      request.y !== null &&
      !request.build &&
      !targetSupported(bot, { x: request.x, y: request.y, z: request.z }, request.range)
    ) {
      const target = { x: request.x, y: request.y, z: request.z };
      return {
        status: "failed",
        error: navigateOutcomes.unsupportedTarget(target, request.range, groundBelow(bot, target)),
        navigation: navigationEvidence(bot, request, start, startDimension, elapsedMs, scaffoldInventoryBefore, bucketBefore),
      };
    }
    // Unset until the first plan: the boat-first crossing below asks `overWater` before any route was planned.
    let route: NavigationResult | undefined;

    // Keep an unloaded surface unresolved while approaching its column. Once
    // observed, freeze the actual destination, including height, for both search
    // and the final receipt. Horizontal proximity alone never completes it.
    const evidenceRequest = () => (destination ? { ...request, ...destination } : request);
    const goal: Goal = {
      resolve(observation) {
        if (destination === null) {
          const surface = surfaceAt(bot, request.x, request.z);
          if (surface === null) {
            const approach = nearXzGoal(request, request.range).resolve(observation);
            return approach.kind === "active" ? { ...approach, isSatisfied: () => false } : approach;
          }
          if (surface.kind === "ambiguous") {
            // The caller named the height it means (its own feet): the floor nearest it, neither the canopy nor a cave.
            const nearY = request.nearY ?? null;
            if (nearY === null || surface.floors.length === 0) return { kind: "invalid", observation: surface.observation };
            const floor = [...surface.floors].sort((a, b) => Math.abs(a - nearY) - Math.abs(b - nearY))[0]!;
            destination = { x: request.x, y: floor, z: request.z };
            const problem = portalProblem();
            if (problem) return { kind: "invalid", observation: problem };
            return nearGoal(destination, request.range).resolve(observation);
          }
          const shore = shoreNear(bot, request);
          if (!shore)
            return { kind: "invalid", observation: navigateOutcomes.targetOnWater(request, SHORE_SEARCH_RADIUS) };
          const ground = surfaceAt(bot, shore.x, shore.z);
          if (!ground || ground.kind === "ambiguous" || !standable(bot, new Vec3(shore.x, ground.y + 1, shore.z))) {
            return { kind: "invalid", observation: "No standable surface was observed in the destination column." };
          }
          destination = { x: shore.x, y: ground.y + 1, z: shore.z };
        }
        const problem = portalProblem();
        if (problem) return { kind: "invalid", observation: problem };
        return nearGoal(destination, request.range).resolve(observation);
      },
    };

    // A route never sets off across deep open water (movement policy). Stopped short with deep water on the straight
    // way on, it says so, or crosses by boat with one carried and goes on from the far side (spec 2026-10-04).
    const overWater = async (stopped: NavigateResult): Promise<NavigateResult> => {
      if (crossings >= MAX_CROSSINGS || context.signal?.aborted) return stopped;
      const here = bot.entity.position.clone();
      const water = deepWaterOnTheWay(bot, here, request);
      if (water === null) return stopped;
      // Perched high over deep water with no way down but the fall into it (live 2026-10-10: Lena, on a furnace 23 blocks
      // up): the planner offers the landing but never plans on from it, because swimming deep water is for a bot already
      // out on it. So the fall is made first, to the node the search reached, and the way on is planned from the sea.
      const landing = route?.status === "stopped" ? route.closest : undefined;
      if (landing !== undefined && landing.y < Math.floor(here.y) - DEFAULT_MAXIMUM_DROP &&
        bot.blockAt(new Vec3(landing.x, landing.y, landing.z))?.name === "water") {
        const fell = await beginNavigate(bot, { ...request, x: landing.x, y: landing.y, z: landing.z, range: 0 }, dependencies, lifetime, () => {}, MAX_CROSSINGS)(context);
        if (fell.status === "succeeded") {
          const onward = await beginNavigate(bot, request, dependencies, lifetime, () => {}, crossings + 1)(context);
          return { ...onward, navigation: { ...onward.navigation, start: stopped.navigation.start } };
        }
      }
      if (!carriesBoat(bot)) {
        return { ...stopped, status: "failed", error: navigateOutcomes.deepWater(request, water.start, water.length) };
      }
      // Already out on the water. Just off the boat by the far bank (live 2026-10-04), the way on is ashore: no boat
      // goes back in. Out at sea otherwise (live 2026-10-04: Vex, swimming at sea, was told "no shore at the water's
      // level" ten times in a row), the boat goes in where she is.
      const atSea = water.shore === null;
      if (atSea && crossings > 0) return beginNavigate(bot, request, dependencies, lifetime, () => {}, crossings + 1)(context);
      // To the water's edge, at the water's level: from a cliff the water is out of reach for a boat.
      const spot = atSea ? bot.entity.position.floored() : launchSpot(bot, water.start);
      if (spot === null) return { ...stopped, status: "failed", error: navigateOutcomes.boatCrossingFailed("no shore at the water's level near where the deep water starts") };
      if (!atSea && bot.entity.position.distanceTo(spot.offset(0.5, 0, 0.5)) > 1.5) {
        const shore = { ...request, x: spot.x, y: spot.y, z: spot.z, range: 0 };
        const atShore = await beginNavigate(bot, shore, dependencies, lifetime, () => {}, MAX_CROSSINGS)(context);
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
      const onward = await beginNavigate(bot, request, dependencies, lifetime, () => {}, crossings + 1)(context);
      const boatBlocks = crossed.blocks + (onward.navigation.boatBlocks ?? 0);
      return { ...onward, navigation: { ...onward.navigation, start: stopped.navigation.start, boatBlocks } };
    };
    // With a boat carried, a long stretch of deep open water on the straight way is crossed by boat at once, as a
    // player does, rather than walked round (live 2026-10-04: two and a half minutes round a bay 380 blocks across).
    if (crossings === 0 && carriesBoat(bot)) {
      const ahead = deepWaterOnTheWay(bot, bot.entity.position, request);
      // Not from high above the water (live 2026-10-10: Lena, 23 blocks up, crashed here): no boat goes in from a
      // cliff; the route is planned first, and from a perch it falls into the water before crossing.
      const nearTheWater = ahead !== null && bot.entity.position.y - ahead.start.y <= DEFAULT_MAXIMUM_DROP + 1;
      if (ahead !== null && nearTheWater && ahead.shore !== null && ahead.length >= BOAT_FIRST_LENGTH) {
        return overWater({
          status: "failed",
          error: navigateOutcomes.deepWater(request, ahead.start, ahead.length),
          navigation: navigationEvidence(bot, evidenceRequest(), start, startDimension, elapsedMs, scaffoldInventoryBefore, bucketBefore),
        });
      }
    }

    const swim = swimFree || carriesBoat(bot) ? null : watchSwim(bot);
    try {
      const stopSignals = [toolLoss?.signal, swim?.signal].filter((signal) => signal !== undefined);
      const attempt = (scaffoldFallback: boolean) =>
        dependencies.navigate({
          movements: dependencies.createMovements(bot, {
            scaffolding: request.scaffold,
            allowDigging: request.dig,
            ...(scaffoldFallback && { scaffoldFallback }),
          }),
          goal,
          signal: context.signal,
          ...(stopSignals.length > 0 && { stopSignal: AbortSignal.any(stopSignals) }),
          ...(toolLoss && { onToolSelected: toolLoss.select }),
        });
      route = await attempt(false);
      // No path and none of the policy's scaffold blocks carried (a bot stranded on a perch with only stone): plan
      // once more with the common block it holds the most of, and report the stock it spends beside the others.
      if (route.status === "stopped" && route.calculationFailed && request.scaffold && preferredScaffoldItem(bot) === null) {
        const fallback = fallbackScaffoldItem(bot);
        if (fallback !== null) {
          scaffoldInventoryBefore.set(fallback.name, bot.inventory.count(fallback.type, null));
          const firstElapsedMs = route.elapsedMs;
          route = await attempt(true);
          route = { ...route, elapsedMs: route.elapsedMs + firstElapsedMs };
        }
      }
      const lost = toolLoss?.loss();
      if (lost) {
        elapsedMs += Date.now() - startedAt;
        return { status: "partial", error: lost.reason, navigation: navigationEvidence(
          bot, evidenceRequest(), start, startDimension, elapsedMs, scaffoldInventoryBefore, bucketBefore,
        ) };
      }
    } catch (cause) {
      elapsedMs += Date.now() - startedAt;
      // Navigation settles its controls and can report an unrestored doorway.
      // Preserve that evidence when propagating the action's cancellation.
      if (context.signal?.aborted) throw cause;
      return {
        status: "failed",
        error: navigateOutcomes.executionFailed(cause),
        navigation: navigationEvidence(
          bot,
          evidenceRequest(),
          start,
          startDimension,
          elapsedMs,
          scaffoldInventoryBefore,
          bucketBefore,
        ),
      };
    }

    finally {
      swim?.close();
    }

    elapsedMs += route.elapsedMs;
    // Deep under the ground with the way on far above, a route through the rock stalls (live 2026-10-04: Ayla, at y 1,
    // saw every route to the surface 30 blocks off stop "planning_stalled" for 15 minutes; one straight up worked):
    // the surface straight above first, digging up to it, then the way on from there.
    const climbOut = async (stopped: NavigateResult): Promise<NavigateResult | null> => {
      if (climbed || !request.dig || context.signal?.aborted) return null;
      const feet = bot.entity.position;
      const above = highestFloor(bot, Math.floor(feet.x), Math.floor(feet.z));
      const goal = destination?.y ?? request.y;
      if (above === null || above - feet.y < CLIMB_OUT_HEIGHT || (goal !== null && goal - feet.y < CLIMB_OUT_HEIGHT)) return null;
      const up = { ...request, x: Math.floor(feet.x), y: above, z: Math.floor(feet.z), range: 1 };
      const climb = await beginNavigate(bot, up, dependencies, lifetime, () => {}, MAX_CROSSINGS, true)(context);
      if (climb.status !== "succeeded") return null;
      const onward = await beginNavigate(bot, request, dependencies, lifetime, () => {}, crossings, true)(context);
      return { ...onward, navigation: { ...onward.navigation, start: stopped.navigation.start } };
    };
    const evidence = navigationEvidence(
      bot,
      evidenceRequest(),
      start,
      startDimension,
      elapsedMs,
      scaffoldInventoryBefore,
      bucketBefore,
    );
    if (evidence.endDimension !== evidence.startDimension) {
      return {
        status: "failed",
        error: navigateOutcomes.dimensionChanged(evidence.startDimension, evidence.endDimension),
        navigation: evidence,
      };
    }
    if (route.escapeRelaxed?.length) evidence.escapeRelaxed = [...route.escapeRelaxed];
    const swum = swim?.exceeded();
    if (swum && route.status === "stopped") {
      return { status: "failed", error: navigateOutcomes.deepWater(request, swum.start, swum.blocks), navigation: evidence };
    }
    if (route.status === "stopped") {
      const stopped: NavigateResult = { status: "failed", error: navigateOutcomes.stopped(route.reason), navigation: evidence };
      return (await climbOut(stopped)) ?? overWater(stopped);
    }
    if (destination === null) {
      return overWater({
        status: "failed",
        error:
          "[NAVIGATION_SURFACE_UNOBSERVED] The destination surface was not observed; horizontal proximity is not arrival.",
        navigation: evidence,
      });
    }
    if (evidence.remainingDistance !== null && evidence.remainingDistance > request.range) {
      return overWater({
        status: "failed",
        error: navigateOutcomes.incomplete(evidence.remainingDistance, request.range),
        navigation: evidence,
      });
    }
    return { status: "succeeded", navigation: evidence };
  }
}

/**
 * More than this many blocks swum in a row through deep open water with no boat stops the route (run 10: Ayla swam
 * ~1500 blocks of sea; nothing measured the water during a route, only after it stopped).
 */
const SWIM_BUDGET = 32;

/**
 * Counts the blocks the bot moves in a row with its feet in deep open water; past {@link SWIM_BUDGET} its signal
 * aborts, to stop the route. Reaching shallows or land starts the count over.
 */
function watchSwim(bot: Bot) {
  const stop = new AbortController();
  let last = bot.entity.position.clone();
  let cell = "";
  let atSea = false;
  let start: Vec3 | null = null;
  let swum = 0;
  const onMove = () => {
    const here = bot.entity.position;
    const moved = Math.hypot(here.x - last.x, here.z - last.z);
    last = here.clone();
    const feet = here.floored();
    const key = `${feet.x},${feet.y},${feet.z}`;
    if (key !== cell) {
      cell = key;
      atSea = standsAtSea(bot);
    }
    if (!atSea) {
      start = null;
      swum = 0;
      return;
    }
    start ??= feet;
    swum += moved;
    if (swum > SWIM_BUDGET && !stop.signal.aborted) stop.abort("[NAVIGATION_DEEP_WATER] swim budget spent");
  };
  bot.on("move", onMove);
  return {
    signal: stop.signal,
    close: () => void bot.off("move", onMove),
    exceeded: () => (stop.signal.aborted && start !== null ? { start, blocks: Math.floor(swum) } : null),
  };
}

/** Whether the bot's feet are in deep open water, by the same test the movement policy's sea exception uses. */
function standsAtSea(bot: Bot): boolean {
  const water = (x: number, y: number, z: number) => {
    const block = bot.blockAt(new Vec3(x, y, z));
    return block !== null && holdsWater(block.name, block.getProperties?.() ?? {});
  };
  const feet = bot.entity.position.floored();
  return feetAtSea(water, feet, (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.boundingBox === "block");
}

/** The line that tells the model a rule of its own style was set aside once to get it out of a pocket. */
function describeEscape(relaxed: readonly string[]): string {
  const flowing = relaxed.includes("dig_next_to_flowing_water") ? " and a dig next to flowing water was allowed" : "";
  return `- Dug down out of a pocket: your rule against digging straight down was set aside once${flowing}.`;
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
    movement: true,
    execution: { kind: "resumable_task", prepare: (signal) => prepareBotForMovement(bot, navigation, signal) },
    annotations: {
      title: NAVIGATE,
      destructiveHint: true,
      openWorldHint: true,
    },
    parse: parseNavigateRequest,
    begin: (request, lifetime, observe) => beginNavigate(bot, request, dependencies, lifetime, observe),
  });
}
