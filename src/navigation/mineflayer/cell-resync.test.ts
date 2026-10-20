import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture, registry } from "../../test-support/bot.js";
import { requestCellResync } from "./cell-resync.js";

const CELL = new Vec3(3, 63, 4);

interface Sent {
  readonly name: string;
  readonly packet: Record<string, unknown>;
}

/**
 * A 1.21.4 bot whose protocol client records what is written, in order, and whose clock the test moves: the world age
 * (`bot.time.age`) and the monotonic wall clock only advance when the injected `sleep` is called.
 */
function resyncFixture(options: { offHand?: { name: string } | null } = {}) {
  const client = Object.assign(new EventEmitter(), {
    write: (name: string, packet: Record<string, unknown>) => sent.push({ name, packet }),
  });
  const sent: Sent[] = [];
  const bot = botFixture(
    { slots: { 45: options.offHand ?? null } },
    { version: "1.21.4", _client: client, supportFeature: (feature: string) => registry.supportFeature(feature as never) },
  );
  const clock = { wall: 0 };
  /** What the "server" does during each wait step: advance the world age by `aged` ticks and `wall` milliseconds pass. */
  const step = { aged: 0, wall: 50, onStep: (_index: number): void => undefined };
  let steps = 0;
  const wait = {
    now: () => clock.wall,
    sleep: async (ms: number) => {
      clock.wall += Math.max(ms, step.wall);
      bot.time.age += step.aged;
      step.onStep(steps++);
    },
  };
  return { bot, client, sent, step, wait, resent: () => sent.filter((entry) => entry.name === "block_place") };
}

const ticks = (sent: readonly Sent[]) => sent.map((entry) => (entry.name === "entity_action" ? `entity_action:${entry.packet.actionId}` : entry.name));

test("sends one use-on-block on the top face with the off hand while sneaking, and stands up again", async () => {
  const fixture = resyncFixture();
  fixture.step.onStep = () => fixture.client.emit("block_change", { location: { x: 3, y: 63, z: 4 }, type: 1 });
  await requestCellResync(fixture.bot, CELL, new AbortController().signal, fixture.wait);
  assert.deepEqual(ticks(fixture.sent), ["entity_action:0", "block_place", "entity_action:1"]);
  const place = fixture.resent()[0]!.packet;
  assert.deepEqual(place.location, CELL, "the clicked cell is the one asked for");
  assert.equal(place.direction, 1, "its top face");
  assert.equal(place.hand, 1, "the off hand");
  assert.equal(typeof place.sequence, "number", "a 1.21.4 interaction carries its sequence");
});

test("a block packet for the cell within the bound is resent", async () => {
  const fixture = resyncFixture();
  fixture.step.onStep = (index) => {
    if (index === 1) fixture.client.emit("block_change", { location: { x: 3, y: 63, z: 4 }, type: 1 });
  };
  assert.equal(await requestCellResync(fixture.bot, CELL, new AbortController().signal, fixture.wait), "resent");
});

test("a packet for another cell is not the answer", async () => {
  const fixture = resyncFixture();
  fixture.step.aged = 20;
  fixture.step.onStep = () => fixture.client.emit("block_change", { location: { x: 9, y: 63, z: 4 }, type: 1 });
  assert.equal(await requestCellResync(fixture.bot, CELL, new AbortController().signal, fixture.wait), "unanswered");
});

test("a resent chunk of the cell's column is the answer", async () => {
  const fixture = resyncFixture();
  fixture.step.onStep = () => fixture.client.emit("map_chunk", { x: 0, z: 0 });
  assert.equal(await requestCellResync(fixture.bot, CELL, new AbortController().signal, fixture.wait), "resent");
});

test("no packet in 40 ticks of world age is unanswered", async () => {
  const fixture = resyncFixture();
  fixture.step.aged = 20;
  const started = fixture.bot.time.age;
  assert.equal(await requestCellResync(fixture.bot, CELL, new AbortController().signal, fixture.wait), "unanswered");
  assert.equal(fixture.bot.time.age - started, 40, "it stopped as the age passed 40, not before");
});

test("no packet and no world age for 2 s is unanswered, on the wall clock", async () => {
  const fixture = resyncFixture();
  fixture.step.wall = 500;
  const started = fixture.bot.time.age;
  assert.equal(await requestCellResync(fixture.bot, CELL, new AbortController().signal, fixture.wait), "unanswered");
  assert.equal(fixture.bot.time.age, started, "the server clock never moved");
});

test("a held off-hand item is unavailable and nothing is sent", async () => {
  const fixture = resyncFixture({ offHand: { name: "shield" } });
  assert.equal(await requestCellResync(fixture.bot, CELL, new AbortController().signal, fixture.wait), "unavailable");
  assert.deepEqual(fixture.sent, [], "no sneak, no use: the bot's items are not swapped");
});

test("an abort during the wait rejects with its reason and the bot stands up", async () => {
  const fixture = resyncFixture();
  const controller = new AbortController();
  fixture.step.onStep = () => controller.abort(new Error("cancelled"));
  await assert.rejects(requestCellResync(fixture.bot, CELL, controller.signal, { ...fixture.wait, sleep: async (ms: number) => {
    await fixture.wait.sleep(ms);
    controller.signal.throwIfAborted();
  } }), /cancelled/);
  assert.equal(ticks(fixture.sent).at(-1), "entity_action:1", "never left crouching");
  assert.equal(fixture.client.listenerCount("block_change"), 0);
});

test("listeners are removed after each outcome", async () => {
  for (const outcome of ["resent", "unanswered", "unavailable"] as const) {
    const fixture = resyncFixture(outcome === "unavailable" ? { offHand: { name: "shield" } } : {});
    if (outcome === "resent") fixture.step.onStep = () => fixture.client.emit("block_change", { location: { x: 3, y: 63, z: 4 }, type: 1 });
    else fixture.step.aged = 40;
    assert.equal(await requestCellResync(fixture.bot, CELL, new AbortController().signal, fixture.wait), outcome);
    for (const name of ["block_change", "multi_block_change", "map_chunk"]) assert.equal(fixture.client.listenerCount(name), 0, `${outcome}: ${name}`);
  }
});
