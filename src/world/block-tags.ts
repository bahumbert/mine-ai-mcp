/**
 * The game's block tags (`logs`, `mineable/pickaxe`, `crops`...): each supported version's tags, generated from its
 * server jar by `block-tags-extract.ts` (see `data/block-tags/`). A tag is the game's own grouping of blocks, so a
 * question such as "is this a log" is answered for every wood, nether stems included, without a list of names.
 */
import tags_1_21_4 from "./data/block-tags/1.21.4.json" with { type: "json" };
import { nearestShipped } from "./shipped-data.js";
import { tagLookup, type TagsData } from "./tag-index.js";

/** Shipped data files, by version. Add a file with `block-tags-extract.ts`, then list it here. */
const SHIPPED: readonly TagsData[] = [tags_1_21_4];

const lookup = tagLookup(SHIPPED);

/** Every tag `block` belongs to in `version` (its own data, else the nearest older shipped one), sorted; none when unknown. */
export function tagsOf(block: string, version: string): readonly string[] {
  return lookup(block, version);
}

/** Every block tag `version` has (its own data, else the nearest shipped one), sorted; none when no data is shipped. */
export function tagNamesOf(version: string): readonly string[] {
  return Object.keys(nearestShipped(version, SHIPPED)?.tags ?? {}).sort();
}
