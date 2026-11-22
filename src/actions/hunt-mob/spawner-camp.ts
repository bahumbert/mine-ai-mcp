import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { nearGoal, type Navigate } from "../../navigation/index.js";
import { clockStart, monotonicNow, waitForSignal, type ClockStart } from "../../utils/index.js";
import { findLoadedBlockPositions } from "../../world/loaded-block-scan.js";
import { MS_PER_ON_TIME_TICK, serverPacedWallMs, serverTickDeadline, ticksOnTime } from "../../world/world-age.js";

// Stand beside the solid spawner, leaving room for navigation to choose safe footing.
const CAMP_RANGE = 3;

/** The longest delay the timer API takes (a platform limit): a longer wait sleeps in chunks of this. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Events that can show quarry or end a window: the time packet (the age moving) and the world's own changes. */
export const OBSERVATION_EVENTS = ["time", "physicsTick", "entitySpawn", "entityUpdate", "blockUpdate"];

/**
 * One observation window of `observe_for_ms` read as game time at 20 ticks a second (plan 2026-11-18-scenario-reds-part2-a3
 * D32): it ends at the first look at or after the time packet `ceil((ticks + 20) / 20) * 20` ticks past the age cached at
 * its start, so a slow server gives the same game time, and at the wall backstop `serverPacedWallMs(ticks)` when the
 * server stops. With no age at its start it is real milliseconds. The deadline decides; the budget entry only reports.
 */
export interface ObservationWindow {
  readonly start: ClockStart;
  readonly ticks: number;
  readonly wallMs: number;
  ended(nowMs: number): boolean;
  elapsedTicks(nowMs: number): number | null;
  /** Milliseconds until the next look is worth taking: the wall or the no-age fallback, at least 1, within the timer limit. */
  wakeMs(nowMs: number): number;
}

export function observationWindow(bot: Bot, ms: number): ObservationWindow {
  const start = clockStart();
  const ticks = ticksOnTime(ms);
  const wallMs = serverPacedWallMs(ticks);
  const readAge = () => bot.time?.age ?? null;
  const ageHeardAtStart = readAge() !== null;
  const deadline = serverTickDeadline(readAge, ticks, start.began, { origin: "packet", wallMs, stoppedMs: null });
  return {
    start,
    ticks,
    wallMs,
    ended: (nowMs) => deadline.passed(nowMs),
    elapsedTicks: (nowMs) => deadline.elapsed(nowMs).ticks,
    wakeMs(nowMs) {
      const sinceStart = nowMs - start.began;
      const noAgeLeft = ageHeardAtStart ? Number.POSITIVE_INFINITY : ticks * MS_PER_ON_TIME_TICK - sinceStart;
      return Math.max(1, Math.ceil(Math.min(wallMs - sinceStart, noAgeLeft, MAX_TIMER_DELAY_MS)));
    },
  };
}

/** The window as the checkpoint and snapshot show it: ticks counted since its start (null until an age was heard). */
export function observationTicksOf(window: ObservationWindow | null): { elapsed: number | null; limit: number } | null {
  return window === null ? null : { elapsed: window.elapsedTicks(monotonicNow()), limit: window.ticks };
}

/**
 * Wait until `done()` or the window ends; rejects with the signal's reason on abort. The caller re-reads `done()` after:
 * availability wins over an expiry that came with it.
 */
export async function waitInObservationWindow(
  bot: Bot,
  window: ObservationWindow,
  done: () => unknown,
  signal: AbortSignal | undefined,
): Promise<void> {
  const settled = () => (done() || window.ended(monotonicNow()) ? true : null);
  for (;;) {
    signal?.throwIfAborted();
    if (settled()) return;
    await waitForSignal(settled, bot, OBSERVATION_EVENTS, {
      ...(signal && { context: { signal } }),
      timeoutMs: window.wakeMs(monotonicNow()),
    });
  }
}

export function closestLoadedSpawner(bot: Bot): Vec3 | null {
  const spawner = bot.registry.blocksByName.spawner;
  if (!spawner) return null;
  const stateIds = new Set<number>();
  for (let id = spawner.minStateId; id <= spawner.maxStateId; id++) stateIds.add(id);
  return findLoadedBlockPositions(bot, { center: bot.entity.position, stateIds, limit: 1 })[0] ?? null;
}

export type CampFailure = {
  readonly termination: "spawner_unavailable" | "spawner_unreachable" | "observation_exhausted";
  readonly reason: string;
};

