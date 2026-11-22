/**
 * Families of items, blocks and entities (`pickaxe`, `helmet`, `food`, `bed`, `chest`, `arrow_entity`...): the words
 * the code and the model use for "what kind of thing is this". A family is defined by game tags, never by names in code:
 * 1. the family map (`data/item-families.json`) lists the vanilla tags that define each family, per registry;
 * 2. the tags come from the server's `tags` packet (`server-tags.ts`) once it arrived, else from the tags shipped for the
 *    bot's version (`item-tags.ts`, `block-tags.ts`, `entity-tags.ts`);
 * 3. the override files (`data/item-families/*.json`, one per namespace) add the members no tag groups and remove
 *    members a tag brings. The vanilla file is the stopgap for the items vanilla leaves untagged (spec P4-17 section 3).
 * Rank, cooked form and the food list come from the bot's registry and the shipped smelting recipes.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Bot } from "mineflayer";
import { z } from "zod";
import familyMap from "./data/item-families.json" with { type: "json" };
import vanillaOverride from "./data/item-families/minecraft.json" with { type: "json" };
import { tagsOf as blockTagsOf } from "./block-tags.js";
import { entityTagsOf } from "./entity-tags.js";
import { itemTagsOf, shippedItemTagsVersion } from "./item-tags.js";
import { serverTagsOf, type TagRegistry } from "./server-tags.js";
import { smeltingData } from "./smelting.js";

/** The family vocabulary is the data file's keys; no list of names in code. */
export type ItemFamily = keyof typeof familyMap.item;
export type BlockFamily = keyof typeof familyMap.block;
export type EntityFamily = keyof typeof familyMap.entity_type;
export const ITEM_FAMILIES = Object.keys(familyMap.item) as readonly ItemFamily[];

export interface FamilySource {
  readonly source: "server" | "shipped" | "none";
  /** The server's version for `server`; the shipped file's version for `shipped`. */
  readonly version: string;
  /** The namespaces of the override files in use. */
  readonly overrides: readonly string[];
}

export interface FamilyIndex {
  itemFamilies(item: string): readonly ItemFamily[];
  blockFamilies(block: string): readonly BlockFamily[];
  entityFamilies(entity: string): readonly EntityFamily[];
  /**
   * Compares two items of one family: harvest capability (count of `bot.registry.blocks[*].harvestTools` listing the
   * item), then maximum durability, then mining speed (`materials["mineable/<family>"]`); negative when `a` is better,
   * 0 on a tie. An item with none of these ranks last.
   */
  compareRank(a: RankedItem, b: RankedItem, family: ItemFamily): number;
  /** Harvest capability alone (the block count above), for tool loss. */
  harvestCapability(item: string): number;
  /** The cooked form of a raw food, or null. */
  cookedForm(item: string): string | null;
  source(): FamilySource;
}

export interface RankedItem {
  readonly name: string;
  /** A stack's own maximum; the registry's when absent. */
  readonly maxDurability?: number;
}

/** One override file: members added to and removed from families, per namespace. */
export interface FamilyOverride {
  readonly namespace: string;
  readonly families: Readonly<Record<string, readonly string[]>>;
  readonly exclude: Readonly<Record<string, readonly string[]>>;
  /** Kept for the later modded ticket (durability, food values...); nothing reads it now. */
  readonly data: Readonly<Record<string, unknown>>;
}

const FAMILY_TAGS: Readonly<Record<TagRegistry, Readonly<Record<string, readonly string[]>>>> = {
  item: familyMap.item, block: familyMap.block, entity_type: familyMap.entity_type,
};
const REGISTRY_OF_FAMILY: ReadonlyMap<string, TagRegistry> = new Map(
  (Object.keys(FAMILY_TAGS) as TagRegistry[]).flatMap((registry) => Object.keys(FAMILY_TAGS[registry]).map((family) => [family, registry] as const)),
);
/** The one family the registry (not a tag) defines: every item with food values. */
const FOOD_FAMILY: ItemFamily = "food";

