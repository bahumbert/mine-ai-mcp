/**
 * Developer tool: extracts every block tag of one Minecraft version from its server jar (`data/minecraft/tags/block/`,
 * `blocks/` before 1.21) into `src/world/data/block-tags/<version>.json`, the data `block-tags.ts` serves.
 * minecraft-data ships no tags; the jar holds them as data (`logs` names every wood's logs and stems, so nothing has to
 * list them by hand). `extractTags` also reads the `item` and `entity_type` tags (`item-tags-extract.ts`,
 * `entity-tags-extract.ts`).
 *
 * Run once per supported version and commit the file: `bun src/world/block-tags-extract.ts <server.jar> <version>`.
 * The runtime never reads a jar.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tagFilePattern, type TagKind } from "./jar-layout.js";
import { readZipEntries } from "./smelting-extract.js";

/** A tag entry: a block id, a `#tag` reference, or either as an optional `{ id, required }`. */
type TagValue = string | { readonly id: string; readonly required?: boolean };

function shortId(id: string): string {
  return id.startsWith("minecraft:") ? id.slice("minecraft:".length) : id;
}

/** Every tag of one kind, by tag name (`logs`, `mineable/axe`), each resolved to its sorted ids; tags sorted by name. */
export function extractTags(jar: Uint8Array, kind: TagKind): Record<string, string[]> {
  const entries = readZipEntries(jar);
  const file = tagFilePattern(kind);
  const raw = new Map<string, readonly TagValue[]>();
  for (const name of entries.keys()) {
    const tag = file.exec(name)?.[1];
    if (tag !== undefined) raw.set(tag, (JSON.parse(entries.get(name)!()) as { values?: readonly TagValue[] }).values ?? []);
  }
  const resolved = new Map<string, ReadonlySet<string>>();
  const resolve = (tag: string, visiting: Set<string>): ReadonlySet<string> => {
    const known = resolved.get(tag);
    if (known !== undefined) return known;
    const blocks = new Set<string>();
    // A tag reached again while it is being resolved adds nothing more (the game rejects such cycles anyway).
    if (visiting.has(tag)) return blocks;
    visiting.add(tag);
    for (const value of raw.get(tag) ?? []) {
      const id = typeof value === "string" ? value : value.id;
      if (id.startsWith("#")) for (const block of resolve(shortId(id.slice(1)), visiting)) blocks.add(block);
      else blocks.add(shortId(id));
    }
    visiting.delete(tag);
    if (visiting.size === 0) resolved.set(tag, blocks);
    return blocks;
  };
  return Object.fromEntries([...raw.keys()].sort().map((tag) => [tag, [...resolve(tag, new Set())].sort()]));
}

/** Every block tag, by tag name, each resolved to its sorted block ids. */
export const extractBlockTags = (jar: Uint8Array): Record<string, string[]> => extractTags(jar, "block");

if (import.meta.main) {
  const [jar, version] = process.argv.slice(2);
  if (jar === undefined || version === undefined) {
    console.log("Usage: bun src/world/block-tags-extract.ts <server.jar> <version>");
    process.exit(2);
  }
  const tags = extractBlockTags(new Uint8Array(readFileSync(jar)));
  const file = new URL(`./data/block-tags/${version}.json`, import.meta.url);
  writeFileSync(file, `${JSON.stringify({ version, tags })}\n`);
  console.log(`${Object.keys(tags).length} block tags written to ${file.pathname}`);
}
