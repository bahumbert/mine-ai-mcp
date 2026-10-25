import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "./fake-clock.js";
import { onServerTick } from "./fake-bot-server-ticks.js";
import { createFakeServer } from "./fake-server.js";

// The stall rules are tested on the server (`fake-server.test.ts`); this is the alias the subsystems use.
test("onServerTick is the server's tick stream: one call per tick, the owed ticks of a caught-up stall at the resume, none after release", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const server = createFakeServer(clock);
  let ticks = 0;
  const release = onServerTick(server, () => (ticks += 1));
  await clock.advance(500);
  assert.equal(ticks, 10);
  server.stop();
  await clock.advance(800);
  assert.equal(ticks, 10);
  server.resume();
  assert.equal(ticks, 26);
  release();
  await clock.advance(500);
  assert.equal(ticks, 26);
});
