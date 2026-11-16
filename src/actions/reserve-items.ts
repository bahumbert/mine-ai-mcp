/** The `reserve_items` input of `navigate` and `build_structure`: scaffold items a route may place only above a count. */
import { z } from "zod";

/** The most item ids one request may ask to keep off its scaffold, by name (`keep_items`) or by count (`reserve_items`). */
export const MAX_KEEP_ITEMS = 64;
/** The longest item id a `keep_items` or `reserve_items` entry may be. */
export const MAX_ITEM_ID_LENGTH = 64;
/** The largest count a reserve may name: a full inventory of one stackable block (36 stacks of 64). */
const MAX_RESERVE_COUNT = 2304;

export const itemIdSchema = z.string().regex(/^[a-z0-9_]+$/).max(MAX_ITEM_ID_LENGTH);

export const RESERVE_ITEMS_DESCRIPTION =
  "Scaffold items the route may place only while it carries more than count of them (blocks kept for later work, by count); the fallback scaffold honours it too. An item named in keep_items is never placed, whatever its count here.";

export const reserveItemsInputSchema = z
  .array(z.strictObject({ item: itemIdSchema, count: z.number().int().min(1).max(MAX_RESERVE_COUNT) }))
  .max(MAX_KEEP_ITEMS)
  .default([])
  .describe(RESERVE_ITEMS_DESCRIPTION);

/** The counts of a request's `reserve_items` by item, the larger count when an item repeats. */
export function reserveCountsOf(entries: readonly { readonly item: string; readonly count: number }[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const { item, count } of entries) counts.set(item, Math.max(count, counts.get(item) ?? 0));
  return counts;
}
