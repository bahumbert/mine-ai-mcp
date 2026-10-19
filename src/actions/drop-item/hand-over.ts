import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { DiscardedItems } from "../../world/discarded-items.js";
import { droppedItemName } from "../../world/item-pickup.js";
import type { DropRecipient } from "./contract.js";

/** How long a hand-over waits for the recipient's pickup packet before it reports the items as left at their feet. */
export const HANDOVER_WAIT_MS = 5_000;

export interface HandoverWatch {
  readonly recipientName: string;
  /**
   * Whether this item entity came from the toss. An entity can spawn a tick after the toss was counted, so this is
   * asked at pickup time, not fixed beforehand.
   */
  readonly isTossed: (entity: Entity) => boolean;
  /** Tossed entities known when the wait starts; the wait also ends once all of them are taken. */
  readonly tossedIds: ReadonlySet<number>;
  /** Items the toss put on the ground in all: the wait ends early once this many were taken. */
  readonly expectedItems: number;
  readonly waitMs: number;
  readonly signal?: AbortSignal;
}

export interface HandoverOutcome {
  /** Items the recipient picked up, from the stack counts the server announced; 0 when none was seen taken. */
  readonly recipientCount: number;
  /** True when every tossed entity was taken by the recipient. */
  readonly recipientTookAll: boolean;
}

function stackCount(entity: Entity): number {
  try {
    return entity.getDroppedItem()?.count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Wait for the server to say who picked the tossed items up.
 *
 * A toss lands at the recipient's feet and the giver can take it straight back when the pickup delay ends (live
 * 2026-10-19, B2: a toss at 1.47 blocks reported success, the giver re-picked it 2 s later). The answer is the
 * `playerCollect` packet, so the wait ends on it; the wall-clock bound only covers a recipient who never takes the
 * items (full inventory, walked off, a mode that does not pick up).
 */
export function awaitHandover(bot: Bot, watch: HandoverWatch): Promise<HandoverOutcome> {
  return new Promise((resolve, reject) => {
    const byRecipient = new Map<number, number>();
    const byAnyone = new Set<number>();
    let takenItems = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const takenByRecipient = () => [...byRecipient.values()].reduce((sum, count) => sum + count, 0);
    const outcome = (): HandoverOutcome => ({
      recipientCount: takenByRecipient(),
      recipientTookAll:
        byRecipient.size > 0 && (takenByRecipient() >= watch.expectedItems || [...watch.tossedIds].every((id) => byRecipient.has(id))),
    });
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      bot.off("playerCollect", collected);
      watch.signal?.removeEventListener("abort", aborted);
      settle();
    };
    const aborted = () => finish(() => reject(watch.signal?.reason));
    const collected = (collector: Entity, entity: Entity) => {
      if (!(watch.tossedIds.has(entity.id) || watch.isTossed(entity)) || byAnyone.has(entity.id)) return;
      byAnyone.add(entity.id);
      const count = stackCount(entity);
      takenItems += count;
      if ((collector as { username?: string }).username === watch.recipientName) byRecipient.set(entity.id, count);
      const allKnownTaken = watch.tossedIds.size > 0 && [...watch.tossedIds].every((id) => byAnyone.has(id));
      if (allKnownTaken || takenItems >= watch.expectedItems) {
        finish(() => resolve(outcome()));
      }
    };

    if (watch.signal?.aborted) return reject(watch.signal.reason);
    bot.on("playerCollect", collected);
    watch.signal?.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(() => finish(() => resolve(outcome())), watch.waitMs);
  });
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
    .filter((entity) => droppedItemName(entity) !== null || entity.name === "item")
    .map((entity) => entity.id);
  discarded.remember(ids);
  return new Set(ids);
}

/** An item entity that was not there before the toss and lies near where it was made. */
export function cameFromToss(entity: Entity, baseline: ReadonlySet<number>, from: { x: number; y: number; z: number }): boolean {
  if (baseline.has(entity.id) || (droppedItemName(entity) === null && entity.name !== "item")) return false;
  return Math.hypot(entity.position.x - from.x, entity.position.z - from.z) <= DISCARD_ATTRIBUTION_RADIUS;
}

export function handOverLine(recipient: DropRecipient, at: { x: number; y: number; z: number }): string {
  const where = `\`${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)}\``;
  return recipient.collected
    ? `Handed to **${recipient.name}** from ${recipient.distance} blocks away, at ${where}: they picked up ${recipient.collectedCount} item${recipient.collectedCount === 1 ? "" : "s"}.`
    : `Left at **${recipient.name}**'s feet, not picked up yet, at ${where}: they were ${recipient.distance} blocks away when the items were tossed.`;
}

