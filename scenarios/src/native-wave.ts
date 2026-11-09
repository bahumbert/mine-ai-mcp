// Summons and bounds acknowledgement of an expedition's native mob waves.
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { monotonicNow } from "../../src/utils/monotonic-clock.ts";
import { createWaveTracker } from "./native-population.ts";

/** Keep one wave in flight and abort if its spawn events do not arrive. */
export function createNativeWave(bot: Bot, positions: readonly Vec3[], log: (message: string) => void, send: (command: string) => void) {
  const tracker = createWaveTracker(positions.length);
  const failed = new AbortController();
  let ticks = 0;
  let started = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let error: Error | undefined;
  const fail = () => {
    if (!tracker.pending || error) return;
    error = new Error(`WAVE NOT ANSWERED ${tracker.spawned}/${positions.length} after ${ticks} ticks ${Math.round(monotonicNow() - started)} ms`);
    failed.abort(error);
  };
  const replenish = (collecting: boolean) => {
    if (!collecting || !tracker.due(tracker.alive(Object.values(bot.entities), "enderman"))) return;
    ticks = 0;
    started = monotonicNow();
    timer = setTimeout(fail, 10_000);
    for (const position of positions)
      send(`/summon minecraft:enderman ${position.x} ${position.y} ${position.z} {PersistenceRequired:1b}`);
    log("Native endermen: replenishes before the population is exhausted; health and loot remain native.");
  };
  return {
    signal: failed.signal,
    get error() { return error; },
    get pending() { return tracker.pending; },
    death(id: number, collecting: boolean) { tracker.observeDeath(id); replenish(collecting); },
    spawn(id: number) { tracker.observeSpawn(id); if (!tracker.pending) clearTimeout(timer); },
    tick(collecting: boolean) { if (tracker.pending && ++ticks >= 100) fail(); replenish(collecting); },
    waitForTicks(count: number): Promise<void> {
      return new Promise((resolve, reject) => {
        let remaining = count;
        const cleanup = () => { bot.off("physicsTick", onTick); failed.signal.removeEventListener("abort", onAbort); };
        const onAbort = () => { cleanup(); reject(failed.signal.reason); };
        const onTick = () => { if (--remaining <= 0) { cleanup(); resolve(); } };
        if (failed.signal.aborted) { onAbort(); return; }
        bot.on("physicsTick", onTick);
        failed.signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    close() { clearTimeout(timer); },
  };
}
