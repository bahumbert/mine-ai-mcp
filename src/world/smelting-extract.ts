/**
 * Developer tool: extracts the furnace (`minecraft:smelting`) recipes of one Minecraft version from its server jar
 * into `src/world/data/smelting/<version>.json`, the data `smelting.ts` serves. minecraft-data has no smelting
 * recipes; the jar holds them as data (recipes + item tags), so nothing about them is written by hand.
 *
 * Run once per supported version and commit the file: `bun src/world/smelting-extract.ts <server.jar> <version>`.
 * The runtime never reads a jar.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import type { SmeltingRecipe } from "./smelting.js";

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/** Every file of a zip (a jar) by name, each read and decoded as UTF-8 text only when asked for. */
export function readZipEntries(bytes: Uint8Array): Map<string, () => string> {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = view.length - 22;
  while (end >= 0 && view.readUInt32LE(end) !== END_OF_DIRECTORY) end -= 1;
  if (end < 0) throw new Error("Not a zip file: no end of central directory.");
  const count = view.readUInt16LE(end + 10);
  let at = view.readUInt32LE(end + 16);
  const entries = new Map<string, () => string>();
  for (let index = 0; index < count; index += 1) {
    if (view.readUInt32LE(at) !== DIRECTORY_ENTRY) throw new Error(`Broken zip directory at byte ${at}.`);
    const method = view.readUInt16LE(at + 10);
    const size = view.readUInt32LE(at + 20);
    const nameLength = view.readUInt16LE(at + 28);
    const skip = nameLength + view.readUInt16LE(at + 30) + view.readUInt16LE(at + 32);
    const local = view.readUInt32LE(at + 42);
    const name = view.toString("utf8", at + 46, at + 46 + nameLength);
    entries.set(name, () => {
      if (view.readUInt32LE(local) !== LOCAL_HEADER) throw new Error(`Broken zip entry ${name}.`);
      const start = local + 30 + view.readUInt16LE(local + 26) + view.readUInt16LE(local + 28);
      const data = view.subarray(start, start + size);
      if (method === 0) return data.toString("utf8");
      if (method === 8) return inflateRawSync(data).toString("utf8");
      throw new Error(`Zip entry ${name} uses unsupported compression method ${method}.`);
    });
    at += 46 + skip;
  }
  return entries;
}

const RECIPES = /^data\/minecraft\/recipe\/[^/]+\.json$/u;

/** `minecraft:sand` → `sand`; other namespaces keep theirs. */
function shortId(id: string): string {
  return id.startsWith("minecraft:") ? id.slice("minecraft:".length) : id;
}

/** The furnace recipes of a server jar, tags resolved to item ids in tag order, sorted by output then inputs. */
export function extractSmeltingRecipes(jar: Uint8Array): SmeltingRecipe[] {
  const entries = readZipEntries(jar);
  const json = (name: string): unknown => JSON.parse(entries.get(name)!());
  const tag = (id: string, seen: ReadonlySet<string> = new Set()): string[] => {
    const [namespace, path] = id.includes(":") ? id.split(":", 2) as [string, string] : ["minecraft", id];
    const file = `data/${namespace}/tags/item/${path}.json`;
    if (!entries.has(file)) throw new Error(`Item tag #${namespace}:${path} is not in the jar.`);
    if (seen.has(file)) return [];
    const values = (json(file) as { values: readonly (string | { id: string })[] }).values;
    return values.flatMap((value) => {
      const name = typeof value === "string" ? value : value.id;
      return name.startsWith("#") ? tag(name.slice(1), new Set([...seen, file])) : [shortId(name)];
    });
  };
  const ingredient = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(ingredient);
    if (typeof value === "string") return value.startsWith("#") ? tag(value.slice(1)) : [shortId(value)];
    // Older versions: { item } or { tag }.
    const object = value as { item?: string; tag?: string };
    if (object.tag !== undefined) return tag(object.tag);
    if (object.item !== undefined) return [shortId(object.item)];
    throw new Error(`Unknown ingredient form ${JSON.stringify(value)}.`);
  };
  const recipes: SmeltingRecipe[] = [];
  for (const name of entries.keys()) {
    if (!RECIPES.test(name)) continue;
    const recipe = json(name) as { type: string; cookingtime?: number; ingredient: unknown; result: { id?: string; item?: string; count?: number } | string };
    if (recipe.type !== "minecraft:smelting") continue;
    const result = typeof recipe.result === "string" ? { id: recipe.result } : recipe.result;
    recipes.push({
      output: shortId(result.id ?? result.item ?? ""),
      count: result.count ?? 1,
      inputs: [...new Set(ingredient(recipe.ingredient))],
      cookingTicks: recipe.cookingtime ?? 200,
    });
  }
  return recipes.sort((a, b) => a.output.localeCompare(b.output) || a.inputs.join().localeCompare(b.inputs.join()));
}

if (import.meta.main) {
  const [jar, version] = process.argv.slice(2);
  if (jar === undefined || version === undefined) {
    console.log("Usage: bun src/world/smelting-extract.ts <server.jar> <version>");
    process.exit(2);
  }
  const recipes = extractSmeltingRecipes(new Uint8Array(readFileSync(jar)));
  const file = new URL(`./data/smelting/${version}.json`, import.meta.url);
  writeFileSync(file, `${JSON.stringify({ version, recipes }, null, 1)}\n`);
  console.log(`${recipes.length} smelting recipes written to ${file.pathname}`);
}
