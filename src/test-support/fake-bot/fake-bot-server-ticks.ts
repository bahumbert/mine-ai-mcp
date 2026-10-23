/** The fake server's ticks: 50 ms of a running server, for what the game reads once a tick (a shift key, a boat's damage). */
import type { FakeClock } from "./fake-clock.js";
import type { FakeServer } from "./fake-server.js";

export const SERVER_TICK_MS = 50;

/** Call `tick` once per 50 ms of clock while the server runs (a stopped server counts none); the returned function stops it. */
export function onServerTick(clock: FakeClock, server: FakeServer, tick: () => void): () => void {
  let carryMs = 0;
  return clock.onSlice("server", (sliceMs) => {
    if (!server.isRunning) return;
    carryMs += sliceMs;
    for (; carryMs >= SERVER_TICK_MS; carryMs -= SERVER_TICK_MS) tick();
  });
}
