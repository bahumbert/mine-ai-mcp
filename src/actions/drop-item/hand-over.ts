import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";
import type { DiscardedItems } from "../../world/discarded-items.js";
import { carriedCount } from "../../world/inventory-count.js";
import { droppedItemName } from "../../world/item-pickup.js";
import type { ActionContext } from "../action.js";
import { dropItemOutcomes, type DroppedItem, type DropRecipient } from "./contract.js";

/**
 * World ticks after the toss at which what was not taken counts as not taken: the pickup delay (40) plus 60 to walk up
 * and take it. Counted on the server's world age, which a lagging server moves slowly.
 */
export const HANDOVER_SETTLE_TICKS = 100;

/**
 * The wall-clock bound for a server whose world age does not move far enough (frozen, or far behind). The answer is
 * then unsettled: nobody knows yet.
 */
export const HANDOVER_WALL_MS = 30_000;

type Point = { readonly x: number; readonly y: number; readonly z: number };

/** An item entity, whose metadata (the item name) may not have arrived yet. */
function isItemEntity(entity: Entity): boolean {
  return droppedItemName(entity) !== null || entity.name === "item";
}

export interface HandoverWatch {
  readonly recipientName: string;
  /**
   * Whether this item entity came from the toss. An entity can spawn a tick after the toss was counted, so this is
   * asked at pickup time, not fixed beforehand.
   */
  readonly isTossed: (entity: Entity) => boolean;
  /** Tossed entities known when the wait starts. */
  readonly tossedIds: ReadonlySet<number>;
  /** Items the toss put on the ground in all: the wait ends early once this many were taken. */
  readonly expectedItems: number;
  readonly wallMs: number;
  readonly signal?: AbortSignal;
}

export interface HandoverOutcome {
  /** Items the recipient picked up, from the `pickupItemCount` of the server's `collect` packets; 0 when none was seen. */
  readonly recipientCount: number;
  /** True when the recipient took every tossed item. */
  readonly recipientTookAll: boolean;
  /** True when the server answered: all taken, or the world age moved `HANDOVER_SETTLE_TICKS`. False: the wall bound ended it. */
  readonly settled: boolean;
}

function stackCount(entity: Entity | undefined): number {
  try {
    return entity?.getDroppedItem()?.count ?? 0;
  } catch {
    return 0;
  }
}

interface CollectPacket {
  readonly collectorEntityId: number;
  readonly collectedEntityId: number;
  readonly pickupItemCount?: number;
}

/** The pickup count a `collect` packet carries; the stack's count when an older server does not say. */
function pickedUpCount(packet: CollectPacket, entity: Entity | undefined): number {
  const announced = packet.pickupItemCount;
  return typeof announced === "number" && Number.isInteger(announced) && announced > 0 ? announced : stackCount(entity);
}

/**
 * Wait for the server to say who picked the tossed items up, and how many.
 *
 * A toss lands at the recipient's feet and the giver can take it straight back when the pickup delay ends (live
 * 2026-10-19, B2: a toss at 1.47 blocks reported success, the giver re-picked it 2 s later). The answer is the raw
 * `collect` packet: our mineflayer fork emits `playerCollect` before it lowers the stack by `pickupItemCount`, so that
 * event cannot tell a partial pickup. Nothing taken once the world age has moved `HANDOVER_SETTLE_TICKS` is an answer
 * too (settled); a server that lags answers late, so the wall-clock bound only ends the wait as unsettled.
 */
export function awaitHandover(bot: Bot, watch: HandoverWatch): Promise<HandoverOutcome> {
  return new Promise((resolve, reject) => {
    const client = bot._client;
    const ageAtToss = bot.time?.age;
    let takenByAnyone = 0;
    let takenByRecipient = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const outcome = (settled: boolean): HandoverOutcome => ({
      recipientCount: takenByRecipient,
      recipientTookAll: takenByRecipient >= watch.expectedItems,
      settled,
    });
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      client.off("collect", collected);
      bot.off("time", ticked);
      watch.signal?.removeEventListener("abort", aborted);
      settle();
    };
    const aborted = () => finish(() => reject(watch.signal?.reason));
    const collected = (packet: CollectPacket) => {
      const entity: Entity | undefined = bot.entities[packet.collectedEntityId];
      if (!(watch.tossedIds.has(packet.collectedEntityId) || (entity && watch.isTossed(entity)))) return;
      const count = Math.min(pickedUpCount(packet, entity), watch.expectedItems - takenByAnyone);
      takenByAnyone += count;
      if (bot.entities[packet.collectorEntityId]?.username === watch.recipientName) takenByRecipient += count;
      if (takenByAnyone >= watch.expectedItems) finish(() => resolve(outcome(true)));
    };
    const ticked = () => {
      const age = bot.time?.age;
      if (ageAtToss !== undefined && age !== undefined && age - ageAtToss >= HANDOVER_SETTLE_TICKS) finish(() => resolve(outcome(true)));
    };

    if (watch.signal?.aborted) return reject(watch.signal.reason);
    client.on("collect", collected);
    bot.on("time", ticked);
    watch.signal?.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(() => finish(() => resolve(outcome(false))), watch.wallMs);
  });
}

/**
 * Read the carried counts again after a toss and report only the net drop.
 *
 * Tossed items the bot stands near come straight back (live 2026-10-10 run 7: coal dropped and picked up again, six
 * times over). `dropped` is updated in place.
 */
