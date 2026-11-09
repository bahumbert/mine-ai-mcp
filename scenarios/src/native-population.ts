// Tracks native deaths and acknowledgements for one summoned wave at a time.

/** Counts living entities and reserves each wave until all new IDs arrive. */
export function createWaveTracker(waveSize: number) {
  const dead = new Set<number>();
  const spawned = new Set<number>();
  const seen = new Set<number>();
  let pending = false;
  return {
    observeDeath(id: number) { dead.add(id); },
    observeSpawn(id: number) {
      if (seen.has(id)) return;
      seen.add(id);
      if (!pending) return;
      spawned.add(id);
      if (spawned.size === waveSize) pending = false;
    },
    alive(entities: Iterable<{ id: number; name?: string; isValid: boolean }>, species: string) {
      const matching = Array.from(entities).filter((entity) => entity.name === species);
      for (const entity of matching) seen.add(entity.id);
      return matching.filter((entity) => entity.isValid && !dead.has(entity.id)).length;
    },
    due(alive: number) {
      if (pending || alive > 1) return false;
      pending = true;
      spawned.clear();
      return true;
    },
    get pending() { return pending; },
    get spawned() { return spawned.size; },
  };
}
