/**
 * The ledger of blocks a life-saving reflex put inside someone else's protected region (owner choice 5 (a), plan
 * 2026-11-07-p4-06a-threat T5a): a footing block under a falling body is placed even there, and each is written down
 * so that it can be taken out again once the bot is safe (T5c). The ledger is per bot and lives in memory: a death
 * keeps it, because the block outlives the body.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { monotonicNow } from "../utils/monotonic-clock.js";
import { foreignRegionAt } from "./protected-regions.js";

export type LifeSavingKind = "block" | "water";

export interface LifeSavingPlacement {
  readonly cell: Vec3;
  /** The block the cell held when it was recorded. */
  readonly block: string;
  readonly regionId: number;
  readonly kind: LifeSavingKind;
  /** `monotonicNow()` at the record. */
  readonly recordedAt: number;
}

const ledgers = new WeakMap<Bot, LifeSavingPlacement[]>();

/**
 * Write down a placement made inside a region of someone else. A cell outside every foreign region is not recorded:
 * nothing there needs taking back. Called when the packet goes out, so a cut or a death after it still leaves the
 * record (the block may stand); `block` is what was placed, the cell's own block when omitted. A record whose cell no
 * longer holds that block is dropped by the removal (T5c), never dug.
 */
export function recordLifeSavingPlacement(bot: Bot, cell: Vec3, kind: LifeSavingKind, block?: string): void {
  const region = foreignRegionAt(bot, cell);
  if (region === null) return;
  const ledger = ledgers.get(bot) ?? [];
  ledgers.set(bot, ledger);
  if (ledger.some((entry) => entry.cell.equals(cell))) return;
  ledger.push({
    cell: cell.clone(),
    block: block ?? bot.blockAt(cell)?.name ?? "unobserved",
    regionId: region.regionId,
    kind,
    recordedAt: monotonicNow(),
  });
}

/** The placements still standing in someone else's region, oldest first. */
export function pendingLifeSavingPlacements(bot: Bot): readonly LifeSavingPlacement[] {
  return ledgers.get(bot) ?? [];
}
