/**
 * One request's record of "our placement packet went to these cells", and what became of it.
 *
 * A reflex cuts a placing action into attempts, and the next attempt must tell the block its own packet put down
 * from one a reflex (or another player) put there. The record is made at the send, never at the choice of the cell:
 * an abort during the equip or the look sends nothing, so nothing is recorded and a block that appears in that cell
 * later is never ours. What became of the packet is decided only once the server has answered: the awaited block is
 * there, or the world age moved `SERVER_ANSWER_TICKS` past the send. A server seconds behind therefore cannot make
 * a resume place a second block while the first is still in flight.
 *
 * No module state: every request keeps its own `OwnPlacement` (20 bots, two requests on one bot).
 */
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import type { WorldBlock } from "./placement.js";
import { waitForServerAnswer } from "./world-age.js";

export interface OwnPlacement {
  /** The cells the last placement packet went to (a bed: foot and head); empty when nothing was sent. */
  cells: readonly Vec3[];
  /** World age when that packet was sent. */
  sentAtAge: number | undefined;
}

/** Wall-clock bound of the answer wait, for a server whose clock has stopped. */
export const OWN_PLACEMENT_WALL_MS = 5_000;

export function startOwnPlacement(): OwnPlacement {
  return { cells: [], sentAtAge: undefined };
}

/** Called right before the packet goes out; a later send replaces the record. */
export function recordPlacementSent(own: OwnPlacement, cells: readonly Vec3[], worldAge: number | undefined): void {
  own.cells = cells.map((cell) => cell.clone());
  own.sentAtAge = worldAge;
}

/** The placement did not take (or was undone): a block that appears there later is not ours. */
export function forgetPlacement(own: OwnPlacement): void {
  own.cells = [];
  own.sentAtAge = undefined;
}

export type OwnPlacementSeen =
  | { readonly kind: "none" }
  | { readonly kind: "landed"; readonly cell: Vec3; readonly block: WorldBlock }
  | { readonly kind: "unloaded"; readonly cell: Vec3 }
  | { readonly kind: "not_landed" };

/** The first sent cell holding a block that `matches`, else the first not loaded, as the world shows them now. */
function lookAtSentCells(
  bot: Bot,
  own: OwnPlacement,
  matches: (block: WorldBlock) => boolean,
): Extract<OwnPlacementSeen, { kind: "landed" | "unloaded" }> | null {
  let unloaded: Vec3 | null = null;
  for (const cell of own.cells) {
    const block = bot.blockAt(cell);
    if (block === null) unloaded ??= cell;
    else if (matches(block)) return { kind: "landed", cell, block };
  }
  return unloaded === null ? null : { kind: "unloaded", cell: unloaded };
}

/**
 * This request's sent placement as the server answered it: waits up to `SERVER_ANSWER_TICKS` of world age past the
 * send (and at most `wallMs` on the wall clock) for a sent cell to hold a block that `matches`. A cell that is not
 * loaded cannot be judged and is reported at once: the bot has to go back near it.
 */
export async function awaitOwnPlacement(
  bot: Bot,
  own: OwnPlacement,
  matches: (block: WorldBlock) => boolean,
  signal?: AbortSignal,
  wallMs = OWN_PLACEMENT_WALL_MS,
): Promise<OwnPlacementSeen> {
  if (own.cells.length === 0) return { kind: "none" };
  const settled = () => lookAtSentCells(bot, own, matches) !== null;
  await waitForServerAnswer(bot, own.sentAtAge, { until: settled, wallMs, ...(signal && { signal }) });
  return lookAtSentCells(bot, own, matches) ?? { kind: "not_landed" };
}
