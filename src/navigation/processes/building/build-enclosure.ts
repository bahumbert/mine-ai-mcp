/**
 * Where a build's bot stands and whether it would be shut in: the feet cell as navigation counts it, which blocks a bot cannot
 * walk through, and the flood fill that tells a structure's last block from a seal. Moved out of `build-process.ts` with
 * its behaviour unchanged.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { asVec3 } from "../../../utils/index.js";
import type { WorldBlock } from "../../../world/index.js";
import { clingsBehindFacing } from "../../../world/block-states.js";
import { packKey, type BlockPosition } from "../../index.js";
import { navigationFeet } from "../../world/block-geometry.js";
import type { BuildCell } from "./build-cell.js";

/**
 * How far a flood fill looks for open ground before calling the bot sealed in.
 * Three blocks beyond the structure is past any wall it could be asked to
 * close, so a doorway or an open top lets the fill out.
 */
const ENCLOSURE_MARGIN = 3;

const NEIGHBOURS = [
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 1, 0),
  new Vec3(0, -1, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
] as const;

export const keyOf = (position: BlockPosition) => packKey(position.x, position.y, position.z);
export const isSolid = (block: WorldBlock | null): boolean => block?.boundingBox === "block";
/**
 * Whether a bot cannot walk through this block's cell. A ladder reads "block" in the registry yet is climbed through:
 * taking it for a wall sealed in every bot standing on one (house-templates scenario saltbox: the roof call ran 290 s,
 * stepping out and back in for every placement).
 */
export const obstructs = (bot: Bot, block: WorldBlock | null): boolean => isSolid(block) && !clingsBehindFacing(bot.registry, block!.name);

/**
 * The cell the bot's feet are in, as navigation counts it: standing on a floor lower than a full block (farmland,
 * soul sand, mud), the floored position is the floor block itself (live 2026-10-03: on farmland at y 75.94, a water
 * cell beside her read as sealing her in).
 */
export function feetOf(bot: Bot): Vec3 {
  return asVec3(navigationFeet(bot.entity.position, bot.entity.onGround === true));
}

/**
 * Whether the bot's feet would be sealed in once `filled` holds blocks: a
 * flood fill through passable cells from the feet that never reaches beyond
 * the structure's surroundings. The world's own blocks bound the fill too, so
 * a floor under a roofed box counts, and a doorway lets the fill out.
 */
export function enclosesBot(
  bot: Bot,
  feet: Vec3,
  filled: ReadonlySet<number>,
  bounds: { readonly min: Vec3; readonly max: Vec3 },
): boolean {
  const min = bounds.min.offset(-ENCLOSURE_MARGIN, -ENCLOSURE_MARGIN, -ENCLOSURE_MARGIN);
  const max = bounds.max.offset(ENCLOSURE_MARGIN, ENCLOSURE_MARGIN, ENCLOSURE_MARGIN);
  const blocked = (position: Vec3) => filled.has(keyOf(position)) || obstructs(bot, bot.blockAt(position));
  if (blocked(feet)) return true;
  const seen = new Set<number>([keyOf(feet)]);
  const queue = [feet];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const step of NEIGHBOURS) {
      const next = current.plus(step);
      if (next.x < min.x || next.y < min.y || next.z < min.z || next.x > max.x || next.y > max.y || next.z > max.z) {
        return false;
      }
      const key = keyOf(next);
      if (seen.has(key) || blocked(next)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return true;
}

export function boundsOf(cells: readonly BuildCell[]): { min: Vec3; max: Vec3 } {
  const min = new Vec3(Infinity, Infinity, Infinity);
  const max = new Vec3(-Infinity, -Infinity, -Infinity);
  for (const { position } of cells) {
    min.set(Math.min(min.x, position.x), Math.min(min.y, position.y), Math.min(min.z, position.z));
    max.set(Math.max(max.x, position.x), Math.max(max.y, position.y), Math.max(max.z, position.z));
  }
  return { min, max };
}
