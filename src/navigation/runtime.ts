/**
 * The per-bot navigation runtime: one construction, one owner, one disposal.
 *
 * The session builds this once for a connected bot and hands the result to
 * whoever needs to move it. There is no registry and no lookup — if you hold a
 * runtime you have navigation, and if you do not, you cannot reach it.
 *
 * This is not the caller-facing boundary — `src/navigation/index.ts` is.
 */
import { EscapeHolds } from "./escape-holds.js";
import type { RouteOutcomes } from "./route-outcomes.js";
import { Diving } from "./diving.js";
import { botEyesInWater } from "../world/eyes-in-water.js";
import type { Bot } from "mineflayer";
import { breakBlockInPlace, type BreakBlockInPlace } from "./execution/in-place-break.js";
import { MineflayerBot, installNetherVinePhysics, mineflayerBotSurface } from "./mineflayer/bot.js";
import { createMineflayerMovementPolicy, type MineflayerMovementPolicyOptions } from "./mineflayer/movement-policy.js";
import { MineflayerWorldView } from "./mineflayer/world.js";
import type { WorldView } from "./world/world.js";
import type { MovementPolicy } from "./movements/policy.js";
import type { Navigate, NavigationResult } from "./navigate.js";
import { navigateAroundDragonBreath } from "./navigate-around-dragon-breath.js";
import { createNavigator, type Navigator } from "./orchestration/navigator.js";
import { waterStancesHeld } from "./steering/hold-water-position.js";
import type { StepFieldProvider } from "./step-field.js";
import type { NavigationEvent, TelemetrySink } from "./telemetry/index.js";

/**
 * Everything one connected bot's navigation offers.
 *
 * Route execution and in-place excavation share the same world and bot adapter.
 */
export interface NavigationRuntime extends AsyncDisposable {
  /** Remaining-air floor while navigation owns a verified dive, otherwise null. */
  diveBackstop?(): number | null;
  /** The world as navigation observes it, for callers that judge blocks the way routes do. */
  readonly world: WorldView;
  readonly navigate: Navigate;
  /**
   * While the returned handle is open every route of this bot starts as an escape (`NavigateOptions.escape`): the
   * session holds it around a pinned bot's movement action, so no action passes the flag down by hand.
   */
  routesAsEscape(): Disposable;
  readonly breakBlockInPlace: BreakBlockInPlace;
  /**
   * Register the one provider every search asks for its step field.
   *
   * The session calls this once, from the one place that holds both this
   * runtime and whatever knows which cells are worth avoiding. Every route
   * then gets the field by default, and a route that must not have it passes
   * `stepField: null`.
   */
  setStepFieldProvider(provider: StepFieldProvider): void;
  /** Whether a route currently owns the bot. */
  readonly active: boolean;
  /** Whether navigation steers the body: a route, process or dive owns it, or a water stance is held (mining under water keeps its depth). */
  readonly steering: boolean;
  cancel(reason?: string): void;
  /** An admitted recovery owner will steer the airborne body after this route releases its controls. */
  releaseForTakeover(reason: string): void;
  onEvent(listener: (event: NavigationEvent) => void): () => void;
  close(): Promise<void>;
}

export function createMovements(bot: Bot, options?: MineflayerMovementPolicyOptions): MovementPolicy {
  return createMineflayerMovementPolicy(bot, options);
}

export interface NavigationRuntimeOptions {
  /** How long a new route waits for a cancelled one to settle before abandoning it (default 5 s). */
  readonly releaseWaitMs?: number;
  /** Told how every route of this bot ended, so the session can tell a failed route from another failure (see `RouteOutcomes`). */
  readonly routes?: RouteOutcomes;
}

/**
 * Ends the route and the dive when the bot dies, changes dimension (a portal respawn unloads every chunk and moves
 * the position, so a route in flight has nothing left to stand on) or loses its connection. Returns the unwatch.
 */
function endNavigationWhenBotIsLost(bot: Bot, diving: Diving, navigator: Navigator): () => void {
  const botDied = () => {
    diving.cancel("bot died");
    navigator.terminateActive("bot died");
  };
  // Mineflayer already reports the new dimension by the time "respawn" fires.
  let dimension = bot.game.dimension;
  const botRespawned = () => {
    if (bot.game.dimension === dimension) return;
    diving.cancel("dimension changed");
    dimension = bot.game.dimension;
    navigator.terminateActive(`dimension changed to ${dimension}`);
  };
  const botEnded = () => { diving.cancel("connection ended"); navigator.terminateActive("connection ended"); };
  bot.on("death", botDied);
  bot.on("respawn", botRespawned);
  bot.on("end", botEnded);
  return () => {
    bot.removeListener("death", botDied);
    bot.removeListener("respawn", botRespawned);
    bot.removeListener("end", botEnded);
  };
}

/** Breaks the block in place unless the runtime is closed or the dive cannot spare the air, and tells the dive when the work is done. */
async function breakInPlaceWithinDive(
  { bot, world, navigationBot, diving, requireOpen }: { bot: Bot; world: WorldView; navigationBot: MineflayerBot; diving: Diving; requireOpen: () => void },
  options: Parameters<BreakBlockInPlace>[0],
): ReturnType<BreakBlockInPlace> {
  requireOpen();
  const block = world.blockAt(options.position.x, options.position.y, options.position.z);
  const evaluation = options.movements.evaluateBreak(block, options.position, world);
  const ticks = options.movements.digTimeEstimator.estimate(block, evaluation.tool, {
    submergedAtEyes: botEyesInWater(bot), onGround: bot.entity.onGround,
    ...navigationBot.observe().player,
  });
  const refused = diving.beforeWork(ticks);
  if (refused !== null) {
    options.signal?.throwIfAborted();
    return { status: "failed", reason: refused };
  }
  const result = await breakBlockInPlace({ world, bot: navigationBot }, options);
  if (result.status === "broken") diving.workCompleted();
  return result;
}

