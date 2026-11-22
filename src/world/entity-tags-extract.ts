/**
 * Developer tool: extracts every entity tag of one Minecraft version from its server jar
 * (`data/minecraft/tags/entity_type/`, `entity_types/` before 1.21) into `src/world/data/entity-tags/<version>.json`,
 * the data `entity-tags.ts` serves (`arrows`, `undead`, `skeletons`...). Same format and resolution as the block tags.
 *
 * Run once per supported version and commit the file: `bun src/world/entity-tags-extract.ts <server.jar> <version>`.
 * The runtime never reads a jar.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { extractTags } from "./block-tags-extract.js";

if (import.meta.main) {
  const [jar, version] = process.argv.slice(2);
  if (jar === undefined || version === undefined) {
    console.log("Usage: bun src/world/entity-tags-extract.ts <server.jar> <version>");
    process.exit(2);
  }
  const tags = extractTags(new Uint8Array(readFileSync(jar)), "entity_type");
  const file = new URL(`./data/entity-tags/${version}.json`, import.meta.url);
  writeFileSync(file, `${JSON.stringify({ version, tags })}\n`);
  console.log(`${Object.keys(tags).length} entity tags written to ${file.pathname}`);
}
