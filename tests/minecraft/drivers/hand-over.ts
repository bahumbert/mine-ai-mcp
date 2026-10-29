import { z } from "zod";
import { dropItemResultSchema, viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { handOverRolesOf, handOverRolesSchema, type HandOverRoles } from "./hand-over-roles.ts";
import type { ScenarioContext, ScenarioRun } from "../scenario.ts";

const paramsSchema = z.strictObject({
  /** Places in the scenario's `players` list. */
  ...handOverRolesSchema,
  item_name: z.string().min(1),
  count: z.number().int().positive(),
  /** How many the server announces the receiver took: fewer than `count` when its inventory has no room (a partial pickup is not announced: 0). */
  taken: z.number().int().nonnegative().optional(),
  /** What the receiver holds of the item when it is done; `count` unless it already held some. */
  receiver_holds: z.number().int().positive().optional(),
  /** How long the idle receiver watches its inventory for the items. */
  receiver_wait_ticks: z.number().int().positive().default(200),
});

/**
 * One driver for both declared players: the giver hands the items over with `drop_item` and `to_player` and must
 * report them taken; the receiver stands still and finishes when it holds them (or when its wait runs out, which the
 * scenario's `hasItem` goal then fails).
 */
export const run: ScenarioRun = async (context) => {
  const params = paramsSchema.parse(context.scenario.params);
  const roles = handOverRolesOf(context, params);
  return roles.isGiver ? give(context, params, roles) : receive(context, params);
};

async function give(context: ScenarioContext, params: z.output<typeof paramsSchema>, roles: HandOverRoles): Promise<ClientCompletion> {
  // The first inventory item is in the hand; the toss is the point of the scenario, not the hand check.
  const output = await context.call("drop_item", { items: [{ item_name: params.item_name, count: params.count }], to_player: roles.receiver, allow_equipped: true });
  const result = dropItemResultSchema.parse(output.result);
  if (result.status !== "succeeded") return { status: "failed", detail: output.summary };
  const recipient = result.drop.recipient;
  const taken = params.taken ?? params.count;
  const whole = taken === params.count;
  const answered = recipient?.settled === true && recipient.collectedCount === taken && recipient.collected === whole;
  if (!answered) return { status: "failed", detail: `Expected ${taken} of ${params.count} taken and settled; ${output.summary}` };
  // What the receiver left lying is the giver's to pick back up, as the trade's hand-off does.
  const left = whole ? null : await context.call("pick_up_items", { item: params.item_name, radius: 8 });
  if (left && left.result.status !== "succeeded") return { status: "failed", detail: `Could not pick the rest back up; ${left.summary}` };
  return { status: "succeeded", detail: output.summary };
}

async function receive(context: ScenarioContext, params: z.output<typeof paramsSchema>): Promise<ClientCompletion> {
  let lastSeen = "";
  for (let waited = 0; waited < params.receiver_wait_ticks; waited += 10) {
    const seen = await context.call("view_status", {});
    lastSeen = seen.summary.match(/Position; [^;]*;|Dropped items[^;]*;[^;]*/gu)?.join(" ") ?? "";
    const status = viewStatusResultSchema.parse(seen.result);
    const held = status.status === "succeeded"
      ? status.situation.inventory.stacks.filter((stack) => stack.name === params.item_name).reduce((sum, stack) => sum + stack.count, 0)
      : 0;
    if (held >= (params.receiver_holds ?? params.count)) return { status: "succeeded", detail: `Holds ${held} ${params.item_name}.` };
    await context.waitForTicks(10);
  }
  return { status: "failed", detail: `Never held ${params.receiver_holds ?? params.count} ${params.item_name}; last seen: ${lastSeen}` };
}
