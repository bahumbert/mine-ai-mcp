// What tells two stacks of one item apart. A 1.21.4 item carries its custom name, enchantments and damage in
// `components` and `removedComponents` and leaves `nbt` null (prismarine-item `index.js:149-163`, contract check
// `item-variant-components`), so `nbt` or `Item.equal` alone call a renamed and a plain stack one.

/** What Prismarine's declarations say an item has; `components` and `removedComponents` are read at runtime (`itemVariantKey`). */
export interface ItemVariantFields {
  readonly type: number;
  readonly metadata: number;
  readonly nbt?: unknown;
}

/** A component entry's `type` as the sort key (an entry without one sorts by its text). */
function entryOrder(entry: unknown): string {
  const type = typeof entry === "object" && entry !== null ? Reflect.get(entry, "type") : undefined;
  return type === undefined ? JSON.stringify(entry, bigintAsText) : String(type);
}

/** A component list sorted by type, the order the server happens to send them in being no part of the variant; a missing list reads as empty. */
function sortedEntries(item: ItemVariantFields, field: "components" | "removedComponents"): unknown[] {
  const list: unknown = Reflect.get(item, field);
  return Array.isArray(list) ? [...list].sort((left, right) => entryOrder(left).localeCompare(entryOrder(right))) : [];
}

/** A `JSON.stringify` replacer for NBT longs, which Prismarine reads as `bigint`. */
function bigintAsText(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value}n` : value;
}

/**
 * The text two stacks share exactly when the game may merge them: the item, its metadata, its components (sorted by
 * type), the components it has removed and its `nbt` (kept, so a pre-1.20.5 item still tells its variants apart).
 * Counts and slots are no part of it.
 */
export function itemVariantKey(item: ItemVariantFields): string {
  return JSON.stringify([item.type, item.metadata, sortedEntries(item, "components"), sortedEntries(item, "removedComponents"), item.nbt ?? null], bigintAsText);
}

/** Whether the game would merge two stacks of these items (same item, same variant), whatever their counts. */
export function sameItemVariant(left: ItemVariantFields, right: ItemVariantFields): boolean {
  return itemVariantKey(left) === itemVariantKey(right);
}
