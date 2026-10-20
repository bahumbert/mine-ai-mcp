/** Tracks deliberate discards shared by collection and hunting. */

/** A dropped item's own lifetime; past this the entity is gone and its id may be reused. */
export const DISCARD_MEMORY_MS = 5 * 60 * 1_000;

export interface DiscardedItems {
  /** Remember item entity ids the bot dropped deliberately. */
  remember(entityIds: Iterable<number>, now?: number): void;
  /** Ids still considered deliberate discards, for use as a pickup exclusion set. */
  ignored(now?: number): ReadonlySet<number>;
}

/**
 * `buriedIds` lists the stacks lying in the bot's sealed pits, ignored for as long as the pit is remembered: the
 * wall-clock memory is shorter than an item's life (6000 server ticks, Oskar 16:18: taken at +305 s).
 */
export function createDiscardedItems(
  memoryMs: number = DISCARD_MEMORY_MS,
  buriedIds: () => Iterable<number> = () => [],
): DiscardedItems {
  const expiries = new Map<number, number>();

  const prune = (now: number) => {
    for (const [id, expiresAt] of expiries) if (expiresAt <= now) expiries.delete(id);
  };

  return {
    remember(entityIds, now = Date.now()) {
      prune(now);
      for (const id of entityIds) expiries.set(id, now + memoryMs);
    },
    ignored(now = Date.now()) {
      prune(now);
      return new Set([...expiries.keys(), ...buriedIds()]);
    },
  };
}
