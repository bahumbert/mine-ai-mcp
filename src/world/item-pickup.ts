import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";
import { armSignal, asVec3, type ArmedSignal, type Position3 } from "../utils/index.js";
import { itemPickupGoal, type MovementPolicy, type Navigate, type NavigationResult } from "../navigation/index.js";
import { withinItemPickupReach } from "../navigation/world/item-geometry.js";
import { hasInventorySpaceFor } from "./inventory-capacity.js";

/** How long inventory settlement gets when an observed item entity is already gone. */
const ITEM_GONE_SETTLE_MS = 1_500;
/** How long to keep waiting after Pathfinder reaches a pickup stance. */
const PICKUP_SETTLE_MS = 900;

/** Events that can first make a newly spawned dropped item identifiable. */
export const DROPPED_ITEM_OBSERVATION_EVENTS = ["entitySpawn", "entityUpdate", "itemDrop"] as const;

export interface ItemCollector {
  readonly entityId: number;
  readonly name: string | null;
}

export interface ItemCollectorWatch {
  /** Another entity emptied this item's stack and the entity then left; null otherwise. */
  takenBy(entityId: number): ItemCollector | null;
  /** Resolves when `entityId` becomes taken by another entity (for waking a wait). */
  whenTaken(entityId: number): Promise<ItemCollector>;
}

export interface ObservedItemPickupOptions {
  readonly entityId: number;
  /** Bound navigation for the bot being driven. */
  readonly navigate: Navigate;
  readonly movements: MovementPolicy;
  readonly hasArrived: () => boolean;
  readonly signal?: AbortSignal;
  /** Optional request-lifetime history, kept across individual pickup attempts. */
  readonly collectors?: ItemCollectorWatch;
  /** Optional caller-owned patience for a route with a concrete local bound. */
  readonly timeoutMs?: number;
  /** How long inventory settlement gets once the item is gone, and after reaching a pickup stance. */
  readonly settleMs?: { readonly itemGone?: number; readonly pickup?: number };
}

export type ObservedItemPickupResult =
  | { readonly kind: "collected" }
  | { readonly kind: "inventory_full"; readonly reason: string }
  | { readonly kind: "item_gone"; readonly takenBy: ItemCollector | null }
  | { readonly kind: "not_collected"; readonly route: NavigationResult };

export interface ObservedItemEntity {
  readonly id: number;
  readonly position: Vec3;
}

export interface NewItemEntitySearch {
  readonly baseline: ReadonlySet<number>;
  /** The item wanted; omitted, any readable dropped item counts. */
  readonly itemName?: string;
  readonly source: Position3;
  readonly maxDistance: number;
  /**
   * Items the bot threw away on purpose, which no sweep should undo. Kept apart
   * from `baseline` because that says "already there before this act" while this
   * says "never wanted", and the two are decided by different callers.
   */
  readonly ignoreIds?: ReadonlySet<number>;
}

/** Record entity identity before a physical act so only newly created items are attributed to it. */
export function snapshotEntityIds(bot: Bot): ReadonlySet<number> {
  return new Set(Object.values(bot.entities).map((entity) => entity.id));
}

/**
 * Whether the entity is a dropped item, whatever its stack metadata says yet. The names are the ones prismarine-entity's
 * `getDroppedItem` checks (the dropped-item entity's name is Java code, no registry trait says it): a name test beside
 * the metadata read, which can be empty when the entity has just spawned.
 */
export function isItemEntity(entity: Pick<Bot["entity"], "name">): boolean {
  return entity.name === "item" || entity.name === "Item" || entity.name === "item_stack";
}

/** Item metadata can arrive after the entity, so unreadable metadata is not evidence yet. */
export function droppedItemName(entity: Bot["entity"]): string | null {
  try {
    return entity.getDroppedItem()?.name ?? null;
  } catch {
    return null;
  }
}

