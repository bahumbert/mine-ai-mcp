/**
 * On every shipped version, each family answer equals what the name-derived tables of the code say today (the
 * references below are copies of those tables, `src/world/tool-tiers.ts`, `brain/src/inventory-room.ts`,
 * `src/world/food.ts`, `src/survival/weapons/equipment.ts`, `src/world/containers.ts`, `src/world/chest-clearance.ts`,
 * `src/survival/perception/combat/projectile-spawn.ts`), except the behaviour changes named in spec P4-17 section 5.
 * A difference is fixed by an entry in `data/item-families/minecraft.json`; its failures are the override's content.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { familyIndexOf } from "./item-families.js";

const SHIPPED_VERSIONS = ["1.19.4", "1.20.1", "1.20.4", "1.20.6", "1.21.1", "1.21.4"] as const;

// --- the references: today's tables, copied -------------------------------------------------------------------------

const TOOL_CLASSES = ["pickaxe", "shovel", "axe", "sword", "hoe", "shears", "bow", "shield", "bucket", "water_bucket", "lava_bucket", "powder_snow_bucket"] as const;
const ARMOUR_CLASSES = ["helmet", "chestplate", "leggings", "boots"] as const;
const BUCKET_CLASSES: readonly string[] = ["bucket", "water_bucket", "lava_bucket", "powder_snow_bucket"];

/** `equipmentClass` of tool-tiers.ts:47. */
function equipmentClass(name: string): string | null {
  if (name === "water_bucket" || name === "lava_bucket" || name === "powder_snow_bucket") return name;
  for (const value of [...TOOL_CLASSES, ...ARMOUR_CLASSES]) {
    if (name === value || name.endsWith(`_${value}`)) return value;
  }
  return null;
}

/** `kindOf` of inventory-room.ts:5, bed and boat included. */
const KEPT_KINDS = ["pickaxe", "axe", "shovel", "hoe", "sword", "bed", "boat"] as const;
const kindOf = (item: string): string | null => KEPT_KINDS.find((kind) => item.split("_").at(-1) === kind) ?? null;

/** inventory-room.ts:26 (its `ARMOUR`, the four classes of `ARMOUR_CLASSES` above, is covered by `equipmentClass`). */
const STATIONS = ["crafting_table", "furnace"];

/** food.ts:7. */
const REFLEX_AVOIDED_FOODS = new Set(["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken", "suspicious_stew", "chorus_fruit", "enchanted_golden_apple"]);

/** equipment.ts:58 (the arrows a bow can use). */
const ARROW_ITEMS = ["arrow", "spectral_arrow", "tipped_arrow"];

/** containers.ts:2-12. */
function isLocationOwnedContainer(blockName: string): boolean {
  return (
    blockName === "chest" || blockName === "trapped_chest" || blockName === "barrel" || blockName === "hopper" ||
    blockName === "dropper" || blockName === "dispenser" || blockName.endsWith("_shulker_box")
  );
}

/** chest-clearance.ts:4. */
const CHESTS = new Set(["chest", "trapped_chest", "ender_chest"]);

/** projectile-spawn.ts:22: arrows and the blaze's small fireball. */
const PROJECTILE_ENTITIES = ["arrow", "spectral_arrow", "small_fireball"];
const ARROW_ENTITIES = ["arrow", "spectral_arrow"];

/** The item families the references decide; `crossbow` is new (no table named it) and `food` is the registry's list. */
function referenceItemFamilies(name: string): string[] {
  const families = new Set<string>();
  const klass = equipmentClass(name);
  // B3 (spec section 5): the old `bucket` classes (every `*_bucket` was a "bucket") are no family; buckets stay item
  // ids, and the consumers (plan 17b) read them as such.
  if (klass !== null && !BUCKET_CLASSES.includes(klass)) families.add(klass);
  const kind = kindOf(name);
  if (kind !== null) families.add(kind);
  if (name === "crossbow") families.add("crossbow");
  // contract.ts:46-47 (before families): the two worn non-armour items the slot rule named.
  if (name === "carved_pumpkin") families.add("head_gear");
  if (name === "elytra") families.add("torso_gear");
  if (STATIONS.includes(name)) families.add("station");
  if (REFLEX_AVOIDED_FOODS.has(name)) families.add("avoided_food");
  if (ARROW_ITEMS.includes(name)) families.add("arrow");
  return [...families];
}

// --- the behaviour changes of spec section 5 that the parity accepts --------------------------------------------------

/** B6: a bamboo raft is a kept boat (the old check read the last word of the name, "raft"). */
const ACCEPTED_ITEM_EXTRAS: Readonly<Record<string, readonly string[]>> = {
  bamboo_raft: ["boat"],
  bamboo_chest_raft: ["boat"],
};
/** B5: a plain shulker box is a container (the old check read `_shulker_box`). */
const ACCEPTED_BLOCK_EXTRAS: Readonly<Record<string, readonly string[]>> = {
  shulker_box: ["container"],
};

/** The families the references speak about: a family the new code adds beyond them (`food`, `sword` from a tag the old table lacks) is judged only for these. */
const COMPARED_ITEM_FAMILIES: ReadonlySet<string> = new Set([
  "pickaxe", "shovel", "axe", "sword", "hoe", "shears", "bow", "crossbow", "shield", "helmet", "chestplate", "leggings", "boots", "head_gear", "torso_gear",
  "bed", "boat", "station", "avoided_food", "arrow",
]);

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

for (const version of SHIPPED_VERSIONS) {
  test(`parity ${version}: item families equal today's name tables, except B6`, () => {
    const { bot } = createFakeBot({ version });
    const index = familyIndexOf(bot);
    const differences: string[] = [];
    for (const item of bot.registry.itemsArray) {
      const expected = sorted([...referenceItemFamilies(item.name), ...(ACCEPTED_ITEM_EXTRAS[item.name] ?? [])]);
      const actual = sorted(index.itemFamilies(item.name).filter((family) => COMPARED_ITEM_FAMILIES.has(family)));
      if (expected.join() !== actual.join()) differences.push(`${item.name}: expected [${expected}] got [${actual}]`);
    }
    assert.deepEqual(differences, []);
  });

  test(`parity ${version}: block and entity families equal containers.ts, chest-clearance.ts and projectile-spawn.ts, except B5`, () => {
    const { bot } = createFakeBot({ version });
    const index = familyIndexOf(bot);
    const differences: string[] = [];
    for (const block of bot.registry.blocksArray) {
      const expected: string[] = [];
      if (CHESTS.has(block.name)) expected.push("chest");
      if (isLocationOwnedContainer(block.name) || ACCEPTED_BLOCK_EXTRAS[block.name]?.includes("container")) expected.push("container");
      const actual = sorted(index.blockFamilies(block.name));
      if (sorted(expected).join() !== actual.join()) differences.push(`${block.name}: expected [${sorted(expected)}] got [${actual}]`);
    }
    // Entities: the projectile names of projectile-spawn.ts.
    for (const entity of bot.registry.entitiesArray) {
      const expected: string[] = [];
      if (ARROW_ENTITIES.includes(entity.name)) expected.push("arrow_entity");
      if (PROJECTILE_ENTITIES.includes(entity.name)) expected.push("projectile_entity");
      const actual = sorted(index.entityFamilies(entity.name));
      if (expected.join() !== actual.join()) differences.push(`${entity.name}: expected [${expected}] got [${actual}]`);
    }
    assert.deepEqual(differences, []);
  });
}
