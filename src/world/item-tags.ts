/**
 * The game's item tags (`logs_that_burn`, `planks`, `wooden_slabs`, `non_flammable_wood`...): each supported version's
 * tags, generated from its server jar by `item-tags-extract.ts` (see `data/item-tags/`). The game keys its fuels on
 * these tags, so "is this a wooden slab" is answered for every wood without a list of names.
 */
import tags_1_21_4 from "./data/item-tags/1.21.4.json" with { type: "json" };
import { tagLookup, type TagsData } from "./tag-index.js";

/** Shipped data files, by version. Add a file with `item-tags-extract.ts`, then list it here. */
const SHIPPED: readonly TagsData[] = [tags_1_21_4];

const lookup = tagLookup(SHIPPED);

/** Every item tag `item` belongs to in `version` (its own data, else the nearest older shipped one), sorted; none when unknown. */
export function itemTagsOf(item: string, version: string): readonly string[] {
  return lookup(item, version);
}
