/**
 * The game's entity tags (`arrows`, `undead`, `skeletons`...): each supported version's tags, generated from its server
 * jar by `entity-tags-extract.ts` (see `data/entity-tags/`). The game groups entity types the way it groups items and
 * blocks, so "is this an arrow entity" is answered by the tag, not by a list of names.
 */
import tags_1_19_4 from "./data/entity-tags/1.19.4.json" with { type: "json" };
import tags_1_20_1 from "./data/entity-tags/1.20.1.json" with { type: "json" };
import tags_1_20_4 from "./data/entity-tags/1.20.4.json" with { type: "json" };
import tags_1_20_6 from "./data/entity-tags/1.20.6.json" with { type: "json" };
import tags_1_21_1 from "./data/entity-tags/1.21.1.json" with { type: "json" };
import tags_1_21_4 from "./data/entity-tags/1.21.4.json" with { type: "json" };
import { tagLookup, type TagsData } from "./tag-index.js";

/** Shipped data files, by version. Add a file with `entity-tags-extract.ts`, then list it here. */
const SHIPPED: readonly TagsData[] = [tags_1_19_4, tags_1_20_1, tags_1_20_4, tags_1_20_6, tags_1_21_1, tags_1_21_4];

const lookup = tagLookup(SHIPPED);

/** Every entity tag `entity` belongs to in `version` (its own data, else the nearest older shipped one), sorted; none when unknown. */
export function entityTagsOf(entity: string, version: string): readonly string[] {
  return lookup(entity, version);
}
