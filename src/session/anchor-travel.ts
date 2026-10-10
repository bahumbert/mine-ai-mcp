interface Point { readonly x: number; readonly y: number; readonly z: number }

/** Horizontal displacement from the anchor that counts as travel, and the vertical one (never counted in water). */
const HORIZONTAL_BLOCKS = 1;
const VERTICAL_BLOCKS = 2;

/**
 * Distance travelled, measured from an anchor rather than summed per sample, the way `PlanningStall` measures
 * displacement: jitter and the bob of a swimmer (live 2026-10-10 run 7: 653 blocks "travelled" at one x/z) add nothing.
 * A move counts once it is at least a block horizontally from the anchor (its horizontal distance), plus a vertical
 * move of at least two blocks while the bot is not in water.
 */
export class AnchorTravel {
  #anchor: Point | null;

  constructor(start: Point | null = null) {
    this.#anchor = start === null ? null : { ...start };
  }

  /** The travel this sample adds; the first sample only places the anchor. */
  add(position: Point, inWater: boolean): number {
    const anchor = this.#anchor;
    if (anchor === null) {
      this.#anchor = { ...position };
      return 0;
    }
    const horizontal = Math.hypot(position.x - anchor.x, position.z - anchor.z);
    const vertical = Math.abs(position.y - anchor.y);
    const counted = (horizontal >= HORIZONTAL_BLOCKS ? horizontal : 0) + (!inWater && vertical >= VERTICAL_BLOCKS ? vertical : 0);
    if (counted > 0) this.#anchor = { ...position };
    return counted;
  }

  /** Forget the anchor (a teleport or dimension change): the next sample places a new one. */
  reset(): void {
    this.#anchor = null;
  }
}
