import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { BreakBlockInPlace } from "../../navigation/execution/in-place-break.js";
import type { MovementPolicy } from "../../navigation/movements/policy.js";
import { preferredScaffoldItem } from "../../navigation/mineflayer/movement-policy.js";
import { observeMineflayerBlock } from "../../navigation/mineflayer/world.js";
import type { BlockPosition } from "../../navigation/world/world.js";
import { waitForSignal } from "../../utils/signals.js";
import type { ActionContext } from "../action.js";
import type { DroppedItem, HoleClosure } from "./contract.js";
import { type InventoryItem, type placeSolidBlockInto } from "../../world/placement.js";
import { PLAYER_HALF_WIDTH } from "../../world/player-physics.js";
import { droppedItemName } from "../../world/item-pickup.js";
import { protectedRegionAt, readProtectedRegions } from "../../world/protected-regions.js";

const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export class DisposalHoleError extends Error {}

/** Full dry walls retain the discards and exclude liquid or a cave opening. */
function wall(bot: Bot, position: Vec3): boolean {
  const block = bot.blockAt(position);
  if (!block) return false;
  const { traits, geometry } = observeMineflayerBlock(block);
  return geometry.fullCube && geometry.safeSupport && !traits.waterlogged && !traits.falling;
}

function air(bot: Bot, position: Vec3): boolean {
  const block = bot.blockAt(position);
  return block !== null && ["air", "cave_air", "void_air"].includes(block.name);
}

function enclosed(bot: Bot, bottom: Vec3): boolean {
  return (
    wall(bot, bottom.offset(0, -1, 0)) &&
    SIDES.every(([dx, dz]) => wall(bot, bottom.offset(dx, 0, dz)) && wall(bot, bottom.offset(dx, 1, dz)))
  );
}

/** Opening a wall must not admit a fluid or a falling block from outside the pit. */
function dryOpening(bot: Bot, bottom: Vec3): boolean {
  return [2, 3].every((height) =>
    [...SIDES.map(([x, z]) => bottom.offset(x, height, z)), bottom.offset(0, height + 1, 0)].every((position) => {
      const block = bot.blockAt(position);
      if (!block) return false;
      const { traits } = observeMineflayerBlock(block);
      return traits.liquid === null && !traits.waterlogged && !traits.falling;
    }),
  );
}

/** How far from the bot a stance with a fit pit is looked for, in blocks. */
export const HOLE_SEARCH_RADIUS = 8;

const openingCells = (cell: Vec3) => [cell.offset(0, 3, 0), cell.offset(0, 2, 0), cell.offset(0, 1, 0), cell];

/** No cell of the pit or its opening may lie in a protected region, the bot's own included. */
function inProtectedRegion(bot: Bot, bottom: Vec3): boolean {
  const regions = readProtectedRegions(bot);
  if (regions.length === 0) return false;
  const dimension = bot.game?.dimension ?? "";
  return openingCells(bottom).some((cell) => protectedRegionAt(regions, dimension, cell.x, cell.y, cell.z) !== null);
}

/** How near a dropped item may lie to a pit's cells before the pit counts as already holding discards. */
const PIT_ITEM_REACH = 1.5;

/** Digging into a pit that holds items hands them back to the bot (live 2026-10-10 run 8: buried items came back). */
function holdsDroppedItem(bot: Bot, bottom: Vec3): boolean {
  const centre = bottom.offset(0.5, 0.5, 0.5);
  return Object.values(bot.entities ?? {}).some((entity) => {
    if (droppedItemName(entity) === null) return false;
    return [0, 1].some((up) => entity.position.distanceTo(centre.offset(0, up, 0)) <= PIT_ITEM_REACH);
  });
}

/** The pit beside a stance (its feet cell and the body's exact position), when one of its four cells fits. */
function pitBeside(bot: Bot, feet: Vec3, position: Vec3): Vec3 | null {
  const candidates = SIDES.map(([dx, dz]) => feet.offset(dx, -2, dz))
    // Never remove any ground beneath the body's footprint at a cell edge.
    .filter(
      (cell) =>
        Math.abs(position.x - cell.x - 0.5) >= 0.5 + PLAYER_HALF_WIDTH ||
        Math.abs(position.z - cell.z - 0.5) >= 0.5 + PLAYER_HALF_WIDTH,
    )
    .sort((a, b) => a.offset(0.5, 0, 0.5).distanceTo(position) - b.offset(0.5, 0, 0.5).distanceTo(position));
  return (
    candidates.find((cell) => {
      if (!enclosed(bot, cell) || !dryOpening(bot, cell) || inProtectedRegion(bot, cell) || holdsDroppedItem(bot, cell)) return false;
      return openingCells(cell).every((position) => {
        if (air(bot, position)) return true;
        const block = bot.blockAt(position);
        if (!block || !wall(bot, position)) return false;
        const { traits } = observeMineflayerBlock(block);
        return traits.safeToBreak && !traits.interactive;
      });
    }) ?? null
  );
}

