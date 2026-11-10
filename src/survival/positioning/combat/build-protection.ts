import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import type { WorldView } from "../../../navigation/index.js";
import { blockClass } from "../../../navigation/mineflayer/world.js";
import { isReplaceableForPlacement } from "../../../world/block-classification.js";
import { findPlacementSupport, occupiedCell, placeBlock } from "../../../world/placement.js";
import { cellsOutsideRegionsFirst, foreignRegionAt } from "../../../world/protected-regions.js";
import type { CombatPolicy } from "../../policy/combat/contract.js";
import { extinguishFireAt } from "../fire-clearance.js";
import { capBlock } from "./hide-blocks.js";

export type ProtectionBuild =
  | { readonly kind: "built"; readonly placed: readonly Vec3[] }
  | { readonly kind: "blocked"; readonly placed: readonly Vec3[]; readonly reason: string };

interface ProtectionBuildOptions {
  readonly signal: AbortSignal;
  readonly mayContinue: () => string | null;
  readonly terrain: Readonly<CombatPolicy["terrain"]>;
  /** Some hazards destroy ordinary walls; selection and existing cover must agree. */
  readonly blockNames?: readonly string[];
  /** The hide owns safe excavation; other protective shapes admit only replaceable cells. */
  readonly clearCell?: (cell: Vec3, signal: AbortSignal) => Promise<"cleared" | string>;
}

/** Clear an obstructed cell only through its caller's excavation policy. */
async function clearProtectionCell(bot: Bot, cell: Vec3, options: ProtectionBuildOptions): Promise<string | null> {
  const current = bot.blockAt(cell);
  if (isReplaceableForPlacement(current, bot.version)) return null;
  const refusal = `Protection cell ${cell} contains ${current?.name ?? "unobserved terrain"}, which cannot be replaced by placement.`;
  if (!options.clearCell) return refusal;
  if (!capBlock(bot, options.blockNames)) return "no block worth placing is carried";
  if (!findPlacementSupport(bot, cell)) return `No reachable supporting face for protection cell ${cell}.`;
  const cleared = await options.clearCell(cell, options.signal);
  options.signal.throwIfAborted();
  return cleared === "cleared" ? null : `${refusal} ${cleared}`;
}

/** Re-read closure supplies after excavation, and report an opening if they changed. */
async function fillProtectionCell(bot: Bot, cell: Vec3, options: ProtectionBuildOptions): Promise<string | null> {
  const { signal, terrain } = options;
  if ((await extinguishFireAt(bot, cell, signal, terrain.dig)) === "blocked")
    return `Fire could not be cleared from protection cell ${cell}.`;
  signal.throwIfAborted();
  const changed = options.mayContinue();
  if (changed) return changed;
  const dug = !isReplaceableForPlacement(bot.blockAt(cell), bot.version);
  const refused = await clearProtectionCell(bot, cell, options);
  if (refused) return refused;
  signal.throwIfAborted();
  const open = (reason: string) => dug ? `Protection cell ${cell} dug and left open: ${reason}. Restore its wall or withdraw.` : reason;
  const interrupted = options.mayContinue();
  if (interrupted) return open(interrupted);
  if (!isReplaceableForPlacement(bot.blockAt(cell), bot.version)) return open("the cell is obstructed again");
  const item = capBlock(bot, options.blockNames);
  if (!item) return open("no block worth placing is carried");
  const support = findPlacementSupport(bot, cell);
  if (!support) return open("no reachable supporting face remains");
  const context = `${item.name} against ${support.support.name} face ${support.face.x},${support.face.y},${support.face.z}`;
  try {
    const result = await placeBlock(bot, {
      item, ...support, expectedCells: [cell],
      matches: (block) => protects(block, options.blockNames),
      signal,
    });
    return result.kind === "failed" ? open(`${context}: ${result.error}`) : null;
  } catch (cause) {
    signal.throwIfAborted();
    return open(`${context}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** Price only cells the server can fill before provoking a quarry or starting construction. */
export function canPlaceProtection(bot: Bot, world: WorldView, cell: Vec3): boolean {
  const observed = world.blockAt(cell.x, cell.y, cell.z);
  const block = observed.kind === "loaded" ? blockClass(bot).fromStateId(observed.stateId, 0) : null;
  // Foreign regions refuse placement (ADR-012): reject the plan before it is half built (P4 review, 2026-11-09).
  return isReplaceableForPlacement(block, bot.version) && occupiedCell(bot, cell) === null && foreignRegionAt(bot, cell) === null;
}

/** A wall must fill its cell. A fence's bounding-box label is not a closed wall. */
export function fullProtectionBlock(block: ReturnType<Bot["blockAt"]>): boolean {
  return (
    block?.shapes?.some(([x, y, z, xx, yy, zz]) => x === 0 && y === 0 && z === 0 && xx === 1 && yy >= 1 && zz === 1) ??
    false
  );
}

/** The same material and shape requirements apply to existing and newly placed cover. */
function protects(block: ReturnType<Bot["blockAt"]>, names?: readonly string[]): boolean {
  return fullProtectionBlock(block) && (!names || names.includes(block!.name));
}

/**
 * One construction transaction for every protective shape. Its caller owns
 * the body and decides whether changed contact or footing permits another cell.
 * Each observed placement supplies the next support; no optimistic packet batch
 * can claim a finished wall while the server has rejected an intermediate cell.
 */
export async function buildProtection(
  bot: Bot,
  cells: readonly Vec3[],
  options: ProtectionBuildOptions,
): Promise<ProtectionBuild> {
  const { signal, mayContinue, terrain } = options;
  // Cells outside every region first, the bot's own region's next, another owner's last: its placement is refused by
  // the core (ADR-012), after everything that can still be built has been.
  const pending = cellsOutsideRegionsFirst(bot, [...new Map(cells.map((cell) => [cell.toString(), cell])).values()]);
  const placed: Vec3[] = [];
  const blocked = (reason: string): ProtectionBuild => ({ kind: "blocked", placed, reason });
  while (pending.length) {
    signal.throwIfAborted();
    const changed = mayContinue();
    if (changed) return blocked(changed);
    const complete = pending.findIndex((cell) => protects(bot.blockAt(cell), options.blockNames));
    if (complete >= 0) {
      pending.splice(complete, 1);
      continue;
    }
    if (!terrain.place) return blocked("Combat placement prohibited by policy.");
    if (!capBlock(bot, options.blockNames)) return blocked("no block worth placing is carried");
    const index = pending.findIndex((cell) => findPlacementSupport(bot, cell) !== null);
    if (index < 0)
      return blocked(`No reachable supporting face for remaining protection cells: ${pending.join(", ")}.`);
    const cell = pending[index]!;
    const refusal = await fillProtectionCell(bot, cell, options);
    if (refusal) return blocked(refusal);
    placed.push(cell);
    pending.splice(index, 1);
  }
  return { kind: "built", placed };
}
