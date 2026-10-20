/**
 * The game's block tags (`logs`, `mineable/pickaxe`, `crops`...): each supported version's tags, generated from its
 * server jar by `block-tags-extract.ts` (see `data/block-tags/`). A tag is the game's own grouping of blocks, so a
 * question such as "is this a log" is answered for every wood, nether stems included, without a list of names.
 */
import tags_1_21_4 from "./data/block-tags/1.21.4.json" with { type: "json" };
import { nearestShipped } from "./shipped-data.js";

interface BlockTagsData {
  readonly version: string;
  /** Block ids by tag name, each list sorted. */
  readonly tags: Readonly<Record<string, readonly string[]>>;
}

/** Shipped data files, by version. Add a file with `block-tags-extract.ts`, then list it here. */
const SHIPPED: readonly BlockTagsData[] = [tags_1_21_4];

const byBlock = new Map<string, ReadonlyMap<string, readonly string[]>>();

/** Every tag `block` belongs to in `version` (its own data, else the nearest older shipped one), sorted; none when unknown. */
export function tagsOf(block: string, version: string): readonly string[] {
  const data = nearestShipped(version, SHIPPED);
  if (data === null) return [];
  let index = byBlock.get(data.version);
  if (index === undefined) {
    const built = new Map<string, string[]>();
    for (const [tag, blocks] of Object.entries(data.tags)) {
      for (const name of blocks) {
        const list = built.get(name);
        if (list === undefined) built.set(name, [tag]);
        else list.push(tag);
      }
    }
    for (const list of built.values()) list.sort();
    index = built;
    byBlock.set(data.version, index);
  }
  return index.get(block) ?? [];
}

/** Every block tag `version` has (its own data, else the nearest shipped one), sorted; none when no data is shipped. */
export function tagNamesOf(version: string): readonly string[] {
  return Object.keys(nearestShipped(version, SHIPPED)?.tags ?? {}).sort();
}
