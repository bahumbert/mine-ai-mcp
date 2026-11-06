/** Families of items, blocks and entities from the server's tags, the shipped tags and the vanilla override. */
import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeBot, type FakeHarness } from "../test-support/fake-bot/index.js";
import { watchServerTags } from "./server-tags.js";
import { createFamilyIndex, familyIndexOf, hasItemFamily, loadFamilyOverrides } from "./item-families.js";

const OVERRIDE_DIR = fileURLToPath(new URL("./data/item-families/", import.meta.url));

function watchedBot(version?: string): FakeHarness {
  const harness = createFakeBot(version === undefined ? {} : { version });
  watchServerTags(harness.bot);
  return harness;
}

const madeDirs: string[] = [];
after(() => { for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true }); });

function overrideDir(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "item-families-"));
  madeDirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test("a datapack tag from the server adds a family member; a second packet (a /reload) replaces it on the next call", () => {
  const harness = watchedBot();
  const id = harness.bot.registry.itemsByName.stick!.id;
  assert.equal(familyIndexOf(harness.bot).itemFamilies("stick").includes("sword"), false);
  harness.emitTags([{ tagType: "minecraft:item", tags: [{ tagName: "minecraft:swords", entries: [id] }, { tagName: "minecraft:axes", entries: [id] }] }]);
  assert.deepEqual(familyIndexOf(harness.bot).itemFamilies("stick"), ["axe", "sword"], "an item in two families counts for each");
  assert.equal(familyIndexOf(harness.bot).source().source, "server");
  assert.equal(hasItemFamily(harness.bot, "stick", "sword"), true);
  assert.equal(hasItemFamily(harness.bot, "stick", "pickaxe"), false);
  assert.equal(familyIndexOf(harness.bot), familyIndexOf(harness.bot), "no packet in between: the cached index is reused");
  harness.emitTags([{ tagType: "minecraft:item", tags: [{ tagName: "minecraft:axes", entries: [id, 999999] }] }]);
  assert.deepEqual(familyIndexOf(harness.bot).itemFamilies("stick"), ["axe"], "an id the registry cannot name is skipped, not thrown");
});

test("shipped tags answer before any packet, with the version of the file that served them", () => {
  for (const version of ["1.21.4", "1.20.4", "1.19.4"]) {
    const { bot } = watchedBot(version);
    const index = familyIndexOf(bot);
    assert.ok(index.itemFamilies("diamond_sword").includes("sword"), version);
    assert.deepEqual(index.source(), { source: "shipped", version, overrides: ["minecraft"] });
  }
});

test("a version nothing is shipped for: source none, and the override and the food list still answer", () => {
  // The fake has no 1.18.2 data: a 1.21.4 bot that reports an older version is enough for the version lookup.
  const { bot } = watchedBot();
  Object.assign(bot, { version: "1.18.2" });
  const index = familyIndexOf(bot);
  assert.equal(index.source().source, "none");
  assert.deepEqual(index.itemFamilies("diamond_sword"), []);
  assert.deepEqual(index.itemFamilies("bread"), ["food"]);
  assert.ok(index.itemFamilies("rotten_flesh").includes("avoided_food"));
});

test("an override adds a family the tags miss", () => {
  const { bot } = watchedBot();
  const dir = overrideDir({ "mypack.json": JSON.stringify({ namespace: "mypack", families: { sword: ["stick"], chest: ["barrel"], projectile_entity: ["snowball"] } }) });
  const index = createFamilyIndex(bot, loadFamilyOverrides(dir));
  assert.ok(index.itemFamilies("stick").includes("sword"));
  assert.ok(index.blockFamilies("barrel").includes("chest"));
  assert.ok(index.entityFamilies("snowball").includes("projectile_entity"));
  assert.deepEqual(index.source().overrides, ["mypack"]);
});

test("an exclude removes a tag member, after the tags and the additions", () => {
  const { bot } = watchedBot();
  const dir = overrideDir({ "mypack.json": JSON.stringify({ namespace: "mypack", families: { sword: ["stick"] }, exclude: { sword: ["diamond_sword", "stick"] } }) });
  const index = createFamilyIndex(bot, loadFamilyOverrides(dir));
  assert.equal(index.itemFamilies("diamond_sword").includes("sword"), false);
  assert.equal(index.itemFamilies("stick").includes("sword"), false);
  assert.ok(index.itemFamilies("iron_sword").includes("sword"));
});

