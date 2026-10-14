/**
 * Developer tool: extracts what every block drops in one Minecraft version from its server jar's loot tables into
 * `src/world/data/block-drops/<version>.json`, the data `block-drops.ts` serves. minecraft-data's `blockLoot` for
 * 1.21.4 is the 1.20 file (old names such as `grass`, shears conditions missing), so hand-written lists grew around it
 * (`collection-facts.ts`, the brain's gathering); the jar holds the real tables as data.
 *
 * Run once per supported version and commit the file: `bun src/world/block-drops-extract.ts <server.jar> <version>`.
 * The runtime never reads a jar.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { BlockDrop } from "./block-drops.js";
import { readZipEntries } from "./smelting-extract.js";

const BLOCK_TABLES = /^data\/minecraft\/loot_table\/blocks\/([^/]+)\.json$/u;

interface Condition {
  readonly condition: string;
  readonly chance?: number;
  readonly chances?: readonly number[];
  readonly unenchanted_chance?: number;
  readonly properties?: Readonly<Record<string, string>>;
  readonly predicate?: { readonly items?: string | readonly string[]; readonly predicates?: Readonly<Record<string, unknown>> };
  readonly terms?: readonly Condition[];
}

interface Entry {
  readonly type: string;
  readonly name?: string;
  readonly conditions?: readonly Condition[];
  readonly children?: readonly Entry[];
}

interface Pool {
  readonly conditions?: readonly Condition[];
  readonly entries: readonly Entry[];
}

/** What a set of conditions asks of a break, as far as gathering cares: how likely, which tool, which block state. */
interface Requirement {
  readonly chance: number;
  readonly tool?: string;
  readonly state?: Readonly<Record<string, string>>;
}

function shortId(id: string): string {
  return id.startsWith("minecraft:") ? id.slice("minecraft:".length) : id;
}

/** The tool a `match_tool` asks for: silk touch by enchantment, else the item (or tag) it names. */
function toolOf(condition: Condition): string | null {
  if (condition.condition === "minecraft:match_tool") {
    if (condition.predicate?.predicates?.["minecraft:enchantments"] !== undefined) return "silk_touch";
    const items = condition.predicate?.items;
    if (items === undefined) return null;
    return (typeof items === "string" ? [items] : items).map(shortId).join(" or ");
  }
  if (condition.condition === "minecraft:any_of") {
    const tools = (condition.terms ?? []).map(toolOf);
    return tools.every((tool) => tool !== null) ? tools.join(" or ") : null;
  }
  return null;
}

/**
 * Fold conditions into a requirement. Chances count at no fortune (`table_bonus`'s first level). An inverted tool
 * condition is what an ordinary break already is, so it asks nothing; explosions, locations and entities are not
 * about a break by hand and are left out.
 */
function requirementOf(conditions: readonly Condition[] | undefined, outer: Requirement): Requirement {
  let { chance, tool, state } = outer;
  for (const condition of conditions ?? []) {
    if (condition.condition === "minecraft:random_chance") chance *= condition.chance ?? 1;
    else if (condition.condition === "minecraft:table_bonus") chance *= condition.chances?.[0] ?? 1;
    else if (condition.condition === "minecraft:random_chance_with_enchanted_bonus") chance *= condition.unenchanted_chance ?? 1;
    else if (condition.condition === "minecraft:block_state_property") state = { ...state, ...condition.properties };
    else tool = toolOf(condition) ?? tool;
  }
  return { chance, ...(tool !== undefined && { tool }), ...(state !== undefined && { state }) };
}

/** The item entries of a pool in loot order, nested alternatives and groups flattened under their conditions. */
function itemDrops(entries: readonly Entry[], outer: Requirement): BlockDrop[] {
  return entries.flatMap((entry): BlockDrop[] => {
    const requirement = requirementOf(entry.conditions, outer);
    if (entry.type === "minecraft:item" && entry.name !== undefined) {
      return [{ item: shortId(entry.name), chance: Number(requirement.chance.toFixed(6)), ...(requirement.tool !== undefined && { tool: requirement.tool }), ...(requirement.state !== undefined && { state: requirement.state }) }];
    }
    return itemDrops(entry.children ?? [], requirement);
  });
}

/** The drops of one loot table file (its JSON text), every pool in loot order. */
export function tableDrops(json: string): BlockDrop[] {
  const pools = (JSON.parse(json) as { pools?: readonly Pool[] }).pools ?? [];
  return pools.flatMap((pool) => itemDrops(pool.entries, requirementOf(pool.conditions, { chance: 1 })));
}

/** Every block's drops, by block id, sorted by id. */
export function extractBlockDrops(jar: Uint8Array): Record<string, BlockDrop[]> {
  const entries = readZipEntries(jar);
  const blocks: Record<string, BlockDrop[]> = {};
  for (const name of [...entries.keys()].sort()) {
    const block = BLOCK_TABLES.exec(name)?.[1];
    if (block === undefined) continue;
    blocks[block] = tableDrops(entries.get(name)!());
  }
  return blocks;
}

if (import.meta.main) {
  const [jar, version] = process.argv.slice(2);
  if (jar === undefined || version === undefined) {
    console.log("Usage: bun src/world/block-drops-extract.ts <server.jar> <version>");
    process.exit(2);
  }
  const blocks = extractBlockDrops(new Uint8Array(readFileSync(jar)));
  const file = new URL(`./data/block-drops/${version}.json`, import.meta.url);
  writeFileSync(file, `${JSON.stringify({ version, blocks })}\n`);
  console.log(`${Object.keys(blocks).length} block loot tables written to ${file.pathname}`);
}