/** Standable full dry ground with free body room, outside every protected region. */
function standable(bot: Bot, feet: Vec3): boolean {
  if (!wall(bot, feet.offset(0, -1, 0)) || !air(bot, feet) || !air(bot, feet.offset(0, 1, 0))) return false;
  return protectedRegionAt(readProtectedRegions(bot), bot.game?.dimension ?? "", feet.x, feet.y, feet.z) === null;
}

/** The nearest other stance within the search radius that has a fit pit beside it. */
function nearestPitStance(bot: Bot): Vec3 | null {
  const origin = bot.entity.position.floored();
  let best: { stance: Vec3; cost: number } | null = null;
  for (let dx = -HOLE_SEARCH_RADIUS; dx <= HOLE_SEARCH_RADIUS; dx++)
    for (let dz = -HOLE_SEARCH_RADIUS; dz <= HOLE_SEARCH_RADIUS; dz++)
      for (const dy of [0, -1, 1, -2, 2]) {
        const cost = Math.hypot(dx, dz) + Math.abs(dy);
        if (Math.hypot(dx, dz) > HOLE_SEARCH_RADIUS || cost === 0 || (best && cost >= best.cost)) continue;
        const stance = origin.offset(dx, dy, dz);
        if (standable(bot, stance) && pitBeside(bot, stance, stance.offset(0.5, 0, 0.5))) best = { stance, cost };
      }
  return best?.stance ?? null;
}

/** The pit a request chose, kept across its attempts so one cut short is dug on instead of a second pit started. */
export interface PitMemory {
  bottom: Vec3 | null;
}

/** The pit's bottom cell for a fresh request: beside the feet when one fits, else beside the nearest fit stance. */
async function choosePit(
  bot: Bot,
  context: ActionContext,
  moveTo?: (stance: Vec3) => Promise<string | undefined>,
): Promise<Vec3> {
  const feet = bot.entity.position.floored();
  const beside =
    bot.entity.onGround && wall(bot, feet.offset(0, -1, 0)) ? pitBeside(bot, feet, bot.entity.position) : null;
  if (beside) return beside;
  const stance = moveTo ? nearestPitStance(bot) : null;
  if (!stance)
    throw new DisposalHoleError(
      `[DROP_HOLE_UNAVAILABLE] No place within ${HOLE_SEARCH_RADIUS} blocks has dry, enclosed ground that can be excavated into a disposal pit outside protected regions.`,
    );
  const failure = await moveTo!(stance);
  context.signal?.throwIfAborted();
  if (failure) throw new DisposalHoleError(`[DROP_HOLE_UNAVAILABLE] Could not walk to a place for the pit: ${failure}`);
  const arrived = pitBeside(bot, bot.entity.position.floored(), bot.entity.position);
  if (!arrived) throw new DisposalHoleError("[DROP_HOLE_CHANGED] The place chosen for the pit no longer fits on arrival.");
  return arrived;
}

/**
 * Walk back beside a pit an earlier attempt chose (a reflex may have moved the body) without judging it again: half
 * dug, it holds the items the digging dropped and no longer passes `pitBeside`.
 */
async function returnToPit(
  bot: Bot,
  bottom: Vec3,
  context: ActionContext,
  moveTo?: (stance: Vec3) => Promise<string | undefined>,
): Promise<Vec3> {
  const stances = SIDES.map(([dx, dz]) => bottom.offset(-dx, 2, -dz)).filter((stance) => standable(bot, stance));
  const here = bot.entity.position.floored();
  if (stances.some((stance) => stance.equals(here)) && bot.entity.onGround) return bottom;
  const nearest = stances.sort((a, b) => a.distanceTo(here) - b.distanceTo(here))[0];
  if (!nearest || !moveTo) throw new DisposalHoleError("[DROP_HOLE_CHANGED] No standable place beside the pit remains.");
  const failure = await moveTo(nearest);
  context.signal?.throwIfAborted();
  if (failure) throw new DisposalHoleError(`[DROP_HOLE_UNAVAILABLE] Could not walk back to the pit: ${failure}`);
  return bottom;
}

/**
 * Make an enclosed pit beside the body, clearing a tunnel wall above it when needed. When none of the four cells
 * beside the feet fits (or the bot is not on dry ground), the nearest stance within `HOLE_SEARCH_RADIUS` blocks that
 * has one is walked to through `moveTo` (which returns a failure reason, or nothing), and the pit is dug there.
 * With a `pit` memory the chosen pit is recorded before the digging starts and, when the memory already holds one,
 * that pit is walked back to and dug on.
 */
