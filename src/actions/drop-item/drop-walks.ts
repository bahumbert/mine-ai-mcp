// The walking and sealing parts of a drop_item request: reaching a player or the pit, leaving the toss, closing the hole.
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";
import { customGoal, HORIZONTAL_TICKS_PER_BLOCK, stanceBesideEntityGoal } from "../../navigation/index.js";
import type { ActionContext } from "../action.js";
import { describeNavigation } from "../navigation-result.js";
import { waitForSignal } from "../../utils/signals.js";
import { isInWater } from "../../survival/perception/body.js";
import { dropItemOutcomes, type DropRecipient, type HoleClosure } from "./contract.js";
import { pluggedCellCount, sealDisposalHole } from "./disposal-hole.js";
import type { DropItemDependencies } from "./drop-item.js";
import { tossAimHeight } from "./hand-over.js";
import { handOverStance, heightBetweenText, heightBlocksStance, HANDOVER_RANGE, inHandOverStance } from "./hand-over-stance.js";
import { startWalkBound, WALK_AWAY_MAX_BLOCKS, WALK_AWAY_MAX_MS } from "./walk-bound.js";
import { awaitStillRecipient, RECIPIENT_STILL_EPSILON, RECIPIENT_STILL_TICKS, RECIPIENT_WAIT_MS, trackRecipientMoves } from "./recipient-still.js";

/** Ticks between facing the recipient and tossing, so the server has the look the toss is thrown along. */
const LOOK_SETTLE_TICKS = 3;

/**
 * How far, in the plane, the bot ends a hole drop from the hole's column.
 *
 * Three blocks puts the whole rim between the bot and the pit, so the next
 * request's route starts from open ground rather than from the lip.
 */
const HOLE_CLEARANCE = 3;

export class DropItemActionError extends Error {}

/**
 * Where a cell counts as being: its centre. The route's goals measure a node by it, and so does the arrival check: the
 * body stops a little short of the node's centre, so a result measured from the body disagreed with the goal that sent
 * it there ("Still 2.93 blocks" after a route that met the 3-block goal).
 */
function cellCentre(cell: { x: number; z: number }): { x: number; z: number } {
  return { x: cell.x + 0.5, z: cell.z + 0.5 };
}

/** The centre of the cell the body's feet are in. */
function feetCellCentre(bot: Bot): { x: number; z: number } {
  return cellCentre(bot.entity.position.floored());
}

/**
 * Why no stance beside a recipient who stood still was reached, as the outcome the brain acts on: a floor too high or too
 * deep to toss from is out of reach (`recipientOutOfReach`: a failed give naming the height, so a retry does not wait for
 * them to come); any other still recipient is a route that found no way (`playerUnreachable`).
 */
function stillRecipientOutcome(bot: Bot, name: string, reason: string): string {
  const entity = bot.players[name]?.entity;
  if (!entity) return dropItemOutcomes.playerLeft(name);
  return heightBlocksStance(bot.entity.position, entity.position)
    ? dropItemOutcomes.recipientOutOfReach(name, heightBetweenText(bot.entity.position, entity.position), entity.position.y > bot.entity.position.y)
    : dropItemOutcomes.playerUnreachable(name, reason);
}

/** The outcome of a walk the deadline or the time left cut: a recipient who moved is one to chase again later, no failure counted. */
function walkCutOutcome(bot: Bot, name: string, recipientMoved: boolean, dependencies: DropItemDependencies): string {
  if (recipientMoved) return recipientMovingOutcome(name, dependencies);
  const seconds = Math.round((dependencies.recipientWaitMs ?? RECIPIENT_WAIT_MS) / 1000);
  return stillRecipientOutcome(bot, name, `no cell beside them was reached within ${seconds} s`);
}

/** Walk to a stance beside the recipient with a route that ends at `deadline`; a route that stops short of one is unreachable. */
async function walkUpToPlayer(
  bot: Bot,
  name: string,
  entity: Entity,
  deadline: AbortSignal,
  recipientMoves: { readonly moved: boolean },
  dependencies: DropItemDependencies,
  context: ActionContext,
): Promise<void> {
  const route = await dependencies
    .navigate({
      movements: dependencies.createMovements(bot),
      goal: stanceBesideEntityGoal({ id: entity.id }, handOverStance),
      signal: context.signal ? AbortSignal.any([context.signal, deadline]) : deadline,
    })
    .catch((cause: unknown) => {
      // A chase the deadline cut is a recipient who kept moving, or one on a floor no route reaches; a cancel stays what the caller aborted with.
      if (deadline.aborted && !context.signal?.aborted) throw new DropItemActionError(walkCutOutcome(bot, name, recipientMoves.moved, dependencies));
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new DropItemActionError(dropItemOutcomes.playerUnreachable(name, reason), { cause });
    });

  // The goal tracks a live entity, so a player who walks off invalidates it.
  const arrived = bot.players[name]?.entity;
  if (!arrived) throw new DropItemActionError(dropItemOutcomes.playerLeft(name));
  // A route that completed with the recipient stepping away just then is a recipient on the move: the wait finds them away.
  if (route.status !== "completed" && !inHandOverStance(bot.entity.position, arrived.position)) {
    const reason = describeNavigation(route);
    throw new DropItemActionError(recipientMoves.moved ? dropItemOutcomes.playerUnreachable(name, reason) : stillRecipientOutcome(bot, name, reason));
  }
}

function recipientMovingOutcome(name: string, dependencies: DropItemDependencies): string {
  return dropItemOutcomes.recipientMoving(name, Math.round((dependencies.recipientWaitMs ?? RECIPIENT_WAIT_MS) / 1000));
}

