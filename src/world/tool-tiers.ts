import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import { z } from "zod";
import { familyIndexOf, type FamilyIndex, type ItemFamily, type RankedItem } from "./item-families.js";

/** The families the snapshot keeps one best item of (the vocabulary is the family map's keys; `satisfies` checks it). */
const TOOL_FAMILIES = ["pickaxe", "shovel", "axe", "sword", "hoe", "shears", "bow", "shield"] as const satisfies readonly ItemFamily[];
const ARMOUR_FAMILIES = ["helmet", "chestplate", "leggings", "boots"] as const satisfies readonly ItemFamily[];
/** Buckets stay item ids (no family): the empty bucket and the three filled ones the bot uses (B3: a milk bucket is none of them). */
const BUCKET_ITEMS = ["bucket", "water_bucket", "lava_bucket", "powder_snow_bucket"] as const;

export const TOOL_CLASSES = [...TOOL_FAMILIES, ...BUCKET_ITEMS] as const;
export const ARMOUR_CLASSES = ARMOUR_FAMILIES;
export type ToolClass = typeof TOOL_CLASSES[number];
export type ArmourClass = typeof ARMOUR_CLASSES[number];
export type EquipmentClass = ToolClass | ArmourClass;

export interface ToolSnapshotEntry {
  class: EquipmentClass;
  /**
   * The item's place in its family's order (`FamilyIndex.compareRank`) among the registry's items of the family:
   * 1 + the number of members that rank strictly below it, so a better item has a higher number, equal items share
   * one, and 0 means none carried. Items with no family (the buckets) have rank 1 when carried.
   */
  rank: number;
  item: string | null;
  slot: number | null;
  durabilityLeft: number | null;
  maximumDurability: number | null;
}

export interface ToolSnapshot {
  tools: ToolSnapshotEntry[];
  armour: ToolSnapshotEntry[];
}

export const toolSnapshotEntrySchema = z.strictObject({
  class: z.enum([...TOOL_CLASSES, ...ARMOUR_CLASSES]),
  rank: z.number().int().nonnegative(),
  item: z.string().nullable(), slot: z.number().int().nullable(),
  durabilityLeft: z.number().int().nonnegative().nullable(), maximumDurability: z.number().int().positive().nullable(),
});
export const toolSnapshotSchema = z.strictObject({ tools: z.array(toolSnapshotEntrySchema), armour: z.array(toolSnapshotEntrySchema) });
export const toolChangeSchema = z.strictObject({
  class: z.enum([...TOOL_CLASSES, ...ARMOUR_CLASSES]), before: toolSnapshotEntrySchema, now: toolSnapshotEntrySchema,
  reason: z.enum(["broke", "replaced", "durability_used", "durability_restored", "acquired", "lost"]),
});

export interface ToolChange {
  class: EquipmentClass;
  before: ToolSnapshotEntry;
  now: ToolSnapshotEntry;
  reason: "broke" | "replaced" | "durability_used" | "durability_restored" | "acquired" | "lost";
}

const isBucketItem = (name: string): name is typeof BUCKET_ITEMS[number] => (BUCKET_ITEMS as readonly string[]).includes(name);

/** The snapshot class of an item: its bucket id, else the first tool or armour family it belongs to. */
export function equipmentClass(index: FamilyIndex, name: string): EquipmentClass | null {
  if (isBucketItem(name)) return name;
  const families = index.itemFamilies(name);
  return [...TOOL_FAMILIES, ...ARMOUR_FAMILIES].find((family) => families.includes(family)) ?? null;
}

/** The family a class is ranked in; null for a bucket item. */
function rankFamily(kind: EquipmentClass): ItemFamily | null {
  return isBucketItem(kind) ? null : kind;
}

/** The comparable item of a snapshot entry: its name and its own stack's maximum durability. */
export function rankedItem(entry: Pick<ToolSnapshotEntry, "item" | "maximumDurability">): RankedItem {
  return { name: entry.item!, ...(entry.maximumDurability === null ? {} : { maxDurability: entry.maximumDurability }) };
}

const membersByIndex = new WeakMap<FamilyIndex, Map<ItemFamily, readonly string[]>>();

/** The registry's items of a family, read once per index (a tags packet makes a new index). */
function familyMembers(bot: Bot, index: FamilyIndex, family: ItemFamily): readonly string[] {
  const cache = membersByIndex.get(index) ?? new Map<ItemFamily, readonly string[]>();
  membersByIndex.set(index, cache);
  let members = cache.get(family);
  if (members === undefined) {
    members = bot.registry.itemsArray.map((item) => item.name).filter((name) => index.itemFamilies(name).includes(family));
    cache.set(family, members);
  }
  return members;
}

