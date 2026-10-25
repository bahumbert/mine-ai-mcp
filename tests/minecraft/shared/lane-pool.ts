// The free lane slots of one server: lowest free index first, held until the trial and its restore settle.
import { LAST_BODY, laneOf, type Lane } from "../arena/lanes.ts";

export class LanePool {
  readonly #held = new Map<number, Lane>();
  readonly #quarantined = new Set<number>();
  /** Per lane index: the body its next trial gets. A body is never handed out twice on one server (the player files stay in its world). */
  readonly #nextBody = new Map<number, number>();
  #highWater = 0;

  /** `maxLanes`: lanes 1..maxLanes exist (lane 0 belongs to refused scenarios on servers of their own). */
  constructor(private readonly maxLanes: number) {}

  /** The lowest free lane with a body it has never had, or null when every lane is held, quarantined or out of bodies. */
  acquire(): Lane | null {
    for (let index = 1; index <= this.maxLanes; index++) {
      if (this.#held.has(index) || this.#quarantined.has(index) || this.#isOutOfBodies(index)) continue;
      const body = this.#nextBody.get(index) ?? 0;
      const lane = laneOf(index, body);
      this.#nextBody.set(index, body + 1);
      this.#held.set(index, lane);
      this.#highWater = Math.max(this.#highWater, index);
      return lane;
    }
    return null;
  }

  release(lane: Lane): void {
    if (!this.#held.delete(lane.index)) throw new Error(`lane ${lane.index} is not held`);
  }

  /** The lane's restore failed: its arena may be dirty, so it is never handed out again on this server. */
  quarantine(lane: Lane): void {
    this.release(lane);
    this.#quarantined.add(lane.index);
  }

  /** Lanes that can still be handed out. */
  get freeCount(): number {
    let free = 0;
    for (let index = 1; index <= this.maxLanes; index++) {
      if (!this.#held.has(index) && !this.#quarantined.has(index) && !this.#isOutOfBodies(index)) free++;
    }
    return free;
  }

  get heldCount(): number {
    return this.#held.size;
  }

  get quarantinedCount(): number {
    return this.#quarantined.size;
  }

  /** Half the lanes ever in use are quarantined, or a lane used its last body: the server restarts once it drains (a fresh world, so no name returns). */
  get needsRestart(): boolean {
    const halfQuarantined = this.#quarantined.size > 0 && this.#quarantined.size * 2 >= this.#highWater;
    return halfQuarantined || [...this.#nextBody.values()].some((next) => next > LAST_BODY);
  }

  #isOutOfBodies(index: number): boolean {
    return (this.#nextBody.get(index) ?? 0) > LAST_BODY;
  }
}
