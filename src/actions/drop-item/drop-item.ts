import { sleepMs } from "../../utils/wall-timers.js";
import { dropCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import type { BreakBlockInPlace } from "../../navigation/execution/in-place-break.js";
import { createMovements, type Navigate, type NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import type { ObserveRequest } from "../../session/request.js";
import { createDiscardedItems, type DiscardedItems } from "../../world/discarded-items.js";
import { rememberSealedPit } from "../../world/sealed-pits.js";
import { carriedCount } from "../../world/inventory-count.js";
import { droppedItemName, isItemEntity, snapshotEntityIds } from "../../world/item-pickup.js";
import { placeSolidBlockInto } from "../../world/placement.js";
import { defineAction, type ActionContext, type RequestExecution } from "../action.js";
import { equipmentSlots } from "../equip/index.js";
import {
  dropItemAnnotations,
  dropItemOutcomes,
  NEVER_DROPPED_SLOTS,
  parseDropItemRequest,
  DROP_ITEM,
  DROP_ITEM_DESCRIPTION,
  dropItemInputSchema,
  dropItemResultSchema,
  type DropItemEvidence,
  type DroppedItem,
  type DropRecipient,
  type DropItemRequest,
  type DropItemResult,
  type HoleClosure,
} from "./contract.js";
import {
  DisposalHoleError,
  observeHoleDrops,
  pluggedCellCount,
  prepareDisposalHole,
  snapshotDroppedCounts,
  type PitMemory,
} from "./disposal-hole.js";
import { approachPlayer, canWalkOffAfterToss, closeDisposalHole, DropItemActionError, walkAwayFromToss, walkToStance } from "./drop-walks.js";
import { planPlugKeep, PLUG_CELLS, type PlugKeep } from "./plug-reserve.js";
import { tossItem, type ItemToss } from "./toss-item.js";

/**
 * How long a toss is given to clear the slot it emptied.
 *
 * A toss is a server round trip: the slot clears when the server acknowledges
 * it, not when the promise resolves. Mining settles observed drops on the same
 * budget (`OBSERVED_DROP_SETTLE_MS`), which is longer than the couple of ticks
 * a receipt normally waits, because a drop that never lands must be reported
 * as not observed rather than merely unconfirmed.
 */
const TOSS_SETTLE_MS = 1_500;

/** Items a bot stands over are picked up again within a couple of seconds; wait this long to see it happen. */
const PICKUP_WAIT_MS = 3_000;

/** A tossed item lands within a couple of blocks; anything further appeared for another reason. */
const DISCARD_ATTRIBUTION_RADIUS = 4;

export interface DropItemDependencies {
  readonly navigate: Navigate;
  readonly breakInPlace: BreakBlockInPlace;
  /** Fills one cell of the hole's shaft with a carried block once the toss is done. */
  readonly placeInto: typeof placeSolidBlockInto;
  readonly createMovements: (bot: Bot) => ReturnType<typeof createMovements>;
  /** How long the server gets to show a toss in the inventory and, for a hole, on the ground. */
  readonly settleMs?: number;
  /** How long after the toss the carried count is read again to catch items picked straight back up. */
  readonly pickupWaitMs?: number;
  /** How long a ground toss waits for a bot in the air to land before it is refused. */
  readonly groundedWaitMs?: number;
}

function productionDependencies(navigation: NavigationRuntime): DropItemDependencies {
  return {
    navigate: navigation.navigate,
    breakInPlace: navigation.breakBlockInPlace,
    placeInto: placeSolidBlockInto,
    createMovements,
  };
}

/** The equipment slot wearing this item, when it is one this action refuses to drop. */
function wornSlot(bot: Bot, itemName: string): string | null {
  const slots = equipmentSlots(bot);
  const byName: Record<(typeof NEVER_DROPPED_SLOTS)[number], string | null> = {
    head: slots.head,
    torso: slots.torso,
    legs: slots.legs,
    feet: slots.feet,
    "off-hand": slots.offHand,
  };
  return NEVER_DROPPED_SLOTS.find((slot) => byName[slot] === itemName) ?? null;
}

/** What one drop request keeps across the attempts a reflex splits it into. */
interface DropProgress {
  readonly freeSlotsBefore: number;
  readonly entityBaseline: ReadonlySet<number>;
  /** Digging may select a shovel or pickaxe; protection refers to the caller's held item, not that tool. */
  readonly heldName: string | undefined;
  /** Per requested item, in request order. */
  readonly tosses: readonly ItemToss[];
  recipient: DropRecipient | null;
  /** What the burial keeps for its plug, planned once the pit is ready (undefined: not planned yet), reused by a resume. */
  plugKeep?: PlugKeep | null;
  /** The pit chosen for the request, from the moment it is chosen: a half-dug one is dug on, not replaced. */
  readonly pit: PitMemory;
  hole: Vec3 | null;
  /** Dropped stacks on the ground when the pit was ready, so the observer counts only what the tosses added. */
  holeBaseline: ReadonlyMap<number, number> | null;
  /** How many times plugging the hole was started: a second one is a resumed plug. */
  closings: number;
  droppedAt: { x: number; y: number; z: number } | null;
}

function startDropProgress(bot: Bot, request: DropItemRequest): DropProgress {
  return {
    freeSlotsBefore: bot.inventory.emptySlotCount(),
    entityBaseline: snapshotEntityIds(bot),
    heldName: bot.heldItem?.name,
    tosses: request.items.map(({ itemName }) => ({ baseline: carriedCount(bot, itemName), tossed: 0, keptForPlug: 0, pending: null })),
    recipient: null,
    pit: { bottom: null },
    hole: null,
    holeBaseline: null,
    closings: 0,
    droppedAt: null,
  };
}

/**
 * Mark the items this toss created so no sweep picks them straight back up.
 *
 * Only entities that appeared during the toss and are close enough to have come
 * from it are attributed to it. Metadata can arrive a tick after the entity, so
 * an item whose name is not yet readable is still claimed: an unattributed
 * discard is worse than a slightly wide one, and the memory expires anyway.
 */
function rememberDiscards(bot: Bot, baseline: ReadonlySet<number>, discarded: DiscardedItems): void {
  const ids = Object.values(bot.entities)
    .filter((entity) => !baseline.has(entity.id))
    .filter((entity) => entity.position.distanceTo(bot.entity.position) <= DISCARD_ATTRIBUTION_RADIUS)
    .filter((entity) => droppedItemName(entity) !== null || isItemEntity(entity))
    .map((entity) => entity.id);
  discarded.remember(ids);
}

/** The entry for an item this action refuses to drop (worn, or the caller's held item), or nothing. */
function refusedEntry(
  bot: Bot,
  request: DropItemRequest,
  progress: DropProgress,
  itemName: string,
  count: number | null,
): DroppedItem | null {
  const carried = carriedCount(bot, itemName);
  const refusal = (error: string): DroppedItem => ({
    item: itemName,
    requested: count,
    carriedBefore: carried,
    carriedAfter: carried,
    dropped: 0,
    error,
  });
  const worn = wornSlot(bot, itemName);
  if (worn) return refusal(dropItemOutcomes.worn(itemName, worn));
  if (!request.allowEquipped && progress.heldName === itemName) return refusal(dropItemOutcomes.held(itemName));
  return null;
}

/** Per requested item, how many the request still buries: what a refusal or an earlier attempt settled is not counted. */
function plannedTosses(bot: Bot, request: DropItemRequest, progress: DropProgress): Map<string, number> {
  const planned = new Map<string, number>();
  for (const [index, { itemName, count }] of request.items.entries()) {
    const toss = progress.tosses[index]!;
    const refused = toss.tossed === 0 && refusedEntry(bot, request, progress, itemName, count) !== null;
    const left = Math.min(count ?? toss.baseline, toss.baseline) - toss.tossed;
    planned.set(itemName, (planned.get(itemName) ?? 0) + (refused ? 0 : Math.max(0, Math.min(left, carriedCount(bot, itemName)))));
  }
  return planned;
}

/** Decide once, with the pit ready and before the first toss, which blocks the burial keeps carried for its plug. */
function planBurialPlug(bot: Bot, request: DropItemRequest, progress: DropProgress): void {
  progress.plugKeep = planPlugKeep(bot, plannedTosses(bot, request, progress));
  const kept = progress.plugKeep;
  if (kept) progress.tosses[request.items.findIndex(({ itemName }) => itemName === kept.item)]!.keptForPlug = kept.count;
}

/** Toss every requested item that still has something left to toss; items an earlier attempt finished are reported as done. */
async function tossRequested(
  bot: Bot,
  request: DropItemRequest,
  progress: DropProgress,
  context: ActionContext,
  settleMs: number,
): Promise<DroppedItem[]> {
  const dropped: DroppedItem[] = [];
  for (const [index, { itemName, count }] of request.items.entries()) {
    context.signal?.throwIfAborted();
    const toss = progress.tosses[index]!;
    // Refusals are for an item the request has not started on: a reflex that equipped it must not undo a drop under way.
    const refusal = toss.tossed === 0 ? refusedEntry(bot, request, progress, itemName, count) : null;
    dropped.push(refusal ?? (await tossItem(bot, itemName, count, context, settleMs, toss)));
  }
  return dropped;
}

/** The failed result for a destination that could not be reached or prepared; nothing was tossed by this attempt. */
function destinationFailure(bot: Bot, progress: DropProgress, error: string): DropItemResult {
  return {
    status: "failed",
    error,
    drop: {
      dropped: [],
      freeSlotsBefore: progress.freeSlotsBefore,
      freeSlotsAfter: bot.inventory.emptySlotCount(),
      droppedAt: { ...bot.entity.position },
      recipient: null,
      hole: progress.hole,
      holeClosure: null,
    },
  };
}

/** The failure for a ground toss the body cannot walk off after; none once a toss has begun (a resume finishes it). */
async function groundTossRefusal(
  bot: Bot,
  progress: DropProgress,
  dependencies: DropItemDependencies,
  context: ActionContext,
): Promise<DropItemResult | null> {
  if (progress.tosses.some((toss) => toss.tossed > 0)) return null;
  if (await canWalkOffAfterToss(bot, dependencies, context)) return null;
  context.signal?.throwIfAborted();
  return destinationFailure(bot, progress, dropItemOutcomes.groundUnavailable());
}

/** Walk to the player or dig (or dig on) the pit; a failure result when the destination is not usable. */
async function reachDestination(
  bot: Bot,
  request: DropItemRequest,
  progress: DropProgress,
  dependencies: DropItemDependencies,
  context: ActionContext,
): Promise<DropItemResult | null> {
  if (request.destination.kind === "ground") return await groundTossRefusal(bot, progress, dependencies, context);
  if (progress.closings > 0) return null;
  try {
    if (request.destination.kind === "player") {
      progress.recipient = await approachPlayer(bot, request.destination.name, dependencies, context);
      return null;
    }
    progress.hole = await prepareDisposalHole(
      bot,
      dependencies.createMovements(bot),
      dependencies.breakInPlace,
      context,
      (stance) => walkToStance(bot, stance, dependencies, context),
      progress.pit,
    );
    progress.holeBaseline ??= snapshotDroppedCounts(bot);
    return null;
  } catch (cause) {
    context.signal?.throwIfAborted();
    if (!(cause instanceof DropItemActionError) && !(cause instanceof DisposalHoleError)) throw cause;
    return destinationFailure(bot, progress, cause.message);
  }
}

/**
 * Tossed items the bot stands near come straight back (live 2026-10-10 run 7: coal dropped and picked up again, six
 * times over): read the carried count again after a short wait and report only the net drop.
 */
async function netOfPickedUp(
  bot: Bot,
  dropped: DroppedItem[],
  hole: Vec3 | null,
  waitMs: number,
  context: ActionContext,
): Promise<void> {
  await sleepMs(waitMs, context.signal);
  for (const [index, entry] of dropped.entries()) {
    if (entry.dropped <= 0 || entry.error) continue;
    const now = carriedCount(bot, entry.item);
    if (now <= entry.carriedAfter) continue;
    const net = Math.max(0, entry.dropped - (now - entry.carriedAfter));
    dropped[index] = {
      ...entry,
      carriedAfter: now,
      dropped: net,
      ...(net === 0 && {
        error: hole ? dropItemOutcomes.notObserved(entry.item, now) : dropItemOutcomes.pickedUp(entry.item),
      }),
    };
  }
}

/** What happens after the tosses: claim the discards, leave the toss, net out what came back. */
async function settleAfterTosses(
  bot: Bot,
  request: DropItemRequest,
  progress: DropProgress,
  dropped: DroppedItem[],
  dependencies: DropItemDependencies,
  discarded: DiscardedItems,
  context: ActionContext,
): Promise<void> {
  // Claim what this toss put on the ground so the hunt's sweep leaves it alone.
  if (dropped.some((entry) => entry.dropped > 0)) rememberDiscards(bot, progress.entityBaseline, discarded);

  const tossedAt = Date.now();
  const droppedAt = progress.droppedAt ?? { ...bot.entity.position };
  progress.droppedAt = droppedAt;
  const anyDropped = dropped.some((entry) => entry.dropped > 0 && !entry.error);
  // A ground toss lands at the bot's feet and is picked up again once its pickup delay ends (live 2026-10-10 run 9: a
  // cave with no pit in reach, all four items "picked up again", twice): walk off before that, away from where the
  // items landed, and only then wait out the check.
  if (anyDropped && request.destination.kind === "ground") await walkAwayFromToss(bot, droppedAt, dependencies, context);
  if (request.destination.kind !== "player" && anyDropped) {
    const waitMs = Math.max(0, (dependencies.pickupWaitMs ?? PICKUP_WAIT_MS) - (Date.now() - tossedAt));
    await netOfPickedUp(bot, dropped, progress.hole, waitMs, context);
  }
}

/** Check the tosses landed in the pit, then plug it and step back, whether or not they were seen. */
async function finishHole(
  bot: Bot,
  hole: Vec3,
  progress: DropProgress,
  dropped: readonly DroppedItem[],
  dependencies: DropItemDependencies,
  discarded: DiscardedItems,
  context: ActionContext,
): Promise<{ readonly landed: boolean; readonly closure: HoleClosure }> {
  const observed = await observeHoleDrops(
    bot,
    hole,
    progress.holeBaseline ?? new Map<number, number>(),
    dropped,
    context,
    dependencies.settleMs ?? TOSS_SETTLE_MS,
  );
  context.signal?.throwIfAborted();
  // The toss-time claim ran before the server spawned the stacks (run 16): claim the ones now seen in the pit.
  discarded.remember(observed.entityIds);
  // Whether or not the toss was seen at the bottom, an open pit beside the
  // bot is the hazard the next route walks into, so close it either way.
  progress.closings += 1;
  const closure = await closeDisposalHole(bot, hole, dependencies, context, progress.closings > 1, progress.plugKeep?.item);
  // A pit plugged in both cells is where this bot's burials lie: its routes must not dig into it (`sealed-pits.ts`).
  if (pluggedCellCount(bot, hole) === PLUG_CELLS) rememberSealedPit(bot, hole);
  return { landed: observed.landed, closure };
}

/** The result of the whole request from what the attempts did. */
function dropResult(evidence: DropItemEvidence, landed: boolean): DropItemResult {
  const { dropped } = evidence;
  if (!landed) {
    return {
      status: "failed",
      error:
        "[DROP_HOLE_CONTENTS_NOT_OBSERVED] The inventory changed, but not all tossed items were observed at the bottom of the hole.",
      drop: evidence,
    };
  }
  // In a list, an item not carried is reported but is no failure once something else was carried: the inventory is
  // already as asked for it (live 2026-10-09: drops listing tools she did not carry "failed 9 of 9" after freeing
  // slots, and were sent again, tossing more). Nothing carried at all still fails (a wrong id).
  const carriedAny = dropped.some((entry) => entry.carriedBefore > 0);
  const failures = dropped.filter((entry) => entry.error && !(carriedAny && entry.carriedBefore === 0 && entry.error.startsWith("[DROP_NOT_CARRIED]")));
  const failed = failures.length;
  if (failed === 0) return { status: "succeeded", drop: evidence };
  return {
    status: failed === dropped.length ? "failed" : "partial",
    error: dropItemOutcomes.incomplete(
      failed,
      dropped.length,
      failures.map((entry) => `${entry.item}: ${entry.error?.startsWith("[DROP_NOT_CARRIED]") ? "not carried" : entry.error}`),
    ),
    drop: evidence,
  };
}

/** One request's executor: the counts tossed, the pit and the plug live across attempts, so a resume finishes the drop once. */
export function beginDropItem(
  bot: Bot,
  request: DropItemRequest,
  observe: ObserveRequest,
  dependencies: DropItemDependencies,
  discarded: DiscardedItems,
): RequestExecution<DropItemResult> {
  const progress = startDropProgress(bot, request);
  observe(() => ({ baseline: { freeSlots: progress.freeSlotsBefore },
    checkpoint: { phase: "disposing", freeSlots: bot.inventory.emptySlotCount(), items: request.items.map((item, index) => {
      const before = progress.tosses[index]!.baseline;
      return { item: item.itemName, requested: item.count ?? before, before,
        current: carriedCount(bot, item.itemName), removed: before - carriedCount(bot, item.itemName) };
    }) },
    completion: { kind: "event", observed: false, owes: "Requested items removed and destination delivery or disposal cleanup confirmed." },
  }));
  return async (context) => {
    context.signal?.throwIfAborted();
    const unreachable = await reachDestination(bot, request, progress, dependencies, context);
    if (unreachable) return unreachable;
    if (progress.hole && progress.plugKeep === undefined) planBurialPlug(bot, request, progress);
    const dropped = await tossRequested(bot, request, progress, context, dependencies.settleMs ?? TOSS_SETTLE_MS);
    await settleAfterTosses(bot, request, progress, dropped, dependencies, discarded, context);

    // Free slots are read now: plugging the hole spends a block and stepping back moves the body, and neither is part of
    // the drop.
    const freeSlotsAfter = bot.inventory.emptySlotCount();
    const finished = progress.hole ? await finishHole(bot, progress.hole, progress, dropped, dependencies, discarded, context) : null;
    return dropResult({
      dropped,
      freeSlotsBefore: progress.freeSlotsBefore,
      freeSlotsAfter,
      droppedAt: progress.droppedAt!,
      recipient: progress.recipient,
      hole: progress.hole,
      holeClosure: finished?.closure ?? null,
    }, finished?.landed ?? true);
  };
}

export function dropItem(
  bot: Bot,
  request: DropItemRequest,
  context: ActionContext,
  dependencies: DropItemDependencies,
  discarded: DiscardedItems,
): Promise<DropItemResult> {
  return beginDropItem(bot, request, context.observeProgress ?? (() => {}), dependencies, discarded)(context);
}

export function formatDropItemResult(result: DropItemResult): string {
  const { drop } = result;
  const lines = drop.dropped.map((entry) =>
    entry.error
      ? `- Could not drop **${entry.item}**: ${entry.error}`
      : `- Dropped **${entry.item}** x${entry.dropped} (carried ${entry.carriedBefore} → ${entry.carriedAfter}).` +
        usedElsewhereNote(entry) +
        (entry.keptForPlug ? ` Kept ${entry.keptForPlug} ${entry.item} to close the hole.` : ""),
  );

  const at = drop.droppedAt;
  lines.push(
    "",
    drop.recipient
      ? `Handed to **${drop.recipient.name}** from ${drop.recipient.distance} blocks away, at \`${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)}\`.`
      : `Dropped at \`${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)}\`.`,
    `Free slots ${drop.freeSlotsBefore} → ${drop.freeSlotsAfter}.`,
  );
  if (drop.hole) {
    lines.push(`Disposal hole bottom: \`${drop.hole.x}, ${drop.hole.y}, ${drop.hole.z}\` (two blocks deep).`);
    const closure = drop.holeClosure;
    if (closure) {
      lines.push(
        closure.placed > 0
          ? `Plugged the hole with ${closure.placed} ${closure.item}; now standing ${closure.distance} blocks from it.`
          : `The hole is still open; the bot stands ${closure.distance} blocks from it.`,
      );
      if (closure.error) lines.push(`**Hole not fully closed:** ${closure.error}`);
    }
  } else if (drop.dropped.some((entry) => !entry.error)) {
    lines.push("Dropped items despawn after about five minutes and this bot may pick them up again if it stays close.");
  }
  if (result.status !== "succeeded") lines.push("", `**Observed stop:** ${result.error}`);
  return lines.join("\n");
}

/** More left the inventory than was tossed: a reflex ate or used some of it between attempts, so less was dropped. */
function usedElsewhereNote(entry: DroppedItem): string {
  const elsewhere = entry.carriedBefore - entry.carriedAfter - entry.dropped;
  return elsewhere > 0 ? ` ${elsewhere} more left the inventory meanwhile (eaten or used), so fewer were dropped.` : "";
}

export function createDropItemAction(
  bot: Bot,
  navigation: NavigationRuntime,
  discarded: DiscardedItems = createDiscardedItems(),
  dependencies: DropItemDependencies = productionDependencies(navigation),
) {
  return defineAction({
    checkpointSchema: dropCheckpointSchema,
    name: DROP_ITEM,
    description: DROP_ITEM_DESCRIPTION,
    inputSchema: dropItemInputSchema,
    resultSchema: dropItemResultSchema,
    formatResult: formatDropItemResult,
    execution: { kind: "resumable_task", prepare: (signal) => prepareBotForMovement(bot, navigation, signal) },
    annotations: dropItemAnnotations,
    parse: parseDropItemRequest,
    begin: (request, _lifetime, observe) => beginDropItem(bot, request, observe, dependencies, discarded),
  });
}
