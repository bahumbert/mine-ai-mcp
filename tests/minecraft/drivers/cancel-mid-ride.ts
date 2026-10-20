import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { ScenarioContext } from "../scenario.ts";

const requestSchema = z.strictObject({
  /** The far land the navigate is aimed at, over a sea the bot crosses by boat. */
  target: z.tuple([z.number(), z.number(), z.number()]),
  /** The cancel comes once the bot sits in a boat and is past this x. */
  cancelPastX: z.number(),
  /** How long after the cancel the navigate may take to settle, and the stopped boat to be looked at. */
  settleWithinMs: z.number().int().positive(),
});

const boatNamed = (name: string | undefined) => name !== undefined && (name.endsWith("_boat") || name.endsWith("_raft"));

/**
 * Cancel a navigate that is riding a boat over deep water: the bot must stay seated in the stopped boat (not swim,
 * not drop the boat), and the next navigate must take the boat back and cross.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { target: [x, y, z], cancelPastX, settleWithinMs } = requestSchema.parse(context.scenario.params);
  const { bot } = context;
  const first = context.call("navigate", { x, y, z, range: 2 });
  const startedAt = performance.now();
  while (!(boatNamed(bot.entity.vehicle?.name) && bot.entity.position.x > cancelPastX)) {
    if (performance.now() - startedAt > 60_000) return { status: "failed", detail: "the bot never rode a boat past the cancel line" };
    await delay(100);
  }
  const cancelledAt = performance.now();
  const cancel = await context.call("cancel_foreground_action", { reason: "scenario cancel in the middle of a boat ride" });
  const settled = await first;
  const waited = Math.round(performance.now() - cancelledAt);
  const boat = bot.entity.vehicle;
  if (settled.result.status === "succeeded") return { status: "failed", detail: `the cancelled navigate succeeded: ${settled.summary}` };
  if (waited > settleWithinMs) return { status: "failed", detail: `the navigate settled ${waited} ms after the cancel, over ${settleWithinMs} ms: ${settled.summary}` };
  if (!boatNamed(boat?.name)) return { status: "failed", detail: `the bot left its boat at the cancel (vehicle ${boat?.name ?? "none"}): ${settled.summary}; cancel: ${cancel.summary}` };
  const stoppedAt = boat!.position.clone();
  await delay(1_000);
  const drift = bot.entity.vehicle === boat ? boat!.position.distanceTo(stoppedAt) : Number.POSITIVE_INFINITY;
  const dropped = Object.values(bot.entities).find((entity) => entity.name === "item" && entity.position.distanceTo(bot.entity.position) < 32);
  if (drift > 1) return { status: "failed", detail: `the boat moved ${drift.toFixed(1)} blocks after the stop, or the bot left it: ${settled.summary}` };
  if (dropped !== undefined) return { status: "failed", detail: `an item entity lies ${Math.round(dropped.position.distanceTo(bot.entity.position))} blocks off after the cancel: ${settled.summary}` };
  // The second navigate rides on from the seat: the same boat all the way, never broken and put in again.
  const secondRide = context.call("navigate", { x, y, z, range: 2 });
  let broken: string | null = null;
  const watchBoat = async () => {
    let done = false;
    secondRide.finally(() => { done = true; });
    while (!done) {
      // Only while seated: the boat is taken back at the far bank, where an item lies for a moment.
      const seat = bot.entity.vehicle;
      const item = seat === null ? undefined : Object.values(bot.entities).find((entity) => entity.name === "item" && entity.position.distanceTo(bot.entity.position) < 32);
      if (item !== undefined) broken ??= "a boat item lay on the water";
      else if (seat !== null && seat !== boat) broken ??= "the bot sat in another boat";
      else if (seat === null && bot.entity.position.x < 90) broken ??= "the bot left the boat before the far bank";
      await delay(100);
    }
  };
  const [next] = await Promise.all([secondRide, watchBoat()]);
  if (broken !== null) return { status: "failed", detail: `the second navigate did not ride on from the seat (${broken}): ${next.summary}` };
  if (next.result.status !== "succeeded") return { status: "failed", detail: `the navigate after the cancel read ${next.result.status}: ${next.summary}; first: ${settled.summary}` };
  const carried = bot.inventory.items().filter((item) => boatNamed(item.name)).reduce((sum, item) => sum + item.count, 0);
  return carried > 0
    ? { status: "succeeded", detail: `cancelled seated (${waited} ms), boat kept still; then ${next.summary}` }
    : { status: "failed", detail: `the second navigate crossed but no boat is carried: ${next.summary}` };
}
