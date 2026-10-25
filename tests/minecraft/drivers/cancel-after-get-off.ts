import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { Bot } from "mineflayer";
import type { ArenaFrame } from "../arena/frame.ts";
import { arenaPoint } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";

const requestSchemaIn = (arena: ArenaFrame) => z.strictObject({
  /** The far land the navigate is aimed at, over a sea whose last blocks before it are shallow. */
  target: arenaPoint(arena),
});

/** The shift press: `entity_action` action 0, what `writeShiftKey` writes on 1.21.4 (`navigation/mineflayer/sneak.ts`). */
const SHIFT_PRESS = 0;
/** A boat entity this close to her feet is the one she stands on. */
const UNDER_FEET_BLOCKS = 2;
const boatNamed = (name: string | undefined) => name !== undefined && (name.endsWith("_boat") || name.endsWith("_raft"));

/**
 * Calls `onShiftAfterSeated` at the first shift press that goes out while she sits in a boat: the get-off of a ride's
 * end. Returns the restore of the client's `write`. (`bot._client.on("packet")` hears incoming packets only.)
 */
function watchGetOffShift(bot: Bot, onShiftAfterSeated: () => void): () => void {
  const client = bot._client;
  const write = client.write;
  let seen = false;
  client.write = function (this: unknown, name: string, params: unknown) {
    const sent = write.call(client, name, params);
    if (!seen && name === "entity_action" && (params as { actionId?: number }).actionId === SHIFT_PRESS && boatNamed(bot.entity.vehicle?.name)) {
      seen = true;
      onShiftAfterSeated();
    }
    return sent;
  } as typeof client.write;
  return () => void (client.write = write);
}

/**
 * Cancel a navigate at the get-off that ends its boat ride: the get-off takes no signal and runs to its end, and the
 * take-back after it, which checks the signal before its first hit, never hits. She is left standing on the boat she
 * rode, over water two deep by the shore, with none carried. The next navigate must free her (take the boat back) and
 * cross.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { target: [x, y, z] } = requestSchemaIn(context.arena).parse(context.scenario.params);
  const { bot } = context;
  const restore = watchGetOffShift(bot, () => {
    void context.call("cancel_foreground_action", { reason: "scenario cancel at the get-off of a boat ride" });
  });
  const first = await context.call("navigate", { x, y, z, range: 2 }).finally(restore);
  if (first.result.status === "succeeded") return { status: "failed", detail: `state not reached: the cancelled navigate succeeded: ${first.summary}` };
  const carried = () => bot.inventory.items().filter((item) => boatNamed(item.name)).reduce((sum, item) => sum + item.count, 0);
  const boats = Object.values(bot.entities).filter((entity) => boatNamed(entity.name));
  const nearest = Math.min(...boats.map((boat) => boat.position.distanceTo(bot.entity.position)));
  if (bot.entity.vehicle !== null || carried() > 0 || nearest > UNDER_FEET_BLOCKS) {
    const where = `seated ${bot.entity.vehicle !== null}, boats carried ${carried()}, boat within ${UNDER_FEET_BLOCKS} blocks ${nearest <= UNDER_FEET_BLOCKS} (nearest of ${boats.length} boats ${Number.isFinite(nearest) ? nearest.toFixed(1) : "none"} off, she at ${bot.entity.position.toString()})`;
    return { status: "failed", detail: `state not reached (${where}): ${first.summary}` };
  }
  const second = await context.call("navigate", { x, y, z, range: 2 });
  if (second.result.status !== "succeeded") return { status: "failed", detail: `the navigate from the boat she stood on read ${second.result.status}: ${second.summary}; first: ${first.summary}` };
  return carried() === 1
    ? { status: "succeeded", detail: `left on the boat (${first.summary}); then ${second.summary}` }
    : { status: "failed", detail: `the second navigate crossed with ${carried()} boats carried, one expected: ${second.summary}` };
}
