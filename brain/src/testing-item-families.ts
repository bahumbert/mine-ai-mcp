// Test fixture: the item families a 1.21.4 server reports for a stack (`vanillaItemFamilies`). Moved out of testing.ts, which
// must not grow past 600 lines (plan 2026-11-07-p4-05a-shelter, global constraints).
import familyMap from "#src/world/data/item-families.json" with { type: "json" };
import vanillaOverride from "#src/world/data/item-families/minecraft.json" with { type: "json" };
import { itemTagsOf } from "#src/world/item-tags.ts";

const VANILLA_VERSION = "1.21.4";

/**
 * The families a 1.21.4 server's stack of `name` reports (`pickaxe`, `boat`...): the shipped item tags through the family
 * map, plus the vanilla override, as `src/world/item-families.ts` resolves them for a bot with no server tags yet (the
 * `food` family, which needs the registry, is left out). Test fixtures use it for the stacks the runtime would label.
 */
export function vanillaItemFamilies(name: string): string[] {
  const tags = itemTagsOf(name, VANILLA_VERSION);
  const added: Readonly<Record<string, readonly string[]>> = vanillaOverride.families;
  return Object.entries(familyMap.item as Record<string, readonly string[]>)
    .filter(([family, familyTags]) => familyTags.some((tag) => tags.includes(tag)) || added[family]?.includes(name) === true)
    .map(([family]) => family)
    .sort();
}
