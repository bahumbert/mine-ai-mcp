import type { NavigationObservation, Position3 } from "../world/world.js";
import type { NavigationFailure } from "./outcome.js";

const STALL_MS = 20_000;
/** Horizontal re-anchors in one window that, over `STALL_MS`, read as a body carried away rather than one shoved. */
const DRIFT_RENEWALS = 6;

/**
 * One stationary planning window across retries, never a deadline for executing a route.
 *
 * A body that keeps moving renews the window, so a current or a conveyor carrying it away from every search's start
 * would never stall. The drift counts those horizontal renewals from the window's first anchor: enough of them over
 * the stall time end the run as `drifting`.
 */
export class PlanningStall {
  #window: { atMs: number; position: Position3; dimension: string } | null = null;
  #drift: { atMs: number; position: Position3; renewals: number } | null = null;

  /** `clock` is the monotonic time in ms; tests move it. */
  constructor(private readonly clock: () => number = () => performance.now()) {}

  begin(observation: NavigationObservation, now = this.clock()): void {
    this.#window ??= { atMs: now, position: { ...observation.position }, dimension: observation.dimension };
    this.#drift ??= { atMs: now, position: { ...observation.position }, renewals: 0 };
  }

  committed(): void {
    this.#window = null;
    this.#drift = null;
  }

  check(observation: NavigationObservation, now = this.clock()): NavigationFailure | null {
    const window = this.#window;
    if (!window) return null;
    const { position } = observation;
    // Measure displacement from an anchor, not accumulated motion: jitter and
    // the one-block vertical surface bob cannot keep renewing this window.
    const moved = Math.hypot(position.x - window.position.x, position.z - window.position.z);
    if (observation.dimension !== window.dimension || moved >= 1 || Math.abs(position.y - window.position.y) >= 2) {
      this.#window = { atMs: now, position: { ...position }, dimension: observation.dimension };
      return observation.dimension === window.dimension && moved >= 1 ? this.#drifted(position, now) : null;
    }
    const elapsedMs = now - window.atMs;
    return elapsedMs >= STALL_MS ? {
      kind: "no_progress", reason: "planning_stalled",
      observation: `Path planning stalled for ${Math.round(elapsedMs)} ms without a route commitment or meaningful displacement (1 block horizontally or 2 vertically); limit ${STALL_MS} ms. Repeated search invalidation does not renew this limit.`,
    } : null;
  }

  /** One more horizontal re-anchor: the failure when the window has been carried that way long enough. */
  #drifted(position: Position3, now: number): NavigationFailure | null {
    const drift = this.#drift;
    if (!drift) return null;
    drift.renewals += 1;
    const elapsedMs = now - drift.atMs;
    if (drift.renewals < DRIFT_RENEWALS || elapsedMs < STALL_MS) return null;
    const blocks = Math.round(Math.hypot(position.x - drift.position.x, position.z - drift.position.z));
    return {
      kind: "no_progress",
      reason: "drifting",
      observation:
        `Carried ${blocks} blocks in ${Math.round(elapsedMs / 1_000)} s while every search from the old cell was overtaken; no route was committed. ` +
        `Something keeps moving the bot (a current, a vehicle, knockback): get clear of it, or stand on solid ground, then ask again.`,
    };
  }
}
