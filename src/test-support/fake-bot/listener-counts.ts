/** Listener counts of an emitter for tests that detach everything they attach: `listenerCounts` lists every event's count, `listenersAddedSince` counts what code under test added to an idle emitter (the harness bot keeps listeners of its own). */
/** An emitter as a listener count reads it: Node's, or Mineflayer's typed one. */
export type Listened = { eventNames(): Array<string | symbol>; listenerCount(event: string | symbol): number };

/** How many listeners each event has: what an observer that detaches everything leaves unchanged. */
export function listenerCounts(emitter: Listened): Record<string, number> {
  return Object.fromEntries(emitter.eventNames().map((name) => [String(name), emitter.listenerCount(name)]));
}

/** Reads the emitter's listeners now as the idle ones; the returned `added(event)` counts the listeners on `event` beyond them (the harness bot and its plugins keep some of their own, so a count is never compared with 0). */
export function listenersAddedSince(emitter: Listened): (event: string) => number {
  const idle = new Map(emitter.eventNames().map((event) => [event, emitter.listenerCount(event)]));
  return (event) => emitter.listenerCount(event) - (idle.get(event) ?? 0);
}