export function recountAfterToss(bot: Bot, dropped: DroppedItem[], hole: Vec3 | null): void {
  for (const [index, entry] of dropped.entries()) {
    if (entry.dropped <= 0 || entry.error) continue;
    const now = carriedCount(bot, entry.item);
    if (now <= entry.carriedAfter) continue;
    const net = Math.max(0, entry.carriedBefore - now);
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

export interface HandOverAndRecount {
  readonly recipient: DropRecipient;
  readonly dropped: DroppedItem[];
  readonly tossedIds: ReadonlySet<number>;
  readonly entityBaseline: ReadonlySet<number>;
  readonly droppedAt: Point;
  readonly discarded: DiscardedItems;
  readonly dependencies: { readonly handoverWallMs?: number };
  readonly context: ActionContext;
  /** Walks the bot off the toss while the watch runs. */
  readonly walkAway: () => Promise<void>;
}

/**
 * Watch the recipient take the toss from the moment it was made, walk off meanwhile, then recount what came back.
 *
 * The recipient takes the items while the giver is still walking off (the pickup delay is 2 s), and the server says so
 * once. Returns the recipient with what the server announced.
 */
export async function handOverAndRecount(bot: Bot, args: HandOverAndRecount): Promise<DropRecipient> {
  const { recipient, dropped, tossedIds, entityBaseline, droppedAt, discarded, dependencies, context } = args;
  // Counted before the recount below, which takes off what the giver picks back up.
  const tossedCount = dropped.reduce((sum, entry) => sum + (entry.error ? 0 : entry.dropped), 0);
  const handoverWatch = awaitHandover(bot, {
    recipientName: recipient.name,
    tossedIds,
    isTossed: (entity) => cameFromToss(entity, entityBaseline, droppedAt),
    expectedItems: tossedCount,
    wallMs: dependencies.handoverWallMs ?? HANDOVER_WALL_MS,
    signal: context.signal,
  });
  handoverWatch.catch(() => undefined);
  await args.walkAway();
  const handover = await handoverWatch;
  // What the recipient left lying was a hand-over that failed, not a deliberate discard: its owner may pick it up again.
  if (!handover.recipientTookAll) discarded.forget(tossedIds);
  recountAfterToss(bot, dropped, null);
  return { ...recipient, collected: handover.recipientTookAll, collectedCount: handover.recipientCount, tossedCount, settled: handover.settled };
}

/** Eye height of a standing player above their feet. */
export const PLAYER_EYE_HEIGHT = 1.62;

/**
 * The height above the recipient's feet to aim at so the toss comes to rest at them rather than past them.
 *
 * A toss slides about 4.3 blocks when thrown level and shorter the steeper it is thrown (measured in Mine Labs, 1.47
 * blocks aimed at the body: the logs rested 1.4 to 2 blocks past the recipient, out of their pickup reach). Resting
 * distance is about `(90 - pitch) / 21` blocks for a toss `pitch` degrees below level, so the pitch that lands at
 * `distance` is `90 - 21 * distance`, clamped to level at the far end.
 */
export function tossAimHeight(distance: number): number {
  const pitchDown = (Math.min(90, Math.max(0, 90 - 21 * distance)) * Math.PI) / 180;
  return PLAYER_EYE_HEIGHT - distance * Math.tan(pitchDown);
}

/** A tossed item lands within a couple of blocks; anything further appeared for another reason. */
const DISCARD_ATTRIBUTION_RADIUS = 4;

/**
 * Mark the items this toss created so no sweep picks them straight back up.
 *
 * Only entities that appeared during the toss and are close enough to have come
 * from it are attributed to it. Metadata can arrive a tick after the entity, so
 * an item whose name is not yet readable is still claimed: an unattributed
 * discard is worse than a slightly wide one, and the memory expires anyway.
 * Returns the claimed ids, which a hand-over waits on.
 */
export function rememberDiscards(bot: Bot, baseline: ReadonlySet<number>, discarded: DiscardedItems): ReadonlySet<number> {
  const ids = Object.values(bot.entities)
    .filter((entity) => !baseline.has(entity.id))
    .filter((entity) => entity.position.distanceTo(bot.entity.position) <= DISCARD_ATTRIBUTION_RADIUS)
    .filter(isItemEntity)
    .map((entity) => entity.id);
  discarded.remember(ids);
  return new Set(ids);
}

/** An item entity that was not there before the toss and lies near where it was made. */
export function cameFromToss(entity: Entity, baseline: ReadonlySet<number>, from: Point): boolean {
  if (baseline.has(entity.id) || !isItemEntity(entity)) return false;
  return Math.hypot(entity.position.x - from.x, entity.position.z - from.z) <= DISCARD_ATTRIBUTION_RADIUS;
}

/** "took X of N" counts against what the toss put on the ground, not the net drop left after a pick-back. */
export function handOverLine(recipient: DropRecipient, at: Point): string {
  const tossed = recipient.tossedCount;
  const where = `\`${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)}\``;
  if (recipient.collected) {
    return `Handed to **${recipient.name}** from ${recipient.distance} blocks away, at ${where}: they picked up ${recipient.collectedCount} item${recipient.collectedCount === 1 ? "" : "s"}.`;
  }
  return recipient.settled
    ? `Left at **${recipient.name}**'s feet: they took ${recipient.collectedCount} of ${tossed}, at ${where}, ${recipient.distance} blocks away when the items were tossed.`
    : `Tossed to **${recipient.name}**; the server has not said yet whether they took them (${recipient.collectedCount} of ${tossed} seen taken), at ${where}.`;
}

