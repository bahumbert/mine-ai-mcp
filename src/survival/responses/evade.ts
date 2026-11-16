// Emergency withdrawal: one budget across committed routes, cover waits and projectile guards.
import type { Bot } from "mineflayer";
import { createMovements, type NavigationRuntime } from "../../navigation/index.js";
import { isHeadPassable, isPassable, isSafeSupport, navigationFeet } from "../../navigation/world/block-geometry.js";
import { monotonicNow } from "../../utils/index.js";
import { PhysicsStoppedError, waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import type { ResponseContext } from "../control/combat/context.js";
import { encounterBaseline, type EvadeResponseResult } from "../control/combat/response-result.js";
import { incomingShieldProjectiles } from "../perception/combat/shield-projectiles.js";
import { creeperEscape } from "../policy/combat/tactics.js";
import type { HostileDirective } from "../policy/combat/response.js";
import type { AttemptBudget } from "../state/budgets.js";
import { equipCombatLoadout, permittedMeleeLoadout, readCombatItems } from "../weapons/equipment.js";
import { combatItemsForTarget } from "../weapons/melee.js";
import { guardRetreatProjectiles, RETREAT_PROJECTILE_ALLOWANCE, retreatGuardLimit } from "../weapons/projectile-guard.js";
import { defendWhileRetreating } from "../weapons/retreat-melee.js";
import { evadeExhaustion } from "./evade-detail.js";
import { EvadeObservation } from "./evade-observation.js";

export { evadeDetail } from "./evade-detail.js";
type Route = Awaited<ReturnType<NavigationRuntime["navigate"]>>;
interface Flight {
  readonly bot: Bot;
  readonly navigation: NavigationRuntime;
  readonly context: ResponseContext;
  readonly observed: EvadeObservation;
  readonly budget: AttemptBudget;
  readonly signal: AbortSignal;
  projectileGuards: number;
}

/** A route stop must finish on supported, passable feet before handing the body back. */
function bodySettled({ bot, navigation }: Flight, completed = false): boolean {
  if (completed) return true;
  const at = navigationFeet(bot.entity.position, bot.entity.onGround);
  return bot.entity.onGround && isSafeSupport(navigation.world.blockAt(at.x, at.y - 1, at.z))
    && isPassable(navigation.world.blockAt(at.x, at.y, at.z))
    && isHeadPassable(navigation.world.blockAt(at.x, at.y + 1, at.z));
}

/** Existing fuse clearance keeps precedence over both a stop for cover and a stationary guard. */
function escapeRequired({ context }: Flight): boolean {
  const { perception } = context;
  const creepers = perception.creeperClearance.observe(perception.tick, perception.resolvedIds);
  const escape = creeperEscape({ creepers, clearancePending: perception.creeperClearance.pending, stationaryCommitment: true });
  if (escape) perception.creeperClearance.require(creepers.filter((threat) => escape.threatIds.includes(threat.id)));
  return escape !== null;
}

/** Projectiles in flight veto even dead/range separation until their physical danger clears. */
function inFlight(flight: Flight): boolean {
  return incomingShieldProjectiles(flight.bot, RETREAT_PROJECTILE_ALLOWANCE).length > 0 || escapeRequired(flight);
}

/** Re-evaluate live reach independently of the route's frozen goal. */
function separated(flight: Flight, completed = false): boolean {
  return flight.observed.ends().every((end) => end.basis !== null) && !inFlight(flight) && bodySettled(flight, completed);
}

/** Stop signals ask navigation to settle its current transaction before releasing movement. */
async function navigateEvade(flight: Flight): Promise<{ route: Route; reached: boolean; incoming: boolean }> {
  const { bot, navigation, context, observed, budget, signal } = flight;
  const incoming = new AbortController();
  const reached = new AbortController();
  const observeStop = () => {
    if (signal.aborted) return;
    if (separated(flight)) reached.abort("Threats can no longer reach the bot.");
    if (context.policy.shield && !escapeRequired(flight) && !retreatGuardLimit(bot, context.policy)
      && incomingShieldProjectiles(bot, RETREAT_PROJECTILE_ALLOWANCE).length > 0)
      incoming.abort("Incoming projectile requires a settled shield guard.");
  };
  bot.on("physicsTick", observeStop);
  try {
    observeStop();
    const route: Route = incoming.signal.aborted && bot.entity.onGround
      ? { status: "stopped", reason: String(incoming.signal.reason), elapsedMs: 0 }
      : await navigation.navigate({
        // Supported routes cannot depend on momentum that an incoming hit can reset (fortress replay, P4-29).
        movements: createMovements(bot, { allowParkour: false, allowDigging: context.policy.terrain.dig,
          scaffolding: context.policy.terrain.place }),
        goal: { resolve: (observation) => observed.goal.resolve(observation) },
        signal, stopSignal: AbortSignal.any([incoming.signal, reached.signal]), timeoutMs: Math.max(1, budget.remaining),
        searchLimits: { primaryTimeoutMs: 500, failureTimeoutMs: 500, maximumRadius: 48 },
      });
    return { route, reached: reached.signal.aborted, incoming: incoming.signal.aborted };
  } finally {
    bot.off("physicsTick", observeStop);
  }
}

/** Hold cover without restarting a completed route; a real-time timer also ends a frozen physics stream. */
async function waitInCover(flight: Flight): Promise<void> {
  const { bot, observed, budget, signal } = flight;
  bot.clearControlStates();
  while (!signal.aborted && !budget.exhausted && !separated(flight) && observed.canWaitInCover(observed.ends())) {
    try { await waitForPhysicsTicks(bot, 1, signal, { wallMs: budget.remaining }); }
    catch (cause) { if (cause instanceof PhysicsStoppedError) return; throw cause; }
    observed.observe();
  }
  if (!budget.exhausted && !separated(flight)) observed.refreshGoal();
}

/** Continue only within the original attempt, re-judging every settled stop and changed arrival. */
async function followEvadeRoutes(flight: Flight): Promise<{ route: Route; guardStop: string | null }> {
  const { bot, observed, budget, signal } = flight;
  let retriedAt: string | null = null;
  let retryRefresh = -1;
  let route: Route = { status: "stopped", reason: "navigation timeout", elapsedMs: 0 };
  while (!budget.exhausted) {
    signal.throwIfAborted();
    const routeStart = bot.entity.position.floored();
    const stopped = await navigateEvade(flight);
    route = stopped.route;
    observed.observe();
    if (separated(flight, route.status === "completed") || budget.exhausted || signal.aborted) break;
    if (stopped.incoming) {
      flight.projectileGuards++;
      const guard = await guardRetreatProjectiles(bot, flight.navigation, signal, monotonicNow() + budget.remaining,
        flight.context.policy, () => escapeRequired(flight));
      if (guard.kind === "stopped") return { route, guardStop: guard.reason };
      continue;
    }
    if (stopped.reached) continue;
    if (route.status !== "completed") break;
    if (observed.canWaitInCover(observed.ends()) && bodySettled(flight)) {
      await waitInCover(flight);
      // Arrival certified the body before the hold, not after a displacement during it (P4-29 T6 review).
      route = { status: "stopped", reason: "Cover wait ended without settled safe separation", elapsedMs: route.elapsedMs };
      if (separated(flight) || budget.exhausted) break;
      continue;
    }
    const at = bot.entity.position.floored().toString();
    if (bot.entity.position.floored().equals(routeStart) && retriedAt === at && retryRefresh === observed.goalRefreshes) break;
    observed.refreshGoal();
    retriedAt = at;
    retryRefresh = observed.goalRefreshes;
  }
  return { route, guardStop: null };
}

/** Execute one measured escape; loadout, route changes and waiting all spend the same monotonic budget. */
export async function evade(bot: Bot, navigation: NavigationRuntime,
  request: Extract<HostileDirective, { kind: "evade" }>, context: ResponseContext,
  healthBefore: number, signal: AbortSignal): Promise<EvadeResponseResult> {
  const observed = new EvadeObservation(bot, context, request.threats, request.safeRange);
  using budget = context.survival.budgets.attempt({ name: "evade", scope: `cell:${bot.entity.position.floored()}`,
    unit: "milliseconds", limit: context.policy.evade_timeout_ms, measure: monotonicNow, startedAt: observed.startedAtMs,
    exhaustion: "Return observed separation or an exhausted escape; route changes and projectile guards cannot renew it." });
  const flight: Flight = { bot, navigation, context, observed, budget, signal, projectileGuards: 0 };
  let explosions = 0;
  const explosion = () => { explosions++; };
  const observe = () => { if (!signal.aborted) observed.observe(); };
  const resolved = (entity: Bot["entity"]) => observed.resolved(entity.id);
  let defence: ReturnType<typeof defendWhileRetreating> | undefined;
  const evidence = () => {
    const melee = defence?.evidence() ?? { attacks: 0, weaponsUsed: [], killedTargetIds: [] };
    return { ...encounterBaseline(bot, { ...request, threats: observed.threats() }, healthBefore),
      response: "evade" as const, ...melee, combatStyles: melee.attacks ? ["melee" as const] : [],
      shieldRaisedSwings: 0, projectileGuards: flight.projectileGuards, explosions,
      elapsedMs: monotonicNow() - observed.startedAtMs, startPosition: observed.startPosition,
      goalRefreshes: observed.goalRefreshes, ends: observed.ends() };
  };
  bot.on("entityDead", resolved);
  bot.on("physicsTick", observe);
  bot._client.on("explosion", explosion);
  try {
    const target = request.threats.map((threat) => bot.entities[threat.id]).find((entity) => entity?.isValid);
    await equipCombatLoadout(bot, permittedMeleeLoadout(bot, target ? combatItemsForTarget(bot, target) : readCombatItems(bot), context.policy), signal);
    signal.throwIfAborted();
    defence = defendWhileRetreating(bot, context, signal);
    observed.observe();
    const { route, guardStop } = await followEvadeRoutes(flight);
    observed.observe();
    const common = evidence();
    if (separated(flight, route.status === "completed")) return { ...common, result: { kind: "separated" } };
    const reason = guardStop ?? (budget.exhausted ? "Emergency evade stopped without settled safe separation: navigation timeout" : route.status === "stopped"
      ? `Emergency evade stopped without settled safe separation: ${route.reason}`
      : "Emergency evade completed without observing the requested separation");
    return { ...common, result: { kind: "exhausted", reason: evadeExhaustion(reason, common.elapsedMs, common.ends, inFlight(flight)) } };
  } catch (cause) {
    return { ...evidence(), result: { kind: "failed", reason: cause instanceof Error ? cause.message : String(cause) } };
  } finally {
    defence?.[Symbol.dispose]();
    bot.off("physicsTick", observe);
    bot.off("entityDead", resolved);
    bot._client.off("explosion", explosion);
  }
}
