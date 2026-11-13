// What a get_items fetch does when a craft would use up a kept item: fetch it first, hold the crafts to it, stop before using it when none can be got.
import { carriedOf } from "./relations/items.ts";
import type { BotRuntime, BotSnapshot, ItemCount } from "./runtime-client.ts";

// Plan 2026-11-12-house-build-fixes Task 4, facts gathering.md "get_items replaces a kept item before a craft uses it".
type Stacks = BotSnapshot["inventory"];

/** The most the `craft_item` step takes in one go (`brain/src/actions.ts`, the step's `count` bound). */
const MAX_CRAFT_STEP = 64;

/** How many of `item` a list of counts names (0 when it does not). */
function countOf(list: readonly ItemCount[], item: string): number {
  return list.find((entry) => entry.item === item)?.count ?? 0;
}

/**
 * A craft that would use kept items up (packed_mud carried for a house, bricks asked for): they are fetched first, and
 * each is raised to `items[i]`; `crafting[i]` is the asked craft that takes `items[i]` (the stop names it).
 */
export interface ReplaceFirst {
  readonly status: "replace_first";
  readonly items: readonly ItemCount[];
  readonly crafting: readonly ItemCount[];
}

/**
 * The kept items a craft that takes `used` from the bag would leave short, each raised to its kept count plus what the
 * craft uses (what has to be carried before it runs). `made`: what the same batch makes (packed_mud crafted beside the
 * bricks that use it replaces it); `inventory`: the bag now.
 */
export function keptInputsUsed(used: readonly ItemCount[], made: readonly ItemCount[], keep: readonly ItemCount[], inventory: Stacks): ItemCount[] {
  const short: ItemCount[] = [];
  for (const { item, count: use } of used) {
    const kept = keep.find((entry) => entry.item === item);
    if (kept === undefined) continue;
    if (carriedOf(inventory, item) - use + countOf(made, item) < kept.count) short.push({ item, count: kept.count + use });
  }
  return short;
}

/** The asked craft that takes `item` from the bag: the only one, else the first whose own plan carries it. */
async function craftUsing(runtime: BotRuntime, crafts: readonly ItemCount[], item: string): Promise<ItemCount> {
  for (const entry of crafts.length === 1 ? [] : crafts) {
    if ((await runtime.craftingNeeds([entry])).carried?.some((used) => used.item === item) === true) return entry;
  }
  return crafts[0]!;
}

/** Whether crafting `crafts` now would use kept items up (the runtime's plan says what it takes from the bag): what to fetch first, or null. */
async function replacementFirst(runtime: BotRuntime, crafts: readonly ItemCount[], keep: readonly ItemCount[], inventory: Stacks): Promise<ReplaceFirst | null> {
  const items = keptInputsUsed((await runtime.craftingNeeds(crafts)).carried ?? [], crafts, keep, inventory);
  if (items.length === 0) return null;
  return { status: "replace_first", items, crafting: await Promise.all(items.map(({ item }) => craftUsing(runtime, crafts, item))) };
}

/**
 * The stop when a kept item a craft would use cannot be got again: it says what the craft would take, why no more could
 * be got (`reason`, the gathering's own words) and the step that crafts from what is carried, the model's choice.
 */
function replacementFailure(craft: ItemCount, kept: string, used: number, reason: string): string {
  // The step's count is the asked output (the craft_item schema's top is 64: a bigger ask is crafted 64 at a time).
  const count = Math.min(craft.count, MAX_CRAFT_STEP);
  const step = JSON.stringify({ skill: "craft_item", item: craft.item, count });
  return `${craft.item} would be crafted from ${used} of the ${kept} you carry, and no more ${kept} could be got (${reason}): get_items keeps what you carried; ${step} crafts ${count < craft.count ? `${count} of it` : "it"} from them`;
}

/**
 * The kept items a craft waits on while they are short: each is raised in the fetch's `wanted` (kept count + what the
 * craft uses), and only the crafts of those items run until they are carried again.
 */
export class ReplacementGuard {
  /** Kept item -> the asked craft that would use it, and how many of the item that craft takes. */
  private readonly waiting = new Map<string, { readonly craft: ItemCount; readonly used: number }>();

  constructor(private readonly bill: readonly ItemCount[], private readonly keep: readonly ItemCount[]) {}

  /** Whether any kept item is short before a craft. */
  get active(): boolean {
    return this.waiting.size > 0;
  }

  /** What to fetch first when crafting `crafts` now would use kept items below their count (see {@link replacementFirst}); null when it would not. */
  replaceFirst(runtime: BotRuntime, crafts: readonly ItemCount[], inventory: Stacks): Promise<ReplaceFirst | null> {
    return replacementFirst(runtime, crafts, this.keep, inventory);
  }

  /**
   * `wanted` with the items of `first` raised (never lowered: a bill may ask for more of the item), and whether any item
   * is new to the guard or was raised (false: the replacement's own craft takes them too, it cannot be got this way).
   */
  raise(wanted: readonly ItemCount[], first: ReplaceFirst): { readonly wanted: ItemCount[]; readonly raised: boolean } {
    const raised = first.items.some((entry) => !this.waiting.has(entry.item) || entry.count > countOf(wanted, entry.item));
    let next = [...wanted];
    first.items.forEach((entry, index) => {
      this.waiting.set(entry.item, { craft: first.crafting[index]!, used: entry.count - countOf(this.keep, entry.item) });
      const asked = Math.max(entry.count, countOf(next, entry.item));
      next = next.some((one) => one.item === entry.item) ? next.map((one) => one.item === entry.item ? { item: entry.item, count: asked } : one) : [...next, { item: entry.item, count: asked }];
    });
    return { wanted: next, raised };
  }

  /** `wanted` with each item now carried again put back to what it was: the raise is spent, a second round must not fetch the stock again. */
  release(wanted: readonly ItemCount[], inventory: Stacks): ItemCount[] {
    let next = [...wanted];
    for (const item of [...this.waiting.keys()]) {
      if (carriedOf(inventory, item) < countOf(next, item)) continue;
      this.waiting.delete(item);
      const was = { item, count: Math.max(countOf(this.bill, item), countOf(this.keep, item)) };
      next = next.map((asked) => asked.item === item ? was : asked);
    }
    return next;
  }

  /** The stop that names the craft waiting on a kept item, `reason` in its parentheses; null when no craft waits. */
  failure(reason: string): string | null {
    const first = [...this.waiting][0];
    if (first === undefined) return null;
    return replacementFailure(first[1].craft, first[0], first[1].used, reason);
  }

  /**
   * The crafts of `ready` that may run now: all when nothing waits; else those of the items waited on (the replacement
   * alone); else the ones that are no waiting asked craft (a furnace the replacement is smelted in), never the asked craft itself.
   */
  allowed(ready: readonly ItemCount[]): readonly ItemCount[] {
    if (this.waiting.size === 0) return ready;
    const replacements = ready.filter((entry) => this.waiting.has(entry.item));
    if (replacements.length > 0) return replacements;
    const asked = new Set([...this.waiting.values()].map(({ craft }) => craft.item));
    return ready.filter((entry) => !asked.has(entry.item));
  }
}
