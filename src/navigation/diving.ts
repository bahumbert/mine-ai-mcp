import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { airSupplyTicks } from "../world/air-supply.js";
import { botEyesInWater } from "../world/eyes-in-water.js";
import { waitForPhysicsTicks } from "../utils/physics-ticks.js";
import { timeoutSignal } from "../utils/wall-timers.js";
import { waitForWorldAge } from "../world/world-age.js";
import { exactBlockGoal } from "./goals/index.js";
import type { Navigate, NavigateOptions } from "./navigate.js";
import type { MovementPolicy } from "./movements/policy.js";
import type { WorldView } from "./world/world.js";
import { DIVE_BACKSTOP_TICKS, DIVE_RESERVE_TICKS, openWaterSurface, swimAscent, swimTravelTicks } from "./world/swimming.js";
import type { RoutePlan } from "./movements/movement.js";

const BREATHING_STOP = "Planned breathing stop";
interface DiveSession {
  readonly cancelled: AbortController;
  owned: boolean;
  returning: boolean;
  stop: AbortController;
  completedWork: number;
  /** The air metadata stayed absent through a submerged observation: the server sends it when it changes, so it is full. */
  unchangedAir: boolean;
  /** The last cell passed with the head in air: where a run that ends under water swims back to. */
  lastBreathable: Vec3 | null;
  /** The run ended with its goal reached: the body is where it was asked to be, whatever the water. */
  completed: boolean;
}

const FULL_AIR_TICKS = 300;
/** How long a submerged bot with no air metadata is watched before the air is taken as unchanged. */
const AIR_OBSERVATION_TICKS = 40;

/** Minecraft refills a breathing body's air by 4 a tick (`LivingEntity.increaseAirSupply`). */
const AIR_REFILL_PER_TICK = 4;
/** World ticks past the refill time a server answer may take (session rules: "a wait is not a server answer"). */
const SERVER_ANSWER_TICKS = 40;
/** Longest wall-clock wait for full air at a breathing stop, whatever the server's clock does. */
const BREATHING_STOP_WALL_MS = 15_000;
const FULL_AIR_NOT_OBSERVED = "Full air was not observed at the breathing stop: the server's clock passed the refill time, or 15 s went by, without it";

/** Longest wall-clock wait for the swim back, whatever the air says. */
const SWIM_BACK_TIMEOUT_MS = 15_000;
/** One physics tick, for turning the air left into a wall-clock bound. */
const TICK_MS = 50;

