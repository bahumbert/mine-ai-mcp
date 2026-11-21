import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { airSupplyTicks } from "../world/air-supply.js";
import { botEyesInWater, standingEyesInWater } from "../world/eyes-in-water.js";
import { elapsedSince, monotonicNow } from "../utils/monotonic-clock.js";
import { waitForPhysicsTicks } from "../utils/physics-ticks.js";
import { serverPacedSignal, type ServerPacedSignal } from "../world/server-paced.js";
import { SERVER_ANSWER_TICKS, serverPacedWallMs, waitForWorldAge } from "../world/world-age.js";
import { FirstDiveAir } from "./diving-first-air.js";
import { exactBlockGoal } from "./goals/index.js";
import type { Navigate, NavigateOptions, NavigationResult } from "./navigate.js";
import type { MovementPolicy } from "./movements/policy.js";
import { type BlockPosition, type WorldView, blockKey, samePosition } from "./world/world.js";
import { DIVE_BACKSTOP_TICKS, DIVE_RESERVE_TICKS, SWIM_DOWN_TICKS, SWIM_EXIT_RADIUS, SWIM_HORIZONTAL_TICKS,
  SWIM_START_TICKS, SWIM_UP_TICKS, type SwimAscent, type SwimCellReader, type SwimStroke,
  openWaterSurface, swimAscent, swimCellsOf, swimExitPath, swimTravelTicks } from "./world/swimming.js";
import type { RoutePlan } from "./movements/movement.js";

const BREATHING_STOP = "Planned breathing stop";
/** Why a return to air ended on a death or a respawn: the stop's own message would tell a dead bot to go and breathe. */
const RETURN_DIED = "died during the return to air";
interface DiveSession {
  readonly cancelled: AbortController;
  readonly lifetime: AbortSignal;
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
  ascentStroke: ObservedAscentStroke | null;
  /** The private first-air-packet allowance of this run's active leg (T31c-air); never read by planning, work or refill. */
  readonly firstAir: FirstDiveAir;
  /** The first-air allowance was running when the verified ascent was lost: the run ends there, with no unverified swim back. */
  allowanceLostAscent: boolean;
}

/** The stroke and world geometry observed on the preceding backstop read in this leg. */
interface ObservedAscentStroke {
  readonly feet: Vec3;
  readonly next: BlockPosition;
  readonly ticks: number;
  readonly worldRevision: number;
  readonly alternatives: readonly SwimStroke[];
  dirty: boolean;
}

const FULL_AIR_TICKS = 300;
/** How long a submerged bot with no air metadata is watched before the air is taken as unchanged. */
const AIR_OBSERVATION_TICKS = 40;

/** Minecraft refills a breathing body's air by 4 a tick (`LivingEntity.increaseAirSupply`). */
const AIR_REFILL_PER_TICK = 4;
/** Longest wall-clock wait for full air at a breathing stop, whatever the server's clock does. */
const BREATHING_STOP_WALL_MS = 15_000;
const FULL_AIR_NOT_OBSERVED = "Full air was not observed at the breathing stop: the server's clock passed the refill time, or 15 s went by, without it";

/** Return limits in server ticks: at most one breath, with time for a short return even at very low air. */
const SWIM_BACK_MAXIMUM_TICKS = 300;
const SWIM_BACK_MINIMUM_TICKS = 40;

/**
 * Credit progress along the planner's first stroke; price distance off it. The body is read at the middle of its
 * cell on x and z and at its feet level on y (a body's `position.y` is its feet); drift off the line is priced by
 * distance, never a zero test (T30a, 2026-11-18).
 */
function remainingStrokeTicks(bot: Bot, feet: Vec3, ascent: SwimAscent, stroke: SwimStroke): number {
  const direction = new Vec3(stroke.cell.x - feet.x, stroke.cell.y - feet.y, stroke.cell.z - feet.z);
  const offset = bot.entity.position.minus(feet.offset(0.5, 0, 0.5));
  const projection = offset.dot(direction);
  const sideways = offset.minus(direction.scaled(projection)).norm();
  if (projection >= 0 && projection <= 1 && bot.entity.velocity.dot(direction) > 0)
    return ascent.ticks - projection * stroke.ticks + sideways * SWIM_HORIZONTAL_TICKS;
  const extra = Math.hypot(Math.min(0, projection), sideways, Math.max(0, projection - 1));
  return ascent.ticks + extra * SWIM_HORIZONTAL_TICKS;
}