/** Track terminal takes from collect metadata and removal, as measured by contract item-taken-by-mob. */
export function watchItemCollectors(bot: Bot, signal: AbortSignal): ItemCollectorWatch {
  const collected = new Map<number, { collector: ItemCollector; entity: Entity }>();
  const taken = new Map<number, ItemCollector>();
  const waiting = new Map<number, { promise: Promise<ItemCollector>; resolve: (collector: ItemCollector) => void }>();
  const onCollect = (collector: Entity, entity: Entity) => {
    collected.delete(entity.id);
    taken.delete(entity.id);
    if (collector.id !== bot.entity.id) {
      collected.set(entity.id, { collector: { entityId: collector.id, name: collector.name ?? null }, entity });
    }
  };
  const onGone = (entity: Entity) => {
    const last = collected.get(entity.id);
    collected.delete(entity.id);
    if (!last || last.entity !== entity || droppedItemName(entity) !== null) return;
    taken.set(entity.id, last.collector);
    waiting.get(entity.id)?.resolve(last.collector);
    waiting.delete(entity.id);
  };
  const cleanup = () => {
    bot.off("playerCollect", onCollect);
    bot.off("entityGone", onGone);
    signal.removeEventListener("abort", cleanup);
    collected.clear();
    waiting.clear();
  };
  if (!signal.aborted) {
    bot.on("playerCollect", onCollect);
    bot.on("entityGone", onGone);
    signal.addEventListener("abort", cleanup, { once: true });
  }
  return {
    takenBy: (entityId) => taken.get(entityId) ?? null,
    whenTaken: (entityId) => {
      const collector = taken.get(entityId);
      if (collector) return Promise.resolve(collector);
      let waiter = waiting.get(entityId);
      if (!waiter) {
        let resolve!: (collector: ItemCollector) => void;
        const promise = new Promise<ItemCollector>((done) => { resolve = done; });
        waiter = { promise, resolve };
        if (!signal.aborted) waiting.set(entityId, waiter);
      }
      return waiter.promise;
    },
  };
}

/** Find the nearest newly observed matching item attributable to one source position. */
export function findNewItemEntity(bot: Bot, search: NewItemEntitySearch): ObservedItemEntity | null {
  const origin = asVec3(search.source);
  return (
    Object.values(bot.entities)
      .filter((entity) => !search.baseline.has(entity.id))
      .filter((entity) => !search.ignoreIds?.has(entity.id))
      .filter((entity) => {
        const name = droppedItemName(entity);
        if (name === null || (search.itemName !== undefined && name !== search.itemName)) return false;
        return entity.position.distanceTo(origin) <= search.maxDistance;
      })
      .sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin))
      .map((entity) => ({ id: entity.id, position: entity.position.clone() }))[0] ?? null
  );
}

/** Refuse a pickup only when its readable stack has no inventory space. */
function pickupCapacityFailure(bot: Bot, entityId: number): Extract<ObservedItemPickupResult, { kind: "inventory_full" }> | null {
  const current = bot.entities[entityId];
  const name = current ? droppedItemName(current) : null;
  return name && !hasInventorySpaceFor(bot.inventory, new Set([name]))
    ? { kind: "inventory_full", reason: `[INVENTORY_FULL] No free slot or matching stack space for observed ${name} #${entityId}.` }
    : null;
}

/** Preserve the inventory grace period unless a terminal take already proves where the item went. */
async function settleGoneItem(
  bot: Bot,
  options: ObservedItemPickupOptions,
  pickup: ArmedSignal<boolean>,
  collectors: ItemCollectorWatch,
): Promise<ObservedItemPickupResult> {
  const takenBy = !bot.entities[options.entityId] ? collectors.takenBy(options.entityId) : null;
  if (takenBy && !options.hasArrived()) return { kind: "item_gone", takenBy };
  const settlement = await pickup.settle(options.settleMs?.itemGone ?? ITEM_GONE_SETTLE_MS);
  options.signal?.throwIfAborted();
  return settlement.kind === "signalled" ? { kind: "collected" } : { kind: "item_gone", takenBy: null };
}

/** Wake an existing pickup settle when the server proves another entity took the drop. */
function settlePickupOrTake(pickup: ArmedSignal<boolean>, collectors: ItemCollectorWatch, entityId: number, timeoutMs: number) {
  return Promise.race([
    pickup.settle(timeoutMs),
    collectors.whenTaken(entityId).then(() => ({ kind: "taken" as const })),
  ]);
}

