/** The game's tags of each shipped version, turned into "which tags hold this id" lookups (block tags, item tags). */
import { nearestShipped } from "./shipped-data.js";

/** One shipped tag file: every tag of a version, each with its ids. */
export interface TagsData {
  readonly version: string;
  /** Ids by tag name, each list sorted. */
  readonly tags: Readonly<Record<string, readonly string[]>>;
}

/** The tags that hold each id of one version, each list sorted. */
function reverseIndex(data: TagsData): ReadonlyMap<string, readonly string[]> {
  const built = new Map<string, string[]>();
  for (const [tag, ids] of Object.entries(data.tags)) {
    for (const member of ids) built.set(member, [...(built.get(member) ?? []), tag]);
  }
  for (const list of built.values()) list.sort();
  return built;
}

/**
 * A lookup over `shipped`: every tag an id belongs to in `version` (its own data, else the nearest older shipped one),
 * sorted; none when the id is unknown or no data covers the version. The reverse index of a version is built once.
 */
export function tagLookup(shipped: readonly TagsData[]): (id: string, version: string) => readonly string[] {
  const byVersion = new Map<string, ReadonlyMap<string, readonly string[]>>();
  return (id, version) => {
    const data = nearestShipped(version, shipped);
    if (data === null) return [];
    let index = byVersion.get(data.version);
    if (index === undefined) {
      index = reverseIndex(data);
      byVersion.set(data.version, index);
    }
    return index.get(id) ?? [];
  };
}