/** One request's remembered source. Navigation owns all physical movement. */
export class SpawnerCamp {
  readonly #dimension: string;
  #phase: "hunting" | "waiting_away" | "returning" | "waiting_at_spawner" = "hunting";
  // The window's `start.at` shows in the snapshot; its game-time deadline ends the wait.
  #absenceWindow: ObservationWindow | null = null;
  #campWindow: ObservationWindow | null = null;

  constructor(
    private readonly bot: Bot,
    readonly position: Vec3 | null,
    private readonly waitMs: number,
    private readonly returnTo: (position: Vec3, signal: AbortSignal) => ReturnType<Navigate>,
  ) {
    this.#dimension = bot.game.dimension;
  }

  get snapshot() {
    return {
      position: this.position ? { x: this.position.x, y: this.position.y, z: this.position.z } : null,
      dimension: this.#dimension,
      phase: this.#phase,
      returnAfter: this.#absenceWindow === null ? null : this.#absenceWindow.start.at + this.waitMs,
      observationUntil: this.#campWindow === null ? null : this.#campWindow.start.at + this.waitMs,
      observationTicks: observationTicksOf(this.#windowOfPhase()),
    };
  }

  /** The window the bot is waiting in now: none while it returns or hunts. */
  #windowOfPhase(): ObservationWindow | null {
    if (this.#phase === "waiting_away") return this.#absenceWindow;
    if (this.#phase === "waiting_at_spawner") return this.#campWindow;
    return null;
  }

  unavailable(): CampFailure | null {
    if (!this.position)
      return {
        termination: "spawner_unavailable",
        reason: "[HUNT_SPAWNER_UNAVAILABLE] No loaded spawner was observed at admission.",
      };
    if (this.bot.game.dimension !== this.#dimension)
      return {
        termination: "spawner_unavailable",
        reason: "[HUNT_SPAWNER_UNAVAILABLE] The remembered spawner is in another dimension.",
      };
    const block = this.bot.blockAt(this.position);
    // Unloaded is unknown, not destroyed. Navigate back to the remembered source.
    if (block && block.name !== "spawner")
      return {
        termination: "spawner_unavailable",
        reason: `[HUNT_SPAWNER_UNAVAILABLE] The remembered spawner at ${this.position} is now ${block.name}.`,
      };
    return null;
  }

  #atCamp(): boolean {
    return this.position !== null && this.bot.entity.position.floored().distanceTo(this.position) <= CAMP_RANGE;
  }

  hunting(): void {
    this.#phase = "hunting";
    this.#absenceWindow = null;
    this.#campWindow = null;
  }

  /** Preserve the away-wait deadline and return phase across reflex suspension. */
  async waitForQuarry(available: () => boolean, signal: AbortSignal): Promise<CampFailure | null> {
    for (;;) {
      signal.throwIfAborted();
      // What the caller already has is read before the camp's own admission: a count met during the wait ends it.
      if (available()) {
        this.hunting();
        return null;
      }
      const missing = this.unavailable();
      if (missing) return missing;
      if (!this.#atCamp()) {
        const absence = (this.#absenceWindow ??= observationWindow(this.bot, this.waitMs));
        if (!absence.ended(monotonicNow())) {
          this.#phase = "waiting_away";
          await waitInObservationWindow(this.bot, absence, () => available() || this.unavailable(), signal);
          if (available() || this.unavailable()) continue;
        }
        this.#phase = "returning";
        const route = await this.returnTo(this.position!, signal);
        signal.throwIfAborted();
        if (route.status === "stopped")
          return { termination: "spawner_unreachable", reason: `[HUNT_SPAWNER_UNREACHABLE] ${route.reason}` };
        if (!this.#atCamp())
          return {
            termination: "spawner_unreachable",
            reason: "[HUNT_SPAWNER_UNREACHABLE] The return route ended outside the spawner's camp area.",
          };
      }
      this.#phase = "waiting_at_spawner";
      const camp = (this.#campWindow ??= observationWindow(this.bot, this.waitMs));
      if (camp.ended(monotonicNow()))
        return {
          termination: "observation_exhausted",
          reason:
            "[HUNT_OBSERVATION_EXHAUSTED] No loaded quarry or requested inventory gain was observed within the requested wait at the spawner.",
        };
      // No repeated routes while already home. Suspension and displacement do
      // not renew this deadline; a dark room is not assumed to produce a mob.
      await waitInObservationWindow(this.bot, camp, () => available() || this.unavailable() || !this.#atCamp(), signal);
    }
  }
}

export function spawnerCampGoal(position: Vec3) {
  return nearGoal(position, CAMP_RANGE);
}
