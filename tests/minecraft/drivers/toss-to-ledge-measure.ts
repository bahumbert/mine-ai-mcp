import { z } from "zod";
import { viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { handOverRolesOf, handOverRolesSchema } from "./hand-over-roles.ts";
import type { ScenarioContext, ScenarioRun } from "../scenario.ts";
import { waitServerTicks } from "./server-ticks.ts";
import { pollWithinServerTicks, traceToss } from "./toss-trace.ts";

/** Server ticks the giver stands before it aims, so the body and the receiver are settled. */
const SETTLE_TICKS = 20;
/** Server ticks the aim holds before the toss. */
const LOOK_SETTLE_TICKS = 3;
/** The giver's own wait outlasts the receiver's by this many server ticks, so the receiver's last look is over before the giver ends. */
const RECEIVER_WATCH_MARGIN_TICKS = 20;
/** Physics ticks between two looks of the receiver at its inventory: a cadence, the budget is `receiver_wait_ticks` of server time. */
const RECEIVER_LOOK_EVERY_PHYSICS_TICKS = 10;

const paramsSchema = z.strictObject({
  /** Places in the scenario's `players` list. */
  ...handOverRolesSchema,
  item_name: z.string().min(1),
  /** Height the giver aims at above the receiver's feet: the toss's pitch decides where it rests (`tossAimHeight`, drop-item/hand-over.ts, at this reach). */
  aim_height: z.number(),
  /** How long the receiver watches its inventory, counted from its own start (server ticks, read from the world age): the giver's settles and walk-off come first, and what is left is past the 40-tick pickup delay. */
  receiver_wait_ticks: z.number().int().positive().default(160),
  /** The giver adds `TOSS_TRACE` lines (its feet, velocity and look, the items near it, who collected one) from the toss to 60 server ticks after the walk-off (`toss-trace.ts`). */
  trace: z.boolean().default(false),
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
  // `bot.players` also lists the players of the other lanes, which have no entity here: the receiver is the one seen (2 of 3 repeats took another lane's player and failed).
  const receiver = Object.values(bot.players).find((player) => player.username !== bot.username && player.entity)?.entity;
  if (!receiver) return { status: "failed", detail: "The receiver is not seen." };
  // `waitServerTicks` rounds up to whole 20-tick time packets plus one (`server-ticks.ts`): both settles are 40 server ticks.
  await waitServerTicks(bot, SETTLE_TICKS);
  await bot.lookAt(receiver.position.offset(0, params.aim_height, 0));
  await waitServerTicks(bot, LOOK_SETTLE_TICKS);
  const stack = bot.inventory.items().find((item) => item.name === params.item_name);
  if (!stack) return { status: "failed", detail: `No ${params.item_name} carried.` };
  const reach = Math.hypot(receiver.position.x - bot.entity.position.x, receiver.position.z - bot.entity.position.z);
  const at = bot.entity.position.floored();
  const tossAndWalkOff = async () => {
    await bot.toss(stack.type, null, 1);
    // As a hand-over does: a giver left standing beside its own toss picks it back up (B2, 2026-10-19).
    await context.call("navigate", { x: at.x - 4, y: at.y, z: at.z, range: 1, dig: false, scaffold: false });
  };
  const traced: { value: void; lines: string[] } = params.trace
    ? await traceToss(bot, tossAndWalkOff)
    : { value: await tossAndWalkOff(), lines: [] };
  const { lines } = traced;
  await waitServerTicks(bot, params.receiver_wait_ticks + RECEIVER_WATCH_MARGIN_TICKS);
  const tossed = `Tossed at reach ${reach.toFixed(2)} from (${bot.entity.position.x.toFixed(2)}, ${bot.entity.position.y.toFixed(2)}, ${bot.entity.position.z.toFixed(2)}) at the receiver ${receiver.position.x.toFixed(2)}, ${receiver.position.y.toFixed(2)}, ${receiver.position.z.toFixed(2)}.`;
  return { status: "succeeded", detail: [tossed, ...lines].join("\n") };
}

async function watch(context: ScenarioContext, params: Params): Promise<ClientCompletion> {
  let lastLying = "none seen";
  const polled = await pollWithinServerTicks(context.bot, params.receiver_wait_ticks, RECEIVER_LOOK_EVERY_PHYSICS_TICKS, async () => {
    const seen = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
    if (seen.status !== "succeeded") return undefined;
    const held = seen.situation.inventory.stacks.filter((stack) => stack.name === params.item_name).reduce((sum, stack) => sum + stack.count, 0);
    if (held > 0) return held;
    const lying = seen.situation.nearby.droppedItems.find((item) => item.name === params.item_name);
    if (lying) lastLying = `rest_dy=${(lying.position.y - context.bot.entity.position.y).toFixed(2)} rest_dx=${(lying.position.x - context.bot.entity.position.x).toFixed(2)} rest_dz=${(lying.position.z - context.bot.entity.position.z).toFixed(2)}`;
    return undefined;
  });
  return { status: "succeeded", detail: "found" in polled ? `LEDGE_TOSS taken=yes held=${polled.found}` : `LEDGE_TOSS taken=no ${lastLying}` };
}
