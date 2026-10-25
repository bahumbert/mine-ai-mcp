// The movement policy's refusal to break a cell whose digging would open a pit this bot buried items in.
import type { Bot } from "mineflayer";
import { sealedPitGuarding } from "../../world/sealed-pits.js";
import type { PolicyDecision } from "../movements/policy.js";

/**
 * Refused for breaking only, so a build or a walk over the plug stays allowed (run 16: collect and navigate dug down
 * plugged pits).
 */
export function sealedPitRefusal(bot: Bot, x: number, y: number, z: number): PolicyDecision | null {
  const pit = sealedPitGuarding(bot, x, y, z);
  return pit === null ? null : { kind: "prohibited", reason: `it would open the pit of items buried at ${pit.x} ${pit.y} ${pit.z}` };
}
