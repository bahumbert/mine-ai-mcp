/**
 * Block states a build may ask for besides `facing` (ADR-013). Minecraft derives each one from how a player places the
 * block: the half from where the clicked face is hit, the axis from which face is clicked.
 */

/** Stairs and trapdoors call it `half`; slabs call it `type` (and add `double`, which a build never asks for). */
export const BLOCK_HALVES = ["top", "bottom"] as const;
export type BlockHalf = (typeof BLOCK_HALVES)[number];

/** Logs, pillars and other blocks with an `axis` lie along the axis of the face they were placed against. */
export const BLOCK_AXES = ["x", "y", "z"] as const;
export type BlockAxis = (typeof BLOCK_AXES)[number];
