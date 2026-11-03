import { z } from "zod";
import { dropItemResultSchema, viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { arenaCell } from "../arena/params.ts";
import type { ArenaFrame } from "../arena/frame.ts";
import { handOverRolesSchema, handOverRun, type HandOverRoles } from "./hand-over-roles.ts";
import type { ScenarioContext, ScenarioRun } from "../scenario.ts";

/** The refusal's codes: a giver that never gets a still recipient (`dropItemOutcomes.recipientMoving`), or one on a floor it cannot toss from (`recipientOutOfReach`), tosses nothing. */
const REFUSAL_CODES = { moving: "[DROP_RECIPIENT_MOVING]", out_of_reach: "[DROP_RECIPIENT_OUT_OF_REACH]" } as const;

const paramsIn = (arena: ArenaFrame) => z.strictObject({
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
  /**
   * The receiver walks to each of `legs` in turn (cells, `x` `z` on the flat floor) before it stands (`then: stand`, and waits for
   * the items) or stops for good (`then: end`: it must hold none of the item, the giver having refused to toss). One far leg is
   * a walk with no pause for the giver to catch it in: a navigate call ends with the bot standing still for a moment.
   */
  receiver_walk: z.strictObject({ legs: z.array(arenaCell(arena)).min(1), then: z.enum(["stand", "end"]) }).optional(),
  /** `moving`: the giver must be refused with `[DROP_RECIPIENT_MOVING]` and toss nothing (the receiver never stands still); `out_of_reach`: with `[DROP_RECIPIENT_OUT_OF_REACH]` (the receiver stands still on a floor the giver cannot toss from). */
  giver_expects: z.enum(["taken", "moving", "out_of_reach"]).default("taken"),
});

type Params = z.output<ReturnType<typeof paramsIn>>;

/**
 * One driver for both declared players: the giver hands the items over with `drop_item` and `to_player` and must
 * report them taken; the receiver stands still and finishes when it holds them (or when its wait runs out, which the
 * scenario's `hasItem` goal then fails).
 */
export const run: ScenarioRun = handOverRun(paramsIn, give, receive);

async function give(context: ScenarioContext, params: Params, roles: HandOverRoles): Promise<ClientCompletion> {
  // The first inventory item is in the hand; the toss is the point of the scenario, not the hand check.
  const output = await context.call("drop_item", { items: [{ item_name: params.item_name, count: params.count }], to_player: roles.receiver, allow_equipped: true });
  if (params.giver_expects !== "taken") {
    const code = REFUSAL_CODES[params.giver_expects];
    const refused = output.result.status === "failed" && output.summary.includes(code);
    return { status: refused ? "succeeded" : "failed", detail: refused ? `Refused, nothing tossed; ${output.summary}` : `Expected ${code}; ${output.summary}` };
  }
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

/** The receiver walks to each leg in turn; the failure of the first leg it could not walk, or null. */
async function walkLegs(context: ScenarioContext, walk: NonNullable<Params["receiver_walk"]>): Promise<string | null> {
  for (const cell of walk.legs) {
    const step = await context.call("navigate", { ...cell, range: 1, dig: false, scaffold: false });
    if (step.result.status !== "succeeded") return step.summary;
  }
  return null;
}

/** What the receiver holds of the item, and the `view_status` summary it read that from. */
async function seeHeld(context: ScenarioContext, itemName: string): Promise<{ held: number; summary: string }> {
  const seen = await context.call("view_status", {});
  const status = viewStatusResultSchema.parse(seen.result);
  const held = status.status === "succeeded"
    ? status.situation.inventory.stacks.filter((stack) => stack.name === itemName).reduce((sum, stack) => sum + stack.count, 0)
    : 0;
  return { held, summary: seen.summary };
}

async function receive(context: ScenarioContext, params: Params): Promise<ClientCompletion> {
  if (params.receiver_walk) {
    const failure = await walkLegs(context, params.receiver_walk);
    if (failure) return { status: "failed", detail: `The receiver could not walk: ${failure}` };
    if (params.receiver_walk.then === "end") {
      const { held } = await seeHeld(context, params.item_name);
      return held === 0 ? { status: "succeeded", detail: "Walked, holds none." } : { status: "failed", detail: `The receiver holds ${held} ${params.item_name}; nothing was to be tossed.` };
    }
  }
  if (params.giver_expects === "out_of_reach") {
    // The giver is refused and tosses nothing: this receiver stays still on its floor through the giver's whole wait, then holds none.
    await context.waitForTicks(params.receiver_wait_ticks);
    const { held } = await seeHeld(context, params.item_name);
    return held === 0 ? { status: "succeeded", detail: "Stood still, holds none." } : { status: "failed", detail: `The receiver holds ${held} ${params.item_name}; nothing was to be tossed.` };
  }
  let lastSeen = "";
  for (let waited = 0; waited < params.receiver_wait_ticks; waited += 10) {
    const { held, summary } = await seeHeld(context, params.item_name);
    lastSeen = summary.match(/Position; [^;]*;|Dropped items[^;]*;[^;]*/gu)?.join(" ") ?? "";
    if (held >= (params.receiver_holds ?? params.count)) return { status: "succeeded", detail: `Holds ${held} ${params.item_name}.` };
    await context.waitForTicks(10);
  }
  return { status: "failed", detail: `Never held ${params.receiver_holds ?? params.count} ${params.item_name}; last seen: ${lastSeen}` };
}
