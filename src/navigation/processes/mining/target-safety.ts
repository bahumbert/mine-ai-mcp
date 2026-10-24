/**
 * May the mine process remove this target, and what must it do first?
 *
 * The movement policy answers "may the route break this block in passing?" and
 * its answer stays no wherever liquid would follow the route in — that is
 * Baritone's `avoidBreaking`, and a route opening a wall into lava while
 * walking is the failure it exists to prevent.
 *
 * A target break is a different question: "can the process make this break
 * safe, then make it?" Baritone never asks it — `MineProcess` prunes ore
 * locations with the same flood rule, so it cannot mine obsidian beside a lava
 * source either, and its users mine obsidian by hand. The departure is ours,
 * on purpose, and it lives here rather than in the policy:
 *
 * - Flowing water beside or above a target requires preparation too. The mine process
 *   removes reachable feeding sources or closes local water faces before the
 *   break. A route's lava avoidance cannot protect a stationary dig from drift.
 * - Lava is closed before the break. Each lava neighbour takes one carried
 *   block, which vanilla lets a placement put into a fluid cell, source
 *   included. A drop that would fall down an open column into lava gets a
 *   floor placed under the target first.
 * - A target with more closures than available building blocks is not
 *   mineable. The caller supplies that budget after reserving collection items.
 *
 * Collect-block's own lateral-lava refusal and its falling-column check are
 * folded in here, so there is one rule in one place.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { plausibleToBreak } from "../../../world/block-classification.js";
import { waterMiningStance } from "../../world/water.js";
import { isDryAir, isLava } from "../../world/block-geometry.js";
import { liveBlockReader } from "../../mineflayer/world.js";
import { MAXIMUM_BUCKET_DROP } from "../../mineflayer/movement-policy.js";
import {
  observeMineflayerBlock,
  type BlockPosition,
  type MineflayerBlock,
  type MovementPolicy,
  type WorldView,
} from "../../index.js";

/** The six cells that can pour into a mined one, or drop into it. */
const NEIGHBOURS = [
  new Vec3(0, 1, 0),
  new Vec3(0, -1, 0),
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
] as const;

export type MineTargetDecision =
  | {
      readonly kind: "mineable";
      /**
       * Whether a route may break this target on its way into the cell. False
       * when liquid touches it: the route refuses such a break, so the process
       * walks into reach, closes the lava with `lavaFacesOf` read again from
       * the live world, and breaks it in place.
       */
      readonly routeMayBreak: boolean;
    }
  | { readonly kind: "prohibited"; readonly reason: string };

/** Every neighbouring cell of `position` that holds lava right now. */
export function lavaFacesOf(bot: Bot, position: BlockPosition): BlockPosition[] {
  const centre = new Vec3(position.x, position.y, position.z);
  return NEIGHBOURS.map((offset) => centre.plus(offset)).filter((cell) => bot.blockAt(cell, false)?.name === "lava");
}

/** How far down an open column the target's drop is followed. */
const DROP_FALL_DEPTH = 24;

/**
 * The cell under the target that needs a block so its drop cannot fall into
 * lava further down an open column. Lava directly below is already a face.
 * Water ends the fall because items float in it, and anything with collision
 * catches the drop.
 */
function dropFloorOf(bot: Bot, position: BlockPosition): BlockPosition | null {
  const read = liveBlockReader(bot);
  for (let depth = 2; depth <= DROP_FALL_DEPTH + 1; depth++) {
    const above = read(position.x, position.y - depth + 1, position.z);
    if (!isDryAir(above)) return null;
    const block = read(position.x, position.y - depth, position.z);
    if (isLava(block)) return { x: position.x, y: position.y - 1, z: position.z };
  }
  return null;
}

/**
 * Every cell that must hold a block before the target comes out: its lava
 * faces, which would flood the mined cell, and a floor when its drop would
 * otherwise fall down an open column into lava.
 */