// The same axis neighbours and stroke prices as the swim paths, searched by ticks instead of hops.
const SWIM_STEPS = [-1, 1].flatMap(step => [
  { x: step, y: 0, z: 0, ticks: SWIM_HORIZONTAL_TICKS },
  { x: 0, y: 0, z: step, ticks: SWIM_HORIZONTAL_TICKS },
  { x: 0, y: step, z: 0, ticks: step > 0 ? SWIM_UP_TICKS : SWIM_DOWN_TICKS },
]);

/** A swim path needs the loaded feet and head cells clear at each step. */
function swimmerFits(cells: SwimCellReader, { x, y, z }: BlockPosition): boolean {
  const body = cells(x, y, z);
  const head = cells(x, y + 1, z);
  return (body === "water" || body === "air") && (head === "water" || head === "air");
}

/** Beyond the breath search's radius, an open column keeps the existing second start charge for the rise. */
function openColumnEscapeTicks(cells: SwimCellReader, cell: BlockPosition, top: number, spent: number, limit: number): number {
  const climb = Math.floor((limit - spent - SWIM_START_TICKS) / SWIM_UP_TICKS);
  if (cell.y + climb <= top || swimExitPath(cells, cell, [], 0) === null) return Infinity;
  let head = cell.y + 1;
  while (head <= cell.y + climb && cells(cell.x, head, cell.z) === "water") head++;
  if (head - 1 <= top || cells(cell.x, head, cell.z) !== "air") return Infinity;
  return spent + SWIM_START_TICKS + (head - 1 - cell.y) * SWIM_UP_TICKS;
}

interface SwimFrontier {
  readonly byTicks: (Vec3[] | undefined)[];
  readonly shortest: Map<number, number>;
}

/** Enqueue only improving, traversable strokes within the planner's breath search radius and price. */
function queueSwimSteps(cells: SwimCellReader, feet: Vec3, frontier: SwimFrontier, cell: Vec3, spent: number, limit: number): void {
  for (const step of SWIM_STEPS) {
    const ticks = spent + step.ticks;
    if (ticks > limit) continue;
    const next = cell.offset(step.x, step.y, step.z);
    if (Math.max(Math.abs(next.x - feet.x), Math.abs(next.y - feet.y), Math.abs(next.z - feet.z)) > SWIM_EXIT_RADIUS) continue;
    const key = blockKey(next);
    if (ticks >= (frontier.shortest.get(key) ?? Infinity) || !swimmerFits(cells, next)) continue;
    frontier.shortest.set(key, ticks);
    (frontier.byTicks[ticks] ??= []).push(next);
  }
}

/** Search by the complete breath price. Visiting the origin again would double back through the same stroke. */
function escapeTicksThrough(cells: SwimCellReader, feet: Vec3, first: Vec3, firstTicks: number, limit: number): number {
  const start = SWIM_START_TICKS + firstTicks;
  if (start > limit || !swimmerFits(cells, first)) return Infinity;
  const frontier: SwimFrontier = { byTicks: [], shortest: new Map([[blockKey(feet), 0], [blockKey(first), start]]) };
  frontier.byTicks[start] = [first];
  let columnEscape = Infinity;
  for (let spent = start; spent <= limit && spent < columnEscape; spent++) {
    for (const cell of frontier.byTicks[spent] ?? []) {
      if (frontier.shortest.get(blockKey(cell)) !== spent) continue;
      if (cells(cell.x, cell.y + 1, cell.z) === "air") return spent;
      columnEscape = Math.min(columnEscape, openColumnEscapeTicks(cells, cell, feet.y + SWIM_EXIT_RADIUS, spent, limit));
      queueSwimSteps(cells, feet, frontier, cell, spent, Math.min(limit, columnEscape - 1));
    }
  }
  return columnEscape;
}

