/**
 * The workstation blocks the game's code ties to a recipe kind: no data file says which block crafts or cooks.
 *
 * Code-only facts, named once here (owner 2026-10-19, Java-only names): a recipe kind has its own station and the
 * registry lists blocks without saying which recipe kind a block serves.
 */

/** The block (and item) a crafting recipe needing a table is made at. */
export const CRAFTING_STATION = "crafting_table" as const;

/** The block (and item) a smelting recipe is cooked in. */
export const SMELTING_STATION = "furnace" as const;
