import { z } from "zod";
import { dropItemResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import type { ScenarioContext, ScenarioRun } from "../scenario.ts";

const paramsSchema = z.strictObject({
  giver: z.string().min(1),
  receiver: z.string().min(1),
  item_name: z.string().min(1),
  count: z.number().int().positive(),
  /** Where the receiver walks off to at once, `x` `z` on the flat floor. */
  walk_to: z.strictObject({ x: z.number(), y: z.number(), z: z.number() }),
  pick_up_radius: z.number().int().positive().default(16),
});

/**
 * F6 (trade s1d, 2026-10-22): the receiver walks away while the giver tosses. The toss must report that it was not
 * picked up, and the giver must be able to pick its own items back up (what the trade's hand-off does next).
 */
export const run: ScenarioRun = async (context) => {
  const params = paramsSchema.parse(context.scenario.params);
  if (context.username === undefined) throw new Error("The client host gave this driver no username.");
  return context.username === params.giver ? give(context, params) : walkOff(context, params);
};

async function give(context: ScenarioContext, params: z.output<typeof paramsSchema>): Promise<ClientCompletion> {
  const output = await context.call("drop_item", { items: [{ item_name: params.item_name, count: params.count }], to_player: params.receiver, allow_equipped: true });
  const result = dropItemResultSchema.parse(output.result);
  if (result.status !== "succeeded") return { status: "failed", detail: output.summary };
  const recipient = result.drop.recipient;
  if (recipient?.collected !== false || recipient.collectedCount !== 0) return { status: "failed", detail: `The receiver was expected to take nothing; ${output.summary}` };
  const back = await context.call("pick_up_items", { item: params.item_name, radius: params.pick_up_radius });
  return back.result.status === "succeeded" ? { status: "succeeded", detail: `Not taken, picked back up; ${back.summary}` } : { status: "failed", detail: `Could not pick the items back up; ${back.summary}` };
}

async function walkOff(context: ScenarioContext, params: z.output<typeof paramsSchema>): Promise<ClientCompletion> {
  const output = await context.call("navigate", { ...params.walk_to, range: 1, dig: false, scaffold: false });
  return { status: output.result.status === "succeeded" ? "succeeded" : "failed", detail: output.summary };
}