/** Walk up to the recipient and wait until they stand still within reach: the walks and the waits share one wall-clock bound. */
async function reachStillRecipient(
  bot: Bot,
  name: string,
  dependencies: DropItemDependencies,
  context: ActionContext,
): Promise<void> {
  const waitMs = dependencies.recipientWaitMs ?? RECIPIENT_WAIT_MS;
  const startedAt = performance.now();
  const timeLeft = () => waitMs - (performance.now() - startedAt);
  const awaitStill = dependencies.awaitStillRecipient ?? awaitStillRecipient;
  using recipientMoves = trackRecipientMoves(bot, name, RECIPIENT_STILL_EPSILON);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("The operation timed out.", "TimeoutError")), waitMs);
  try {
    for (;;) {
      const entity = bot.players[name]?.entity;
      if (!entity) throw new DropItemActionError(dropItemOutcomes.playerLeft(name));
      if (timeLeft() <= 0) throw new DropItemActionError(walkCutOutcome(bot, name, recipientMoves.moved, dependencies));
      if (!inHandOverStance(bot.entity.position, entity.position)) {
        await walkUpToPlayer(bot, name, entity, deadline.signal, recipientMoves, dependencies, context);
      }
      const outcome = await awaitStill(bot, name, {
        range: HANDOVER_RANGE,
        inStance: inHandOverStance,
        stillTicks: RECIPIENT_STILL_TICKS,
        epsilon: RECIPIENT_STILL_EPSILON,
        maxWallMs: timeLeft(),
        signal: context.signal,
      });
      if (outcome === "still") return;
      if (outcome === "left") throw new DropItemActionError(dropItemOutcomes.playerLeft(name));
      if (outcome === "timeout") throw new DropItemActionError(recipientMovingOutcome(name, dependencies));
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk to the named player, wait until they stand still within reach and face them, so a toss lands at their feet rather
 * than ours, and is there to be picked up when its delay ends.
 */
export async function approachPlayer(
  bot: Bot,
  name: string,
  dependencies: DropItemDependencies,
  context: ActionContext,
): Promise<DropRecipient> {
  if (!bot.players[name]?.entity) throw new DropItemActionError(dropItemOutcomes.playerNotFound(name));
  await reachStillRecipient(bot, name, dependencies, context);

  const target = bot.players[name]?.entity;
  if (!target) throw new DropItemActionError(dropItemOutcomes.playerLeft(name));
  // Aimed so the toss rests at their feet: facing their body overshot them and facing their feet fell short, back at the
  // giver (B2, 2026-10-19).
  const reach = Math.hypot(target.position.x - bot.entity.position.x, target.position.z - bot.entity.position.z);
  await bot.lookAt(target.position.offset(0, tossAimHeight(reach), 0));
  // The server learns the new pitch with the next position packet; a toss sent before it flies level and overshoots.
  await bot.waitForTicks(LOOK_SETTLE_TICKS);
  return {
    name,
    distance: Number(bot.entity.position.distanceTo(target.position).toFixed(2)),
    position: { x: target.position.x, y: target.position.y, z: target.position.z },
    collected: false,
    collectedCount: 0,
    tossedCount: 0,
    settled: false,
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

/** What a walk off a toss or a hole may cost in all its sides: a route that does not get clear by then is cut. */
const WALK_BOUND = { maxBlocks: WALK_AWAY_MAX_BLOCKS, maxMs: WALK_AWAY_MAX_MS };

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
  using bound = startWalkBound(bot, WALK_BOUND);
  for (const [index, side] of sides.entries()) {
    if (bound.signal.aborted) return;
    const reach = (node: { feet: { x: number; z: number } }) => {
      const centre = cellCentre(node.feet);
      return (centre.x - from.x) * side.x + (centre.z - from.z) * side.z;
    };
    const goal = customGoal(
      `clear-of-toss:${index}:${from.x.toFixed(1)},${from.z.toFixed(1)}`,
      (node) => reach(node) >= GROUND_CLEARANCE,
      (node) => Math.max(0, GROUND_CLEARANCE - reach(node)) * HORIZONTAL_TICKS_PER_BLOCK,
    );
    try {
      await dependencies.navigate({ movements: dependencies.createMovements(bot), goal, signal: context.signal, stopSignal: bound.signal });
    } catch {
      context.signal?.throwIfAborted();
    }
    const centre = feetCellCentre(bot);
    if (Math.hypot(centre.x - from.x, centre.z - from.z) >= GROUND_CLEARANCE) return;
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
    (node) => distanceFrom(cellCentre(node.feet)) >= HOLE_CLEARANCE,
    (node) => Math.max(0, HOLE_CLEARANCE - distanceFrom(cellCentre(node.feet))) * HORIZONTAL_TICKS_PER_BLOCK,
  );
  using bound = startWalkBound(bot, WALK_BOUND);
  try {
    const route = await dependencies.navigate({
      movements: dependencies.createMovements(bot),
      goal,
      signal: context.signal,
      stopSignal: bound.signal,
    });
    const distance = Number(distanceFrom(feetCellCentre(bot)).toFixed(2));
    return distance >= HOLE_CLEARANCE
      ? { distance }
      : { distance, error: `[DROP_HOLE_BESIDE] Still ${distance} blocks from the hole: ${describeNavigation(route)}` };
  } catch (cause) {
    context.signal?.throwIfAborted();
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      distance: Number(distanceFrom(feetCellCentre(bot)).toFixed(2)),
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
