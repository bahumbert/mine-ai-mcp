/** How many letters a name may be off (added, dropped or changed) and still count as close. */
const MAX_EDITS = 2;

/** Ranks the names a letter or two off (score: base + edit count) below all names of the same kind. */
const NEAR_BASE = 1000;

/**
 * Registry names close to an unknown `name`, closest first, at most `limit`: the names holding all its words
 * ("wool": red_wool, ..., "hoe": wooden_hoe, ...), then those of the
 * same kind, i.e. sharing its last word, nearest spelling first ("oak_sword": wooden_sword, stone_sword, ...: a model
 * slips on the material far more often than on the kind), then those a letter or two off ("sticks": stick).
 */
export function similarNames(name: string, names: Iterable<string>, limit = 5): string[] {
  const words = name.split("_");
  const kind = words[words.length - 1]!;
  const close: { readonly name: string; readonly score: number }[] = [];
  for (const candidate of names) {
    const parts = candidate.split("_");
    let score: number | null;
    if (words.every((word) => parts.includes(word))) score = 0;
    else if (parts[parts.length - 1] === kind) score = 1 + editCount(name, candidate);
    else score = editCount(name, candidate) <= MAX_EDITS ? NEAR_BASE + editCount(name, candidate) : null;
    if (score !== null) close.push({ name: candidate, score });
  }
  return close
    .sort((left, right) => left.score - right.score || left.name.length - right.name.length || left.name.localeCompare(right.name))
    .slice(0, limit)
    .map((entry) => entry.name);
}

/** `name`, followed by the registry names close to it when there are any: "sticks (closest: stick)". */
export function withSimilar(name: string, names: Iterable<string>): string {
  const close = similarNames(name, names);
  return close.length === 0 ? name : `${name} (closest: ${close.join(", ")})`;
}

/** The edit distance between two names. */
function editCount(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const row = [i];
    for (let j = 1; j <= right.length; j++) {
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[right.length]!;
}
