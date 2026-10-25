/**
 * A route that is rebuilt when dragon breath appears, grows or goes away, and refuses steps into breath that was
 * not already around the bot when the route was planned.
 */
import type { Bot } from "mineflayer";
import { ExecutionScope } from "../execution/execution-scope.js";
import { cloudExposure, readDragonCloudHazards, type DragonCloud } from "../world/dragon-hazards.js";
import type { MovementPolicy } from "./movements/policy.js";
import { runNavigation, type Navigate, type NavigationResult } from "./navigate.js";
import type { Navigator } from "./orchestration/navigator.js";
import type { NavigationEvent } from "./telemetry/index.js";

/** The stop reason a route gets when the breath around it changed, which is what makes `navigateAroundDragonBreath` plan again. */
const DRAGON_BREATH_CHANGED = "Dragon breath geometry changed";

/** What `navigateAroundDragonBreath` reads and writes of the runtime that owns the route. */
export interface DragonBreathRouteContext {
  readonly bot: Bot;
  readonly navigator: Navigator;
  /** The runtime's event listeners: the route reports its progress through one added here for its lifetime. */
  readonly listeners: Set<(event: NavigationEvent) => void>;
  isClosed(): boolean;
  /** Throws when the runtime is closed. */
  requireOpen(): void;
  /** The route being run, which the runtime awaits when it closes. */
  readonly activeRoute: { current: Promise<NavigationResult> | null };
}

/** Reports the search and the steps of a route to its execution scope, as it goes. */
function reportNavigationProgress(execution: ExecutionScope, event: NavigationEvent): void {
  switch (event.kind) {
    case "search_started":
      execution.progress("search", `${event.searchId}: ${event.reason}; goal=${event.goal}`);
      break;
    case "search_slice":
      execution.progress("search", `${event.searchId}: visited=${event.visited}, generated=${event.generated}, computeMs=${event.computeMs}`);
      break;
    case "step_started":
      execution.progress("movement", `${event.stepId}: ${event.movement}`);
      break;
    case "step_phase":
      execution.progress("movement", `${event.stepId}: ${event.phase}`);
      break;
  }
}

/**
 * The caller's movements, except that a step into breath the bot was not already standing in is prohibited. Goals and
 * movement share the same fixed perch radius / eventual fireball radius: ordinary cloud growth must not cancel each step.
 */
function movementsAvoidingDragonBreath(movements: MovementPolicy, clouds: readonly DragonCloud[], start: { x: number; y: number; z: number }): MovementPolicy {
  if (clouds.length === 0) return movements;
  const initialExposure = new Map(clouds.map((c) => [c.id, cloudExposure(c, start)]));
  return {
    ...movements,
    get scaffold() {
      return movements.scaffold;
    },
    decideStep(x, y, z, view) {
      const base = movements.decideStep(x, y, z, view);
      if (base.kind === "prohibited") return base;
      for (const cloud of clouds) {
        if (cloudExposure(cloud, { x: x + 0.5, y, z: z + 0.5 }) > (initialExposure.get(cloud.id) ?? 0))
          return { kind: "prohibited", reason: "Observed dragon breath occupies this step" };
      }
      return base;
    },
  };
}

/**
 * Cloud appearance, removal, or growth changes safety without a block change: the returned signal aborts when the
 * clouds differ from `clouds`. `stop` removes the physics listener.
 */
function watchDragonBreathChanges(bot: Bot, clouds: readonly DragonCloud[]): { readonly signal: AbortSignal; stop(): void } {
  const changed = new AbortController();
  const known = new Map(clouds.map((c) => [c.id, c.radius]));
  const watchClouds = () => {
    const current = readDragonCloudHazards(bot);
    if (current.length !== known.size || current.some((c) => known.get(c.id) !== c.radius))
      changed.abort(DRAGON_BREATH_CHANGED);
  };
  bot.on("physicsTick", watchClouds);
  return { signal: changed.signal, stop: () => bot.off("physicsTick", watchClouds) };
}

/**
 * Runs the requested route, and rebuilds this same route after physical release when the breath around it changed,
 * unless its caller stopped it or a defensive takeover cancelled the action.
 */
export const navigateAroundDragonBreath = async (context: DragonBreathRouteContext, options: Parameters<Navigate>[0]): ReturnType<Navigate> => {
  const { bot, navigator, activeRoute } = context;
  using execution = new ExecutionScope({ bot: bot.username, operation: "navigation", targetId: null });
  using observations = new DisposableStack();
  const reportProgress = (event: NavigationEvent) => reportNavigationProgress(execution, event);
  context.listeners.add(reportProgress);
  observations.defer(() => context.listeners.delete(reportProgress));
  const startedAt = Date.now();
  for (;;) {
    await execution.checkpoint(options.signal);
    context.requireOpen();
    const clouds = readDragonCloudHazards(bot);
    const start = bot.entity.position.floored().offset(0.5, 0, 0.5);
    const breath = watchDragonBreathChanges(bot, clouds);
    const route = execution.run("route", () =>
      runNavigation(navigator, {
        ...options,
        timeoutMs:
          options.timeoutMs === undefined ? undefined : Math.max(0, options.timeoutMs - (Date.now() - startedAt)),
        movements: movementsAvoidingDragonBreath(options.movements, clouds, start),
        stopSignal: AbortSignal.any([breath.signal, ...(options.stopSignal ? [options.stopSignal] : [])]),
      }),
    );
    activeRoute.current = route;
    try {
      const result = await route;
      if (
        result.status === "stopped" &&
        result.reason === DRAGON_BREATH_CHANGED &&
        !context.isClosed() &&
        !options.signal?.aborted &&
        !options.stopSignal?.aborted
      )
        continue;
      return { ...result, elapsedMs: Date.now() - startedAt };
    } finally {
      breath.stop();
      if (activeRoute.current === route) activeRoute.current = null;
    }
  }
};
