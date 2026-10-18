import type { BotRuntime, BotSnapshot } from "./runtime-client.ts";

/** The tool classes (and bed, boat) of which the last one carried is never dropped on its own. */
export const KEPT_KINDS = ["pickaxe", "axe", "shovel", "hoe", "sword", "bed", "boat"] as const;
export const kindOf = (item: string): (typeof KEPT_KINDS)[number] | null => KEPT_KINDS.find((kind) => item.split("_").at(-1) === kind) ?? null;

const TIERS = ["netherite", "diamond", "iron", "golden", "stone", "wooden"];
/** 0 for the best tier of a tool, up; an item with no tier ranks last. */
export const tierRank = (item: string): number => { const rank = TIERS.indexOf(item.split("_")[0]!); return rank < 0 ? TIERS.length : rank; };

/** The failures of a full inventory: a workstation or a craft without room, a pickup or a collect with no free slot. */
export const FULL_INVENTORY = /WORKSTATION_NO_ROOM|INVENTORY_FULL|no free inventory slot|needs inventory room/u;

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
  // One tool of each class (and one bed, one boat) is needed: the best tier carried; the others are spare (run 15 N5).
  const best = new Map<string, string>();
  for (const { name } of snapshot.inventory) {
    const kind = kindOf(name);
    const current = kind === null ? undefined : best.get(kind);
    if (kind !== null && (current === undefined || tierRank(name) < tierRank(current))) best.set(kind, name);
  }
  for (const name of best.values()) needed.add(name);
  for (const { name } of snapshot.inventory) {
    const last = name.split("_").at(-1)!;
    if (ARMOUR.includes(last) || STATIONS.includes(name) || named.has(name)) needed.add(name);
  }
  return needed;
}

const MOST_SHOWN = 6;

/** A carried kind nothing in the work needs: its whole count, the stacks it takes and the count of each, in inventory order. */
export interface JunkStack {
  readonly name: string;
  readonly count: number;
  readonly slots: number;
  readonly stacks: readonly number[];
}

/**
 * The carried kinds not in `needed`, most stacks first, then the biggest count, then by name. The stacks of a needed tool
 * (bed, boat) beyond the first are junk too: one is kept, the copies can go.
 */
export function junkStacks(snapshot: Pick<BotSnapshot, "inventory">, needed: ReadonlySet<string>): JunkStack[] {
  const junk = new Map<string, number[]>();
  const keptOne = new Set<string>();
  for (const { name, count } of snapshot.inventory) {
    const copy = needed.has(name) && kindOf(name) !== null && keptOne.has(name);
    if (needed.has(name) && kindOf(name) !== null) keptOne.add(name);
    if (!needed.has(name) || copy) junk.set(name, [...(junk.get(name) ?? []), count]);
  }
  return [...junk]
    .map(([name, stacks]) => ({ name, count: stacks.reduce((sum, count) => sum + count, 0), slots: stacks.length, stacks }))
    .sort((a, b) => b.slots - a.slots || b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * What to drop from a full inventory: the carried items nothing in the work needs, each with its whole count and the
 * stacks it takes, most stacks first. Null when everything carried is needed.
 */
export function junkHint(snapshot: Pick<BotSnapshot, "inventory">, needed: ReadonlySet<string>): string {
  const junk = junkStacks(snapshot, needed);
  if (junk.length === 0) return "everything you carry is needed: give up something you need least, or store it";
  const shown = junk.slice(0, MOST_SHOWN);
  const list = shown.map(({ name, count, slots }) => `${count} ${name} (${slots} ${slots === 1 ? "slot" : "slots"})`).join(", ");
  const items = JSON.stringify(shown.map(({ name }) => ({ item: name })));
  return `your inventory is full: nothing you are doing needs ${list}: drop them all in one drop_item step, without counts ({"skill":"drop_item","items":${items}})`;
}

/**
 * The items an action consumes, which making room for it must never drop: a craft's whole recipe tree (the runtime's
 * plan), a smelt's input and fuel.
 */
export async function consumedBy(runtime: Pick<BotRuntime, "craftingNeeds">, tool: string, input: Readonly<Record<string, unknown>>): Promise<Set<string>> {
  if (tool === "smelt_item") return new Set([input.item_name, input.fuel_item_name].filter((name): name is string => typeof name === "string"));
  if (tool !== "craft_item" || !Array.isArray(input.items)) return new Set();
  const items = (input.items as { item_name?: unknown; count?: unknown }[]).map((entry) => ({ item: String(entry.item_name), count: Number(entry.count ?? 1) }));
  return new Set((await runtime.craftingNeeds(items)).inputs ?? []);
}
