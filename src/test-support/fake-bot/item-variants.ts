/**
 * The stacks the game tells apart by their components, as a 1.21.4 server sends them: each entry has the command text
 * that makes the stack (`item replace ... with <command> <count>`) and the `components` and `removedComponents` lists
 * the server answers for it, measured by the contract check `item-variant-components`. A test names a variant where it
 * would name an item (`carried`, `containers`, `slots`): `itemOf` builds it through `variantItemOf`.
 */
import { createRequire } from "node:module";
import type minecraftData from "minecraft-data";
import type { Item } from "prismarine-item";
import { sameItemVariant } from "../../world/item-variant.js";

type Registry = ReturnType<typeof minecraftData>;
const require = createRequire(import.meta.url);

export interface MeasuredVariant {
  /** The registry name of the item that carries the components. */
  readonly item: string;
  /** What follows `with` in the item commands (`give`, `item replace`), before the count. */
  readonly command: string;
  readonly components: readonly unknown[];
  readonly removedComponents: readonly unknown[];
}

export const ITEM_VARIANTS = {
  renamed_first_cobblestone: { item: "cobblestone", command: `cobblestone[custom_name='"first"']`, components: [{ type: "custom_name", data: { type: "string", value: "first" } }], removedComponents: [] },
  renamed_second_cobblestone: { item: "cobblestone", command: `cobblestone[custom_name='"second"']`, components: [{ type: "custom_name", data: { type: "string", value: "second" } }], removedComponents: [] },
  enchanted_cobblestone: { item: "cobblestone", command: `cobblestone[enchantments={levels:{"minecraft:efficiency":1}}]`, components: [{ type: "enchantments", data: { enchantments: [{ id: 8, level: 1 }], showTooltip: true } }], removedComponents: [] },
  damaged_diamond_pickaxe: { item: "diamond_pickaxe", command: "diamond_pickaxe[damage=5]", components: [{ type: "damage", data: 5 }], removedComponents: [] },
  renamed_oak_planks: { item: "oak_planks", command: `oak_planks[custom_name='"x"']`, components: [{ type: "custom_name", data: { type: "string", value: "x" } }], removedComponents: [] },
} as const satisfies Readonly<Record<string, MeasuredVariant>>;

export type ItemVariantName = keyof typeof ITEM_VARIANTS;

/** Whether `name` names a variant of `ITEM_VARIANTS` rather than a registry item. */
export function isItemVariantName(name: string): name is ItemVariantName {
  return Object.hasOwn(ITEM_VARIANTS, name);
}

/** The item command text of a stack named as a test names it: a variant's command, or the item's own name. */
export function itemCommandOf(name: string): string {
  return isItemVariantName(name) ? ITEM_VARIANTS[name].command : name;
}

/** The registry item a name stands for: itself, or the item a variant carries its components on. */
export function registryNameOf(name: string): string {
  return isItemVariantName(name) ? ITEM_VARIANTS[name].item : name;
}

/** `count` of a variant as the server's items are built: `Item.fromNotch` with the measured lists (`prismarine-item` `index.js:149-163`). */
export function variantItemOf(registry: Registry, variant: ItemVariantName, count: number): Item {
  const { item, components, removedComponents } = ITEM_VARIANTS[variant];
  const known = registry.itemsByName[item];
  if (!known) throw new Error(`variant ${variant}: unknown item ${item} in ${registry.version.minecraftVersion}`);
  const ItemClass = (require("prismarine-item") as (registry: Registry) => typeof Item)(registry);
  const notch = { itemId: known.id, itemCount: count, components: structuredClone(components), removeComponents: structuredClone(removedComponents) };
  return (ItemClass as unknown as { fromNotch(notch: unknown): Item }).fromNotch(notch);
}

/** A new item like `item` with another count, components and all, as the server's `set_slot` builds one (never the old item changed in place). */
export function itemWithCount(registry: Registry, item: Item, count: number): Item {
  const ItemClass = (require("prismarine-item") as (registry: Registry) => typeof Item)(registry) as unknown as { fromNotch(notch: unknown): Item; toNotch(item: Item): unknown };
  return Object.assign(ItemClass.fromNotch(ItemClass.toNotch(item)), { count });
}

/** The name a test gives a stack: its `ITEM_VARIANTS` name when it is one of them, else its item's name. */
export function stackNameOf(registry: Registry, item: Item): string {
  const variant = (Object.keys(ITEM_VARIANTS) as ItemVariantName[]).find((name) => sameItemVariant(item, variantItemOf(registry, name, 1)));
  return variant ?? item.name;
}