/** Build the navigation runtime for one connected Mineflayer bot. */
export function createNavigationRuntime(bot: Bot, options: NavigationRuntimeOptions = {}): NavigationRuntime {
  const releaseWaitMs = options.releaseWaitMs ?? 5_000;
  const { routes } = options;
  // Built in dependency order: the world view, the bot port over it, and the
  // navigator that looks at and acts on the bot through that port.
  const world = new MineflayerWorldView(bot);
  const diving = new Diving(bot, world, (state) => telemetry.emit({ kind: "dive", runId: "dive", atMs: Date.now(), state }));
  let selectedTool: ((itemType: number | null) => void) | undefined;
  const surface = mineflayerBotSurface(bot);
  const releaseNetherVinePhysics = installNetherVinePhysics(surface);
  const navigationBot = new MineflayerBot(surface, world, () => diving.owned, () => selectedTool);
  const listeners = new Set<(event: NavigationEvent) => void>();
  const telemetry: TelemetrySink = {
    emit(event) {
      if (event.kind === "route_committed") diving.committed(event.plan);
      for (const listener of [...listeners]) listener(event);
    },
    error(runId, cause) {
      process.stderr.write(
        `[mine-ai-mcp] Navigation run ${runId} failed internally: ${cause instanceof Error ? cause.stack || cause.message : String(cause)}\n`,
      );
    },
  };
  const navigator = createNavigator({ world, bot: navigationBot, telemetry });

    const activeRouteSlot: { current: Promise<NavigationResult> | null } = { current: null };
  /** The one route request that owns navigation, and whether it was cancelled (by its caller or this runtime). */
  let activeNavigation: { readonly pending: Promise<NavigationResult>; readonly signal: AbortSignal | undefined; cancelled: boolean } | null = null;
  const markCancelled = () => {
    if (activeNavigation !== null) activeNavigation.cancelled = true;
  };
  /**
   * The slot held by a cancelled request is waited for, then abandoned: "busy" never outlives the owner (run 14b: a
   * stalled navigate waited for a tick for good and every later route was refused busy). A live one is still busy.
   */
  const releaseCancelled = async (): Promise<void> => {
    const held = activeNavigation;
    if (held === null) return;
    if (!held.cancelled && !held.signal?.aborted) throw new Error("Navigation is busy with another request.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      held.pending.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), releaseWaitMs); }),
    ]);
    clearTimeout(timer);
    if (activeNavigation !== held) {
      if (activeNavigation !== null) throw new Error("Navigation is busy with another request.");
      return;
    }
    if (!settled) {
      diving.cancel("abandoned: its owner stopped it and it did not settle");
      navigator.abandonActive("abandoned: its owner stopped it and it did not settle");
      activeRouteSlot.current = null;
      activeNavigation = null;
    }
  };
  let closed = false;
  const escapes = new EscapeHolds();

  const stopWatchingBot = endNavigationWhenBotIsLost(bot, diving, navigator);

  const requireOpen = (): void => {
    if (closed) throw new Error("This navigation runtime is closed.");
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    diving.cancel("navigation runtime closed");
    navigator.terminateActive("navigation runtime closed");
    if (activeNavigation) await activeNavigation.pending.catch(() => undefined);
    if (activeRouteSlot.current) await activeRouteSlot.current.catch(() => undefined);
    navigationBot.clearOwnedControls();
    stopWatchingBot();
    releaseNetherVinePhysics();
    world.close();
    listeners.clear();
  };

  const navigate: Navigate = (options) =>
    navigateAroundDragonBreath({ bot, navigator, listeners, isClosed: () => closed, requireOpen, activeRoute: activeRouteSlot }, options);
  return {
    world,
    diveBackstop: () => diving.backstop(),
    navigate: async (options) => {
      requireOpen();
      await releaseCancelled();
      requireOpen();
      selectedTool = options.onToolSelected;
      const pending = diving.run(escapes.active ? { ...options, escape: true } : options, navigate).then((result) => routes?.note(result) ?? result);
      const held = { pending, signal: options.signal, cancelled: false };
      activeNavigation = held;
      try { return await pending; }
      finally {
        if (activeNavigation === held) {
          activeNavigation = null;
          selectedTool = undefined;
        }
      }
    },
    routesAsEscape: () => escapes.hold(),
    breakBlockInPlace: (options) => breakInPlaceWithinDive({ bot, world, navigationBot, diving, requireOpen }, options),
    setStepFieldProvider: (provider) => navigator.setStepFieldProvider(provider),
    get active() {
      return diving.active || navigator.active !== null;
    },
    get steering() { return this.active || waterStancesHeld(bot) > 0; },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancel(reason = "cancelled") {
      markCancelled();
      diving.cancel(reason);
      navigator.cancelActive(reason);
    },
    releaseForTakeover(reason) {
      markCancelled();
      diving.cancel(reason);
      navigator.terminateActive(reason);
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}
