/**
 * A stack the game tells apart from another of its item (a custom name, enchantments, damage) arrives as `components`
 * and `removedComponents` lists on the item, and `nbt` stays null (a damageable item gets Prismarine's own `Damage` 0 there, whatever its damage): Prismarine's `Item.fromNotch` reads `itemsWithComponents`
 * items that way (`prismarine-item` `index.js:149-163`). The measured lists are `ITEM_VARIANTS`; a plain stack has empty
 * ones (1.21.4, 2026-10-23).
 */
import assert from "node:assert/strict";
import { ITEM_VARIANTS, type ItemVariantName } from "../../../../src/test-support/fake-bot/item-variants.ts";
import type { ContractCheck } from "../checks.ts";
import { settleWithin } from "../subject.ts";

const OPEN_WALL_MS = 5_000;
/** The chest's cell in the fixture's frame; `subject.world` moves it to the lane. */
const CHEST = [0, -60, 0] as const;
/** The stacks in the chest, slot 0 first: a variant name or a plain item name, and its count. */
const STACKS: readonly (readonly [ItemVariantName | "cobblestone" | "diamond_pickaxe", number])[] = [
  ["renamed_first_cobblestone", 5],
  ["renamed_second_cobblestone", 7],
  ["enchanted_cobblestone", 3],
  ["cobblestone", 4],
  ["damaged_diamond_pickaxe", 1],
  ["diamond_pickaxe", 1],
  ["renamed_oak_planks", 64],
];

/** What Prismarine gives a damageable item it builds from the server's notch: `Damage` 0 whatever the stack's damage (that is the `damage` component): `fromNotch` passes `true` as the constructor's `stackId`, so `sentByServer` is unset and `durabilityUsed` is initialised. */
const DAMAGEABLE_NBT = { type: "compound", name: "", value: { Damage: { type: "int", value: 0 } } };

/** BigInt-safe text of a component list, for the failure message a measurement is read from. */
const textOf = (value: unknown): string => JSON.stringify(value, (_key, field: unknown) => (typeof field === "bigint" ? `${field}n` : field));

export const itemVariantComponents: ContractCheck = {
  name: "item-variant-components",
  // Bare bot: our runtime would act on the window.
  withoutRuntime: true,
  fixture: {
    cells: { "0,-60,0": "chest" },
    carried: {},
    containers: {
      "0,-60,0": {
        renamed_first_cobblestone: 5,
        renamed_second_cobblestone: 7,
        enchanted_cobblestone: 3,
        cobblestone: 4,
        damaged_diamond_pickaxe: 1,
        diamond_pickaxe: 1,
        renamed_oak_planks: 64,
      },
    },
    position: [-4.5, -60, 0.5],
  },
  async run(subject) {
    const { bot } = subject;
    const opened = await settleWithin(subject, bot.openContainer(bot.blockAt(subject.world(CHEST))!), OPEN_WALL_MS);
    assert.ok(opened?.value !== undefined, `the chest opened: ${opened?.error?.message ?? "never"}`);
    const { slots } = opened.value;
    const measured = STACKS.map((_, slot) => {
      const item = slots[slot];
      return item ? { name: item.name, count: item.count, nbt: item.nbt, components: Reflect.get(item, "components"), removedComponents: Reflect.get(item, "removedComponents") } : null;
    });
    const expected = STACKS.map(([name, count]) => {
      const variant = name in ITEM_VARIANTS ? ITEM_VARIANTS[name as ItemVariantName] : null;
      return { name: variant?.item ?? name, count, nbt: bot.registry.itemsByName[variant?.item ?? name]!.maxDurability ? DAMAGEABLE_NBT : null, components: variant?.components ?? [], removedComponents: variant?.removedComponents ?? [] };
    });
    assert.equal(textOf(measured), textOf(expected), `the chest's stacks, slot by slot: measured ${textOf(measured)}`);
    opened.value.close();
  },
};
