// The walking and sealing parts of a drop_item request: reaching a player or the pit, leaving the toss, closing the hole.
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";
import { customGoal, HORIZONTAL_TICKS_PER_BLOCK, nearEntityGoal } from "../../navigation/index.js";
import type { ActionContext } from "../action.js";
import { describeNavigation } from "../navigation-result.js";
import { waitForSignal } from "../../utils/signals.js";
import { isInWater } from "../../survival/perception/body.js";
import { dropItemOutcomes, type DropRecipient, type HoleClosure } from "./contract.js";
import { pluggedCellCount, sealDisposalHole } from "./disposal-hole.js";
import type { DropItemDependencies } from "./drop-item.js";

/** How close the bot gets before handing items over. Within this, a toss lands at their feet. */
const HANDOVER_RANGE = 2;

/**
 * How far, in the plane, the bot ends a hole drop from the hole's column.
 *
 * Three blocks puts the whole rim between the bot and the pit, so the next
 * request's route starts from open ground rather than from the lip.
 */
const HOLE_CLEARANCE = 3;

export class DropItemActionError extends Error {}

/** Walk to the named player and face them, so a toss lands at their feet rather than ours. */
export async function approachPlayer(
  bot: Bot,
  name: string,
  dependencies: DropItemDependencies,
  context: ActionContext,
): Promise<DropRecipient> {
  const entity: Entity | undefined = bot.players[name]?.entity;
  if (!entity) throw new DropItemActionError(dropItemOutcomes.playerNotFound(name));

  if (bot.entity.position.distanceTo(entity.position) > HANDOVER_RANGE) {
    const route = await dependencies
      .navigate({
        movements: dependencies.createMovements(bot),
        goal: nearEntityGoal({ id: entity.id }, HANDOVER_RANGE),
        signal: context.signal,
      })
      .catch((cause: unknown) => {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new DropItemActionError(dropItemOutcomes.playerUnreachable(name, reason), { cause });
      });

    // The goal tracks a live entity, so a player who walks off invalidates it.
    const arrived = bot.players[name]?.entity;
    if (!arrived) throw new DropItemActionError(dropItemOutcomes.playerLeft(name));
    if (bot.entity.position.distanceTo(arrived.position) > HANDOVER_RANGE) {
      throw new DropItemActionError(dropItemOutcomes.playerUnreachable(name, describeNavigation(route)));
    }
  }

  const target = bot.players[name]?.entity;
  if (!target) throw new DropItemActionError(dropItemOutcomes.playerLeft(name));
  await bot.lookAt(target.position);
  return {
    name,
    distance: Number(bot.entity.position.distanceTo(target.position).toFixed(2)),
    position: { x: target.position.x, y: target.position.y, z: target.position.z },
  };
}

