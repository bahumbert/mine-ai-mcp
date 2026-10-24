import assert from "node:assert/strict";
import test from "node:test";
import { type FakeHarness, type FakeServerOptions, createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { getOff } from "./boat-get-off.js";

/** Boat 7, which the bot sits in once `seat` ran. */
const BOAT_ID = 7;

/** A bot at sea beside boat 7, on a mocked clock (install it before `seat`); the server answers after `lagMs`. */
function seaHarness(options: { readonly lagMs?: number; readonly server?: Omit<FakeServerOptions, "lagMs"> } = {}): FakeHarness {
  return createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    position: { x: 0.5, y: 63, z: 0.5 },
    groundY: 49,
    entities: { [BOAT_ID]: { name: "oak_boat", position: { x: 0.5, y: 62.5, z: 3.5 } } },
    lagMs: options.lagMs,
    server: options.server,
  });
}

/** Seated in boat 7 by the server; returns the positions her client is fed from now on. */
async function seat(harness: FakeHarness, settleMs = 50): Promise<unknown[]> {
  harness.bot.mount(harness.bot.entities[BOAT_ID]!);
  await harness.clock.advance(settleMs);
  assert.equal(harness.server.riderOf(BOAT_ID), harness.bot.entity.id, "seated on the server");
  const positions: unknown[] = [];
  harness.bot._client.on("position", (packet: unknown) => {
    positions.push(packet);
  });
  return positions;
}

/** The shift presses (true) and releases (false) written, in order, with when: a 1.21.4 server reads them from entity_action. */
const shiftPackets = (harness: FakeHarness) =>
  harness.server.packets.filter((packet) => packet.name === "entity_action").map((packet) => ({ down: (packet.data as { actionId: number }).actionId === 0, atMs: packet.atMs }));
const shifts = (harness: FakeHarness): boolean[] => shiftPackets(harness).map((packet) => packet.down);
const serverSeated = (harness: FakeHarness): boolean => harness.server.riderOf(BOAT_ID) === harness.bot.entity.id;

/** `getOff` run while the clock moves `ms` on; its result. */
async function getOffOver(harness: FakeHarness, ms: number, options?: Parameters<typeof getOff>[1]) {
  const pending = getOff(harness.bot, options);
  await harness.clock.advance(ms);
  return pending;
}

// Review focus 4 (run 15 L): the server seconds behind.
test("a get-off holds shift while the world age stands still, and lets go only once it moved 40 ticks", async () => {
  // A server whose answer to the shift takes 3 s, longer than its 40 ticks: the get-off ends on the world age.
  const harness = seaHarness({ lagMs: 3_000 });
  using _installed = harness.clock.install();
  const positions = await seat(harness, 3_050);
  // Stopped for 800 ms: no tick, time packet or answer until it runs again; the game then catches the 16 owed ticks up at once.
  harness.server.stop();
  harness.clock.after(800, () => harness.server.resume());
  const ageAtShift: number[] = [];
  harness.server.onPacket("entity_action", () => ageAtShift.push(harness.bot.time.age));
  const startedAt = performance.now();
  // Two time packets after the resume, before the late answer (due 3 s after the press).
  const result = await getOffOver(harness, 2_500);
  const [, release] = shiftPackets(harness);
  assert.ok(release!.atMs - startedAt >= 700, "shift stayed down while the server clock was stopped");
  assert.equal(result.answered, true, "the server clock moved past the send: it handled the shift");
  assert.equal(result.ended, "world_age");
  assert.deepEqual(shifts(harness), [true, false]);
  assert.equal(ageAtShift.length, 2);
  assert.ok(ageAtShift[1]! - ageAtShift[0]! >= 40, `shift released after the age she heard moved ${String(ageAtShift[1]! - ageAtShift[0]!)} ticks, the caught-up ones included`);
  assert.equal(positions.length, 1);
  assert.equal(harness.bot.vehicle, null);
});