const OVERRIDE_DIR = fileURLToPath(new URL("./data/item-families/", import.meta.url));
const idList = z.record(z.string(), z.array(z.string()));
/** Strict: a misspelt key (`excludes`) fails and is logged by file instead of loading with the wrong content. */
const overrideFileSchema = z.strictObject({
  namespace: z.string().min(1),
  families: idList,
  exclude: idList.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  /** A reason per family, for the person reading the file. */
  why: z.record(z.string(), z.string()).optional(),
});

// --- override loading -----------------------------------------------------------------------------------------------

/** The families of `table` the data file defines; each other one is logged by file and dropped. */
function knownFamilies(table: Readonly<Record<string, readonly string[]>>, file: string): Record<string, readonly string[]> {
  const kept: Record<string, readonly string[]> = {};
  for (const [family, ids] of Object.entries(table)) {
    if (REGISTRY_OF_FAMILY.has(family)) kept[family] = ids;
    else console.error(`[item-families] override ${file}: unknown family "${family}" ignored (the family map defines: ${[...REGISTRY_OF_FAMILY.keys()].join(", ")}). Rename it in the file, or add the family to data/item-families.json, and restart the host.`);
  }
  return kept;
}

/** One override file's content (`read` gives the parsed JSON); a file that cannot be read or does not fit the format is logged by name and skipped. */
function parseOverride(file: string, read: () => unknown): FamilyOverride | null {
  try {
    const parsed = overrideFileSchema.parse(read());
    return { namespace: parsed.namespace, families: knownFamilies(parsed.families, file), exclude: knownFamilies(parsed.exclude ?? {}, file), data: parsed.data ?? {} };
  } catch (error) {
    console.error(`[item-families] override ${file} ignored, the other files still load: ${error instanceof Error ? error.message : String(error)}. Fix the file (JSON of the format in spec P4-17 section 3) and restart the host.`);
    return null;
  }
}

/** Every `*.json` of `dir` as an override, by file name. A missing folder holds no extra override (the vanilla one is compiled in). */
export function loadFamilyOverrides(dir: string = OVERRIDE_DIR): FamilyOverride[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
  return files.flatMap((file) => parseOverride(file, () => JSON.parse(readFileSync(join(dir, file), "utf8"))) ?? []);
}

let processOverrides: FamilyOverride[] | null = null;
/**
 * The vanilla override (imported, so a bundled app has it: `import.meta.url` of a bundled module is its entry's, facts
 * `packaging.md` "The built app") plus every other file of the folder (a later per-mod file), read once per process.
 */
function defaultOverrides(): readonly FamilyOverride[] {
  if (processOverrides === null) {
    const vanilla = parseOverride("minecraft.json", () => vanillaOverride);
    const others = loadFamilyOverrides().filter((file) => file.namespace !== vanilla?.namespace);
    processOverrides = vanilla === null ? others : [vanilla, ...others];
  }
  return processOverrides;
}

// --- membership -----------------------------------------------------------------------------------------------------

type Names = Map<string, Set<string>>;

/** family -> names, over every override file, for one of `files`' tables. */
function namesByFamily(overrides: readonly FamilyOverride[], table: "families" | "exclude"): Names {
  const byFamily: Names = new Map();
  for (const file of overrides) {
    for (const [family, names] of Object.entries(file[table])) {
      const set = byFamily.get(family) ?? new Set<string>();
      for (const name of names) set.add(name);
      byFamily.set(family, set);
    }
  }
  return byFamily;
}

/**
 * The tags of `name` in `registry`: the server's when its packet arrived, else the shipped ones of the bot's version.
 * The choice is per registry list the packet carried: a packet without a registry leaves that registry untagged (a
 * vanilla server sends all three).
 */
function tagsFromServerOrShipped(bot: Bot, registry: TagRegistry): (name: string) => readonly string[] {
  const server = serverTagsOf(bot);
  if (server !== null) return (name) => server.tagsOf(registry, name);
  const shipped = { item: itemTagsOf, block: blockTagsOf, entity_type: entityTagsOf }[registry];
  return (name) => shipped(name, bot.version);
}