/** Follow a rolling item after arrival, or finish the arrival so navigation can perform its handoff. */
async function settleItemArrival(
  bot: Bot,
  options: ObservedItemPickupOptions,
  pickup: ArmedSignal<boolean>,
  collectors: ItemCollectorWatch,
  signal: AbortSignal,
): Promise<{ kind: "completed" } | { kind: "continue" }> {
  const settlement = await settlePickupOrTake(pickup, collectors, options.entityId, options.settleMs?.pickup ?? PICKUP_SETTLE_MS);
  if (signal.aborted || settlement.kind === "signalled" || settlement.kind === "taken" || options.hasArrived()) return { kind: "completed" };
  const current = bot.entities[options.entityId];
  // A drop can roll out of reach before its pickup delay expires; keep following it.
  if (current && !withinItemPickupReach(bot.entity.position, current)) return { kind: "continue" };
  return { kind: "completed" };
}

/** Join the pickup walk even when inventory wins, preserving navigation's cleanup and handoff. */
async function walkToObservedItem(
  bot: Bot,
  options: ObservedItemPickupOptions,
  pickup: ArmedSignal<boolean>,
  collectors: ItemCollectorWatch,
): Promise<{ route: NavigationResult; collected: boolean }> {
  const routeAbort = new AbortController();
  const walk = options.navigate({
    movements: options.movements,
    goal: itemPickupGoal({ id: options.entityId }),
    onArrival: ({ signal }) => settleItemArrival(bot, options, pickup, collectors, signal),
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    stopSignal: routeAbort.signal,
    // A moving or disappearing drop must not hold route planning up.
    searchLimits: { primaryTimeoutMs: 100 },
  });
  const finished = await Promise.race([
    pickup.promise.then((outcome) => ({ kind: "pickup" as const, outcome })),
    walk.then((route) => ({ kind: "walk" as const, route })),
  ]);
  if (finished.kind === "walk") return { route: finished.route, collected: false };
  routeAbort.abort("pickup_observed");
  return { route: await walk, collected: finished.outcome.kind === "signalled" };
}

/** Follow one observed item until inventory proves pickup or the attempt settles. */
export async function pickupObservedItem(
  bot: Bot,
  options: ObservedItemPickupOptions,
): Promise<ObservedItemPickupResult> {
  const watchAbort = new AbortController();
  const watchSignal = options.signal ? AbortSignal.any([options.signal, watchAbort.signal]) : watchAbort.signal;
  const collectors = options.collectors ?? watchItemCollectors(bot, watchSignal);
  const pickup = armSignal(bot.inventory, "updateSlot", () => options.hasArrived() || null, {
    context: { signal: options.signal },
  });

  try {
    options.signal?.throwIfAborted();
    if (options.hasArrived()) return { kind: "collected" };
    if (!bot.entities[options.entityId]?.position) return await settleGoneItem(bot, options, pickup, collectors);
    const beforeWalk = pickupCapacityFailure(bot, options.entityId);
    if (beforeWalk) return beforeWalk;

    const { route, collected } = await walkToObservedItem(bot, options, pickup, collectors);
    options.signal?.throwIfAborted();
    if (collected || options.hasArrived()) return { kind: "collected" };
    if (!bot.entities[options.entityId]) return await settleGoneItem(bot, options, pickup, collectors);

    const afterWalk = pickupCapacityFailure(bot, options.entityId);
    if (afterWalk) return afterWalk;
    if (route.status === "stopped") {
      const settlement = await settlePickupOrTake(pickup, collectors, options.entityId, options.settleMs?.pickup ?? PICKUP_SETTLE_MS);
      options.signal?.throwIfAborted();
      if (settlement.kind === "signalled" || options.hasArrived()) return { kind: "collected" };
      return bot.entities[options.entityId]
        ? { kind: "not_collected", route }
        : { kind: "item_gone", takenBy: collectors.takenBy(options.entityId) };
    }

    return { kind: "not_collected", route };
  } finally {
    pickup.cancel();
    watchAbort.abort();
  }
}
