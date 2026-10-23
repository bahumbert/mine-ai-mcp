// The free lane slots of one server: lowest free index first, held until the trial and its restore settle.
import { laneOf, type Lane } from "../arena/lanes.ts";

export class LanePool {
  readonly #held = new Map<number, Lane>();
  readonly #quarantined = new Set<number>();
  #highWater = 0;

  /** `maxLanes`: lanes 1..maxLanes exist (lane 0 belongs to refused scenarios on servers of their own). */
  constructor(private readonly maxLanes: number) {}

  /** The lowest free lane, or null when every lane is held or quarantined. */
  acquire(): Lane | null {
    for (let index = 1; index <= this.maxLanes; index++) {
      if (this.#held.has(index) || this.#quarantined.has(index)) continue;
      const lane = laneOf(index);
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
    return this.maxLanes - this.#held.size - this.#quarantined.size;
  }

  get heldCount(): number {
    return this.#held.size;
  }

  get quarantinedCount(): number {
    return this.#quarantined.size;
  }

  /** Half the lanes ever in use are quarantined: the server restarts once it drains. */
  get needsRestart(): boolean {
    return this.#quarantined.size > 0 && this.#quarantined.size * 2 >= this.#highWater;
  }
}