export async function prepareDisposalHole(
  bot: Bot,
  movements: MovementPolicy,
  breakInPlace: BreakBlockInPlace,
  context: ActionContext,
  moveTo?: (stance: Vec3) => Promise<string | undefined>,
  pit?: PitMemory,
): Promise<Vec3> {
  const bottom = pit?.bottom ? await returnToPit(bot, pit.bottom, context, moveTo) : await choosePit(bot, context, moveTo);
  if (pit) pit.bottom = bottom;
  const opening = openingCells;
  for (const position of opening(bottom)) {
    context.signal?.throwIfAborted();
    if (air(bot, position)) continue;
    if (!enclosed(bot, bottom) || !dryOpening(bot, bottom))
      throw new DisposalHoleError("[DROP_HOLE_CHANGED] The hole's enclosing blocks changed before digging.");
    const result = await breakInPlace({ movements, position, signal: context.signal });
    if (result.status !== "broken") throw new DisposalHoleError(`[DROP_HOLE_DIG_FAILED] ${result.reason}`);
  }
  if (!enclosed(bot, bottom) || !air(bot, bottom) || !air(bot, bottom.offset(0, 1, 0)))
    throw new DisposalHoleError(
      "[DROP_HOLE_NOT_OBSERVED] A dry, enclosed two-block-deep hole was not observed after digging.",
    );
  // Aim through the opening. Aiming at the bottom throws too steeply: the
  // stack's collision box clips the near rim before it crosses the edge.
  // Aim half a block above the lip to clear the item's own collision radius.
  // Await the normal look so the server receives that orientation before toss.
  await bot.lookAt(bottom.offset(0.5, 2.5, 0.5));
  return bottom;
}

/** Existing entities may merge with a toss; retain their counts as well as their ids. */
export function snapshotDroppedCounts(bot: Bot): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const entity of Object.values(bot.entities)) {
    try {
      const item = entity.getDroppedItem();
      if (item) counts.set(entity.id, item.count);
    } catch {
      // Metadata has not arrived yet; it cannot establish an item count.
    }
  }
  return counts;
}

/** Inventory loss alone does not show that the toss landed below pickup height. */
export async function observeHoleDrops(
  bot: Bot,
  bottom: BlockPosition,
  baseline: ReadonlyMap<number, number>,
  dropped: readonly DroppedItem[],
  context: ActionContext,
  settleMs = 1_500,
): Promise<boolean> {
  const expected = new Map<string, number>();
  for (const entry of dropped)
    if (entry.dropped > 0) expected.set(entry.item, (expected.get(entry.item) ?? 0) + entry.dropped);
  return (
    (await waitForSignal(
      () => {
        const observed = new Map<string, number>();
        for (const entity of Object.values(bot.entities)) {
          const p = entity.position;
          if (Math.floor(p.x) !== bottom.x || Math.floor(p.z) !== bottom.z || p.y < bottom.y || p.y > bottom.y + 0.3)
            continue;
          try {
            const item = entity.getDroppedItem();
            if (item)
              observed.set(
                item.name,
                (observed.get(item.name) ?? 0) + Math.max(0, item.count - (baseline.get(entity.id) ?? 0)),
              );
          } catch {
            // Wait for the dropped stack's metadata before counting it.
          }
        }
        return [...expected].every(([name, count]) => (observed.get(name) ?? 0) >= count);
      },
      bot,
      ["physicsTick", "entityMoved", "entityUpdate", "itemDrop"],
      {
        // Falling from hand height to this two-deep floor takes under a second.
        // The default allows 1.5 seconds for fall and server observation, then reports failure.
        timeoutMs: settleMs,
        context,
      },
    )) === true
  );
}

/** How many of the two cells above the discards hold a block now: the plug, however many attempts placed it. */
export function pluggedCellCount(bot: Bot, bottom: Vec3): number {
  return [bottom.offset(0, 1, 0), bottom.offset(0, 2, 0)].filter((cell) => !air(bot, cell)).length;
}

/** What `sealDisposalHole` reports; the caller adds how far it then stepped back. */
export type DisposalHoleSeal = Pick<HoleClosure, "item" | "placed"> & { readonly error?: string };

/** Use the first carried, physically safe block admitted by the live scaffold policy. */
function plugMaterial(bot: Bot): InventoryItem | null {
  return preferredScaffoldItem(bot);
}

/**
 * Plug the shaft above the discards so nothing later paths down into the pit.
 *
 * A collect request issued straight after a hole drop walked back into the
 * open pit it had just tossed into. The cell above the items is filled first,
 * which is what keeps them out of reach; the ground-level cell follows when
 * material allows, so the surface is flush again and no pathfinder sees a
 * one-deep step to drop into.
 */
export async function sealDisposalHole(
  bot: Bot,
  bottom: Vec3,
  place: typeof placeSolidBlockInto,
  context: ActionContext,
): Promise<DisposalHoleSeal> {
  let item: string | null = null;
  let placed = 0;
  for (const cell of [bottom.offset(0, 1, 0), bottom.offset(0, 2, 0)]) {
    context.signal?.throwIfAborted();
    if (!air(bot, cell)) continue;
    const material = plugMaterial(bot);
    if (!material)
      return {
        item,
        placed,
        error: `[DROP_HOLE_OPEN] No full, dry, non-falling block is carried to plug the hole at (${cell.x}, ${cell.y}, ${cell.z}).`,
      };
    const result = await place(bot, cell, material, { signal: context.signal });
    if (result.kind === "failed")
      return { item, placed, error: `[DROP_HOLE_OPEN] Could not plug (${cell.x}, ${cell.y}, ${cell.z}): ${result.error}` };
    item = material.name;
    placed += 1;
  }
  return { item, placed };
}
