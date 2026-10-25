/** The fake server's ticks for what the game reads once a tick (a shift key, a boat's damage): the counter of `FakeServer.onTick`. */
import type { FakeServer } from "./fake-server.js";

/** Call `tick` once per server tick (none while the server is stopped, the owed ticks of a caught-up stop at the resume); the returned function stops it. */
export function onServerTick(server: FakeServer, tick: () => void): () => void {
  return server.onTick(tick);
}
