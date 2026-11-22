// Summons and bounds acknowledgement of an expedition's native mob waves.
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { serverPacedElapsed, serverPacedSignal, waitForServerPaced, type ServerPacedSignal } from "../../src/world/server-paced.ts";
import { createWaveTracker } from "./native-population.ts";

/** Keep one wave in flight and abort if its spawn events do not arrive. */
export function createNativeWave(bot: Bot, positions: readonly Vec3[], log: (message: string) => void, send: (command: string) => void, signal: AbortSignal) {
  const tracker = createWaveTracker(positions.length);
  const failed = new AbortController();
  const closed = new AbortController();
  const stopped = AbortSignal.any([signal, failed.signal, closed.signal]);
  let budget: ServerPacedSignal | undefined;
  let error: Error | undefined;
  const stopBudget = () => {
    budget?.signal.removeEventListener("abort", fail);
    budget?.[Symbol.dispose]();
    budget = undefined;
  };
  const fail = () => {
    if (!tracker.pending || error || !budget) return;
    const elapsed = budget.elapsed();
    error = new Error(`WAVE NOT ANSWERED ${tracker.spawned}/${positions.length} ${JSON.stringify({ end: budget.end(), elapsedMs: elapsed.ms, elapsedTicks: elapsed.ticks })}`);
    stopBudget();
    signal.removeEventListener("abort", close);
    failed.abort(error);
  };
  const close = () => {
    stopBudget();
    signal.removeEventListener("abort", close);
    closed.abort(new Error("Native wave closed"));
  };
  const replenish = (collecting: boolean) => {
    if (stopped.aborted || !collecting || !tracker.due(tracker.alive(Object.values(bot.entities), "enderman"))) return;
    budget = serverPacedSignal(bot, 100);
    budget.signal.addEventListener("abort", fail, { once: true });
    for (const position of positions)
      send(`/summon minecraft:enderman ${position.x} ${position.y} ${position.z} {PersistenceRequired:1b}`);
    log("Native endermen: replenishes before the population is exhausted; health and loot remain native.");
  };
  if (!signal.aborted) signal.addEventListener("abort", close, { once: true });
  return {
    signal: failed.signal,
    get error() { return error; },
    get pending() { return tracker.pending; },
    death(id: number, collecting: boolean) { tracker.observeDeath(id); replenish(collecting); },
    spawn(id: number) { tracker.observeSpawn(id); if (!tracker.pending) stopBudget(); },
    tick(collecting: boolean) { replenish(collecting); },
    async waitServerTicks(count: number): Promise<void> {
      const elapsed = serverPacedElapsed(bot);
      const end = await waitForServerPaced(bot, count, { signal: stopped });
      if (end !== "ticks") throw new Error(`Native wave observation ${JSON.stringify({ end, ...elapsed() })}`);
    },
    close,
  };
}