/** Scoped declaration shared with survival; never a switch that removes the reflex. */
export class Diving {
  #session: DiveSession | null = null;
  readonly #read: WorldView["blockAt"];
  constructor(readonly bot: Bot, readonly world: WorldView,
    readonly report: (state: "breathing" | "resumed" | "released") => void = () => {}) {
    this.#read = (x, y, z) => world.blockAt(x, y, z);
  }
  get owned(): boolean { return this.#session?.owned === true; }
  get active(): boolean { return this.#session !== null; }
  cancel(reason: string): void { this.#session?.cancelled.abort(reason); }
  workCompleted(): void { if (this.#session) this.#session.completedWork++; }

  backstop(): number | null {
    const session = this.#session;
    if (!session?.owned) return null;
    if (!botEyesInWater(this.bot)) return DIVE_BACKSTOP_TICKS;
    const feet = this.bot.entity.position.floored();
    const ascent = swimAscent(this.#read, feet);
    if (!ascent) return 300; // The admission premise disappeared: request immediate rescue.
    return ascent.ticks + DIVE_BACKSTOP_TICKS;
  }

  committed(plan: Pick<RoutePlan, "steps">): void {
    const session = this.#session;
    if (!session) return;
    if (plan.steps.some(({ to }) => botEyesInWater(this.bot, new Vec3(to.x + 0.5, to.y, to.z + 0.5)) && swimAscent(this.#read, to))) {
      session.owned = true;
    }
  }

  /** Long interactions ask before starting; an aborted route retains its original callback. */
  beforeWork(ticks: number): string | null {
    const session = this.#session;
    const feet = this.bot.entity.position.floored();
    if (!botEyesInWater(this.bot)) return null;
    const surface = openWaterSurface(this.#read, feet);
    const air = airSupplyTicks(this.bot);
    if (!session?.owned || !surface || air === null || !this.bot.entity.onGround)
      return `Underwater stance unavailable at ${feet}: owned=${session?.owned === true}, escape=${!!surface}, air=${air}, grounded=${this.bot.entity.onGround}`;
    // A fresh dive must be able to finish this work, otherwise resurfacing would repeat forever.
    if (swimTravelTicks(surface, feet) + ticks + swimTravelTicks(feet, surface) + DIVE_RESERVE_TICKS > 300)
      return `Underwater work needs ${ticks} ticks at ${feet}; the full dive exceeds one breath`;
    if (ticks + swimTravelTicks(feet, surface) + DIVE_RESERVE_TICKS <= air) return null;
    session.stop.abort(BREATHING_STOP);
    return BREATHING_STOP;
  }

  async run(options: NavigateOptions, navigate: Navigate) {
    if (this.#session) throw new Error("Navigation already owns a dive session.");
    const session: DiveSession = { owned: false, returning: false, stop: new AbortController(),
      cancelled: new AbortController(), completedWork: 0, unchangedAir: false, lastBreathable: null, completed: false };
    this.#session = session;
    const lifetime = AbortSignal.any([session.cancelled.signal, ...(options.signal ? [options.signal] : [])]);
    options = { ...options, stopSignal: AbortSignal.any([session.cancelled.signal,
      ...(options.stopSignal ? [options.stopSignal] : [])]) };
    const started = Date.now();
    let previousStop = "";
    let repeatedStops = 0;
    const tick = () => {
      if (this.#headInAir()) session.lastBreathable = this.bot.entity.position.floored();
      if (!session.owned || session.returning || session.stop.signal.aborted) return;
      const feet = this.bot.entity.position.floored();
      const ascent = swimAscent(this.#read, feet);
      const air = airSupplyTicks(this.bot) ?? (session.unchangedAir ? FULL_AIR_TICKS : null);
      // With a lost corridor the survival backstop must take over; do not call it a planned return.
      if (!ascent) return;
      if (botEyesInWater(this.bot) &&
        (air === null || air <= ascent.ticks + DIVE_RESERVE_TICKS))
        session.stop.abort(BREATHING_STOP);
    };
    this.bot.on("physicsTick", tick);
    if (this.#headInAir()) session.lastBreathable = this.bot.entity.position.floored();
    try {
      await this.#observeAir(options, session, lifetime);
      for (;;) {
        options.signal?.throwIfAborted();
        if (options.stopSignal?.aborted) return { status: "stopped" as const,
          reason: String(options.stopSignal.reason), elapsedMs: Date.now() - started };
        const air = airSupplyTicks(this.bot) ?? (session.unchangedAir ? FULL_AIR_TICKS : null);
        const origin = this.bot.entity.position.clone();
        // A request beginning underwater must hold depth while its first search runs.
        session.owned = session.owned || (options.movements.allowSwimming && air !== null && swimAscent(this.#read, origin.floored()) !== null &&
          botEyesInWater(this.bot, origin));
        const movements: MovementPolicy = { ...options.movements,
          get scaffold() { return options.movements.scaffold; },
          ...(air !== null && options.movements.allowSwimming ? { dive: { origin, airTicks: air } } : {}),
        };
        const result = await navigate({ ...options, movements,
          timeoutMs: options.timeoutMs === undefined ? undefined : Math.max(0, options.timeoutMs - (Date.now() - started)),
          stopSignal: AbortSignal.any([session.stop.signal, ...(options.stopSignal ? [options.stopSignal] : [])]),
        });
        const continuingDive = session.stop.signal.aborted;
        const returnToProcess = options.onArrival !== undefined && session.owned &&
          botEyesInWater(this.bot);
        if ((!continuingDive && !returnToProcess) || session.cancelled.signal.aborted || options.signal?.aborted ||
          (options.stopSignal?.aborted && !returnToProcess)) return this.#finished(session, result);
        const surface = swimAscent(this.#read, this.bot.entity.position.floored())?.surface;
        if (!surface) return { status: "stopped" as const, reason: "Dive lost its verified ascent corridor", elapsedMs: Date.now() - started };
        const progress = `${this.bot.entity.position.floored()}:${session.completedWork}`;
        repeatedStops = progress === previousStop ? repeatedStops + 1 : 0;
        previousStop = progress;
        if (repeatedStops >= 2) return { status: "stopped" as const, reason: "Dive cannot make progress within one breath", elapsedMs: Date.now() - started };
        session.returning = true;
        this.report("breathing");
        // A process's quantity signal ends its route, but still owes a safe
        // handoff. Action cancellation and defensive takeover always win.
        const returnStop = returnToProcess ? session.cancelled.signal : options.stopSignal;
        const returned = await navigate({ movements, goal: exactBlockGoal(surface), signal: options.signal,
          stopSignal: returnStop, timeoutMs: 15_000 });
        if (returned.status !== "completed") return returned;
        const breath = await waitForFullAir(this.bot, lifetime, returnStop);
        if (breath !== "full") return { status: "stopped" as const, reason: breath === "stopped" ? "Request stopped while breathing" : FULL_AIR_NOT_OBSERVED, elapsedMs: Date.now() - started };
        session.returning = false;
        session.stop = new AbortController();
        this.report("resumed");
        // A mining process may revise targets between navigation transactions.
        // Return its body with air, rather than exposing low air to the ordinary reflex in that gap.
        if (!continuingDive) return this.#finished(session, result);
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (session.cancelled.signal.aborted) return { status: "stopped" as const,
        reason: String(session.cancelled.signal.reason), elapsedMs: Date.now() - started };
      throw error;
    } finally {
      this.bot.off("physicsTick", tick);
      if (session.returning) this.bot.setControlState("jump", false);
      await this.#swimBackToAir(session, options, navigate);
      this.#session = null;
      if (session.owned) this.report("released");
    }
  }

  /** The air the server has not reported yet, observed before the first route is planned. */
  async #observeAir(options: NavigateOptions, session: DiveSession, lifetime: AbortSignal): Promise<void> {
    // Servers omit unchanged default air metadata on login. Observe the first
    // shallow head immersion before admitting any dive; never invent full air.
    // This stays within one block of an already verified breathable surface.
    const initialSurface = openWaterSurface(this.#read, this.bot.entity.position.floored());
    if (options.movements.allowSwimming && airSupplyTicks(this.bot) === null && initialSurface &&
      this.bot.entity.position.y >= initialSurface.y - 0.5) {
      try {
        for (let ticks = 0; ticks < 80 && airSupplyTicks(this.bot) === null; ticks++) {
          options.signal?.throwIfAborted();
          if (options.stopSignal?.aborted) break;
          this.bot.setControlState("jump", this.bot.entity.position.y < initialSurface.y - 0.8);
          await waitForPhysicsTicks(this.bot, 1, lifetime);
        }
      } finally { this.bot.setControlState("jump", false); }
    }
    // Roofed, there is no surface to breathe at to make the server report the air (live 2026-10-10: a bot stuck on
    // the sea floor under an overhang never got a dive budget, so no route out). The server sends the air whenever
    // it changes, so a head kept under water for a moment with none sent means it is not running down.
    if (options.movements.allowSwimming && airSupplyTicks(this.bot) === null && initialSurface === null) {
      for (let ticks = 0; ticks < AIR_OBSERVATION_TICKS && airSupplyTicks(this.bot) === null &&
        botEyesInWater(this.bot); ticks++) {
        options.signal?.throwIfAborted();
        await waitForPhysicsTicks(this.bot, 1, lifetime);
      }
      session.unchangedAir = airSupplyTicks(this.bot) === null &&
        botEyesInWater(this.bot);
    }
  }

  #headInAir(): boolean {
    return !botEyesInWater(this.bot);
  }

  /** Notes whether the run's last route reached its goal (see {@link DiveSession.completed}); returns the result. */
  #finished<Result extends { readonly status: string }>(session: DiveSession, result: Result): Result {
    session.completed = result.status === "completed";
    return result;
  }

  /**
   * A run that did not reach its goal (failed, stopped, cancelled) with the dive owned and the head under water leaves the
   * body where the route left it: in a roofed tunnel that is a drowning (run 15, Sana, five blocks in). Swim back along
   * the way to the last cell passed with the head in air, bounded by the air left and the wall clock. A run that reached
   * its goal under water stays there (a swim back would undo the arrival and a retry repeat it). A takeover cancel is the
   * breath reflex taking the body, the action's own cancel ends the swim back at once, and a death or respawn ends it:
   * none is fought.
   */
  async #swimBackToAir(session: DiveSession, options: NavigateOptions, navigate: Navigate): Promise<void> {
    const target = session.lastBreathable;
    if (session.completed || !session.owned || target === null || session.cancelled.signal.aborted || options.signal?.aborted ||
      (this.bot.health ?? 20) <= 0) return;
    if (!botEyesInWater(this.bot)) return;
    const air = airSupplyTicks(this.bot);
    const budgetMs = air === null ? SWIM_BACK_TIMEOUT_MS : Math.min(SWIM_BACK_TIMEOUT_MS, Math.max(2_000, air * TICK_MS));
    const ended = new AbortController();
    const onEnd = () => ended.abort("died during the swim back");
    this.bot.once("death", onEnd);
    this.bot.once("respawn", onEnd);
    try {
      const origin = this.bot.entity.position.clone();
      await navigate({ movements: { ...options.movements, ...(options.movements.allowSwimming ? { dive: { origin, airTicks: air ?? FULL_AIR_TICKS } } : {}) },
        goal: exactBlockGoal(target), timeoutMs: budgetMs,
        stopSignal: AbortSignal.any([ended.signal, timeoutSignal(budgetMs), ...(options.signal ? [options.signal] : [])]) });
    } catch {
      // The route back failed: the body stays where it is for the breath reflex, which owns the last resort.
    } finally {
      this.bot.off("death", onEnd);
      this.bot.off("respawn", onEnd);
    }
  }
}

/**
 * Holds jump at a breathing stop until the server reports full air, or its world age moved the refill time and an
 * answer's margin, or the wall clock ran out (NAVP-13, run 15: a server 2.5-4.6 s behind refilled the air after the 100
 * client ticks the stop used to count). "stopped": the return was stopped by its own stop signal; the run's lifetime
 * ending rethrows.
 */
async function waitForFullAir(bot: Bot, lifetime: AbortSignal, returnStop: AbortSignal | undefined): Promise<"full" | "short" | "stopped"> {
  const air = airSupplyTicks(bot) ?? 0;
  bot.setControlState("jump", true);
  try {
    await waitForWorldAge(bot, Math.ceil((FULL_AIR_TICKS - air) / AIR_REFILL_PER_TICK) + SERVER_ANSWER_TICKS, {
      wallMs: BREATHING_STOP_WALL_MS,
      until: () => airSupplyTicks(bot) === FULL_AIR_TICKS,
      signal: AbortSignal.any([lifetime, ...(returnStop ? [returnStop] : [])]),
    });
  } catch (cause) {
    lifetime.throwIfAborted();
    if (returnStop?.aborted) return "stopped";
    throw cause;
  } finally {
    bot.setControlState("jump", false);
  }
  return airSupplyTicks(bot) === FULL_AIR_TICKS ? "full" : "short";
}
