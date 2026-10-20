import assert from "node:assert/strict";
import test from "node:test";
import { mountedBot, shifts } from "../../test-support/boat-bot.js";
import { getOff } from "./boat-get-off.js";

// Review focus 4 (run 15 L): the server seconds behind.
test("a get-off holds shift while the world age stands still, and lets go only once it moved 40 ticks", { timeout: 30_000 }, async () => {
  const { bot, raw, written, client } = await mountedBot({ serverClock: { frozenMs: 800 } });
  const positions: unknown[] = [];
  client.on("position", (packet: unknown) => positions.push(packet));
  const startedAt = performance.now();
  const result = await getOff(bot);
  assert.ok(performance.now() - startedAt >= 700, "shift stayed down while the server clock was stopped");
  assert.equal(result.answered, true, "the server clock moved past the send: it handled the shift");
  assert.deepEqual(shifts(written), [true, false]);
  assert.equal(positions.length, 1);
  assert.equal(raw.vehicle, null);
});

test("a get-off the server clock never answers fails on the wall clock, with shift released and physics on", { timeout: 30_000 }, async () => {
  const { bot, raw, written, client } = await mountedBot({ serverClock: "frozen" });
  const positions: unknown[] = [];
  client.on("position", (packet: unknown) => positions.push(packet));
  const result = await getOff(bot, { wallMs: 300 });
  assert.equal(result.answered, false);
  assert.deepEqual(shifts(written), [true, false]);
  assert.equal(positions.length, 1, "physics is back on");
  assert.equal(raw.vehicle, null, "the vehicle is forgotten");
  assert.equal(raw.entity.vehicle, null);
});

test("a death during the get-off ends it at once, shift released, nothing resumed", { timeout: 30_000 }, async () => {
  const { bot, raw, written, client } = await mountedBot({ serverClock: "frozen" });
  const positions: unknown[] = [];
  client.on("position", (packet: unknown) => positions.push(packet));
  setTimeout(() => raw.emit("death"), 50);
  const startedAt = performance.now();
  const result = await getOff(bot, { wallMs: 5_000 });
  assert.ok(performance.now() - startedAt < 1_000);
  assert.equal(result.answered, false);
  assert.deepEqual(shifts(written), [true, false]);
  assert.equal(positions.length, 0);
  assert.equal(raw.listenerCount("dismount") + raw.listenerCount("death") + raw.listenerCount("respawn") + raw.listenerCount("forcedMove"), 0, "no listener is left");
});

// Backlog 76 (Cleo, run 16): a 1.21.4 server reads the shift from entity_action, never from player_input.
test("a get-off on 1.21.4 holds entity_action shift until the server lets her off, and writes no player_input", { timeout: 30_000 }, async () => {
  const { bot, written, serverSeated } = await mountedBot();
  assert.equal(serverSeated(), true);
  const result = await getOff(bot);
  assert.deepEqual(shifts(written), [true, false]);
  assert.equal(written.some((entry) => entry.name === "player_input"), false);
  assert.equal(serverSeated(), false, "the server read the held shift at one of its ticks");
  assert.equal(result.answered, true);
  assert.equal(result.ended, "world_age");
});

test("a press and release read in one server tick do not let her off: the release waits for the world age", { timeout: 30_000 }, async () => {
  const { bot, written, serverSeated } = await mountedBot({ serverClock: { frozenMs: 800 } });
  await getOff(bot);
  const [down, up] = written.filter((entry) => entry.name === "entity_action");
  assert.ok(up!.at - down!.at >= 700, `shift was released ${String(up!.at - down!.at)} ms after the press, before the server clock moved`);
  assert.equal(serverSeated(), false);
});

test("a world age that jumps 40 in the first 250 ms after the press is not the server's answer", { timeout: 30_000 }, async () => {
  // Run 16: the server ran ~30 % behind and Cleo's get-off "answered" in ~1.1 s: a client whose event loop was blocked
  // reads its queued time packets after the press, so the age it sees jump says nothing about the server reading the shift.
  const { bot, written, serverSeated } = await mountedBot({ serverClock: { burstOnPress: 40 } });
  await getOff(bot);
  const [down, up] = written.filter((entry) => entry.name === "entity_action");
  assert.ok(up!.at - down!.at >= 300, `shift was released ${String(up!.at - down!.at)} ms after the press: the burst counted as 40 server ticks`);
  assert.equal(serverSeated(), false);
});