test("an unreadable override is skipped, logged once by file, and the others load", () => {
  const dir = overrideDir({
    "broken.json": "{ not json",
    "wrong-shape.json": JSON.stringify({ namespace: "x", families: "sword" }),
    "misspelt.json": JSON.stringify({ namespace: "y", families: {}, excludes: { sword: ["stick"] } }),
    "good.json": JSON.stringify({ namespace: "good", families: { sword: ["stick"] } }),
  });
  const errors = mock.method(console, "error", () => undefined);
  try {
    const loaded = loadFamilyOverrides(dir);
    assert.deepEqual(loaded.map((file) => file.namespace), ["good"]);
    const lines = errors.mock.calls.map((call) => String(call.arguments[0]));
    assert.equal(lines.length, 3);
    for (const file of ["broken.json", "wrong-shape.json", "misspelt.json"]) assert.ok(lines.some((line) => line.includes(file) && /restart the host/u.test(line)), file);
  } finally {
    errors.mock.restore();
  }
});

test("a family the data file does not define is dropped from an override with a log naming the file", () => {
  const dir = overrideDir({ "mypack.json": JSON.stringify({ namespace: "mypack", families: { warhammer: ["stick"], sword: ["stick"] } }) });
  const errors = mock.method(console, "error", () => undefined);
  try {
    const [loaded] = loadFamilyOverrides(dir);
    assert.deepEqual(Object.keys(loaded!.families), ["sword"]);
    assert.equal(errors.mock.calls.length, 1);
    assert.match(String(errors.mock.calls[0]!.arguments[0]), /mypack\.json.*warhammer/u);
  } finally {
    errors.mock.restore();
  }
});

test("a missing or empty override folder holds no extra override, silently: the vanilla one is compiled in", () => {
  const dir = join(overrideDir({}), "absent");
  const errors = mock.method(console, "error", () => undefined);
  try {
    assert.deepEqual(loadFamilyOverrides(dir), []);
    mkdirSync(dir);
    assert.deepEqual(loadFamilyOverrides(dir), []);
    assert.equal(errors.mock.calls.length, 0);
  } finally {
    errors.mock.restore();
  }
});

test("every family of the vanilla override file says why", () => {
  const [vanilla] = loadFamilyOverrides();
  assert.equal(vanilla?.namespace, "minecraft");
  const why = JSON.parse(readFileSync(join(OVERRIDE_DIR, "minecraft.json"), "utf8")).why as Record<string, string>;
  assert.deepEqual(Object.keys(why).sort(), Object.keys(vanilla!.families).sort());
  assert.ok(Object.values(why).every((reason) => reason.length > 10));
});

test("rank: netherite ties diamond on harvest and wins on durability", () => {
  const { bot } = watchedBot();
  const index = familyIndexOf(bot);
  assert.equal(index.harvestCapability("netherite_pickaxe"), 372);
  assert.equal(index.harvestCapability("diamond_pickaxe"), 372);
  assert.ok(index.compareRank({ name: "netherite_pickaxe" }, { name: "diamond_pickaxe" }, "pickaxe") < 0);
  assert.ok(index.compareRank({ name: "diamond_pickaxe" }, { name: "netherite_pickaxe" }, "pickaxe") > 0);
  assert.equal(index.compareRank({ name: "diamond_pickaxe" }, { name: "diamond_pickaxe" }, "pickaxe"), 0);
});

test("rank: a stone pickaxe is above a golden one, on harvest capability", () => {
  const index = familyIndexOf(watchedBot().bot);
  assert.equal(index.harvestCapability("stone_pickaxe"), 355);
  assert.equal(index.harvestCapability("golden_pickaxe"), 280);
  assert.ok(index.compareRank({ name: "stone_pickaxe" }, { name: "golden_pickaxe" }, "pickaxe") < 0);
});

