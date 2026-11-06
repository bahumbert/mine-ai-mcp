import minecraftData from "minecraft-data";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { mock } from "node:test";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { createFamilyIndex, familyIndexOf } from "../../world/item-families.js";
import { watchServerTags } from "../../world/server-tags.js";
import { equipCombatLoadout, readCombatItems, selectCombatLoadout, selectMeleeLoadout } from "./equipment.js";

const registry = minecraftData("1.21.4");
// The package exports a CommonJS loader; its default declaration is not callable under NodeNext.
const loadItem = createRequire(import.meta.url)("prismarine-item") as typeof import("prismarine-item").default;
const Item = loadItem(registry);
const item = (name: string) => new Item(registry.itemsByName[name]!.id, 1);
const idOf = (name: string) => registry.itemsByName[name]!.id;

/** A bot whose server sent no tags: the shipped 1.21.4 tags answer. */
function shippedIndex() {
  return familyIndexOf(createFakeBot().bot);
}

/** A bot that listens for the server's `tags` packet, as the runtime host does. */
function watchedBot(options: Parameters<typeof createFakeBot>[0] = {}) {
  const harness = createFakeBot(options);
  watchServerTags(harness.bot);
  return harness;
}

test("melee falls back to the best carried tool family, including when a bow is unloaded", () => {
  const index = shippedIndex();
  const axe = item("iron_axe");
  assert.deepEqual(selectCombatLoadout(index, [item("diamond_shovel"), item("wooden_pickaxe"), axe], { x: 2, y: 0, z: 0 }), {
    kind: "melee",
    weapon: axe,
    shield: null,
    cooldownTicks: 25,
  });
  const stoneAxe = item("stone_axe");
  assert.deepEqual(selectCombatLoadout(index, [item("bow"), stoneAxe], { x: 10, y: 0, z: 0 }), {
    kind: "melee",
    weapon: stoneAxe,
    shield: null,
    cooldownTicks: 25,
  });
});

test("a usable bow yields to melee at the six-block boundary", () => {
  const index = shippedIndex();
  const bow = item("bow");
  const sword = item("iron_sword");
  const shield = item("shield");
  const carried = [bow, item("arrow"), sword, shield];

  assert.deepEqual(selectCombatLoadout(index, carried, { x: 6, y: 0, z: 0 }), {
    kind: "melee",
    weapon: sword,
    shield,
    cooldownTicks: 13,
  });
  assert.deepEqual(selectCombatLoadout(index, carried, { x: 6.01, y: 0, z: 0 }), { kind: "bow", weapon: bow, shield });
});

test("each supported arrow makes a bow usable; an unloaded bow falls back to an empty hand", () => {
  const index = shippedIndex();
  const bow = item("bow");
  for (const arrow of ["arrow", "spectral_arrow", "tipped_arrow"]) {
    assert.deepEqual(selectCombatLoadout(index, [bow, item(arrow)], { x: 10, y: 0, z: 0 }), {
      kind: "bow",
      weapon: bow,
      shield: null,
    });
  }
  assert.deepEqual(selectCombatLoadout(index, [bow], { x: 10, y: 0, z: 0 }), {
    kind: "melee",
    weapon: null,
    shield: null,
    cooldownTicks: 5,
  });
});

test("a nearby target above melee height uses the carried bow without changing ground melee selection", () => {
  const index = shippedIndex();
  const bow = item("bow");
  const sword = item("iron_sword");
  const carried = [bow, sword, item("arrow")];
  assert.equal(selectCombatLoadout(index, carried, { x: 3, y: 4, z: 0 }).kind, "bow");
  assert.equal(selectCombatLoadout(index, carried, { x: 3, y: 3, z: 0 }).kind, "melee");
  assert.equal(selectCombatLoadout(index, carried, { x: 5, y: 0, z: 0 }).kind, "melee");
  assert.equal(selectCombatLoadout(index, [bow, sword], { x: 3, y: 4, z: 0 }).kind, "melee");
});

test("best ranked melee weapon: a netherite sword beats a diamond and a stone sword, whatever the carried order", () => {
  const index = shippedIndex();
  const netherite = item("netherite_sword");
  for (const carried of [
    [item("stone_sword"), item("diamond_sword"), netherite],
    [netherite, item("stone_sword"), item("diamond_sword")],
    [item("diamond_sword"), netherite, item("stone_sword")],
  ]) {
    assert.equal(selectMeleeLoadout(index, carried).weapon, netherite);
  }
});

