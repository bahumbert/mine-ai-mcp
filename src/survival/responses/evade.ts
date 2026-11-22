// Emergency withdrawal: one clock of server ticks across committed routes, cover waits and projectile guards.
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
import { equipCombatLoadout, permittedMeleeLoadout, readCombatItems } from "../weapons/equipment.js";
import { combatItemsForTarget } from "../weapons/melee.js";
import { guardRetreatProjectiles, RETREAT_PROJECTILE_ALLOWANCE, retreatGuardLimit } from "../weapons/projectile-guard.js";
import { defendWhileRetreating } from "../weapons/retreat-melee.js";
import { evadeExhaustion } from "./evade-detail.js";
import { EvadeClock, evadeBudgetTicks } from "./evade-clock.js";
import { EvadeObservation } from "./evade-observation.js";

export { evadeDetail } from "./evade-detail.js";
type Route = Awaited<ReturnType<NavigationRuntime["navigate"]>>;
interface Flight {
  readonly bot: Bot;
  readonly navigation: NavigationRuntime;
  readonly context: ResponseContext;
  readonly observed: EvadeObservation;
  readonly clock: EvadeClock;
  /** The caller's signal: its abort is a cancel, a failure of the evade. */
  readonly signal: AbortSignal;
  /** The caller's signal or the clock's: every awaited phase (loadout, cover wait, guard) stops on it. */
  readonly phase: AbortSignal;
  projectileGuards: number;
}

const NAVIGATION_TIMEOUT = "Emergency evade stopped without settled safe separation: navigation timeout";

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
  const { bot, navigation, context, observed, clock, signal } = flight;
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
        signal, stopSignal: AbortSignal.any([incoming.signal, reached.signal, clock.signal]), timeoutMs: clock.remainingMs(),
        searchLimits: { primaryTimeoutMs: 500, failureTimeoutMs: 500, maximumRadius: 48 },
      });
    return { route, reached: reached.signal.aborted, incoming: incoming.signal.aborted };
  } finally {
    bot.off("physicsTick", observeStop);
  }
}

/** Hold cover without restarting a completed route; the clock's wall also ends a frozen physics stream. */
async function waitInCover(flight: Flight): Promise<void> {
  const { bot, observed, clock, signal, phase } = flight;
  bot.clearControlStates();
  while (!phase.aborted && !separated(flight) && observed.canWaitInCover(observed.ends(), inFlight(flight))) {
    try { await waitForPhysicsTicks(bot, 1, phase, { wallMs: clock.remainingMs() }); }
    catch (cause) {
      // The clock ending is the budget ending, not a failure; a caller's abort still throws.
      if (cause instanceof PhysicsStoppedError || (clock.signal.aborted && !signal.aborted)) return;
      throw cause;
    }
    observed.observe();
  }
  if (!clock.exhausted && !separated(flight)) observed.refreshGoal();
}

/** Fuse clearance wins; otherwise every settled stop either guards or refuses incoming flight. */
async function settleIncoming(flight: Flight, completed = false): Promise<{ kind: "guarded" | "refused" | "none"; guardStop: string | null }> {
  const { bot, context, observed, clock } = flight;
  if (flight.phase.aborted || escapeRequired(flight) || !bodySettled(flight, completed)) return { kind: "none", guardStop: null };
  const projectiles = incomingShieldProjectiles(bot, RETREAT_PROJECTILE_ALLOWANCE);
  if (projectiles.length === 0) return { kind: "none", guardStop: null };
  if (!context.policy.shield || retreatGuardLimit(bot, context.policy)) {
    observed.refuseTrajectories(projectiles);
    return { kind: "refused", guardStop: null };
  }
  flight.projectileGuards++;
  const guard = await guardRetreatProjectiles(bot, flight.navigation, flight.phase, monotonicNow() + clock.remainingMs(),
    context.policy, () => escapeRequired(flight));
  return { kind: "guarded", guardStop: guard.kind === "stopped" ? guard.reason : null };
}

