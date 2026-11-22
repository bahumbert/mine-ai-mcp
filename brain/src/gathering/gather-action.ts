// Runs one body action for a gathering and reads what its result reports (a tool that broke, blocks broken).
import { z } from "zod";
import type { ActOutcome } from "../body.ts";
import { consumedBy, FULL_INVENTORY } from "../inventory-room.ts";
import type { GatherContext, GatherResult } from "./gather-materials.ts";
import type { Knowledge } from "./how-to-get.ts";

/** The part of a `collect_block` result that names a tool which broke during the run (src/actions/collect-block/contract.ts). */
const toolLostSchema = z.object({ collected: z.object({ toolLost: z.object({ class: z.string() }) }) });

/**
 * Runs one action; null when it succeeded. A tool the runtime says broke during it (`toolLost`, succeeded or not) is
 * added to `wear.lost` and counted in `wear.losses`; `observe` sees each outcome.
 */
export async function act(context: GatherContext, tool: "collect_block" | "collect_mob_drop" | "craft_item" | "smelt_item" | "navigate" | "use_bucket", input: Record<string, unknown>, rationale: string, wear?: Knowledge, observe?: (outcome: ActOutcome) => void): Promise<GatherResult | null> {
  let outcome = await context.body.act(tool, input, rationale, { signal: context.signal });
  const broke = toolLostSchema.safeParse(outcome.result);
  if (broke.success && wear !== undefined) {
    const toolClass = broke.data.collected.toolLost.class;
    wear.lost.add(toolClass);
    wear.losses.set(toolClass, (wear.losses.get(toolClass) ?? 0) + 1);
  }
  if (context.signal.aborted) return { status: "stopped" };
  // A craft or a smelt with no room for its result or its workstation: room is made once, then it runs again (run 12).
  if (outcome.status !== "succeeded" && (tool === "craft_item" || tool === "smelt_item") && FULL_INVENTORY.test(outcome.error ?? "") && context.makeRoom !== undefined && (await context.makeRoom(await consumedBy(context.runtime, tool, input)))) {
    outcome = await context.body.act(tool, input, rationale, { signal: context.signal });
    if (context.signal.aborted) return { status: "stopped" };
  }
  observe?.(outcome);
  if (outcome.status === "succeeded") return null;
  return { status: "failed", detail: outcome.error ?? `${tool} ${outcome.status}` };
}

/** What a `collect_block` result reports (src/actions/collect-block/contract.ts `collected`), on success and on failure. */
const collectedSchema = z.object({ collected: z.object({ blocksBroken: z.number() }) });

/** The matching blocks a `collect_block` result reports broken; 0 when it reports none. */
export function blocksBroken(result: ActOutcome["result"]): number {
  return collectedSchema.safeParse(result).data?.collected.blocksBroken ?? 0;
}