function rankOf(bot: Bot, index: FamilyIndex, kind: EquipmentClass, item: RankedItem): number {
  const family = rankFamily(kind);
  if (family === null) return 1;
  return 1 + familyMembers(bot, index, family).filter((member) => index.compareRank(item, { name: member }, family) < 0).length;
}

/** Durability left and the maximum of a carried item; both null for an item with no durability. */
export function durabilityOf(item: Item): Pick<ToolSnapshotEntry, "durabilityLeft" | "maximumDurability"> {
  const maximum = item.maxDurability;
  const used = item.durabilityUsed;
  return Number.isFinite(maximum) && maximum > 0 && Number.isFinite(used)
    ? { durabilityLeft: Math.max(0, maximum - used), maximumDurability: maximum }
    : { durabilityLeft: null, maximumDurability: null };
}

function empty(kind: EquipmentClass): ToolSnapshotEntry {
  return { class: kind, rank: 0, item: null, slot: null, durabilityLeft: null, maximumDurability: null };
}

type Candidate = Omit<ToolSnapshotEntry, "rank"> & { item: string };

/** Best first: the family's rank order, then the stack with more durability left, then the name (a stable tie). */
function compareCandidates(index: FamilyIndex, kind: EquipmentClass, a: Candidate, b: Candidate): number {
  const family = rankFamily(kind);
  return (family === null ? 0 : index.compareRank(rankedItem(a), rankedItem(b), family)) ||
    (b.durabilityLeft ?? Number.MAX_SAFE_INTEGER) - (a.durabilityLeft ?? Number.MAX_SAFE_INTEGER) ||
    b.item.localeCompare(a.item);
}

/** Current best carried item per class. Worn armour is included because its slots are part of inventory. */
export function snapshotTools(bot: Bot): ToolSnapshot {
  const items = [...(bot.inventory?.items() ?? [])];
  // Mineflayer removes a stack from slots before placing it on the cursor
  // during equip/moveSlotItem. It is still carried throughout that transfer.
  const selected = bot.inventory?.selectedItem;
  if (selected && !items.includes(selected)) items.push(selected);
  for (const slot of [5, 6, 7, 8, 45]) {
    const item = bot.inventory?.slots?.[slot];
    if (item && !items.some((entry) => entry.slot === slot)) items.push(item);
  }
  const index = familyIndexOf(bot);
  const candidates = items.flatMap((item): Candidate[] => {
    const kind = equipmentClass(index, item.name);
    if (!kind) return [];
    return [{ class: kind, item: item.name, slot: Number.isInteger(item.slot) ? item.slot : null, ...durabilityOf(item) }];
  });
  const choose = (kind: EquipmentClass): ToolSnapshotEntry => {
    const best = candidates.filter((entry) => entry.class === kind).sort((a, b) => compareCandidates(index, kind, a, b))[0];
    return best ? { ...best, rank: rankOf(bot, index, kind, rankedItem(best)) } : empty(kind);
  };
  return { tools: TOOL_CLASSES.map(choose), armour: ARMOUR_CLASSES.map(choose) };
}

export function toolChanges(before: ToolSnapshot, now: ToolSnapshot): ToolChange[] {
  const old = new Map([...before.tools, ...before.armour].map((entry) => [entry.class, entry]));
  return [...now.tools, ...now.armour].flatMap((entry): ToolChange[] => {
    const previous = old.get(entry.class) ?? empty(entry.class);
    if (previous.item === entry.item && previous.durabilityLeft === entry.durabilityLeft) return [];
    const reason: ToolChange["reason"] = previous.item === null ? "acquired"
      : entry.item === null ? "lost"
      : previous.item !== entry.item ? "replaced"
      : (entry.durabilityLeft ?? 0) > (previous.durabilityLeft ?? 0) ? "durability_restored" : "durability_used";
    return [{ class: entry.class, before: previous, now: entry, reason }];
  });
}

export function formatToolChange(change: ToolChange): string {
  const label = change.class;
  if (change.reason === "durability_used" || change.reason === "durability_restored") return `${label} durability ${change.before.durabilityLeft} → ${change.now.durabilityLeft}`;
  return `${label}: ${change.before.item ?? "none"} → ${change.now.item ?? "none"}${change.reason === "broke" ? ` (${change.before.item} broke)` : ""}`;
}