/** Only an escape with the same complete cell price can contribute a different first stroke (T30b, 2026-11-20). */
function equalEscapeStrokes(read: WorldView["blockAt"], feet: Vec3, primary: SwimStroke, limit: number): SwimStroke[] {
  const cells = swimCellsOf(read);
  const alternatives: SwimStroke[] = [];
  for (const { x, y, z, ticks } of SWIM_STEPS) {
    const cell = feet.offset(x, y, z);
    if (!samePosition(cell, primary.cell) && escapeTicksThrough(cells, feet, cell, ticks, limit) === limit) alternatives.push({ cell, ticks });
  }
  return alternatives;
}

/** Price alternate approaches from the actual body while keeping the remainder of each tied escape fixed. */
function remainingAscentTicks(bot: Bot, feet: Vec3, ascent: SwimAscent, stroke: SwimStroke, alternatives: readonly SwimStroke[]): number {
  let remaining = remainingStrokeTicks(bot, feet, ascent, stroke);
  const position = bot.entity.position;
  for (const { cell, ticks } of alternatives) {
    const verticalPrice = cell.y === feet.y ? SWIM_HORIZONTAL_TICKS : ticks;
    const approach = Math.hypot((cell.x + 0.5 - position.x) * SWIM_HORIZONTAL_TICKS,
      (cell.y - position.y) * verticalPrice, (cell.z + 0.5 - position.z) * SWIM_HORIZONTAL_TICKS);
    remaining = Math.min(remaining, ascent.ticks - ticks + approach);
  }
  return remaining;
}

/** Death and respawn forget the stroke. Column packets can change escapes without changing the world's block revision. */
function watchAscentStroke(bot: Bot, session: DiveSession): Disposable {
  const forget = () => { session.ascentStroke = null; };
  const markDirty = () => { if (session.ascentStroke) session.ascentStroke.dirty = true; };
  bot.on("death", forget);
  bot.on("respawn", forget);
  bot.on("chunkColumnLoad", markDirty);
  bot.on("chunkColumnUnload", markDirty);
  return { [Symbol.dispose]: () => {
    bot.off("death", forget);
    bot.off("respawn", forget);
    bot.off("chunkColumnLoad", markDirty);
    bot.off("chunkColumnUnload", markDirty);
  } };
}