/** Continue only within the original attempt, re-judging every settled stop and changed arrival. */
async function followEvadeRoutes(flight: Flight): Promise<{ route: Route; guardStop: string | null }> {
  const { bot, observed, clock, signal } = flight;
  let retriedAt: string | null = null;
  let retryRefresh = -1;
  let route: Route = { status: "stopped", reason: "navigation timeout", elapsedMs: 0 };
  while (!clock.exhausted) {
    signal.throwIfAborted();
    const routeStart = bot.entity.position.floored();
    const stopped = await navigateEvade(flight);
    route = stopped.route;
    observed.observe();
    if (separated(flight, route.status === "completed") || clock.exhausted || signal.aborted) break;
    const incoming = await settleIncoming(flight, route.status === "completed");
    if (incoming.guardStop) return { route, guardStop: incoming.guardStop };
    if (incoming.kind !== "none") continue;
    if (stopped.reached) continue;
    if (route.status !== "completed") break;
    if (observed.canWaitInCover(observed.ends(), inFlight(flight)) && bodySettled(flight)) {
      await waitInCover(flight);
      // Arrival certified the body before the hold, not after a displacement during it (P4-29 T6 review).
      route = { status: "stopped", reason: "Cover wait ended without settled safe separation", elapsedMs: route.elapsedMs };
      if (separated(flight) || clock.exhausted) break;
      const incoming = await settleIncoming(flight);
      if (incoming.guardStop) return { route, guardStop: incoming.guardStop };
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

/** Execute one measured escape; loadout, route changes and waiting all spend the same clock of server ticks. */
export async function evade(bot: Bot, navigation: NavigationRuntime,
  request: Extract<HostileDirective, { kind: "evade" }>, context: ResponseContext,
  healthBefore: number, signal: AbortSignal): Promise<EvadeResponseResult> {
  using clock = new EvadeClock(bot, evadeBudgetTicks(context.policy));
  const observed = new EvadeObservation(bot, context, request.threats, request.safeRange, clock);
  // The snapshot of the budgets registry (monitor, receipts) shows the clock; every decision reads the clock itself.
  using _snapshot = context.survival.budgets.attempt({ name: "evade", scope: `cell:${bot.entity.position.floored()}`,
    unit: "ticks", limit: evadeBudgetTicks(context.policy), measure: () => clock.elapsedTicks() ?? 0,
    wall: { limitMs: clock.wallMs, measure: monotonicNow, startedAt: clock.startedAtMs },
    exhaustion: "Return observed separation or an exhausted escape; route changes and projectile guards cannot renew it." });
  const flight: Flight = { bot, navigation, context, observed, clock, signal, phase: AbortSignal.any([signal, clock.signal]),
    projectileGuards: 0 };
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
      elapsedMs: monotonicNow() - observed.startedAtMs, elapsedTicks: clock.elapsedTicks(), startPosition: observed.startPosition,
      goalRefreshes: observed.goalRefreshes, ends: observed.ends() };
  };
  bot.on("entityDead", resolved);
  bot.on("physicsTick", observe);
  bot._client.on("explosion", explosion);
  try {
    const target = request.threats.map((threat) => bot.entities[threat.id]).find((entity) => entity?.isValid);
    await equipCombatLoadout(bot, permittedMeleeLoadout(bot, target ? combatItemsForTarget(bot, target) : readCombatItems(bot), context.policy), flight.phase);
    signal.throwIfAborted();
    defence = defendWhileRetreating(bot, context, signal);
    observed.observe();
    const { route, guardStop } = await followEvadeRoutes(flight);
    observed.observe();
    const common = evidence();
    if (separated(flight, route.status === "completed")) return { ...common, result: { kind: "separated" } };
    const reason = guardStop ?? (clock.exhausted ? NAVIGATION_TIMEOUT : route.status === "stopped"
      ? `Emergency evade stopped without settled safe separation: ${route.reason}`
      : "Emergency evade completed without observing the requested separation");
    return { ...common, result: { kind: "exhausted", reason: evadeExhaustion(reason, common.elapsedMs, common.ends, inFlight(flight)) } };
  } catch (cause) {
    const common = evidence();
    // The clock ending an awaited phase (loadout, cover wait, guard) is the budget ending, as a stopped route is; any
    // other error (a cleanup that throws) stays the evade's failure even when the clock ended it too.
    if (cause === clock.signal.reason && !signal.aborted)
      return { ...common, result: { kind: "exhausted", reason: evadeExhaustion(NAVIGATION_TIMEOUT, common.elapsedMs, common.ends, inFlight(flight)) } };
    return { ...common, result: { kind: "failed", reason: cause instanceof Error ? cause.message : String(cause) } };
  } finally {
    defence?.[Symbol.dispose]();
    bot.off("physicsTick", observe);
    bot.off("entityDead", resolved);
    bot._client.off("explosion", explosion);
  }
}
