import { z } from "zod";
import { dropItemResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { arenaCell } from "../arena/params.ts";
import type { ArenaFrame } from "../arena/frame.ts";
import { handOverRolesOf, handOverRolesSchema, type HandOverRoles } from "./hand-over-roles.ts";
import type { ScenarioContext, ScenarioRun } from "../scenario.ts";

const paramsIn = (arena: ArenaFrame) => z.strictObject({
  /** Places in the scenario's `players` list. */
  ...handOverRolesSchema,
  item_name: z.string().min(1),
  count: z.number().int().positive(),
  /** Where the receiver walks off to at once, `x` `z` on the flat floor (arena-local in the YAML, a world cell here). */
  walk_to: arenaCell(arena),
  /** The brain's pick-back: this radius around the spot the giver tossed from (`PICK_BACK_RADIUS`, relations/handoff.ts). */
  pick_up_radius: z.number().int().positive().default(8),
});

type Params = z.output<ReturnType<typeof paramsIn>>;

/**
 * F6 (trade s1d, 2026-10-22): the receiver walks away while the giver tosses. The toss must report that it was not
 * picked up, and the giver must be able to pick its own items back up (what the trade's hand-off does next).
 */
export const run: ScenarioRun = async (context) => {
  const params = paramsIn(context.arena).parse(context.scenario.params);
  const roles = handOverRolesOf(context, params);
  return roles.isGiver ? give(context, params, roles) : walkOff(context, params);
};

async function give(context: ScenarioContext, params: Params, roles: HandOverRoles): Promise<ClientCompletion> {
  const output = await context.call("drop_item", { items: [{ item_name: params.item_name, count: params.count }], to_player: roles.receiver, allow_equipped: true });
  const result = dropItemResultSchema.parse(output.result);
  if (result.status !== "succeeded") return { status: "failed", detail: output.summary };
  const recipient = result.drop.recipient;
  if (recipient?.collected !== false || recipient.collectedCount !== 0 || recipient.settled !== true) return { status: "failed", detail: `The receiver was expected to take nothing; ${output.summary}` };
  const back = await context.call("pick_up_items", { item: params.item_name, ...result.drop.droppedAt, radius: params.pick_up_radius });
  return back.result.status === "succeeded" ? { status: "succeeded", detail: `Not taken, picked back up; ${back.summary}` } : { status: "failed", detail: `Could not pick the items back up; ${back.summary}` };
}

async function walkOff(context: ScenarioContext, params: Params): Promise<ClientCompletion> {
  const output = await context.call("navigate", { ...params.walk_to, range: 1, dig: false, scaffold: false });
  return { status: output.result.status === "succeeded" ? "succeeded" : "failed", detail: output.summary };
}
