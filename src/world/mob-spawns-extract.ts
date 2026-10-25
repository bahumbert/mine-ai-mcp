/**
 * Developer tool: extracts which mobs spawn naturally in each biome of one Minecraft version from its server jar's
 * worldgen data (`data/minecraft/worldgen/biome/*.json`, the `spawners` lists) into
 * `src/world/data/mob-spawns/<version>.json`, the data `mob-spawns.ts` serves (live run 15: `porkchop` was hunted from
 * hoglin, a Nether mob, in the overworld, because nothing said where a mob lives).
 *
 * Run once per supported version and commit the file: `bun src/world/mob-spawns-extract.ts <server.jar> <version>`
 * (the unbundled jar, `versions/<version>/server-<version>.jar`). The runtime never reads a jar.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { readZipEntries } from "./smelting-extract.js";

const BIOME_FILES = /^data\/minecraft\/worldgen\/biome\/([^/]+)\.json$/u;

interface BiomeFile {
  readonly spawners?: Readonly<Record<string, readonly { readonly type: string }[]>>;
}

/** The mobs each biome lists in any spawner category (creature, monster, water...), by biome id, mob ids sorted. Biomes spawning nothing are left out. */
export function extractMobSpawns(jar: Uint8Array): Record<string, string[]> {
  const entries = readZipEntries(jar);
  const biomes: Record<string, string[]> = {};
  for (const name of [...entries.keys()].sort()) {
    const biome = BIOME_FILES.exec(name)?.[1];
    if (biome === undefined) continue;
    const file = JSON.parse(entries.get(name)!()) as BiomeFile;
    const mobs = new Set(Object.values(file.spawners ?? {}).flat().map((spawner) => spawner.type.replace(/^minecraft:/u, "")));
    if (mobs.size > 0) biomes[biome] = [...mobs].sort();
  }
  return biomes;
}

if (import.meta.main) {
  const [jar, version] = process.argv.slice(2);
  if (jar === undefined || version === undefined) {
    console.log("Usage: bun src/world/mob-spawns-extract.ts <server.jar> <version>");
    process.exit(2);
  }
  const biomes = extractMobSpawns(new Uint8Array(readFileSync(jar)));
  const file = new URL(`./data/mob-spawns/${version}.json`, import.meta.url);
  writeFileSync(file, `${JSON.stringify({ version, biomes })}\n`);
  console.log(`${Object.keys(biomes).length} biome spawner lists written to ${file.pathname}`);
}
