import { z } from "zod";
import { dropItemResultSchema, viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { handOverRolesOf, handOverRolesSchema, type HandOverRoles } from "./hand-over-roles.ts";
import type { ScenarioContext, ScenarioRun } from "../scenario.ts";

/** The most `pick_up_items` accepts as a radius (`src/actions/pick-up-items`): a toss resting farther cannot be picked back. */
const TOOL_RADIUS_LIMIT = 32;

const paramsSchema = z.strictObject({
  /** Places in the scenario's `players` list. */
  ...handOverRolesSchema,
  item_name: z.string().min(1),
  count: z.number().int().positive(),
  /** Only names the ground the toss lands on in the result line. */
  surface: z.string().min(1),
  /** `measure` logs where the refused toss rests; `guard` also picks it back up with `pick_up_radius` and needs it all back. */
  mode: z.enum(["measure", "guard"]),
  /** The brain's pick-back radius (`PICK_BACK_RADIUS`, relations/handoff.ts; `handoff.test.ts` keeps the two equal). */
  pick_up_radius: z.number().int().positive().max(TOOL_RADIUS_LIMIT).optional(),
  /** How long the receiver stands on after it first sees the toss: longer than the toss's own settle wait (100 ticks). */
  receiver_stay_ticks: z.number().int().positive().default(240),
  receiver_wait_ticks: z.number().int().positive().default(400),
});

type Params = z.output<typeof paramsSchema>;

/**
 * Where a toss to a player who cannot pick it up comes to rest, measured as `pick_up_items` filters: the 3-D distance
 * from the spot the giver tossed from (`droppedAt`). Gives the brain's pick-back radius its number (plan 2026-11-01-trading-tickets-2-6 C1).
 */
export const run: ScenarioRun = async (context) => {
  const params = paramsSchema.parse(context.scenario.params);
  const roles = handOverRolesOf(context, params);
  return roles.isGiver ? give(context, params, roles) : stand(context, params);
};

async function groundItems(context: ScenarioContext, itemName: string) {
  const seen = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
  return seen.status === "succeeded" ? seen.situation.nearby.droppedItems.filter((item) => item.name === itemName) : [];
}

async function give(context: ScenarioContext, params: Params, roles: HandOverRoles): Promise<ClientCompletion> {
  const output = await context.call("drop_item", { items: [{ item_name: params.item_name, count: params.count }], to_player: roles.receiver, allow_equipped: true });
  const result = dropItemResultSchema.parse(output.result);
  if (result.status !== "succeeded") return { status: "failed", detail: output.summary };
  const { recipient, droppedAt } = result.drop;
  if (recipient?.collected !== false || recipient.collectedCount !== 0 || recipient.settled !== true) return { status: "failed", detail: `The receiver was expected to take nothing; ${output.summary}` };
  const resting = await groundItems(context, params.item_name);
  if (resting.length === 0) return { status: "failed", detail: `No ${params.item_name} lies on the ground after the toss (${params.surface}); ${output.summary}` };
  const rest = Math.max(...resting.map((item) => Math.hypot(item.position.x - droppedAt.x, item.position.y - droppedAt.y, item.position.z - droppedAt.z)));
  const measured = `TOSS_REST surface=${params.surface} rest=${rest.toFixed(2)} receiver=${recipient.distance.toFixed(2)} from=(${droppedAt.x.toFixed(2)},${droppedAt.y.toFixed(2)},${droppedAt.z.toFixed(2)})`;
  if (rest > TOOL_RADIUS_LIMIT) return { status: "failed", detail: `${measured} is past the pick_up_items limit of ${TOOL_RADIUS_LIMIT}` };
  if (params.mode === "measure") return { status: "succeeded", detail: measured };
  if (params.pick_up_radius === undefined) return { status: "failed", detail: `${measured}; a guard scenario needs params.pick_up_radius` };
  const back = await context.call("pick_up_items", { item: params.item_name, ...droppedAt, radius: params.pick_up_radius });
  return back.result.status === "succeeded" ? { status: "succeeded", detail: `${measured}; picked back up: ${back.summary}` } : { status: "failed", detail: `${measured}; could not pick the toss back up with radius ${params.pick_up_radius}: ${back.summary}` };
}

/** The receiver holds a full inventory and only stands: it waits for the toss to show, then stays through the giver's settle wait. */
async function stand(context: ScenarioContext, params: Params): Promise<ClientCompletion> {
  for (let waited = 0; waited < params.receiver_wait_ticks; waited += 10) {
    if ((await groundItems(context, params.item_name)).length > 0) {
      await context.waitForTicks(params.receiver_stay_ticks);
      return { status: "succeeded", detail: "Saw the toss and stayed." };
    }
    await context.waitForTicks(10);
  }
  return { status: "failed", detail: `Never saw ${params.item_name} on the ground.` };
}
