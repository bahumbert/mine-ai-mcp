import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import { createMovements, exactBlockGoal, type NavigationRuntime } from "../navigation/index.js";
import { carriedCount } from "../world/inventory-count.js";
import { awaitOwnPlacement, forgetPlacement, recordPlacementSent, startOwnPlacement, type OwnPlacement } from "../world/own-placement.js";
import {
  findStandingSpot,
  placeCarriedBlockNearby,
  STANDING_SPOT_RADIUS,
  type NearbyPlacement,
} from "../world/nearby-placement.js";
import type { WorldBlock } from "../world/placement.js";
import { collectBlock } from "./collect-block/collect-block.js";
import { parseCollectBlockRequest } from "./collect-block/contract.js";
import type { ActionContext, ActionResult } from "./action.js";
import { recoverWorkstationDrop, type DropClock } from "./workstation-drop.js";

export const temporaryWorkstationInputSchema = z
  .boolean()
  .optional()
  .describe(
    "Place a workstation already in inventory for this call, then collect it before returning. Fails if none is carried. Cancellation can leave the workstation behind.",
  );

export const workstationEvidenceSchema = z.strictObject({
  block: z.enum(["crafting_table", "furnace"]),
  position: z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
  recovered: z.boolean(),
});

type WorkstationEvidence = z.output<typeof workstationEvidenceSchema>;
type WorkstationName = WorkstationEvidence["block"];

export interface WorkstationOperations {
  /** `onPlacementSent` fires right before the placement packet: an abort in the wait for the server still leaves the cell known. */
  place(name: WorkstationName, signal?: AbortSignal, onPlacementSent?: (cells: readonly Vec3[]) => void): Promise<NearbyPlacement>;
  /** Walk to the nearest spot where a player can stand and set the block down; false when there is none. */
  moveToOpenGround(name: WorkstationName, context: ActionContext): Promise<boolean>;
  collect(
    name: WorkstationName,
    position: WorkstationEvidence["position"],
    context: ActionContext,
  ): Promise<ActionResult>;
}

export function workstationOperations(
  bot: Bot,
  navigation: NavigationRuntime,
  dropClock?: DropClock,
): WorkstationOperations {
  return {
    place: (name, signal, onPlacementSent) => placeCarriedBlockNearby(bot, name, { signal, onPlacementSent }),
    moveToOpenGround: async (name, context) => {
      const spot = findStandingSpot(bot, STANDING_SPOT_RADIUS, name);
      if (!spot) return false;
      // Arriving short of it is not a failure here: the second placement is the judge.
      await navigation.navigate({ movements: createMovements(bot), goal: exactBlockGoal(spot), signal: context.signal });
      return true;
    },
    collect: async (name, position, context) => {
      if (name === "furnace") {
        const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
        if (block?.name === "furnace") {
          const window = await bot.openFurnace(block);
          try {
            if (window.inputItem() || window.outputItem() || window.fuelItem()) {
              return { status: "failed", error: "The temporary furnace still contains items; it was left in place." };
            }
          } finally {
            window.close();
          }
        }
      }
      const carriedBefore = carriedCount(bot, name);
      const collected = await collectBlock(
        bot,
        navigation,
        // It set the workstation down itself a moment ago, possibly inside a region of its own: pick it up regardless.
        { ...parseCollectBlockRequest({ block_name: name, ...position, scaffold: false }), ignoreOwnRegions: true },
        context,
      );
      if (collected.status === "succeeded") return collected;
      // Broken but not picked up (run 14b: the drop spawned after the mining wait ended, on a server far behind):
      // wait for the drop and walk onto it. A block still standing is a different failure and keeps its message.
      if (bot.blockAt(new Vec3(position.x, position.y, position.z))?.name === name) return collected;
      context.signal?.throwIfAborted();
      const drop = await recoverWorkstationDrop(bot, navigation, name, position, carriedBefore, context, { clock: dropClock });
      return drop.status === "succeeded" ? drop : { ...drop, error: `${drop.error} (${collected.error})` };
    },
  };
}

interface WorkstationSetDown {
  readonly position: Vec3;
  /** Null when the block stands but the placement was not confirmed: nothing may start, the block is still recovered. */
  readonly block: WorldBlock | null;
  readonly placementError: string;
}

/**
 * The block this request's own packet put down earlier, as the server answered it, while it still stands; a string is
 * the refusal when it cannot be told. A block of that name that our packet did not put there is not the request's.
 */
async function heldWorkstation(
  bot: Bot,
  name: WorkstationName,
  hold: OwnPlacement,
  signal?: AbortSignal,
): Promise<WorkstationSetDown | string | null> {
  const seen = await awaitOwnPlacement(bot, hold, (block) => block.name === name, signal);
  switch (seen.kind) {
    case "landed":
      return { position: seen.cell, block: seen.block, placementError: "" };
    case "unloaded":
      return `[WORKSTATION_NOT_LOADED] The temporary ${name} set down at ${seen.cell} is not in a loaded chunk; go back near it.`;
    case "not_landed":
      forgetPlacement(hold);
      return null;
    case "none":
      return null;
  }
}

