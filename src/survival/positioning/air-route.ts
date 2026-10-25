/** The swim to air a drowning or pinned swimmer follows, cell by cell, and when a way counts as blocked. */
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { headInAir, routeCellReached, swimBreathRoute, swimCellKey } from "./swim-escape.js";

/** A cell of the swim to air the body gets no nearer to for this long (one second) marks that way blocked. */
const CELL_STALL_TICKS = 20;
/** Nearer by this much (blocks) is progress: a slow swim against a current is not a stall (run 16, Yuki: 0.5 block in 2 s). */
const STALL_PROGRESS_BLOCKS = 0.1;
/** After this many blocked ways the breath reflex digs up instead of asking for another. */
export const BLOCKED_WAYS_BEFORE_DIGGING = 2;

/**
 * The swim to a breathable cell the breath reflex and the pinned escape follow: asked for when there is none, walked
 * cell by cell, a way the body stops getting nearer to closed for the next. A route that is spent (empty because the
 * head was in air, or walked to its last cell) is dropped as soon as the head is under water again, so the swimmer
 * asks anew, or digs, instead of only jumping (review 2026-10-18, run 15 fixes).
 */
export class AirRoute {
  #route: Vec3[] | null = null;
  #next = 0;
  #stalledTicks = 0;
  #nearest = Number.POSITIVE_INFINITY;
  #blockedWays = 0;
  readonly #closedCells = new Set<string>();

  /** `maximumBlockedWays`: after this many ways closed no other is asked for. */
  constructor(readonly maximumBlockedWays = BLOCKED_WAYS_BEFORE_DIGGING) {}

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

  /** One physics tick of the swim; `roofed` is a roof over the swimming body (a way to air is asked for only then). */
  update(bot: Bot, roofed: boolean): void {
    this.#walk(bot);
    if (this.#spent() && !headInAir(bot)) this.#route = null;
    if (roofed && this.#route === null && this.#blockedWays < this.maximumBlockedWays) {
      this.#route = swimBreathRoute(bot, this.#closedCells);
      this.#next = 0;
      this.#startCell();
    }
  }

  /** Forgets the ways closed so far, so the next update asks again through them (the roof was too slow to dig). */
  reopenClosedWays(): void {
    this.#closedCells.clear();
    this.#blockedWays = 0;
  }

  #spent(): boolean {
    return this.#route !== null && this.#next >= this.#route.length;
  }

  #startCell(): void {
    this.#stalledTicks = 0;
    this.#nearest = Number.POSITIVE_INFINITY;
  }

  #walk(bot: Bot): void {
    if (this.#route === null || this.#spent()) return;
    const cell = this.#route[this.#next]!;
    if (routeCellReached(bot.entity.position, cell)) {
      this.#next++;
      this.#startCell();
      return;
    }
    const distance = bot.entity.position.distanceTo(cell);
    if (distance < this.#nearest - STALL_PROGRESS_BLOCKS) {
      this.#nearest = distance;
      this.#stalledTicks = 0;
    } else if (++this.#stalledTicks >= CELL_STALL_TICKS) {
      this.#closedCells.add(swimCellKey(cell.floored()));
      this.#blockedWays++;
      this.#route = null;
    }
  }
}
