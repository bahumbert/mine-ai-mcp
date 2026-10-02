import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { extractSmeltingRecipes, readZipEntries } from "./smelting-extract.js";

/** A zip holding `files` (`deflated` names are compressed, the others stored), like a server jar. */
function zip(files: Readonly<Record<string, string>>, deflated: readonly string[] = []): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const method = deflated.includes(name) ? 8 : 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

test("zip entries are read whether stored or deflated", () => {
  const entries = readZipEntries(zip({ "a.json": "{\"a\":1}", "dir/b.json": "{\"b\":2}" }, ["dir/b.json"]));
  assert.deepEqual([...entries.keys()], ["a.json", "dir/b.json"]);
  assert.equal(entries.get("dir/b.json")!(), "{\"b\":2}");
});

test("smelting recipes resolve ids, tags, nested tags and lists, and skip other recipe types", () => {
  const jar = zip({
    "data/minecraft/recipe/glass.json": JSON.stringify({ type: "minecraft:smelting", cookingtime: 200, ingredient: "#minecraft:smelts_to_glass", result: { id: "minecraft:glass" } }),
    "data/minecraft/recipe/iron_ingot_from_smelting_raw_iron.json": JSON.stringify({ type: "minecraft:smelting", cookingtime: 200, ingredient: "minecraft:raw_iron", result: { id: "minecraft:iron_ingot" } }),
    "data/minecraft/recipe/charcoal.json": JSON.stringify({ type: "minecraft:smelting", cookingtime: 200, ingredient: "#minecraft:logs_that_burn", result: { id: "minecraft:charcoal" } }),
    "data/minecraft/recipe/dried_kelp.json": JSON.stringify({ type: "minecraft:smelting", cookingtime: 200, ingredient: ["minecraft:kelp"], result: { count: 1, id: "minecraft:dried_kelp" } }),
    "data/minecraft/recipe/iron_ingot_from_blasting_raw_iron.json": JSON.stringify({ type: "minecraft:blasting", cookingtime: 100, ingredient: "minecraft:raw_iron", result: { id: "minecraft:iron_ingot" } }),
    "data/minecraft/recipe/oak_planks.json": JSON.stringify({ type: "minecraft:crafting_shapeless", ingredients: ["#minecraft:oak_logs"], result: { count: 4, id: "minecraft:oak_planks" } }),
    "data/minecraft/tags/item/smelts_to_glass.json": JSON.stringify({ values: ["minecraft:sand", "minecraft:red_sand"] }),
    "data/minecraft/tags/item/logs_that_burn.json": JSON.stringify({ values: ["#minecraft:oak_logs", { id: "minecraft:birch_log", required: false }] }),
    "data/minecraft/tags/item/oak_logs.json": JSON.stringify({ values: ["minecraft:oak_log", "minecraft:oak_wood"] }),
  }, ["data/minecraft/recipe/glass.json", "data/minecraft/tags/item/logs_that_burn.json"]);
  assert.deepEqual(extractSmeltingRecipes(jar), [
    { output: "charcoal", count: 1, inputs: ["oak_log", "oak_wood", "birch_log"], cookingTicks: 200 },
    { output: "dried_kelp", count: 1, inputs: ["kelp"], cookingTicks: 200 },
    { output: "glass", count: 1, inputs: ["sand", "red_sand"], cookingTicks: 200 },
    { output: "iron_ingot", count: 1, inputs: ["raw_iron"], cookingTicks: 200 },
  ]);
});

test("a recipe naming a tag the jar lacks is reported, not silently emptied", () => {
  const jar = zip({
    "data/minecraft/recipe/glass.json": JSON.stringify({ type: "minecraft:smelting", cookingtime: 200, ingredient: "#minecraft:missing", result: { id: "minecraft:glass" } }),
  });
  assert.throws(() => extractSmeltingRecipes(jar), /minecraft:missing/u);
});
