import type { FamilyIndex } from "./item-families.js";

/**
 * Whether a block is a storage container that belongs to its location (not a held item): the kinds `use_container`
 * opens, read from the block family `container` of the server's tags (a plain shulker box is one, spec P4-17 B5).
 */
export function isLocationOwnedContainer(index: FamilyIndex, blockName: string): boolean {
  return index.blockFamilies(blockName).includes("container");
}
