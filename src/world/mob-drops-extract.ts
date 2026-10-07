/**
 * Developer tool: extracts what every mob drops in one Minecraft version from its server jar's entity loot tables into
 * `src/world/data/mob-drops/<version>.json`, the data `mob-drops.ts` serves (live 2026-10-04: with block loot tables
 * only, `get_items` planned a bed's wool from string and never thought of sheep).
 *
 * Run once per supported version and commit the file: `bun src/world/mob-drops-extract.ts <server.jar> <version>`
 * (the unbundled jar, `versions/<version>/server-<version>.jar`). The runtime never reads a jar.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tableDrops } from "./block-drops-extract.js";
import type { MobDrop } from "./mob-drops.js";
import { readZipEntries } from "./smelting-extract.js";

/** `entities/sheep.json`, and a variant's own table such as `entities/sheep/white.json` (the sheep's wool). */
const ENTITY_TABLES = /^data\/minecraft\/loot_table\/entities\/([^/]+)(?:\/[^/]+)?\.json$/u;

/**
 * Every mob's drops, by entity id, sorted by id: each item once, at its best chance over the mob's tables. Conditions on
 * the killer or the mob itself (killed by a player, on fire, a variant) are not about whether it can drop the item, and
 * are left out.
 */
export function extractMobDrops(jar: Uint8Array): Record<string, MobDrop[]> {
  const entries = readZipEntries(jar);
  const mobs: Record<string, MobDrop[]> = {};
  for (const name of [...entries.keys()].sort()) {
    const mob = ENTITY_TABLES.exec(name)?.[1];
    if (mob === undefined) continue;
    const drops = new Map((mobs[mob] ?? []).map((drop) => [drop.item, drop.chance]));
    for (const drop of tableDrops(entries.get(name)!())) drops.set(drop.item, Math.max(drops.get(drop.item) ?? 0, drop.chance));
    mobs[mob] = [...drops].map(([item, chance]) => ({ item, chance })).sort((a, b) => a.item.localeCompare(b.item));
  }
  return Object.fromEntries(Object.entries(mobs).filter(([, drops]) => drops.length > 0));
}

if (import.meta.main) {
  const [jar, version] = process.argv.slice(2);
  if (jar === undefined || version === undefined) {
    console.log("Usage: bun src/world/mob-drops-extract.ts <server.jar> <version>");
    process.exit(2);
  }
  const mobs = extractMobDrops(new Uint8Array(readFileSync(jar)));
  const file = new URL(`./data/mob-drops/${version}.json`, import.meta.url);
  writeFileSync(file, `${JSON.stringify({ version, mobs })}\n`);
  console.log(`${Object.keys(mobs).length} mob loot tables written to ${file.pathname}`);
}