test("the family order holds: a stone sword beats a netherite axe, as MELEE_FAMILIES ordered them", () => {
  const index = shippedIndex();
  const stoneSword = item("stone_sword");
  assert.deepEqual(selectMeleeLoadout(index, [item("netherite_axe"), stoneSword]), {
    kind: "melee",
    weapon: stoneSword,
    shield: null,
    cooldownTicks: 13,
  });
  // sword, axe, pickaxe, shovel, hoe: each is chosen while no earlier family is carried.
  const rest = ["netherite_axe", "netherite_pickaxe", "netherite_shovel", "netherite_hoe"];
  const cooldowns = [25, 17, 20, 20];
  rest.forEach((name, position) => {
    const loadout = selectMeleeLoadout(index, rest.slice(position).map(item));
    assert.equal(loadout.weapon?.name, name);
    assert.equal(loadout.cooldownTicks, cooldowns[position]);
  });
});

test("B1: the materials rank as before except a wooden tool now beats a golden one (durability 59 against 32)", () => {
  const index = shippedIndex();
  const todaysOrder = ["netherite", "diamond", "iron", "stone", "golden", "wooden"];
  const familyRankOrder = ["netherite", "diamond", "iron", "stone", "wooden", "golden"];
  for (const tool of ["sword", "axe", "pickaxe", "shovel", "hoe"]) {
    for (let dropped = 0; dropped < todaysOrder.length; dropped++) {
      const carried = familyRankOrder.slice(dropped).reverse().map((material) => item(`${material}_${tool}`));
      assert.equal(selectMeleeLoadout(index, carried).weapon?.name, `${familyRankOrder[dropped]}_${tool}`, `${tool} from ${familyRankOrder[dropped]}`);
    }
  }
});

test("a bow with only an arrow a datapack added to the arrows tag is usable (B4)", () => {
  const { bot, emitTags } = watchedBot();
  const bow = item("bow");
  assert.equal(selectCombatLoadout(familyIndexOf(bot), [bow, item("stick")], { x: 10, y: 0, z: 0 }).kind, "melee", "a stick is no arrow yet");
  emitTags([{ tagType: "minecraft:item", tags: [{ tagName: "minecraft:arrows", entries: [idOf("stick"), idOf("arrow")] }, { tagName: "minecraft:enchantable/bow", entries: [idOf("bow")] }] }]);
  assert.deepEqual(selectCombatLoadout(familyIndexOf(bot), [bow, item("stick")], { x: 10, y: 0, z: 0 }), { kind: "bow", weapon: bow, shield: null });
});

test("a bow with only tipped or spectral arrows is usable on every shipped version", () => {
  for (const version of ["1.21.4", "1.20.4", "1.19.4"]) {
    const { bot } = createFakeBot({ version });
    const VersionItem = loadItem(bot.registry);
    const make = (name: string) => new VersionItem(bot.registry.itemsByName[name]!.id, 1);
    for (const arrow of ["tipped_arrow", "spectral_arrow"]) {
      assert.equal(selectCombatLoadout(familyIndexOf(bot), [make("bow"), make(arrow)], { x: 10, y: 0, z: 0 }).kind, "bow", `${version} ${arrow}`);
    }
  }
});

test("an item the override files put in the shield family is the loadout's shield", () => {
  const { bot } = createFakeBot();
  const index = createFamilyIndex(bot, [{ namespace: "test", families: { shield: ["stick"] }, exclude: {}, data: {} }]);
  assert.equal(selectMeleeLoadout(index, [item("stone_sword"), item("stick")]).shield?.name, "stick");
  assert.equal(selectMeleeLoadout(shippedIndex(), [item("stone_sword"), item("stick")]).shield, null, "no override: a stick is no shield");
});

test("the shield stays: the vanilla shield in the off-hand is kept, the weapon alone is equipped", async () => {
  // The sword sits in a hotbar slot that is not selected, so equipping it is a real equip.
  const { bot } = createFakeBot({ slots: { 45: { name: "shield" }, 37: { name: "stone_sword" } } });
  const equip = mock.method(bot, "equip");
  const loadout = selectMeleeLoadout(familyIndexOf(bot), readCombatItems(bot));
  assert.equal(loadout.shield?.name, "shield");
  await equipCombatLoadout(bot, loadout);
  assert.deepEqual(equip.mock.calls.map((call) => call.arguments[1]), ["hand"]);
  await equipCombatLoadout(bot, selectMeleeLoadout(familyIndexOf(bot), readCombatItems(bot)));
  assert.deepEqual(equip.mock.calls.map((call) => call.arguments[1]), ["hand"], "a second turn changes nothing");
});

test("revision change re-reads: an item a tags packet adds to swords is the next loadout's weapon", () => {
  const { bot, emitTags } = watchedBot({ carried: { stick: 1, stone_axe: 1 } });
  const choose = () => selectMeleeLoadout(familyIndexOf(bot), readCombatItems(bot));
  assert.equal(choose().weapon?.name, "stone_axe");
  emitTags([{ tagType: "minecraft:item", tags: [
    { tagName: "minecraft:swords", entries: [idOf("stick")] },
    { tagName: "minecraft:axes", entries: [idOf("stone_axe")] },
  ] }]);
  const after = choose();
  assert.equal(after.weapon?.name, "stick");
  assert.equal(after.cooldownTicks, 13, "the sword family's cooldown");
});
