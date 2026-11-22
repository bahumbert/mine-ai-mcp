/**
 * Reads the damage types of a server jar (`data/minecraft/damage_type/*.json`): each one's `scaling` says how the
 * difficulty changes a hit of that type (`never`, `always`, `when_caused_by_living_non_player`). The combat data file
 * (`combat-data-write.ts`) ships them; the runtime never reads a jar.
 */
import { DAMAGE_TYPE_FILE } from "./jar-layout.js";
import { readZipEntries } from "./smelting-extract.js";

/** Every damage type of the jar by name (`mob_attack`), each with its scaling; sorted by name. A file with no scaling throws naming the type: no default is guessed. */
export function extractDamageTypes(jar: Uint8Array): Record<string, { scaling: string }> {
  const entries = readZipEntries(jar);
  const types: Record<string, { scaling: string }> = {};
  for (const path of [...entries.keys()].sort()) {
    const name = DAMAGE_TYPE_FILE.exec(path)?.[1];
    if (name === undefined) continue;
    const { scaling } = JSON.parse(entries.get(path)!()) as { scaling?: unknown };
    if (typeof scaling !== "string") throw new Error(`damage type ${name}: no scaling in ${path}`);
    types[name] = { scaling };
  }
  return types;
}
