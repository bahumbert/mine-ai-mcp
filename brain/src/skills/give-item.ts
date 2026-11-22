// Giving an item to a player (give_item): walk up to them, then drop it at them, keeping what an agreed trade owes to someone else.
import { handedOver, recipientSettled, recipientTook, tossSpot } from "../give-result.ts";
import { carriedOf, owedSentence, spareFor } from "../relations/items.ts";
import type { Position } from "../runtime-client.ts";
import type { SkillContext, SkillResult } from "../skills.ts";
import { come } from "./follow.ts";
import { findPlayer } from "./positions.ts";

/** The code `drop_item` answers with when the recipient never stood still: nothing was tossed. */
const RECIPIENT_MOVING_CODE = "[DROP_RECIPIENT_MOVING]";

/** The code `drop_item` answers with when the recipient stands still on a floor no toss from a reachable one rests at their feet from (a ledge): nothing was tossed. */
const RECIPIENT_OUT_OF_REACH_CODE = "[DROP_RECIPIENT_OUT_OF_REACH]";

/** How far across (blocks) a failed walk to a player may have ended for the hand-over's own approach to take over. */
const BESIDE_RANGE = 6;

/** Whether the player is seen and within `BESIDE_RANGE` blocks across of where I stand (a height difference does not count). */
async function endedBeside(context: SkillContext, player: string): Promise<boolean> {
  const status = await context.runtime.status();
  const seen = findPlayer(status, player)?.position;
  return seen != null && Math.hypot(seen.x - status.position.x, seen.z - status.position.z) <= BESIDE_RANGE;
}

export async function giveItem(context: SkillContext, player: string, item: string, count: number): Promise<SkillResult> {
  const owed = context.owed?.() ?? [];
  const holding = owedSentence(owed, item, player);
  if (holding !== "") {
    const spare = spareFor(carriedOf((await context.runtime.status()).inventory, item), owed, item, player);
    if (count > spare) return { status: "failed", detail: `${holding}: you can give ${spare}; keep the rest for them` };
  }
  const { result, taken } = await giveTo(context, player, item, count);
  return result.status === "done" && taken !== null ? { ...result, taken } : result;
}

/** The reason a refused hand-over tells the code that must act on it (a recipient to try again later, or one out of reach by height). */
function failedGiveReason(error: string | null | undefined): { readonly reason: "recipient_busy" | "recipient_unreachable" } | Record<string, never> {
  if (error?.startsWith(RECIPIENT_MOVING_CODE)) return { reason: "recipient_busy" };
  if (error?.startsWith(RECIPIENT_OUT_OF_REACH_CODE)) return { reason: "recipient_unreachable" };
  return {};
}

/**
 * A hand-over to a player: how it went, how many of the items the recipient took (null when the runtime says nothing of a
 * recipient), and whether the answer is settled: false when the server had not said yet (late or stopped), so the count
 * may be short of what happened. An old runtime names no `settled`: read as settled.
 */
export async function giveTo(context: SkillContext, player: string, item: string, count: number): Promise<{ readonly result: SkillResult; readonly taken: number | null; readonly settled: boolean; readonly droppedAt: Position | null }> {
  const approach = await come(context, player);
  // A walk that failed beside the player is not the end: the drop's own approach knows the stance and names a recipient out of reach by height (F3: a pillar made `come` fail with a plain navigation error, hiding recipient_unreachable). A walk that failed far away keeps its own error: the drop would call distance or water a ledge.
  if (approach.status !== "done" && !(approach.status === "failed" && await endedBeside(context, player))) return { result: approach, taken: null, settled: true, droppedAt: null };
  const outcome = await context.body.act("drop_item", { items: [{ item_name: item, count }], to_player: player, allow_equipped: true }, `${player} asked me for ${item}.`, { signal: context.signal });
  if (context.signal.aborted) return { result: { status: "stopped" }, taken: null, settled: true, droppedAt: null };
  if (outcome.status !== "succeeded") return { result: { status: "failed", detail: outcome.error ?? `drop_item ${outcome.status}`, ...failedGiveReason(outcome.error) }, taken: null, settled: true, droppedAt: null };
  const detail = handedOver(outcome.result) === false ? `left ${count} ${item} at ${player}'s feet (not picked up yet)` : `gave ${count} ${item} to ${player}`;
  return { result: { status: "done", detail }, taken: recipientTook(outcome.result), settled: recipientSettled(outcome.result), droppedAt: tossSpot(outcome.result) };
}