test("a get-off the server clock never answers fails on the wall clock, with shift released and physics on", async () => {
  const harness = seaHarness();
  using _installed = harness.clock.install();
  const positions = await seat(harness);
  harness.server.stop();
  const result = await getOffOver(harness, 400, { wallMs: 300 });
  assert.equal(result.answered, false);
  assert.deepEqual(shifts(harness), [true, false]);
  assert.equal(positions.length, 1, "physics is back on");
  assert.equal(harness.bot.vehicle, null, "the vehicle is forgotten");
  assert.equal(harness.bot.entity.vehicle, null);
});

test("a death during the get-off ends it at once, shift released, nothing resumed", async () => {
  const harness = seaHarness();
  using _installed = harness.clock.install();
  const positions = await seat(harness);
  const { bot } = harness;
  harness.server.stop();
  // Mineflayer's own plugins listen for some of these too: only the get-off's own listeners are counted.
  const listeners = () => bot.listenerCount("dismount") + bot.listenerCount("death") + bot.listenerCount("respawn") + bot.listenerCount("forcedMove");
  const ownListeners = listeners();
  harness.clock.after(50, () => bot.emit("death"));
  const startedAt = performance.now();
  const result = await getOffOver(harness, 1_000, { wallMs: 5_000 });
  const [, release] = shiftPackets(harness);
  assert.ok(release!.atMs - startedAt < 1_000);
  assert.equal(result.answered, false);
  assert.deepEqual(shifts(harness), [true, false]);
  assert.equal(positions.length, 0);
  assert.equal(listeners() - ownListeners, 0, "no listener is left");
});

// Backlog 76 (Cleo, run 16): a 1.21.4 server reads the shift from entity_action, never from player_input.
test("a get-off on 1.21.4 holds entity_action shift until the server lets her off, and writes no player_input", async () => {
  const harness = seaHarness();
  using _installed = harness.clock.install();
  await seat(harness);
  assert.equal(serverSeated(harness), true);
  const result = await getOffOver(harness, 3_000);
  assert.deepEqual(shifts(harness), [true, false]);
  assert.equal(harness.server.packets.some((packet) => packet.name === "player_input"), false);
  assert.equal(serverSeated(harness), false, "the server read the held shift at one of its ticks");
  assert.equal(result.answered, true);
  // The server's answer, not the world age: it sends her the boat's passenger list without her and a position
  // (contract check boat-get-off-by-shift, Mine Labs 2026-10-21).
  assert.equal(result.ended, "answer");
});

test("a press and release read in one server tick do not let her off: the release waits for the world age", async () => {
  const harness = seaHarness();
  using _installed = harness.clock.install();
  await seat(harness);
  harness.server.stop();
  harness.clock.after(800, () => harness.server.resume());
  await getOffOver(harness, 3_000);
  const [down, up] = shiftPackets(harness);
  assert.ok(up!.atMs - down!.atMs >= 700, `shift was released ${String(up!.atMs - down!.atMs)} ms after the press, before the server clock moved`);
  assert.equal(serverSeated(harness), false);
});

test("a world age that jumps 40 in the first 250 ms after the press is not the server's answer", async () => {
  // Run 16: the server ran ~30 % behind and Cleo's get-off "answered" in ~1.1 s: a client whose event loop was blocked
  // reads its queued time packets after the press, so the age it sees jump says nothing about the server reading the shift.
  // Here the time packet 50 ms after the press brings 40 ticks at once (two queued packets read together), and the
  // server's answer to the shift takes 500 ms. `ticksPerSecond: 40` stands for that burst of two packets in the client's
  // queue: a server on time sends 20 ticks a packet, so this fake really runs 40 a second to make one packet carry 40.
  const harness = seaHarness({ lagMs: 500, server: { phaseMs: 550, ticksPerSecond: 40 } });
  using _installed = harness.clock.install();
  await seat(harness, 500);
  await getOffOver(harness, 3_000);
  const [down, up] = shiftPackets(harness);
  assert.ok(up!.atMs - down!.atMs >= 300, `shift was released ${String(up!.atMs - down!.atMs)} ms after the press: the burst counted as 40 server ticks`);
  assert.equal(serverSeated(harness), false);
});
