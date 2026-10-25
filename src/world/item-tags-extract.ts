/**
 * Developer tool: extracts every item tag of one Minecraft version from its server jar (`data/minecraft/tags/item/`)
 * into `src/world/data/item-tags/<version>.json`, the data `item-tags.ts` serves (the tags that name the fuels:
 * `logs_that_burn`, `planks`, `wooden_slabs`, `non_flammable_wood`). Same format and resolution as the block tags.
 *
 * Run once per supported version and commit the file: `bun src/world/item-tags-extract.ts <server.jar> <version>`.
 * The runtime never reads a jar.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { extractTags } from "./block-tags-extract.js";

if (import.meta.main) {
  const [jar, version] = process.argv.slice(2);
  if (jar === undefined || version === undefined) {
    console.log("Usage: bun src/world/item-tags-extract.ts <server.jar> <version>");
    process.exit(2);
  }
  const tags = extractTags(new Uint8Array(readFileSync(jar)), "item");
  const file = new URL(`./data/item-tags/${version}.json`, import.meta.url);
  writeFileSync(file, `${JSON.stringify({ version, tags })}\n`);
  console.log(`${Object.keys(tags).length} item tags written to ${file.pathname}`);
}
