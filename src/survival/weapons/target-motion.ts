// A fight's record of each target's observed movement (blocks per tick), which the bow leads.
import { Vec3 } from "vec3";

/** A target's velocity is its mean displacement per tick over this many tick intervals, 6 sightings (spec 2026-11-07-p4-06c D7). */
export const TARGET_MOTION_TICKS = 5;

interface Sighting {
  readonly tick: number;
  readonly position: Vec3;
}

/**
 * What a fight has seen of each target's movement, from positions observed on consecutive physics ticks. The bow leads
 * this observed displacement; the `movement_speed` attribute is not used (whether the server sends it for mobs, and its
 * unit, are unmeasured: spec D7).
 */
export class TargetMotion {
  readonly #sightings = new Map<number, Sighting[]>();

  /** Record the entity's position at this tick; a gap in the ticks starts that entity's history again. */
  observe(entity: { readonly id: number; readonly position: Vec3 }, tick: number): void {
    const history = this.#sightings.get(entity.id) ?? [];
    if (history.length > 0 && history[history.length - 1]!.tick !== tick - 1) history.length = 0;
    history.push({ tick, position: entity.position.clone() });
    if (history.length > TARGET_MOTION_TICKS + 1) history.shift();
    this.#sightings.set(entity.id, history);
  }

  /** Blocks per tick; zero until two consecutive ticks were seen. */
  velocity(id: number): Vec3 {
    const history = this.#sightings.get(id);
    if (!history || history.length < 2) return new Vec3(0, 0, 0);
    const first = history[0]!;
    const last = history[history.length - 1]!;
    return last.position.minus(first.position).scaled(1 / (last.tick - first.tick));
  }
}
