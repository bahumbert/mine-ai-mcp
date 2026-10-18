import assert from "node:assert/strict";
import test from "node:test";
import { zip } from "../test-support/zip.js";
import minecraftData from "minecraft-data";
import { mobNotItemAnswer, mobSourcesOf, rankedMobSources, unknownItemAnswer } from "./mob-drops.js";
import { extractMobDrops } from "./mob-drops-extract.js";

const entity = (path: string, items: readonly string[]) => ({
  [`data/minecraft/loot_table/entities/${path}.json`]: JSON.stringify({
    type: "minecraft:entity",
    pools: items.map((name) => ({ rolls: 1, conditions: [{ condition: "minecraft:killed_by_player" }], entries: [{ type: "minecraft:item", name: `minecraft:${name}` }] })),
  }),
});

test("entity loot tables become each mob's drops; a variant's own table (a sheep's wool) counts for its mob", () => {
  const mobs = extractMobDrops(zip({
    ...entity("cow", ["beef", "leather"]),
    ...entity("sheep", ["mutton"]),
    ...entity("sheep/white", ["white_wool"]),
    ...entity("allay", []),
    "data/minecraft/loot_table/blocks/stone.json": JSON.stringify({ type: "minecraft:block", pools: [] }),
  }));
  assert.deepEqual(mobs, {
    cow: [{ item: "beef", chance: 1 }, { item: "leather", chance: 1 }],
    sheep: [{ item: "mutton", chance: 1 }, { item: "white_wool", chance: 1 }],
  });
});

test("the shipped data names the mobs an item is hunted from, likeliest first", () => {
  assert.deepEqual(mobSourcesOf("white_wool", "1.21.4"), [{ mob: "sheep", chance: 1 }]);
  assert.ok(mobSourcesOf("beef", "1.21.4").some((source) => source.mob === "cow"));
  assert.deepEqual(mobSourcesOf("oak_log", "1.21.4"), []);
});

const names = (sources: readonly { readonly mob: string }[]) => sources.map((source) => source.mob);
const nothingLoaded = () => 0;

test("sources are ranked by loaded nearby, then spawning in the bot's dimension, then chance, then name", () => {
  // Live run 15: porkchop was hunted from hoglin (a Nether mob) before pig, salmon from polar_bear.
  assert.equal(rankedMobSources("porkchop", "1.21.4", "overworld", nothingLoaded)[0]?.mob, "pig");
  assert.equal(rankedMobSources("porkchop", "1.21.4", "the_nether", nothingLoaded)[0]?.mob, "hoglin");
  const overworld = rankedMobSources("porkchop", "1.21.4", "overworld", nothingLoaded);
  assert.deepEqual(overworld.find((source) => source.mob === "hoglin"), { mob: "hoglin", chance: overworld.find((source) => source.mob === "hoglin")!.chance, spawnsInDimension: false, loaded: 0 });
  assert.equal(overworld.find((source) => source.mob === "pig")?.spawnsInDimension, true);
});

test("a loaded mob beats a likelier one; with none loaded, spawning here, then chance, then name decide", () => {
  const salmon = (loaded: (mob: string) => number) => names(rankedMobSources("salmon", "1.21.4", "overworld", loaded));
  assert.deepEqual(salmon((mob) => (mob === "salmon" ? 2 : 0)).slice(0, 1), ["salmon"]);
  assert.ok(salmon((mob) => (mob === "polar_bear" ? 1 : 0))[0] === "polar_bear");
  const none = rankedMobSources("salmon", "1.21.4", "overworld", nothingLoaded);
  assert.deepEqual(names(none), ["polar_bear", "salmon"]);
  assert.deepEqual(none.map((source) => source.loaded), [0, 0]);
});

test("no dimension known ranks by loaded, then chance, then name", () => {
  assert.deepEqual(names(rankedMobSources("white_wool", "1.21.4", undefined, nothingLoaded)), ["sheep"]);
});

const registry = minecraftData("1.21.4");

test("an unknown item that is a mob answers with its drops; any other unknown name gets its closest item ids", () => {
  // Live run 15: `get 1 cow` was answered `closest: cow_spawn_egg, bow, cod`.
  assert.equal(mobNotItemAnswer("cow", registry.entitiesByName, "1.21.4"), "cow is a mob, not an item: it drops beef, leather (get_items beef hunts it)");
  assert.equal(mobNotItemAnswer("moon_rock", registry.entitiesByName, "1.21.4"), null);
  assert.equal(mobNotItemAnswer("allay", registry.entitiesByName, "1.21.4"), "allay is a mob, not an item");
  const names = Object.keys(registry.itemsByName);
  assert.match(unknownItemAnswer("cow", names, registry.entitiesByName, "1.21.4"), /^cow is a mob, not an item: it drops beef, leather/u);
  assert.equal(unknownItemAnswer("raw_beef", names, registry.entitiesByName, "1.21.4"), "raw_beef (closest: beef, cooked_beef)");
});
