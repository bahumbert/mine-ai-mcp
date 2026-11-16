// What a walk must not spend of what the work at its end needs, and the one rule that gives a walk that kept too much a second
// try (plan 2026-11-14-house-build-fixes-2 Tasks 4 and 6, spec section 4): `navigate`'s `keep_items` (names: never placed) and
// `reserve_items` (counts: placed only while more are carried).
import type { ActOutcome } from "./body.ts";
import type { BotRuntime, ItemCount } from "./runtime-client.ts";

/**
 * What a walk keeps. `items`: kinds never placed (the house's blocks by name, the fetched items). `reserve`: blocks kept by count
 * (the house's bill, so a spare may still bridge). `scaffold`: the counts the cells out of reach need to stand on
 * (`scaffoldReserve`), the part {@link relaxedKeep} drops.
 */
export interface WalkKeep {
  readonly items: readonly string[];
  readonly reserve: readonly ItemCount[];
  readonly scaffold: readonly ItemCount[];
}

/** A walk that keeps nothing. */
export const NO_KEEP: WalkKeep = { items: [], reserve: [], scaffold: [] };

/** `navigate`'s `keep_items` and `reserve_items` for `keep` (none of either when empty). */
export function walkKeepInput(keep: WalkKeep): Record<string, unknown> {
  // One entry per item, the larger count (as the runtime reads a repeat): the input's list is capped.
  const counted = new Map<string, number>();
  for (const { item, count } of [...keep.reserve, ...keep.scaffold]) counted.set(item, Math.max(count, counted.get(item) ?? 0));
  return {
    ...(keep.items.length > 0 && { keep_items: [...new Set(keep.items)] }),
    ...(counted.size > 0 && { reserve_items: [...counted].map(([item, count]) => ({ item, count })) }),
  };
}

/** `a` and `b` side by side: each list joined, names once. */
export function mergedKeep(a: WalkKeep, b: WalkKeep): WalkKeep {
  return { items: [...new Set([...a.items, ...b.items])], reserve: [...a.reserve, ...b.reserve], scaffold: [...a.scaffold, ...b.scaffold] };
}

/**
 * The keep of a walk that found no way: every kept name becomes a count (its count in `countsBefore`: the bill's need for a
 * bill, what was carried before the fetch for a fetched item), the counted reserve stays, the scaffold is dropped. So the asked
 * item's spare and the bill's spare may bridge, and no keep strands the bot.
 */
export function relaxedKeep(keep: WalkKeep, countsBefore: readonly ItemCount[]): WalkKeep {
  const byName = keep.items.flatMap((item) => {
    const count = countsBefore.find((entry) => entry.item === item)?.count ?? 0;
    return count > 0 ? [{ item, count }] : [];
  });
  return { items: [], reserve: [...keep.reserve, ...byName], scaffold: [] };
}

/** How many of `item` a walk with `keep` may place of the `carried` ones. */
function spendable(keep: WalkKeep, item: string, carried: number): number {
  if (keep.items.includes(item)) return 0;
  const kept = Math.max(0, ...[...keep.reserve, ...keep.scaffold].filter((entry) => entry.item === item).map((entry) => entry.count));
  return Math.max(0, carried - kept);
}

/** Whether `relaxed` lets a walk place more of some carried item than `keep` does: when it does not, a second walk would be the same walk. */
function frees(keep: WalkKeep, relaxed: WalkKeep, inventory: readonly { readonly name: string; readonly count: number }[]): boolean {
  return inventory.some((stack) => spendable(relaxed, stack.name, stack.count) > spendable(keep, stack.name, stack.count));
}

/** Whether a walk's result is the pathfinder finding no way, the one failure keeping blocks can cause (deep water, a boat or a dimension change keep their own result). */
export const isNoPath = (outcome: Pick<ActOutcome, "status" | "error">): boolean => outcome.status !== "succeeded" && outcome.error?.startsWith("[NAVIGATION_STOPPED]") === true;

/**
 * Walks with `keep` (`walk` sends the `navigate`); on no path (`stoppedNoPath`), not aborted, and when relaxing the keep would
 * free a carried block ({@link relaxedKeep}), walks once more with the relaxed keep. The first result stands otherwise.
 */
export async function walkRelaxing<T>(context: { readonly runtime: Pick<BotRuntime, "status">; readonly signal: AbortSignal }, keep: WalkKeep, countsBefore: readonly ItemCount[], walk: (keep: WalkKeep) => Promise<T>, stoppedNoPath: (outcome: T) => boolean): Promise<T> {
  const first = await walk(keep);
  if (!stoppedNoPath(first) || context.signal.aborted) return first;
  const relaxed = relaxedKeep(keep, countsBefore);
  if (!frees(keep, relaxed, (await context.runtime.status()).inventory)) return first;
  return walk(relaxed);
}
