import type { BotSnapshot } from "./runtime-client.ts";

/** The tool classes (and bed, boat) of which the last one carried is never dropped on its own. */
export const KEPT_KINDS = ["pickaxe", "axe", "shovel", "hoe", "sword", "bed", "boat"] as const;
export const kindOf = (item: string): (typeof KEPT_KINDS)[number] | null => KEPT_KINDS.find((kind) => item.split("_").at(-1) === kind) ?? null;

const ARMOUR = ["helmet", "chestplate", "leggings", "boots"];
const STATIONS = ["crafting_table", "furnace"];

/** What the work in hand needs besides what the inventory shows. */
export interface RoomFacts {
  /** The items of the unfinished house's bill of materials. */
  readonly houseBill?: readonly string[];
  /** The items the objective's steps are out to obtain (get_items, hunt, craft_item) and the blocks its collect_block steps mine. */
  readonly wanted?: ReadonlySet<string>;
  /** The objective's text: any carried item it names (an id such as `cobblestone` in "Mine cobblestone") is what it gathers. */
  readonly objective?: string;
}

/**
 * The carried items the work needs: tools, a bed, a boat, armour, a crafting table, a furnace, the foods, the unfinished
 * house's materials and what the objective's steps are out to get (live 2026-10-10/11: the model dropped its house
 * planks and logs to free a slot, and 18 of 238 snowballs at a time).
 */
export function neededItems(snapshot: Pick<BotSnapshot, "inventory" | "foods">, facts: RoomFacts = {}): Set<string> {
  const needed = new Set<string>([...(facts.houseBill ?? []), ...(facts.wanted ?? []), ...snapshot.foods.map((food) => food.name)]);
  const named = new Set(facts.objective?.toLowerCase().match(/[a-z][a-z0-9_]*/gu) ?? []);
  for (const { name } of snapshot.inventory) {
    const last = name.split("_").at(-1)!;
    if (kindOf(name) !== null || ARMOUR.includes(last) || STATIONS.includes(name) || named.has(name)) needed.add(name);
  }
  return needed;
}

const MOST_SHOWN = 6;

/**
 * What to drop from a full inventory: the carried items nothing in the work needs, each with its whole count and the
 * stacks it takes, most stacks first. Null when everything carried is needed.
 */
export function junkHint(snapshot: Pick<BotSnapshot, "inventory">, needed: ReadonlySet<string>): string {
  const junk = new Map<string, { count: number; slots: number }>();
  for (const { name, count } of snapshot.inventory) {
    if (needed.has(name)) continue;
    const entry = junk.get(name) ?? { count: 0, slots: 0 };
    junk.set(name, { count: entry.count + count, slots: entry.slots + 1 });
  }
  if (junk.size === 0) return "everything you carry is needed: give up something you need least, or store it";
  const shown = [...junk].sort((a, b) => b[1].slots - a[1].slots || b[1].count - a[1].count || a[0].localeCompare(b[0])).slice(0, MOST_SHOWN);
  const list = shown.map(([name, { count, slots }]) => `${count} ${name} (${slots} ${slots === 1 ? "slot" : "slots"})`).join(", ");
  const items = JSON.stringify(shown.map(([name]) => ({ item: name })));
  return `your inventory is full: nothing you are doing needs ${list}: drop them all in one drop_item step, without counts ({"skill":"drop_item","items":${items}})`;
}
