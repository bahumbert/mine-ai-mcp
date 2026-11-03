import { z } from "zod";
import { viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { handOverRolesOf, handOverRolesSchema } from "./hand-over-roles.ts";
import type { ScenarioContext, ScenarioRun } from "../scenario.ts";

const paramsSchema = z.strictObject({
  /** Places in the scenario's `players` list. */
  ...handOverRolesSchema,
  item_name: z.string().min(1),
  /** Height the giver aims at above the receiver's feet: the toss's pitch decides where it rests (`tossAimHeight`, drop-item/hand-over.ts, at this reach). */
  aim_height: z.number(),
  /** How long the receiver watches its inventory after the toss (ticks): past the 40-tick pickup delay. */
  receiver_wait_ticks: z.number().int().positive().default(160),
});

type Params = z.output<typeof paramsSchema>;

/**
 * Measurement for the hand-over stance (plan 2026-11-03-handover-ledge-and-unconfirmed-toss F1 step 1): the giver stands
 * still where the scenario put it and tosses one item aimed at the receiver, whose feet are higher or lower than its own.
 * It walks off after the toss (as a hand-over does) but not before it, so the height difference is the only variable (`drop_item` would walk the giver to a cell the stance
 * test accepts). The receiver reports whether it took the item or where it lies, as `LEDGE_TOSS taken=... rest_dy=...`.
 */
export const run: ScenarioRun = async (context) => {
  const params = paramsSchema.parse(context.scenario.params);
  return handOverRolesOf(context, params).isGiver ? toss(context, params) : watch(context, params);
};

async function toss(context: ScenarioContext, params: Params): Promise<ClientCompletion> {
  const { bot } = context;
  const receiver = Object.values(bot.players).find((player) => player.username !== bot.username)?.entity;
  if (!receiver) return { status: "failed", detail: "The receiver is not seen." };
  await context.waitForTicks(20);
  await bot.lookAt(receiver.position.offset(0, params.aim_height, 0));
  await context.waitForTicks(3);
  const stack = bot.inventory.items().find((item) => item.name === params.item_name);
  if (!stack) return { status: "failed", detail: `No ${params.item_name} carried.` };
  await bot.toss(stack.type, null, 1);
  // As a hand-over does: a giver left standing beside its own toss picks it back up (B2, 2026-10-19).
  const at = bot.entity.position.floored();
  await context.call("navigate", { x: at.x - 4, y: at.y, z: at.z, range: 1, dig: false, scaffold: false });
  await context.waitForTicks(params.receiver_wait_ticks + 20);
  return { status: "succeeded", detail: `Tossed from (${bot.entity.position.x.toFixed(2)}, ${bot.entity.position.y.toFixed(2)}, ${bot.entity.position.z.toFixed(2)}) at the receiver ${receiver.position.x.toFixed(2)}, ${receiver.position.y.toFixed(2)}, ${receiver.position.z.toFixed(2)}.` };
}

async function watch(context: ScenarioContext, params: Params): Promise<ClientCompletion> {
  let lastLying = "none seen";
  for (let waited = 0; waited < params.receiver_wait_ticks; waited += 10) {
    const seen = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
    if (seen.status === "succeeded") {
      const held = seen.situation.inventory.stacks.filter((stack) => stack.name === params.item_name).reduce((sum, stack) => sum + stack.count, 0);
      if (held > 0) return { status: "succeeded", detail: `LEDGE_TOSS taken=yes held=${held}` };
      const lying = seen.situation.nearby.droppedItems.find((item) => item.name === params.item_name);
      if (lying) lastLying = `rest_dy=${(lying.position.y - context.bot.entity.position.y).toFixed(2)} rest_dx=${(lying.position.x - context.bot.entity.position.x).toFixed(2)} rest_dz=${(lying.position.z - context.bot.entity.position.z).toFixed(2)}`;
    }
    await context.waitForTicks(10);
  }
  return { status: "succeeded", detail: `LEDGE_TOSS taken=no ${lastLying}` };
}