/** Resolves families of one registry: tags, then additions, food (items), then exclusions; memoised per name. */
function familyResolver(bot: Bot, registry: TagRegistry, additions: Names, exclusions: Names): (name: string) => readonly string[] {
  const tagsOf = tagsFromServerOrShipped(bot, registry);
  const families = Object.entries(FAMILY_TAGS[registry]);
  const known = new Map<string, readonly string[]>();
  return (name) => {
    const cached = known.get(name);
    if (cached !== undefined) return cached;
    const tags = tagsOf(name);
    const found = new Set(families.filter(([, familyTags]) => familyTags.some((tag) => tags.includes(tag))).map(([family]) => family));
    for (const [family] of families) if (additions.get(family)?.has(name)) found.add(family);
    if (registry === "item" && Object.hasOwn(bot.registry.foodsByName, name)) found.add(FOOD_FAMILY);
    for (const [family] of families) if (exclusions.get(family)?.has(name)) found.delete(family);
    const sorted = [...found].sort();
    known.set(name, sorted);
    return sorted;
  };
}

// --- rank and cooked form -------------------------------------------------------------------------------------------

/** Blocks each item can harvest, counted once per index over `bot.registry.blocks[*].harvestTools`. */
function harvestCounts(bot: Bot): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const block of bot.registry.blocksArray) {
    for (const id of Object.keys(block.harvestTools ?? {})) counts.set(Number(id), (counts.get(Number(id)) ?? 0) + 1);
  }
  return counts;
}

/** Mining speed of an item for a family's blocks (`materials["mineable/<family>"]`), 0 when the registry has none. */
function miningSpeed(bot: Bot, itemId: number | undefined, family: string): number {
  if (itemId === undefined) return 0;
  const materials = bot.registry.materials as Record<string, Record<number, number> | undefined>;
  return materials[`mineable/${family}`]?.[itemId] ?? 0;
}

/** The smelting output of a raw food when that output is a food with more points; null otherwise. */
function cookedFormOf(bot: Bot, item: string): string | null {
  if (!Object.hasOwn(bot.registry.foodsByName, item)) return null;
  const raw = bot.registry.foodsByName[item]!;
  let best: { name: string; points: number } | null = null;
  for (const recipe of smeltingData(bot.version)?.recipes ?? []) {
    if (!recipe.inputs.includes(item)) continue;
    const points = bot.registry.foodsByName[recipe.output]?.foodPoints;
    if (points !== undefined && points > raw.foodPoints && points > (best?.points ?? -1)) best = { name: recipe.output, points };
  }
  return best?.name ?? null;
}

function familySource(bot: Bot, overrides: readonly FamilyOverride[]): FamilySource {
  const names = overrides.map((file) => file.namespace);
  if (serverTagsOf(bot) !== null) return { source: "server", version: bot.version, overrides: names };
  const shipped = shippedItemTagsVersion(bot.version);
  return shipped === null ? { source: "none", version: bot.version, overrides: names } : { source: "shipped", version: shipped, overrides: names };
}

