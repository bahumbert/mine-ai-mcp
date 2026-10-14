import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import { createMovements, exactBlockGoal, type NavigationRuntime } from "../navigation/index.js";
import { carriedCount } from "../world/inventory-count.js";
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
  place(name: WorkstationName, signal?: AbortSignal): Promise<NearbyPlacement>;
  /** Walk to the nearest spot where a player can stand and set the block down; false when there is none. */
  moveToOpenGround(name: WorkstationName, context: ActionContext): Promise<boolean>;
  collect(
    name: WorkstationName,
    position: WorkstationEvidence["position"],
    context: ActionContext,
  ): Promise<ActionResult>;
}

export function workstationOperations(bot: Bot, navigation: NavigationRuntime): WorkstationOperations {
  return {
    place: (name, signal) => placeCarriedBlockNearby(bot, name, { signal }),
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
      return collectBlock(
        bot,
        navigation,
        // It set the workstation down itself a moment ago, possibly inside a region of its own: pick it up regardless.
        { ...parseCollectBlockRequest({ block_name: name, ...position, scaffold: false }), ignoreOwnRegions: true },
        context,
      );
    },
  };
}

/** Own only this call's placed block; a failed operation still returns its workstation. */
export async function useTemporaryWorkstation<Evidence extends object>(
  bot: Bot,
  name: WorkstationName,
  context: ActionContext,
  operations: WorkstationOperations,
  execute: (block: WorldBlock) => Promise<ActionResult & Evidence>,
  failure: (error: string) => ActionResult & Evidence,
): Promise<ActionResult & Evidence & { workstation?: WorkstationEvidence }> {
  context.signal?.throwIfAborted();
  if (carriedCount(bot, name) < 1) {
    return failure(`[WORKSTATION_NOT_CARRIED] No ${name} is carried for temporary use.`);
  }
  // Picking it back up needs a free slot: the slot it leaves may fill with what it makes (live 2026-10-02: a full
  // inventory left a furnace inside the house being built, a cell the build may not dig).
  if (bot.inventory.emptySlotCount?.() === 0) {
    return failure(`[WORKSTATION_NO_ROOM] ${name}: no free inventory slot to pick it back up afterwards; make room first.`);
  }
  let placement = await operations.place(name, context.signal);
  // A player standing in water, or in a tunnel too tight to set anything down, takes a few steps first (live
  // 2026-10-02: a bot logged in standing in water; 2026-10-10 run 9: Yuki, no_cell twice). Once.
  if (placement.kind === "no_cell" && (await operations.moveToOpenGround(name, context))) {
    context.signal?.throwIfAborted();
    placement = await operations.place(name, context.signal);
  }
  if (placement.kind === "no_item") {
    return failure(`[WORKSTATION_PLACEMENT_FAILED] ${name}: no_item.`);
  }
  if (placement.kind === "no_cell") {
    return failure(
      `[WORKSTATION_PLACEMENT_FAILED] ${name}: no_cell (no dry, clear cell within ${STANDING_SPOT_RADIUS} blocks: in water, a tunnel or a crowded spot); move to open dry ground first.`,
    );
  }
  // A placement may report unsettled inventory even though the block appeared.
  // That cell is still ours to recover, but no crafting/cooking may begin.
  const placed = bot.blockAt(placement.position)?.name === name;
  if (!placed) {
    return failure(
      `[WORKSTATION_PLACEMENT_FAILED] ${name}: ${placement.kind === "failed" ? placement.error : "placed block was not observed"}.`,
    );
  }
  let result: ActionResult & Evidence;
  let recovered = false;
  let recoveryError = "";
  try {
    result =
      placement.kind === "placed"
        ? await execute(placement.block)
        : failure(`[WORKSTATION_PLACEMENT_FAILED] ${placement.error}`);
  } catch (cause) {
    context.signal?.throwIfAborted();
    result = failure(`[WORKSTATION_OPERATION_FAILED] ${cause instanceof Error ? cause.message : String(cause)}`);
  } finally {
    // Cancellation hands the body to the session/reflex. Do not move after that handoff.
    if (!context.signal?.aborted) {
      try {
        const collected = await operations.collect(name, placement.position, context);
        const remaining = bot.blockAt(placement.position);
        recovered = collected.status === "succeeded" && remaining !== null && remaining.name !== name;
        if (collected.status !== "succeeded") recoveryError = collected.error;
        else if (!recovered) recoveryError = "Removal of the placed workstation was not observed.";
      } catch (cause) {
        recoveryError = cause instanceof Error ? cause.message : String(cause);
      }
    }
  }
  context.signal?.throwIfAborted();
  const workstation = {
    block: name,
    position: { x: placement.position.x, y: placement.position.y, z: placement.position.z },
    recovered,
  };
  if (recovered) return { ...result, workstation };
  const error = `[WORKSTATION_NOT_RECOVERED] ${name} at ${placement.position}: ${recoveryError}`;
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