export function lavaClosuresOf(bot: Bot, position: BlockPosition): BlockPosition[] {
  const closures = lavaFacesOf(bot, position).map(({ x, y, z }) => ({ x, y, z }));
  const floor = dropFloorOf(bot, position);
  return floor === null ? closures : [...closures, floor];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Whether a stack of sand or gravel above the target can come down safely.
 *
 * Baritone prices such a column into the mining cost and mines through it. The
 * one case worth refusing is a stack whose own break the policy prohibits,
 * because then the column stays where it is and the target is never exposed.
 */
function fallingColumnStop(
  bot: Bot,
  movements: MovementPolicy,
  position: BlockPosition,
  world: WorldView,
): string | null {
  for (let above = new Vec3(position.x, position.y + 1, position.z); ; above = above.offset(0, 1, 0)) {
    const block = bot.blockAt(above, false);
    if (!block) return "the column above the target is not loaded";
    const observation = observeMineflayerBlock(block);
    if (!observation.traits.falling) return null;
    const cell = { x: above.x, y: above.y, z: above.z };
    if (movements.evaluateBreak(observation, cell, world).decision.kind === "prohibited") {
      return `a ${block.name} resting on the target cannot be broken`;
    }
  }
}

/**
 * Whether the block is a walkway in the air: something to stand on, with nothing under it for more blocks than a fall
 * is safe from and no deep water to land in. A bridge or a pillar the bot built is one, and mining it strands the bot
 * (live 2026-10-10: Lena mined the blocks of her own bridge over a 23-block drop). A natural ceiling is not (solid above).
 */
export function isWalkwayOverDrop(movements: MovementPolicy, world: WorldView, position: BlockPosition): boolean {
  const open = (y: number) => {
    const block = world.blockAt(position.x, y, position.z);
    return block.kind === "loaded" && block.traits.empty && block.traits.liquid === null;
  };
  if (!open(position.y + 1)) return false;
  let depth = 0;
  for (let y = position.y - 1; open(y); y -= 1) {
    depth += 1;
    if (depth > MAXIMUM_BUCKET_DROP) return true;
  }
  if (depth <= movements.maximumDrop) return false;
  const landing = world.blockAt(position.x, position.y - 1 - depth, position.z);
  const below = world.blockAt(position.x, position.y - 2 - depth, position.z);
  const deepWater = (block: typeof landing) => block.kind === "loaded" && block.traits.liquid === "water";
  return !(deepWater(landing) && deepWater(below));
}

/**
 * Whether the bot stands on the block at `position`, on the ground or dry. Such a block is a fine target but its top cell
 * is no stance to work it from: the scan excludes that stance and the route steps off (a wader breaking it in place
 * would let the water into the hole). A swimmer afloat over a submerged block keeps the top stance, the one water
 * work uses (`sealAndBreakInReach` lets a floating body dig).
 */
export function standsOnBlock(bot: Bot, position: BlockPosition): boolean {
  const feet = bot.entity.position;
  const floating = Reflect.get(bot.entity, "isInWater") === true && !bot.entity.onGround;
  return (
    !floating &&
    position.x === Math.floor(feet.x) &&
    position.z === Math.floor(feet.z) &&
    position.y === Math.ceil(feet.y) - 1
  );
}

/**
 * The mine process's one target rule. Callers hand it a loaded matching block;
 * it answers whether the block can come out with the available placement
 * budget, and what has to happen first.
 */
export function evaluateMineTarget(
  bot: Bot,
  movements: MovementPolicy,
  block: MineflayerBlock,
  world: WorldView,
  availableBlocks: number,
): MineTargetDecision {
  if (!plausibleToBreak(block)) return { kind: "prohibited", reason: `${block.name} cannot be broken at all` };
  const position = { x: block.position.x, y: block.position.y, z: block.position.z };
  // Never a walkway the bot built over a drop. The block under its feet is a question of stance (`standsOnBlock`).
  if (isWalkwayOverDrop(movements, world, position)) {
    return { kind: "prohibited", reason: "a walkway over a drop: mining it would strand the bot" };
  }
  const evaluation = movements.evaluateBreak(observeMineflayerBlock(block), position, world);
  const decision = evaluation.decision;
  const floodRule = decision.kind === "prohibited" && decision.cause === "opens_into_liquid";
  if (decision.kind === "prohibited" && !floodRule) return { kind: "prohibited", reason: decision.reason };
  const below = world.blockAt(position.x, position.y - 1, position.z);
  const needsIsolation = floodRule || (below.kind === "loaded" && below.traits.liquid === "water");

  const lavaFaces = lavaFacesOf(bot, position).length;
  const closures = lavaClosuresOf(bot, position).length;
  if (closures > availableBlocks) {
    const floor = closures > lavaFaces ? "a floor over lava" : null;
    const needed = lavaFaces === 0 ? floor : floor === null ? plural(lavaFaces, "lava face")
      : `${plural(lavaFaces, "lava face")} and ${floor}`;
    return {
      kind: "prohibited",
      reason: `${needed}, ${plural(availableBlocks, "block")} available for placement`,
    };
  }
  // A swimmer may still need to settle, and a shore miner can approach a
  // submerged target through its open water column. Neither needs to flood
  // a dry stance; physical work still checks the actual stance and air.
  if (needsIsolation && availableBlocks === 0 && !bot.inventory.items().some((item) => item.name === "bucket") &&
    Reflect.get(bot.entity, "isInWater") !== true &&
    !waterMiningStance((x, y, z) => world.blockAt(x, y, z), { ...position, y: position.y + 1 }, true)) {
    return { kind: "prohibited", reason: "liquid isolation needs a permitted building block or an empty bucket" };
  }
  const falling = fallingColumnStop(bot, movements, position, world);
  if (falling !== null) return { kind: "prohibited", reason: falling };
  return { kind: "mineable", routeMayBreak: !needsIsolation && closures === 0 };
}
