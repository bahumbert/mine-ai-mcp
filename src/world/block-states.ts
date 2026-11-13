/**
 * Block states a build may ask for besides `facing` (ADR-013). Minecraft derives each one from how a player places the
 * block: the half from where the clicked face is hit, the axis from which face is clicked.
 */

import type { IndexedData } from "minecraft-data";
import { facingVector, HORIZONTAL_FACINGS, type HorizontalFacing } from "./facing.js";

/** Whether `box` is a plate spanning the cell but its thickness along `facing`'s axis, flush with the face behind `facing`. */
function isPlateBehind(box: readonly number[], facing: HorizontalFacing): boolean {
  const way = facingVector(facing);
  const axis = way.x !== 0 ? 0 : 2;
  const sign = way.x !== 0 ? way.x : way.z;
  const [lo, hi] = [box[axis]!, box[axis + 3]!];
  const flush = sign < 0 ? lo > 0 && hi === 1 : lo === 0 && hi < 1;
  return flush && [0, 1, 2].filter((index) => index !== axis).every((index) => box[index] === 0 && box[index + 3] === 1);
}

const clingingByRegistry = new WeakMap<IndexedData, Map<string, boolean>>();

/**
 * Whether the block clings to the face behind its `facing` (a ladder): its horizontal `facing` is the face it was placed
 * against, and in every state of one facing its collision is the one thin plate flush with the cell's face behind it
 * (a door or trapdoor changes shape with `open` or `half`, stairs and gates are no plate). Read from the registry's
 * collision shapes, no list of names; a clinging block with no collision (torch, sign) is not seen. The server refuses
 * the click of such a block on any other face (house-templates scenarios, pagoda-house: "Server processed placement,
 * but block ... is still air"). `brain/src/building/support.ts` keeps a copy; `face-fits-agree.test.ts` keeps them one.
 */
export function clingsBehindFacing(registry: IndexedData, block: string): boolean {
  const known = clingingByRegistry.get(registry) ?? new Map<string, boolean>();
  clingingByRegistry.set(registry, known);
  const cached = known.get(block);
  if (cached !== undefined) return cached;
  const clings = computeClings(registry, block);
  known.set(block, clings);
  return clings;
}

function computeClings(registry: IndexedData, block: string): boolean {
  const states = registry.blocksByName[block]?.states ?? [];
  const facingIndex = states.findIndex((state) => state.name === "facing");
  const values = states[facingIndex]?.values;
  if (values === undefined || values.length !== HORIZONTAL_FACINGS.length || !HORIZONTAL_FACINGS.every((name) => values.includes(name))) return false;
  const reference = registry.blockCollisionShapes.blocks[block];
  if (reference === undefined) return false;
  const shapeIds = Array.isArray(reference) ? reference : [reference];
  // State ids run through the properties in order, the last one fastest: the facing changes every `stride` states.
  const stride = states.slice(facingIndex + 1).reduce((product, state) => product * (state.num_values ?? 1), 1);
  return HORIZONTAL_FACINGS.every((name) => {
    const index = values.indexOf(name);
    const shapes = new Set(shapeIds.filter((_, stateIndex) => Math.floor(stateIndex / stride) % values.length === index));
    const [only] = [...shapes];
    const boxes = only === undefined ? undefined : registry.blockCollisionShapes.shapes[only];
    return shapes.size === 1 && boxes?.length === 1 && isPlateBehind(boxes[0]!, name);
  });
}

/** Stairs and trapdoors call it `half`; slabs call it `type` (and add `double`, which a build never asks for). */
export const BLOCK_HALVES = ["top", "bottom"] as const;
export type BlockHalf = (typeof BLOCK_HALVES)[number];

/** Logs, pillars and other blocks with an `axis` lie along the axis of the face they were placed against. */
export const BLOCK_AXES = ["x", "y", "z"] as const;
export type BlockAxis = (typeof BLOCK_AXES)[number];
