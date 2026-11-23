// One cell of a structure to build, and whether a block or a placement face gives it its asked states.
import type { WorldBlock } from "../../../world/index.js";
import type { BlockPosition } from "../../index.js";
import { facingVector, type HorizontalFacing } from "../../../world/facing.js";
import type { BlockAxis, BlockHalf } from "../../../world/block-states.js";

import { DIG_CLEAR_BLOCK } from "../../../world/dig-clear.js";

/** Whether the request asks this cell dug clear, not a block placed. */
export function digsClear(cell: Pick<BuildCell, "blockName">): boolean {
  return cell.blockName === DIG_CLEAR_BLOCK;
}

export interface BuildCell {
  readonly position: BlockPosition;
  readonly blockName: string;
  /**
   * The facing an oriented block must have. Minecraft gives a door or stairs the
   * placing player's facing, so the bot looks that way while placing it; the
   * same block facing elsewhere is a wrong block. A door hung sideways in a
   * wall swings its open panel across the doorway, and navigation, which
   * passes an open door from any side, walked into it for good.
   */
  readonly facing?: HorizontalFacing;
  /** The upper or lower half of stairs, a slab (its `type`) or a trapdoor, set by where the side face is clicked. */
  readonly half?: BlockHalf;
  /** The axis of a log or pillar, set by the face it is placed against. */
  readonly axis?: BlockAxis;
}

/**
 * Whether placing against this face (pointing from the support into the cell) can give the cell its asked states
 * (ADR-013): an axis comes from the face's own axis; a top half never rests on the block below, a bottom half never
 * hangs from the block above, and a side face takes either half from where it is clicked. A block that clings
 * (`clings`, a ladder: `clingsBehindFacing`) is placed against the face behind its facing only, the face that points
 * the way it faces: the server refuses its click on any other.
 */
export function faceFits(face: { readonly x: number; readonly y: number; readonly z: number }, cell: Pick<BuildCell, "facing" | "half" | "axis">, clings = false): boolean {
  if (clings && cell.facing !== undefined) {
    const way = facingVector(cell.facing);
    if (face.x !== way.x || face.y !== way.y || face.z !== way.z) return false;
  }
  if (cell.axis !== undefined && (cell.axis === "x" ? face.x : cell.axis === "y" ? face.y : face.z) === 0) return false;
  if (cell.half === "top" && face.y > 0) return false;
  if (cell.half === "bottom" && face.y < 0) return false;
  return true;
}

/** The states a block has, in the cell's terms: a slab's `type` is its half. */
function statesOf(block: WorldBlock): { readonly facing: unknown; readonly half: unknown; readonly axis: unknown } {
  const properties = block.getProperties() as Readonly<Record<string, unknown>>;
  return { facing: properties.facing, half: properties.half ?? properties.type, axis: properties.axis };
}

/**
 * Whether `block` is what `cell` asks for: its block, in every state the cell asks (ADR-013), any other state free. A
 * state the block has no property for cannot differ (planks asked an `axis`: the cell never counted as right, house
 * templates Task 7b); the same block name has the same properties, so an absent one is the block kind's, not a wrong state.
 */
export function holdsCell(block: WorldBlock, cell: BuildCell): boolean {
  if (block.name !== cell.blockName) return false;
  if (cell.facing === undefined && cell.half === undefined && cell.axis === undefined) return true;
  const states = statesOf(block);
  return (cell.facing === undefined || states.facing === undefined || states.facing === cell.facing) &&
    (cell.half === undefined || states.half === undefined || states.half === cell.half) &&
    (cell.axis === undefined || states.axis === undefined || states.axis === cell.axis);
}

/** A block for the audit: its name, and the states the cell asks about, as they are. */
export function described(block: WorldBlock, cell: BuildCell): string {
  const states = statesOf(block);
  const shown = [
    cell.facing !== undefined && typeof states.facing === "string" ? `facing ${states.facing}` : null,
    cell.half !== undefined && typeof states.half === "string" ? states.half : null,
    cell.axis !== undefined && typeof states.axis === "string" ? `along ${states.axis}` : null,
  ].filter((part): part is string => part !== null);
  return [block.name, ...shown].join(" ");
}
