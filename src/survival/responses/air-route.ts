import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { headInAir, routeCellReached, swimBreathRoute, swimCellKey } from "../positioning/swim-escape.js";

/** A cell of the swim to air that is not closed in this long (one second) marks that way blocked. */
const CELL_STALL_TICKS = 20;
/** After this many blocked ways the reflex digs up instead of asking for another. */
const BLOCKED_WAYS_BEFORE_DIGGING = 2;

/**
 * The swim to a breathable cell the breath reflex follows: asked for when there is none, walked cell by cell, a way that
 * stalls closed for the next. A route that is spent (empty because the head was in air, or walked to its last cell) is
 * dropped as soon as the head is under water again, so the reflex asks anew, or digs, instead of only jumping (review
 * 2026-10-18, run 15 fixes).
 */
export class AirRoute {
  #route: Vec3[] | null = null;
  #next = 0;
  #cellTicks = 0;
  #blockedWays = 0;
  readonly #closedCells = new Set<string>();

  /** No way to air is known: none was found, or the ways tried stalled. Digging up is the reflex's last resort then. */
  get none(): boolean {
    return this.#route === null;
  }

  /** The cell being swum to; null when there is no route or it is spent. */
  get target(): Vec3 | null {
    return this.#route?.[this.#next] ?? null;
  }

  /** Whether the cell being swum to is the last one (it is always risen to). */
  get onLastCell(): boolean {
    return this.#route !== null && this.#next === this.#route.length - 1;
  }

  /** One physics tick of the surfacing; `roofed` is a roof over the swimming body (a way to air is asked for only then). */
  update(bot: Bot, roofed: boolean): void {
    this.#walk(bot);
    if (this.#spent() && !headInAir(bot)) this.#route = null;
    if (roofed && this.#route === null && this.#blockedWays < BLOCKED_WAYS_BEFORE_DIGGING) {
      this.#route = swimBreathRoute(bot, this.#closedCells);
      this.#next = 0;
      this.#cellTicks = 0;
    }
  }

  #spent(): boolean {
    return this.#route !== null && this.#next >= this.#route.length;
  }

  #walk(bot: Bot): void {
    if (this.#route === null || this.#spent()) return;
    if (routeCellReached(bot.entity.position, this.#route[this.#next]!)) {
      this.#next++;
      this.#cellTicks = 0;
    } else if (++this.#cellTicks >= CELL_STALL_TICKS) {
      this.#closedCells.add(swimCellKey(this.#route[this.#next]!.floored()));
      this.#blockedWays++;
      this.#route = null;
    }
  }
}
