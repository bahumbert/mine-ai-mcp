/** Whether a block is a storage container that belongs to its location (not a held item): the kinds `use_container` opens. */
export function isLocationOwnedContainer(blockName: string): boolean {
  return (
    blockName === "chest" ||
    blockName === "trapped_chest" ||
    blockName === "barrel" ||
    blockName === "hopper" ||
    blockName === "dropper" ||
    blockName === "dispenser" ||
    blockName.endsWith("_shulker_box")
  );
}
