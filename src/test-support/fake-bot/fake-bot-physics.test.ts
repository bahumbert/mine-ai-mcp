import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "./fake-bot.js";
import { sentPitchOf } from "./fake-bot-physics.js";
import type { FakeServer } from "./fake-server.js";

/** The pitch the server holds; the client must have sent a look. */
function sentPitch(server: FakeServer): number {
  const pitch = sentPitchOf(server.packets);
  assert.ok(pitch !== undefined, "the client sent a look packet");
  return pitch;
}

/** A bot whose server already holds pitch 0.31 (a forced look, one tick to send it). */
async function pitchedBot() {
  const harness = createFakeBot();
  const { bot, clock } = harness;
  await bot.look(bot.entity.yaw, 0.31, true);
  await clock.advance(50);
  assert.ok(Math.abs(sentPitch(harness.server) - 0.31) < 1e-6);
  return harness;
}

function track<T>(promise: Promise<T>) {
  const state = { done: false };
  void promise.then(() => (state.done = true));
  return state;
}

test("an unforced look with the yaw already aimed resolves with the pitch still on its way", async () => {
  // `physics.js:164-175`: the sent pitch moves 0.15 rad a tick; `:308-311`: the look ends on the sent yaw alone.
  const { bot, clock, server } = await pitchedBot();
  const looking = track(bot.look(bot.entity.yaw, -1.26));
  await clock.advance(50);
  assert.equal(looking.done, true, "the yaw was aimed: resolved on the first tick");
  assert.ok(Math.abs(sentPitch(server) - 0.16) < 1e-3, `sent pitch after 1 tick ${sentPitch(server)}`);
  await clock.advance(150);
  assert.ok(Math.abs(sentPitch(server) - -0.29) < 1e-3, `sent pitch after 4 ticks ${sentPitch(server)}`);
});

test("a forced look sends the aimed pitch at once", async () => {
  const { bot, clock, server } = await pitchedBot();
  await bot.look(bot.entity.yaw, -1.26, true);
  await clock.advance(50);
  assert.ok(Math.abs(sentPitch(server) - -1.26) < 1e-3, `sent pitch after 1 tick ${sentPitch(server)}`);
});

test("an unforced look turns the sent yaw and pitch together, 0.15 rad a tick each, and ends once the yaw is there", async () => {
  const { bot, clock, server } = await pitchedBot();
  const start = bot.entity.yaw;
  const looking = track(bot.look(start + 0.3, 0.31 - 0.6));
  await clock.advance(50);
  assert.equal(looking.done, false, "0.3 rad of yaw takes two ticks");
  await clock.advance(50);
  assert.equal(looking.done, true);
  assert.ok(Math.abs(sentPitch(server) - (0.31 - 0.3)) < 1e-3);
});