/** An index over `overrides`; `familyIndexOf` is the cached one with the process' override files. */
export function createFamilyIndex(bot: Bot, overrides: readonly FamilyOverride[]): FamilyIndex {
  const additions = namesByFamily(overrides, "families");
  const exclusions = namesByFamily(overrides, "exclude");
  const resolvers = Object.fromEntries(
    (Object.keys(FAMILY_TAGS) as TagRegistry[]).map((registry) => [registry, familyResolver(bot, registry, additions, exclusions)]),
  ) as Record<TagRegistry, (name: string) => readonly string[]>;
  const source = familySource(bot, overrides);
  let harvest: ReadonlyMap<number, number> | null = null;
  const harvestCapability = (item: string): number => {
    const id = bot.registry.itemsByName[item]?.id;
    harvest ??= harvestCounts(bot);
    return id === undefined ? 0 : (harvest.get(id) ?? 0);
  };
  const durabilityOf = (item: RankedItem): number => item.maxDurability ?? bot.registry.itemsByName[item.name]?.maxDurability ?? 0;
  const cooked = new Map<string, string | null>();
  return {
    itemFamilies: (item) => resolvers.item(item) as readonly ItemFamily[],
    blockFamilies: (block) => resolvers.block(block) as readonly BlockFamily[],
    entityFamilies: (entity) => resolvers.entity_type(entity) as readonly EntityFamily[],
    harvestCapability,
    compareRank: (a, b, family) =>
      harvestCapability(b.name) - harvestCapability(a.name) ||
      durabilityOf(b) - durabilityOf(a) ||
      miningSpeed(bot, bot.registry.itemsByName[b.name]?.id, family) - miningSpeed(bot, bot.registry.itemsByName[a.name]?.id, family),
    cookedForm: (item) => {
      if (!cooked.has(item)) cooked.set(item, cookedFormOf(bot, item));
      return cooked.get(item) ?? null;
    },
    source: () => source,
  };
}

interface CachedIndex { readonly revision: number; readonly index: FamilyIndex }
const cache = new WeakMap<Bot, CachedIndex>();

/** The bot's family index, rebuilt when its server tags changed (a `tags` packet bumps the revision). */
export function familyIndexOf(bot: Bot): FamilyIndex {
  const revision = serverTagsOf(bot)?.revision ?? 0;
  const cached = cache.get(bot);
  if (cached?.revision === revision) return cached.index;
  const index = createFamilyIndex(bot, defaultOverrides());
  cache.set(bot, { revision, index });
  return index;
}

export function hasItemFamily(bot: Bot, item: string, family: ItemFamily): boolean {
  return familyIndexOf(bot).itemFamilies(item).includes(family);
}

const itemMembersByIndex = new WeakMap<FamilyIndex, Map<ItemFamily, readonly string[]>>();
const blockMembersByIndex = new WeakMap<FamilyIndex, Map<BlockFamily, readonly string[]>>();

/** Registry-ordered item members, cached until the family index changes. */
export function familyMembers(bot: Bot, family: ItemFamily): readonly string[] {
  const index = familyIndexOf(bot);
  const cache = itemMembersByIndex.get(index) ?? new Map<ItemFamily, readonly string[]>();
  itemMembersByIndex.set(index, cache);
  if (!cache.has(family)) cache.set(family, bot.registry.itemsArray.filter((item) => index.itemFamilies(item.name).includes(family)).map((item) => item.name));
  return cache.get(family)!;
}

/** Registry-ordered block members, cached until the family index changes. */
export function blockFamilyMembers(bot: Bot, family: BlockFamily): readonly string[] {
  const index = familyIndexOf(bot);
  const cache = blockMembersByIndex.get(index) ?? new Map<BlockFamily, readonly string[]>();
  blockMembersByIndex.set(index, cache);
  if (!cache.has(family)) cache.set(family, bot.registry.blocksArray.filter((block) => index.blockFamilies(block.name).includes(family)).map((block) => block.name));
  return cache.get(family)!;
}

/** The unique sign block dropped as this item with the requested attachment state. */
export function signBlockFor(bot: Bot, item: string, attach: "ground" | "wall"): string | null {
  const id = bot.registry.itemsByName[item]?.id;
  if (id === undefined) return null;
  const matches = blockFamilyMembers(bot, "sign").filter((name) => {
    const block = bot.registry.blocksByName[name]!;
    const rotation = block.states?.some((state) => state.name === "rotation") ?? false;
    const facing = block.states?.find((state) => state.name === "facing");
    return block.drops.includes(id) && (attach === "ground" ? rotation : !rotation && ["north", "south", "east", "west"].every((value) => facing?.values?.includes(value)));
  });
  return matches.length === 1 ? matches[0]! : null;
}