/** Remember the last air pocket and request a breathing stop before an owned dive spends its ascent reserve. */
function observeDiveTick(bot: Bot, read: WorldView["blockAt"], session: DiveSession): void {
  if (!botEyesInWater(bot)) {
    session.lastBreathable = bot.entity.position.floored();
    session.firstAir.captureDry(session.lastBreathable);
  }
  if (!session.owned || session.returning || session.stop.signal.aborted || session.lifetime.aborted) return;
  const ascent = swimAscent(read, bot.entity.position.floored());
  const reported = airSupplyTicks(bot);
  // A numeric air the server filed wins at once: the allowance is over and the ordinary stop below judges it.
  if (reported !== null) session.firstAir.end();
  const air = reported ?? (session.unchangedAir ? FULL_AIR_TICKS : null);
  if (!ascent) {
    // With a lost corridor the survival backstop must take over; do not call it a planned return. A leg running on the
    // first-air allowance has nothing to stand on: it ends here, and the run reports the lost corridor.
    if (session.firstAir.active) {
      session.firstAir.end();
      session.allowanceLostAscent = true;
      session.stop.abort(BREATHING_STOP);
    }
    return;
  }
  if (botEyesInWater(bot) && (air === null || air <= ascent.ticks + DIVE_RESERVE_TICKS)) {
    if (air === null && session.firstAir.permits(ascent.ticks)) return;
    session.stop.abort(BREATHING_STOP);
  }
}

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
  cancel(reason: string): void {
    if (!this.#session) return;
    this.#session.ascentStroke = null;
    this.#session.cancelled.abort(reason);
  }
  workCompleted(): void { if (this.#session) this.#session.completedWork++; }

  backstop(): number | null {
    const session = this.#session;
    if (!session?.owned) return null;
    if (!botEyesInWater(this.bot)) {
      session.ascentStroke = null;
      return DIVE_BACKSTOP_TICKS;
    }
    const feet = this.bot.entity.position.floored();
    const ascent = swimAscent(this.#read, feet);
    const stroke = ascent?.path[0];
    const previous = session.ascentStroke;
    if (!ascent || !stroke || session.lifetime.aborted) {
      session.ascentStroke = null;
      // If the admission premise disappeared, request immediate rescue.
      return ascent ? ascent.ticks + DIVE_BACKSTOP_TICKS : FULL_AIR_TICKS;
    }
    const sameStroke = previous && previous.feet.equals(feet) && samePosition(previous.next, stroke.cell);
    const continuing = sameStroke && previous.ticks === ascent.ticks ? previous : null;
    const worldRevision = this.world.revision;
    let verified: readonly SwimStroke[];
    if (continuing && !continuing.dirty && continuing.worldRevision === worldRevision) {
      verified = continuing.alternatives;
    } else {
      const alternatives = equalEscapeStrokes(this.#read, feet, stroke, ascent.ticks);
      // A refresh can confirm a stroke already seen. A newly found stroke still needs another read (T30e, 2026-11-20).
      verified = continuing ? alternatives.filter(({ cell, ticks }) => continuing.alternatives.some(prior =>
        prior.ticks === ticks && samePosition(prior.cell, cell))) : [];
      session.ascentStroke = { feet, next: stroke.cell, ticks: ascent.ticks, worldRevision, alternatives, dirty: false };
    }
    const ticks = sameStroke ? remainingAscentTicks(this.bot, feet, ascent, stroke, verified) : ascent.ticks;
    return ticks + DIVE_BACKSTOP_TICKS;
  }

  committed(plan: Pick<RoutePlan, "steps">): void {
    const session = this.#session;
    if (!session) return;
    if (plan.steps.some(({ to }) => standingEyesInWater(this.bot, new Vec3(to.x + 0.5, to.y, to.z + 0.5)) && swimAscent(this.#read, to))) {
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

  /** The run's session, with its private first-air allowance bound to the active leg's stop token. */
  #openSession(options: NavigateOptions): DiveSession {
    const cancelled = new AbortController();
    const lifetime = AbortSignal.any([cancelled.signal, ...(options.signal ? [options.signal] : [])]);
    const firstAir = new FirstDiveAir({ bot: this.bot, world: this.world, leg: () => session.stop.signal,
      decide: () => observeDiveTick(this.bot, this.#read, session) });
    const session: DiveSession = { owned: false, returning: false, stop: new AbortController(),
      cancelled, lifetime, completedWork: 0, unchangedAir: false, lastBreathable: null, completed: false, ascentStroke: null,
      firstAir, allowanceLostAscent: false };
    this.#session = session;
    return session;
  }

  async run(options: NavigateOptions, navigate: Navigate) {
    if (this.#session) throw new Error("Navigation already owns a dive session.");
    const session = this.#openSession(options);
    const { lifetime } = session;
    const tick = () => observeDiveTick(this.bot, this.#read, session);
    using _strokeWatcher = watchAscentStroke(this.bot, session);
    using _firstAir = session.firstAir;
    options = { ...options, stopSignal: AbortSignal.any([session.cancelled.signal,
      ...(options.stopSignal ? [options.stopSignal] : [])]) };
    const started = monotonicNow();
    let previousStop = "";
    let repeatedStops = 0;
    this.bot.on("physicsTick", tick);
    if (this.#headInAir()) session.lastBreathable = this.bot.entity.position.floored();
    try {
      await this.#observeAir(options, session, lifetime);
      for (;;) {
        session.ascentStroke = null;
        options.signal?.throwIfAborted();
        if (options.stopSignal?.aborted) return { status: "stopped" as const,
          reason: String(options.stopSignal.reason), elapsedMs: elapsedSince(started) };
        const air = airSupplyTicks(this.bot) ?? (session.unchangedAir ? FULL_AIR_TICKS : null);
        const origin = this.bot.entity.position.clone();
        // A request beginning underwater must hold depth while its first search runs.
        session.owned = session.owned || (options.movements.allowSwimming && air !== null && swimAscent(this.#read, origin.floored()) !== null &&
          botEyesInWater(this.bot));
        const movements: MovementPolicy = { ...options.movements,
          get scaffold() { return options.movements.scaffold; },
          ...(air !== null && options.movements.allowSwimming ? { dive: { origin, airTicks: air } } : {}),
        };
        const result = await navigate({ ...options, movements,
          timeoutMs: options.timeoutMs === undefined ? undefined : Math.max(0, options.timeoutMs - elapsedSince(started)),
          stopSignal: AbortSignal.any([session.stop.signal, ...(options.stopSignal ? [options.stopSignal] : [])]),
        });
        const continuingDive = session.stop.signal.aborted;
        const returnToProcess = options.onArrival !== undefined && session.owned &&
          botEyesInWater(this.bot);
        if ((!continuingDive && !returnToProcess) || session.cancelled.signal.aborted || options.signal?.aborted ||
          (options.stopSignal?.aborted && !returnToProcess)) return this.#finished(session, result);
        const surface = swimAscent(this.#read, this.bot.entity.position.floored())?.surface;
        if (!surface) return { status: "stopped" as const, reason: "Dive lost its verified ascent corridor", elapsedMs: elapsedSince(started) };
        // The corridor is back: the run goes on, and a later failure keeps the ordinary swim back.
        session.allowanceLostAscent = false;
        const progress = `${this.bot.entity.position.floored()}:${session.completedWork}`;
        repeatedStops = progress === previousStop ? repeatedStops + 1 : 0;
        previousStop = progress;
        if (repeatedStops >= 2) return { status: "stopped" as const, reason: "Dive cannot make progress within one breath", elapsedMs: elapsedSince(started) };
        session.returning = true;
        session.ascentStroke = null;
        this.report("breathing");
        // A process's quantity signal ends its route, but still owes a safe
        // handoff. Action cancellation and defensive takeover always win.
        const returnStop = returnToProcess ? session.cancelled.signal : options.stopSignal;
        const unbreathed = await this.#breatheAtSurface(session, options, navigate, surface, lifetime, returnStop);
        if (unbreathed) return { ...unbreathed, elapsedMs: elapsedSince(started) };
        session.returning = false;
        session.ascentStroke = null;
        session.stop = new AbortController();
        this.report("resumed");
        // A mining process may revise targets between navigation transactions.
        // Return its body with air, rather than exposing low air to the ordinary reflex in that gap.
        if (!continuingDive) return this.#finished(session, result);
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (session.cancelled.signal.aborted) return { status: "stopped" as const,
        reason: String(session.cancelled.signal.reason), elapsedMs: elapsedSince(started) };
      throw error;
    } finally {
      this.bot.off("physicsTick", tick);
      session.firstAir.end(); // the window is the leg's: the swim back below runs on real air only
      session.ascentStroke = null;
      if (session.returning && !session.cancelled.signal.aborted) this.bot.setControlState("jump", false);
      await this.#swimBackToAir(session, options, navigate);
      this.#session = null;
      if (session.owned) this.report("released");
    }
  }

  /** The breathing stop's swim to `surface` and wait for full air; why it ended without full air, or null. */
  async #breatheAtSurface(session: DiveSession, options: NavigateOptions, navigate: Navigate, surface: BlockPosition,
    lifetime: AbortSignal, returnStop: AbortSignal | undefined): Promise<Omit<Extract<NavigationResult, { status: "stopped" }>, "elapsedMs"> | null> {
    using budget = this.#returnBudget(null);
    const returned = await this.#returnToAir(session, options, navigate, exactBlockGoal(surface), budget, returnStop);
    // The route's own failure fields are kept (the pinned watch reads `routeFailed`). A cancel, a takeover or a death keeps
    // its own reason; a return that found no way says so and what the model can do next.
    if (returned.status !== "completed") return session.cancelled.signal.aborted || returnStop?.aborted || returned.reason === RETURN_DIED
      ? returned : { ...returned, reason: `${BREATHING_STOP}: the swim back to air did not get there (${returned.reason}); breathe at the surface before trying this way again` };
    const breath = await waitForFullAir(this.bot, lifetime, returnStop);
    return breath === "full" ? null : { status: "stopped", reason: breath === "stopped" ? "Request stopped while breathing" : FULL_AIR_NOT_OBSERVED };
  }

  /** The air the server has not reported yet, observed before the first route is planned. */
  async #observeAir(options: NavigateOptions, session: DiveSession, lifetime: AbortSignal): Promise<void> {
    // Servers omit unchanged default air metadata on login. Observe the first
    // shallow head immersion before admitting any dive; full air is inferred only by
    // `air-supply.ts` (a body never under water since it spawned), never here.
    // This stays within one block of an already verified breathable surface.
    const initialSurface = openWaterSurface(this.#read, this.bot.entity.position.floored());
    if (!options.movements.allowSwimming || airSupplyTicks(this.bot) !== null) return;
    const shallow = initialSurface !== null && this.bot.entity.position.y >= initialSurface.y - 0.5;
    if (initialSurface !== null && !shallow) return;
    // Roofed, there is no surface to breathe at to make the server report the air (live 2026-10-10: a bot stuck on
    // the sea floor under an overhang never got a dive budget, so no route out). The server sends the air whenever
    // it changes, so a head kept under water for a moment with none sent means it is not running down.
    using budget = serverPacedSignal(this.bot, shallow ? 80 : AIR_OBSERVATION_TICKS);
    const stop = AbortSignal.any([lifetime, budget.signal, ...(options.stopSignal ? [options.stopSignal] : [])]);
    try {
      while (!stop.aborted && airSupplyTicks(this.bot) === null && (shallow || botEyesInWater(this.bot))) {
        options.signal?.throwIfAborted();
        if (shallow) this.bot.setControlState("jump", this.bot.entity.position.y < initialSurface!.y - 0.8);
        await waitForPhysicsTicks(this.bot, 1, stop);
      }
    } catch (cause) {
      lifetime.throwIfAborted();
      if (!budget.signal.aborted && !options.stopSignal?.aborted) throw cause;
    } finally {
      if (shallow && !session.cancelled.signal.aborted) this.bot.setControlState("jump", false);
    }
    session.unchangedAir = !shallow && budget.end() === "ticks" && airSupplyTicks(this.bot) === null && botEyesInWater(this.bot);
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
    if (session.completed || session.allowanceLostAscent || !session.owned || target === null || session.cancelled.signal.aborted || options.signal?.aborted ||
      (this.bot.health ?? 20) <= 0) return;
    if (!botEyesInWater(this.bot)) return;
    using budget = this.#returnBudget(airSupplyTicks(this.bot));
    try {
      await this.#returnToAir(session, options, navigate, exactBlockGoal(target), budget, options.signal);
    } catch {
      // The route back failed: the body stays where it is for the breath reflex, which owns the last resort.
    }
  }

  /** Bound a return by the air's server ticks, with the shared wall and stopped-clock backstops. */
  #returnBudget(air: number | null) {
    const ticks = air === null ? SWIM_BACK_MAXIMUM_TICKS : Math.min(SWIM_BACK_MAXIMUM_TICKS, Math.max(SWIM_BACK_MINIMUM_TICKS, air));
    return { ticks, ...serverPacedSignal(this.bot, ticks) };
  }

  /**
   * A swim to air from where the body is: admitted while each cell's way up fits the air left, with no reserve (the
   * dive's own admission refuses every cell once the air is at most the way up plus the reserve, which is when a stop
   * fires: T5 probe 2026-10-21). A death or a respawn ends it.
   */
  async #returnToAir(session: DiveSession, options: NavigateOptions, navigate: Navigate, goal: NavigateOptions["goal"],
    budget: ServerPacedSignal & { readonly ticks: number }, stopSignal: AbortSignal | undefined): ReturnType<Navigate> {
    session.ascentStroke = null;
    const ended = new AbortController();
    const onEnd = () => ended.abort(RETURN_DIED);
    this.bot.once("death", onEnd);
    this.bot.once("respawn", onEnd);
    try {
      // Air not reported here was never seen running down (the swim back's rule before T6): taken as full.
      const air = airSupplyTicks(this.bot) ?? FULL_AIR_TICKS;
      const dive = options.movements.allowSwimming ? { dive: { origin: this.bot.entity.position.clone(), airTicks: air, toAir: true } } : {};
      return await navigate({ movements: { ...options.movements, ...dive }, goal, signal: options.signal,
        timeoutMs: serverPacedWallMs(budget.ticks),
        stopSignal: AbortSignal.any([budget.signal, session.cancelled.signal, ended.signal, ...(stopSignal ? [stopSignal] : [])]) });
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
