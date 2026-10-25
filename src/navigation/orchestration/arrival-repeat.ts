/** The same satisfied goal coming back again and again with the arrival work changing nothing: how a run notices it and ends. */
import type { BlockPosition, NavigationObservation, WorldChange } from "../world/world.js";
import type { NavigationFailure } from "./outcome.js";

/** How long one arrival may keep coming back to nothing done before the run says so. */
export const ARRIVAL_REPEAT_MS = 5_000;
/** The least calls in that time: two are an arrival and its retry, three are a loop. */
export const ARRIVAL_REPEAT_CALLS = 3;
/** A block changed this near the arrival is work the arrival did (a dig, a placement), however small. */
const WORK_REACH = 5;

/** What one satisfied goal asks of `ArrivalRepeat.note`. */
export interface ArrivalIdentity {
  readonly goalRevision: string;
  readonly feet: BlockPosition;
  readonly observation: NavigationObservation;
}

/**
 * The same arrival, asked again and again with nothing done.
 *
 * A process's arrival work (mining, building) may answer `continue` after acting at the reached cell. One that acts
 * on nothing - the body is in the air or in the water where the work cannot start - lets the loop judge the same
 * goal satisfied at once, forever. The identity is the goal revision, the feet cell, the inventory revision and the
 * count of world changes near the feet since the last arrival: when all hold for `ARRIVAL_REPEAT_MS` and
 * `ARRIVAL_REPEAT_CALLS` calls the run ends. Any route commit, move, inventory change or nearby block change starts over.
 */
export class ArrivalRepeat {
  #current: { readonly identity: string; readonly atMs: number; calls: number } | null = null;
  #anchor: BlockPosition | null = null;
  #nearChanges = 0;

  /** `clock` is the monotonic time in ms; tests move it. */
  constructor(private readonly clock: () => number = () => performance.now()) {}

  /** The run's world subscription tells every change; the ones near the last arrival count as work. */
  worldChanged({ position }: WorldChange): void {
    const anchor = this.#anchor;
    if (anchor && Math.max(Math.abs(position.x - anchor.x), Math.abs(position.y - anchor.y), Math.abs(position.z - anchor.z)) <= WORK_REACH)
      this.#nearChanges += 1;
  }

  /** One satisfied goal whose arrival work asked to go on: the failure when it has done nothing for long enough. */
  note({ goalRevision, feet, observation }: ArrivalIdentity, now = this.clock()): NavigationFailure | null {
    this.#anchor = feet;
    const identity = `${goalRevision}|${feet.x},${feet.y},${feet.z}|${observation.resourceRevision}|${this.#nearChanges}`;
    if (this.#current?.identity !== identity) {
      this.#current = { identity, atMs: now, calls: 1 };
      return null;
    }
    this.#current.calls += 1;
    const elapsedMs = now - this.#current.atMs;
    if (this.#current.calls < ARRIVAL_REPEAT_CALLS || elapsedMs < ARRIVAL_REPEAT_MS) return null;
    return {
      kind: "no_progress",
      reason: "repeated_arrival",
      observation:
        `The goal is reached at ${feet.x}, ${feet.y}, ${feet.z} but the work there changed nothing for ${Math.round(elapsedMs / 1_000)} s ` +
        `in the ${observation.stance} stance (${this.#current.calls} tries); move or change what is asked.`,
    };
  }

  reset(): void {
    this.#current = null;
    this.#anchor = null;
    this.#nearChanges = 0;
  }
}
