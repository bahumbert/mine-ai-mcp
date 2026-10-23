import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeClock, createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { requestCellResync } from "./cell-resync.js";
import { SERVER_ANSWER_WALL_MS } from "./server-block-changes.js";

const CELL = new Vec3(3, 63, 4);

/**
 * A 1.21.4 bot on the shared fake whose clock also drives the global timers: the wait's polls, its wall bound and the
 * server's time packets (the world age, 20 ticks a second) all run on the clock the test moves.
 */
function resyncFixture(options: { offHand?: { name: string } | null } = {}) {
  const harness = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), slots: { 45: options.offHand ?? null } });
  const { bot, server } = harness;
  /** The protocol packet the server sends the client: the bot's client emits it as the connection does. */
  const hear = (name: string, packet: Record<string, unknown>) => bot._client.emit(name, packet);
  const hearBlockChange = (location: { x: number; y: number; z: number }) => hear("block_change", { location, type: 1 });
  return { ...harness, hear, hearBlockChange, sent: server.packets, resent: () => server.packets.filter((entry) => entry.name === "block_place") };
}

/** Move the clock `ms` on and hand back the resync, which must be over by then. Stopgap until M2 merges `clock.settle`. */
async function settledAfter<T>(clock: FakeClock, ms: number, pending: Promise<T>): Promise<T> {
  let over = false;
  void pending.then(
    () => (over = true),
    () => (over = true),
  );
  await clock.advance(ms);
  assert.ok(over, `the resync still waits after ${ms} ms of clock`);
  return pending;
}

/**
 * The packets written, in order. The shift goes out as Mineflayer writes it for the control (`player_input`, which 1.21.3
 * and later send) and again as the `entity_action` this server reads (`setSneaking`; Mineflayer `physics.js:245-275` for the first).
 */
const ticks = (sent: readonly { name: string; data: unknown }[]) =>
  sent.map((entry) => (entry.name === "entity_action" ? `entity_action:${(entry.data as { actionId: number }).actionId}` : entry.name));

test("sends one use-on-block on the top face with the off hand while sneaking, and stands up again", async () => {
  const fixture = resyncFixture();
  using _timers = fixture.clock.install();
  fixture.clock.after(50, () => fixture.hearBlockChange({ x: 3, y: 63, z: 4 }));
  await settledAfter(fixture.clock, 100, requestCellResync(fixture.bot, CELL, new AbortController().signal));
  assert.deepEqual(ticks(fixture.sent), ["player_input", "entity_action:0", "block_place", "player_input", "entity_action:1"]);
  const place = fixture.resent()[0]!.data as Record<string, unknown>;
  assert.deepEqual(place.location, CELL, "the clicked cell is the one asked for");
  assert.equal(place.direction, 1, "its top face");
  assert.equal(place.hand, 1, "the off hand");
  assert.equal(typeof place.sequence, "number", "a 1.21.4 interaction carries its sequence");
});

test("a block packet for the cell within the bound is resent", async () => {
  const fixture = resyncFixture();
  using _timers = fixture.clock.install();
  fixture.clock.after(1_500, () => fixture.hearBlockChange({ x: 3, y: 63, z: 4 }));
  assert.equal(await settledAfter(fixture.clock, 1_550, requestCellResync(fixture.bot, CELL, new AbortController().signal)), "resent");
});

test("a packet for another cell is not the answer", async () => {
  const fixture = resyncFixture();
  using _timers = fixture.clock.install();
  fixture.clock.after(50, () => fixture.hearBlockChange({ x: 9, y: 63, z: 4 }));
  assert.equal(await settledAfter(fixture.clock, 2_000, requestCellResync(fixture.bot, CELL, new AbortController().signal)), "unanswered");
});

test("a resent chunk of the cell's column is the answer", async () => {
  const fixture = resyncFixture();
  using _timers = fixture.clock.install();
  fixture.clock.after(50, () => fixture.hear("map_chunk", { x: 0, z: 0 }));
  assert.equal(await settledAfter(fixture.clock, 100, requestCellResync(fixture.bot, CELL, new AbortController().signal)), "resent");
});

test("no packet in 40 ticks of world age is unanswered", async () => {
  const fixture = resyncFixture();
  using _timers = fixture.clock.install();
  const started = fixture.bot.time.age;
  // Two time packets (contract check `world-age-per-second`) are the 40 ticks: the wait ends with the second.
  assert.equal(await settledAfter(fixture.clock, 2_000, requestCellResync(fixture.bot, CELL, new AbortController().signal)), "unanswered");
  assert.equal(fixture.bot.time.age - started, 40, "it stopped as the age passed 40, not before");
});

test("no packet and no world age for 2 s is unanswered, on the wall clock", async () => {
  const fixture = resyncFixture();
  using _timers = fixture.clock.install();
  fixture.server.stop();
  const started = fixture.bot.time.age;
  assert.equal(await settledAfter(fixture.clock, SERVER_ANSWER_WALL_MS, requestCellResync(fixture.bot, CELL, new AbortController().signal)), "unanswered");
  assert.equal(fixture.bot.time.age, started, "the server clock never moved");
});

test("a held off-hand item is unavailable and nothing is sent", async () => {
  const fixture = resyncFixture({ offHand: { name: "shield" } });
  assert.equal(await requestCellResync(fixture.bot, CELL, new AbortController().signal), "unavailable");
  assert.deepEqual(fixture.sent, [], "no sneak, no use: the bot's items are not swapped");
});

test("an abort during the wait rejects with its reason and the bot stands up", async () => {
  const fixture = resyncFixture();
  using _timers = fixture.clock.install();
  const controller = new AbortController();
  fixture.clock.after(50, () => controller.abort(new Error("cancelled")));
  const rejected = assert.rejects(requestCellResync(fixture.bot, CELL, controller.signal), /cancelled/);
  await fixture.clock.advance(100);
  await rejected;
  assert.equal(ticks(fixture.sent).at(-1), "entity_action:1", "never left crouching");
  assert.equal(fixture.bot._client.listenerCount("block_change"), 0);
});

test("listeners are removed after each outcome", async () => {
  for (const outcome of ["resent", "unanswered", "unavailable"] as const) {
    const fixture = resyncFixture(outcome === "unavailable" ? { offHand: { name: "shield" } } : {});
    using _timers = fixture.clock.install();
    if (outcome === "resent") fixture.clock.after(50, () => fixture.hearBlockChange({ x: 3, y: 63, z: 4 }));
    const pending = requestCellResync(fixture.bot, CELL, new AbortController().signal);
    assert.equal(await settledAfter(fixture.clock, 2_000, pending), outcome);
    for (const name of ["block_change", "multi_block_change", "map_chunk"]) assert.equal(fixture.bot._client.listenerCount(name), 0, `${outcome}: ${name}`);
  }
});
