/** How many letters a name may be off (added, dropped or changed) and still count as close. */
const MAX_EDITS = 2;

/**
 * Registry names close to an unknown `name`, closest first, at most `limit`: the names holding all its words
 * ("wool": red_wool, ..., "planks": oak_planks), then those a letter or two off ("sticks": stick). A model's
 * slips are of these kinds; anything farther is no guess worth offering.
 */
export function similarNames(name: string, names: Iterable<string>, limit = 5): string[] {
  const words = name.split("_");
  const close: { readonly name: string; readonly score: number }[] = [];
  for (const candidate of names) {
    const parts = candidate.split("_");
    const score = words.every((word) => parts.includes(word)) ? 0 : editsWithin(name, candidate, MAX_EDITS);
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

/** The edit distance between two names when it is at most `max` (1 or more); null when it is more. */
function editsWithin(left: string, right: string, max: number): number | null {
  if (Math.abs(left.length - right.length) > max) return null;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const row = [i];
    for (let j = 1; j <= right.length; j++) {
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  const edits = previous[right.length]!;
  return edits <= max ? edits : null;
}
