// The cells around a bot that is hiding: where it stands, whether the box is closed, who is inside it.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { navigationFeet } from "../../navigation/world/block-geometry.js";
import { cellIntersectsBody } from "../../utils/geometry.js";
import type { WorldBlock } from "../../world/index.js";
import type { ResponseContext } from "../control/combat/context.js";
import { isThreat } from "../perception/combat/threats.js";
import { fullProtectionBlock } from "../positioning/combat/build-protection.js";
import { PROTECTION_SIDES, protectionShell } from "../positioning/combat/planner.js";

export type Entity = Parameters<Bot["attack"]>[0];

export const SIDES = PROTECTION_SIDES;
/** A mob this close is in the shaft with the bot, and the only fight left is the one at arm's length. */
const SHAFT_REACH = 2;

export function shelterFeet(bot: Bot): Vec3 {
  const cell = navigationFeet(bot.entity.position, bot.entity.onGround);
  return new Vec3(cell.x, cell.y, cell.z);
}

export function solid(block: WorldBlock | null): block is WorldBlock {
  return block?.boundingBox === "block";
}

export function diggable(block: WorldBlock | null): block is WorldBlock {
  return solid(block) && block.name !== "bedrock" && block.hardness !== null && block.hardness >= 0;
}

/** The cells that make a closed box around a bot standing at `feet`: four sides at each level, and the cap. */
function shell(feet: Vec3): readonly Vec3[] {
  return protectionShell(feet, [feet]);
}

export function enclosedInPlace(bot: Bot, blockNames?: readonly string[]): boolean {
  return shell(shelterFeet(bot)).every((cell) => {
    const block = bot.blockAt(cell);
    return fullProtectionBlock(block) && (!blockNames || blockNames.includes(block!.name));
  });
}

/** An authorized threat occupying the body or shelter shell; never chase beyond construction space. */
export function shelterIntruder(bot: Bot, context: ResponseContext): Entity | null {
  for (const id in bot.entities) {
    const entity = bot.entities[id];
    // Multipart dragon contact belongs to the End owner, not shaft melee.
    if (entity?.name === "ender_dragon") continue;
    if (!isThreat(bot, entity, context)) continue;
    const delta = entity.position.minus(bot.entity.position);
    const feet = shelterFeet(bot);
    if (
      delta.y >= -1 &&
      delta.y <= SHAFT_REACH &&
      [feet, feet.offset(0, 1, 0), ...shell(feet)].some((cell) => cellIntersectsBody(cell, entity))
    )
      return entity;
  }
  return null;
}

/** The four sides, the one facing the nearest hostile first, so cover goes up where the arrows come from. */
export function sidesByThreat(bot: Bot, context: ResponseContext): readonly Vec3[] {
  let nearest: Entity | null = null;
  for (const id in bot.entities) {
    const entity = bot.entities[id];
    if (!isThreat(bot, entity, context)) continue;
    if (
      !nearest ||
      entity.position.distanceTo(bot.entity.position) < nearest.position.distanceTo(bot.entity.position)
    ) {
      nearest = entity;
    }
  }
  if (!nearest) return SIDES;
  const toward = nearest.position.minus(bot.entity.position);
  return [...SIDES].sort((left, right) => right.dot(toward) - left.dot(toward));
}
