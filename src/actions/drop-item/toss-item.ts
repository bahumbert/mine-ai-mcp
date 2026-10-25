// Tossing one requested item stack by stack, and confirming from the inventory what the server really took.
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import { carriedCount, settleInventoryCount } from "../../world/inventory-count.js";
import { durabilityOf } from "../../world/tool-tiers.js";
import type { ActionContext } from "../action.js";
import { dropItemOutcomes, type DroppedItem } from "./contract.js";

/**
 * The stacks of an item to toss, the most worn first (a tool with a durability maximum): a drop of one of two pickaxes
 * gives up the worn one and keeps the best (review 2026-10-19 #5). Items without a durability keep inventory order, so a
 * count equal to the first stack frees that slot.
 */
function stacksOf(bot: Bot, itemName: string): Item[] {
  const left = (item: Item) => durabilityOf(item).durabilityLeft ?? Number.POSITIVE_INFINITY;
  return bot.inventory.items().filter((item) => item.name === itemName).sort((a, b) => left(a) - left(b));
}

/** One requested item's count across attempts: carried when the request began, and tossed since. */
export interface ItemToss {
  readonly baseline: number;
  tossed: number;
  /** Blocks of this item the burial keeps carried to plug the hole: not part of what the request tosses. */
  keptForPlug: number;
  /** Tosses that resolved but were not yet seen leaving the inventory: how many, and the count carried before the first. */
  pending: { readonly before: number; readonly count: number } | null;
}

/** Toss `remaining` of one item stack by stack, adding each toss to the item's record the moment it resolves. */
async function tossStacks(
  bot: Bot,
  itemName: string,
  remaining: number,
  carriedBefore: number,
  toss: ItemToss,
  context: ActionContext,
): Promise<void> {
  for (const stack of stacksOf(bot, itemName)) {
    if (remaining <= 0) break;
    context.signal?.throwIfAborted();
    const taking = Math.min(remaining, stack.count);
    if (remaining >= stack.count) await bot.tossStack(stack);
    else await bot.toss(stack.type, null, remaining);
    toss.tossed += taking;
    toss.pending = { before: toss.pending?.before ?? carriedBefore, count: (toss.pending?.count ?? 0) + taking };
    remaining -= taking;
  }
}

/**
 * Toss what is left of one requested item, then confirm the inventory actually lost it.
 *
 * `bot.toss` throws for a count larger than one stack, so a partial count is
 * spread over the stacks that hold it and whole stacks go through `tossStack`.
 * Every toss is added to the item's record the moment it resolves, so an attempt a reflex cut short leaves the next
 * one the exact count still owed: never more than asked, never more than carried.
 */
export async function tossItem(
  bot: Bot,
  itemName: string,
  requested: number | null,
  context: ActionContext,
  settleMs: number,
  toss: ItemToss,
): Promise<DroppedItem> {
  // A toss a reflex cut off before its confirmation is confirmed now, from the inventory as it stands.
  if (toss.pending) await confirmPendingTosses(bot, itemName, toss, context, settleMs);
  const carriedNow = carriedCount(bot, itemName);
  if (toss.baseline === 0 || (carriedNow === 0 && toss.tossed === 0)) {
    return {
      item: itemName,
      requested,
      carriedBefore: toss.baseline,
      carriedAfter: 0,
      dropped: 0,
      error: dropItemOutcomes.notCarried(itemName),
    };
  }

  // A count above what was carried drops all of it: that is done, not a toss the server swallowed (live 2026-10-09).
  const wanted = Math.min(requested ?? toss.baseline, toss.baseline) - toss.keptForPlug;
  const tossedBefore = toss.tossed;
  try {
    await tossStacks(bot, itemName, Math.min(wanted - toss.tossed, carriedNow), carriedNow, toss, context);
  } catch (cause) {
    context.signal?.throwIfAborted();
    return {
      item: itemName,
      requested,
      carriedBefore: toss.baseline,
      carriedAfter: carriedCount(bot, itemName),
      dropped: toss.tossed,
      error: dropItemOutcomes.rejected(itemName, cause),
    };
  }

  if (toss.tossed === tossedBefore) return droppedEntry(itemName, requested, toss, wanted, carriedNow);
  return droppedEntry(itemName, requested, toss, wanted, await confirmPendingTosses(bot, itemName, toss, context, settleMs));
}

/**
 * Wait for the inventory to show the pending tosses leaving it, and credit only the ones it showed: a toss the server
 * did not show is not counted as done. A reflex that cuts this wait off leaves the tosses pending, so the next attempt
 * confirms them instead of crediting a swallowed toss (review 2026-10-19). Returns the count carried once settled.
 */
async function confirmPendingTosses(
  bot: Bot,
  itemName: string,
  toss: ItemToss,
  context: ActionContext,
  settleMs: number,
): Promise<number> {
  const pending = toss.pending;
  if (!pending) return carriedCount(bot, itemName);
  const settled = await settleInventoryCount(bot, itemName, Math.max(0, pending.before - pending.count), {
    timeoutMs: settleMs,
    signal: context.signal,
  });
  context.signal?.throwIfAborted();
  toss.tossed -= pending.count - Math.min(pending.count, Math.max(0, pending.before - settled.count));
  toss.pending = null;
  return settled.count;
}

function droppedEntry(
  itemName: string,
  requested: number | null,
  toss: ItemToss,
  wanted: number,
  carriedAfter: number,
): DroppedItem {
  const entry = {
    item: itemName,
    requested,
    carriedBefore: toss.baseline,
    carriedAfter,
    dropped: toss.tossed,
    ...(toss.keptForPlug > 0 && { keptForPlug: toss.keptForPlug }),
  };
  // Nothing left to toss is done too: a reflex that ate part of the stack between attempts leaves fewer to drop.
  const finished = toss.tossed >= wanted || (toss.tossed > 0 && carriedAfter === 0);
  return finished ? entry : { ...entry, error: dropItemOutcomes.notObserved(itemName, carriedAfter) };
}