/** Walk to the feet cell of a stance chosen for the pit; the failure reason, or nothing once there. */
export async function walkToStance(
  bot: Bot,
  stance: Vec3,
  dependencies: DropItemDependencies,
  context: ActionContext,
): Promise<string | undefined> {
  const goal = customGoal(
    `pit-stance:${stance.x},${stance.y},${stance.z}`,
    (node) => node.feet.x === stance.x && node.feet.y === stance.y && node.feet.z === stance.z,
    (node) =>
      (Math.abs(node.feet.x - stance.x) + Math.abs(node.feet.z - stance.z) + Math.abs(node.feet.y - stance.y)) *
      HORIZONTAL_TICKS_PER_BLOCK,
  );
  try {
    const route = await dependencies.navigate({ movements: dependencies.createMovements(bot), goal, signal: context.signal });
    const here = bot.entity.position.floored();
    return here.equals(stance) ? undefined : describeNavigation(route);
  } catch (cause) {
    context.signal?.throwIfAborted();
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/** How far from where the items landed a ground drop walks before the pickup check. */
const GROUND_CLEARANCE = 4;

/**
 * Walk at least `GROUND_CLEARANCE` blocks from a ground toss: first the way opposite to where the bot faced when
 * tossing, then the sides, then ahead. A route that does not get there is not an error here: the check that follows
 * reports whatever came back.
 */
export async function walkAwayFromToss(
  bot: Bot,
  from: { x: number; z: number },
  dependencies: DropItemDependencies,
  context: ActionContext,
): Promise<void> {
  const yaw = bot.entity.yaw ?? 0;
  // Mineflayer's yaw 0 faces -z, and a positive yaw turns toward -x.
  const ahead = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  const sides = [
    { x: -ahead.x, z: -ahead.z },
    { x: -ahead.z, z: ahead.x },
    { x: ahead.z, z: -ahead.x },
    ahead,
  ];
  for (const [index, side] of sides.entries()) {
    const reach = (node: { feet: { x: number; z: number } }) => (node.feet.x + 0.5 - from.x) * side.x + (node.feet.z + 0.5 - from.z) * side.z;
    const goal = customGoal(
      `clear-of-toss:${index}:${from.x.toFixed(1)},${from.z.toFixed(1)}`,
      (node) => reach(node) >= GROUND_CLEARANCE,
      (node) => Math.max(0, GROUND_CLEARANCE - reach(node)) * HORIZONTAL_TICKS_PER_BLOCK,
    );
    try {
      await dependencies.navigate({ movements: dependencies.createMovements(bot), goal, signal: context.signal });
    } catch {
      context.signal?.throwIfAborted();
    }
    if (Math.hypot(bot.entity.position.x - from.x, bot.entity.position.z - from.z) >= GROUND_CLEARANCE) return;
  }
}

/** Walk clear of the hole so the next request's route does not start beside, or in, the pit. */
async function stepAwayFromHole(
  bot: Bot,
  hole: Vec3,
  dependencies: DropItemDependencies,
  context: ActionContext,
): Promise<{ distance: number; error?: string }> {
  const column = { x: hole.x + 0.5, z: hole.z + 0.5 };
  const distanceFrom = (position: { x: number; z: number }) =>
    Math.hypot(position.x - column.x, position.z - column.z);
  const goal = customGoal(
    `clear-of-hole:${hole.x},${hole.y},${hole.z}`,
    (node) => distanceFrom({ x: node.feet.x + 0.5, z: node.feet.z + 0.5 }) >= HOLE_CLEARANCE,
    (node) =>
      Math.max(0, HOLE_CLEARANCE - distanceFrom({ x: node.feet.x + 0.5, z: node.feet.z + 0.5 })) *
      HORIZONTAL_TICKS_PER_BLOCK,
  );
  try {
    const route = await dependencies.navigate({
      movements: dependencies.createMovements(bot),
      goal,
      signal: context.signal,
    });
    const distance = Number(distanceFrom(bot.entity.position).toFixed(2));
    return distance >= HOLE_CLEARANCE
      ? { distance }
      : { distance, error: `[DROP_HOLE_BESIDE] Still ${distance} blocks from the hole: ${describeNavigation(route)}` };
  } catch (cause) {
    context.signal?.throwIfAborted();
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      distance: Number(distanceFrom(bot.entity.position).toFixed(2)),
      error: `[DROP_HOLE_BESIDE] Could not step back from the hole: ${reason}`,
    };
  }
}

/**
 * Plug the pit and step back from it.
 *
 * A collect request issued straight after a hole drop routed the bot back
 * into the open pit it had just tossed into. Neither step changes the drop's
 * outcome, so both report into the evidence rather than the status.
 */
export async function closeDisposalHole(
  bot: Bot,
  hole: Vec3,
  dependencies: DropItemDependencies,
  context: ActionContext,
  /** An earlier attempt already began plugging: what it placed is counted from the world, not from this call. */
  resumed = false,
  /** The block the burial kept back to plug with, when it kept one. */
  plugItem?: string,
): Promise<HoleClosure> {
  const seal = await sealDisposalHole(bot, hole, dependencies.placeInto, context, { plugItem });
  const retreat = await stepAwayFromHole(bot, hole, dependencies, context);
  const errors = [seal.error, retreat.error].filter((error): error is string => error !== undefined);
  return {
    item: seal.item,
    placed: resumed ? Math.max(seal.placed, pluggedCellCount(bot, hole)) : seal.placed,
    distance: retreat.distance,
    ...(errors.length > 0 && { error: errors.join(" ") }),
  };
}

/** How long a bot in the air is given to land before a ground toss is refused. */
const GROUNDED_WAIT_MS = 1_000;

/**
 * Whether the body can walk off after a toss at its feet: standing on the ground, in water or in a vehicle. A bot held in
 * the air (a ghost-air pin, run 16: 58 ground tosses, every one picked straight back up) cannot, so the toss is refused
 * up front with the next step instead of reported as picked up again. A body that lands within the wait is no refusal.
 */
export async function canWalkOffAfterToss(
  bot: Bot,
  dependencies: Pick<DropItemDependencies, "groundedWaitMs">,
  context: ActionContext,
): Promise<boolean> {
  const supported = () => bot.entity.onGround || isInWater(bot) || Boolean(bot.entity.vehicle);
  return (
    supported() ||
    (await waitForSignal(supported, bot, "physicsTick", { timeoutMs: dependencies.groundedWaitMs ?? GROUNDED_WAIT_MS, context })) === true
  );
}