/** Reuse the held workstation, or place the carried one (once walking to open ground if there is no cell); a string is the refusal. */
async function setWorkstationDown(
  bot: Bot,
  name: WorkstationName,
  context: ActionContext,
  operations: WorkstationOperations,
  hold: OwnPlacement,
): Promise<WorkstationSetDown | string> {
  const held = await heldWorkstation(bot, name, hold, context.signal);
  if (held !== null) return held;
  if (carriedCount(bot, name) < 1) return `[WORKSTATION_NOT_CARRIED] No ${name} is carried for temporary use.`;
  // Picking it back up needs a free slot: the slot it leaves may fill with what it makes (live 2026-10-02: a full
  // inventory left a furnace inside the house being built, a cell the build may not dig).
  if (bot.inventory.emptySlotCount?.() === 0) {
    return `[WORKSTATION_NO_ROOM] ${name}: no free inventory slot to pick it back up afterwards; make room first.`;
  }
  const sent = (cells: readonly Vec3[]) => recordPlacementSent(hold, cells, bot.time?.age);
  let placement = await operations.place(name, context.signal, sent);
  // A player standing in water, or in a tunnel too tight to set anything down, takes a few steps first (live
  // 2026-10-02: a bot logged in standing in water; 2026-10-10 run 9: Yuki, no_cell twice). Once.
  if (placement.kind === "no_cell" && (await operations.moveToOpenGround(name, context))) {
    context.signal?.throwIfAborted();
    placement = await operations.place(name, context.signal, sent);
  }
  if (placement.kind === "no_item") return `[WORKSTATION_PLACEMENT_FAILED] ${name}: no_item.`;
  if (placement.kind === "no_cell") {
    return `[WORKSTATION_PLACEMENT_FAILED] ${name}: no_cell (no dry, clear cell within ${STANDING_SPOT_RADIUS} blocks: in water, a tunnel or a crowded spot); move to open dry ground first.`;
  }
  // A placement may report unsettled inventory even though the block appeared.
  // That cell is still ours to recover, but no crafting/cooking may begin.
  if (bot.blockAt(placement.position)?.name !== name) {
    forgetPlacement(hold);
    return `[WORKSTATION_PLACEMENT_FAILED] ${name}: ${placement.kind === "failed" ? placement.error : "placed block was not observed"}.`;
  }
  return placement.kind === "placed"
    ? { position: placement.position, block: placement.block, placementError: "" }
    : { position: placement.position, block: null, placementError: placement.error };
}

/**
 * Own only this request's placed block; a failed operation still returns its workstation. An attempt a reflex aborts
 * leaves the block standing in `hold`, and the next attempt of the same request reuses it.
 */
export async function useTemporaryWorkstation<Evidence extends object>(
  bot: Bot,
  name: WorkstationName,
  context: ActionContext,
  operations: WorkstationOperations,
  execute: (block: WorldBlock) => Promise<ActionResult & Evidence>,
  failure: (error: string) => ActionResult & Evidence,
  hold: OwnPlacement = startOwnPlacement(),
): Promise<ActionResult & Evidence & { workstation?: WorkstationEvidence }> {
  context.signal?.throwIfAborted();
  const setDown = await setWorkstationDown(bot, name, context, operations, hold);
  if (typeof setDown === "string") return failure(setDown);
  const { position } = setDown;
  let result: ActionResult & Evidence;
  let recovered = false;
  let recoveryError = "";
  try {
    result = setDown.block
      ? await execute(setDown.block)
      : failure(`[WORKSTATION_PLACEMENT_FAILED] ${setDown.placementError}`);
  } catch (cause) {
    context.signal?.throwIfAborted();
    result = failure(`[WORKSTATION_OPERATION_FAILED] ${cause instanceof Error ? cause.message : String(cause)}`);
  } finally {
    // Cancellation hands the body to the session/reflex. Do not move after that handoff.
    if (!context.signal?.aborted) {
      try {
        const collected = await operations.collect(name, position, context);
        const remaining = bot.blockAt(position);
        recovered = collected.status === "succeeded" && remaining !== null && remaining.name !== name;
        if (collected.status !== "succeeded") recoveryError = collected.error;
        else if (!recovered) recoveryError = "Removal of the placed workstation was not observed.";
      } catch (cause) {
        recoveryError = cause instanceof Error ? cause.message : String(cause);
      }
      // The request ends here whatever the recovery found: nothing is left for a later attempt to reuse.
      if (!context.signal?.aborted) forgetPlacement(hold);
    }
  }
  context.signal?.throwIfAborted();
  const workstation = { block: name, position: { x: position.x, y: position.y, z: position.z }, recovered };
  if (recovered) return { ...result, workstation };
  const error = `[WORKSTATION_NOT_RECOVERED] ${name} at ${position}: ${recoveryError}`;
  return {
    ...result,
    workstation,
    status: result.status === "succeeded" ? "partial" : result.status,
    error: result.status === "succeeded" ? error : `${result.error} ${error}`,
  };
}

export function formatWorkstation(workstation?: WorkstationEvidence): string[] {
  if (!workstation) return [];
  const { block, position, recovered } = workstation;
  return [
    `- Temporary ${block} at ${position.x}, ${position.y}, ${position.z}: ${recovered ? "collected back into inventory" : "not recovered"}`,
  ];
}
