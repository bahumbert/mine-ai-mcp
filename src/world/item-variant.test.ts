import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import minecraftData from "minecraft-data";
import type { Item } from "prismarine-item";
import { itemOf } from "../test-support/fake-bot/fake-inventory.js";
import { variantItemOf } from "../test-support/fake-bot/item-variants.js";
import { itemVariantKey, sameItemVariant } from "./item-variant.js";

const registry = minecraftData("1.21.4");
const ItemClass = (createRequire(import.meta.url)("prismarine-item") as (registry: unknown) => typeof Item)(registry);

/** An item as the server sends it, with the component lists given as they come off the wire. */
function notchItem(name: string, components: readonly unknown[], removeComponents: readonly unknown[] = []): Item {
  const made = (ItemClass as unknown as { fromNotch(notch: unknown): Item }).fromNotch({ itemId: registry.itemsByName[name]!.id, itemCount: 1, components, removeComponents });
  return made;
}

test("stacks of one item with another custom name, an enchantment, or damage are other variants", () => {
  const first = variantItemOf(registry, "renamed_first_cobblestone", 5);
  const plain = itemOf(registry, "cobblestone", 4);
  assert.equal(sameItemVariant(first, variantItemOf(registry, "renamed_second_cobblestone", 7)), false, "renamed first and second");
  assert.equal(sameItemVariant(first, plain), false, "renamed and plain");
  assert.equal(sameItemVariant(variantItemOf(registry, "enchanted_cobblestone", 3), plain), false, "enchanted and plain");
  assert.equal(sameItemVariant(variantItemOf(registry, "damaged_diamond_pickaxe", 1), itemOf(registry, "diamond_pickaxe", 1)), false, "a damaged pickaxe and a new one");
});

test("two stacks of one variant are the same whatever their counts and slots, and a plain stack is the same however it was built", () => {
  const first = variantItemOf(registry, "renamed_first_cobblestone", 5);
  const another = variantItemOf(registry, "renamed_first_cobblestone", 40);
  another.slot = 12;
  assert.equal(sameItemVariant(first, another), true);
  assert.equal(sameItemVariant(itemOf(registry, "cobblestone", 4), notchItem("cobblestone", [])), true, "constructor with [] and fromNotch with []");
});

test("stacks of two items are never the same variant", () => {
  assert.equal(sameItemVariant(itemOf(registry, "cobblestone"), itemOf(registry, "stone")), false);
});

test("one stack's components listed in two orders give one key", () => {
  const name = { type: "custom_name", data: { type: "string", value: "x" } };
  const enchantments = { type: "enchantments", data: { enchantments: [{ id: 8, level: 1 }], showTooltip: true } };
  assert.equal(itemVariantKey(notchItem("diamond_pickaxe", [name, enchantments])), itemVariantKey(notchItem("diamond_pickaxe", [enchantments, name])));
  assert.equal(itemVariantKey(notchItem("diamond_pickaxe", [], [{ type: "damage" }, { type: "rarity" }])), itemVariantKey(notchItem("diamond_pickaxe", [], [{ type: "rarity" }, { type: "damage" }])));
});

test("a removed default component tells a stack from a plain one, and a missing list reads as an empty one", () => {
  const removed = notchItem("cobblestone", [], [{ type: "max_stack_size" }]);
  assert.equal(sameItemVariant(removed, itemOf(registry, "cobblestone")), false);
  const noLists = notchItem("cobblestone", []);
  Reflect.deleteProperty(noLists, "removedComponents");
  Reflect.deleteProperty(noLists, "components");
  assert.equal(sameItemVariant(noLists, itemOf(registry, "cobblestone")), true);
});

test("a component whose data holds a bigint is keyed and does not throw", () => {
  const withLong = (value: bigint) => notchItem("cobblestone", [{ type: "custom_data", data: { type: "compound", value: { seed: { type: "long", value } } } }]);
  assert.equal(sameItemVariant(withLong(5n), withLong(5n)), true);
  assert.equal(sameItemVariant(withLong(5n), withLong(6n)), false);
});

test("an item of a version with no components keys by its nbt: equal nbt the same, different nbt apart", () => {
  const old = minecraftData("1.20.4");
  const OldItem = (createRequire(import.meta.url)("prismarine-item") as (registry: unknown) => typeof Item)(old);
  const cobblestone = old.itemsByName.cobblestone!.id;
  const named = (value: string) => new OldItem(cobblestone, 1, 0, { type: "compound", name: "", value: { display: { type: "string", value } } });
  assert.equal(Reflect.get(named("a"), "components"), undefined, "this registry's items have no components");
  assert.equal(sameItemVariant(named("a"), named("a")), true);
  assert.equal(sameItemVariant(named("a"), named("b")), false);
  assert.equal(sameItemVariant(named("a"), new OldItem(cobblestone, 1, 0)), false);
});