test("rank: a netherite axe is above a golden one though every axe has no harvest capability", () => {
  const index = familyIndexOf(watchedBot().bot);
  assert.equal(index.harvestCapability("netherite_axe"), 0);
  assert.equal(index.harvestCapability("golden_axe"), 0);
  assert.ok(index.compareRank({ name: "netherite_axe" }, { name: "golden_axe" }, "axe") < 0);
});

test("B1: a wooden sword is above a golden one; B2: iron and chainmail armour tie (240 each), durability left decides", () => {
  const index = familyIndexOf(watchedBot().bot);
  assert.ok(index.compareRank({ name: "wooden_sword" }, { name: "golden_sword" }, "sword") < 0);
  assert.equal(index.compareRank({ name: "iron_chestplate" }, { name: "chainmail_chestplate" }, "chestplate"), 0);
});

test("rank: a durability the caller passes (a worn stack's maximum) beats the registry's, and an unknown item ranks last", () => {
  const index = familyIndexOf(watchedBot().bot);
  assert.ok(index.compareRank({ name: "iron_sword", maxDurability: 10 }, { name: "iron_sword", maxDurability: 500 }, "sword") > 0);
  assert.ok(index.compareRank({ name: "not_an_item" }, { name: "wooden_sword" }, "sword") > 0);
  assert.ok(index.compareRank({ name: "wooden_sword" }, { name: "not_an_item" }, "sword") < 0);
  assert.equal(index.harvestCapability("not_an_item"), 0);
});

test("cooked form comes from the smelting recipes: raw food only, and only to a better food", () => {
  const index = familyIndexOf(watchedBot().bot);
  assert.equal(index.cookedForm("beef"), "cooked_beef");
  assert.equal(index.cookedForm("potato"), "baked_potato");
  assert.equal(index.cookedForm("cooked_beef"), null);
  assert.equal(index.cookedForm("raw_iron"), null);
  assert.equal(index.cookedForm("not_an_item"), null);
});

test("cooked form on 1.20.4 uses that version's recipes", () => {
  assert.equal(familyIndexOf(watchedBot("1.20.4").bot).cookedForm("beef"), "cooked_beef");
});

test("avoided food is the override's list: rotten flesh and suspicious stew, not bread", () => {
  const index = familyIndexOf(watchedBot().bot);
  assert.ok(index.itemFamilies("rotten_flesh").includes("avoided_food"));
  assert.ok(index.itemFamilies("suspicious_stew").includes("avoided_food"));
  assert.ok(index.itemFamilies("rotten_flesh").includes("food"));
  assert.deepEqual(index.itemFamilies("bread"), ["food"]);
  // Object.prototype members are no foods or items: stack names reach this from the model's chat.
  assert.deepEqual(index.itemFamilies("constructor"), []);
  assert.equal(index.cookedForm("constructor"), null);
});

test("block and entity families: containers, chests, arrows and the other projectiles", () => {
  const index = familyIndexOf(watchedBot().bot);
  assert.deepEqual(index.blockFamilies("barrel"), ["container"]);
  assert.deepEqual(index.blockFamilies("chest"), ["chest", "container"]);
  assert.deepEqual(index.blockFamilies("ender_chest"), ["chest"]);
  assert.deepEqual(index.blockFamilies("shulker_box"), ["container"]);
  assert.deepEqual(index.entityFamilies("arrow"), ["arrow_entity", "projectile_entity"]);
  assert.deepEqual(index.entityFamilies("small_fireball"), ["projectile_entity"]);
  assert.deepEqual(index.entityFamilies("snowball"), []);
});

test("two bots, two indexes: a packet to one is not seen by the other", () => {
  const first = watchedBot();
  const second = watchedBot();
  first.emitTags([{ tagType: "minecraft:item", tags: [{ tagName: "minecraft:swords", entries: [first.bot.registry.itemsByName.stick!.id] }] }]);
  assert.ok(familyIndexOf(first.bot).itemFamilies("stick").includes("sword"));
  assert.equal(familyIndexOf(second.bot).itemFamilies("stick").includes("sword"), false);
  assert.equal(familyIndexOf(second.bot).source().source, "shipped");
});
