import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { createFakeBot, createFakeClock } from "../test-support/fake-bot/index.js";
import { SERVER_ANSWER_TICKS } from "./world-age.js";
import { airSupplyTicks, watchAirHistory } from "./air-supply.js";

// `airSupplyTicks` with the history tracker (plan 2026-11-18-scenario-reds-part5 T31a): a body never under water since it spawned has
// full air the server never sent; every other case stays unknown. Each timing case runs at 20 tps, 10 tps and with the server stopped.

/** The cell above the feet at (0, 0, 0): water in it puts the eyes (feet 0, eye 1.62) under water. */
const EYE_CELL = new Vec3(0, 1, 0);

/**
 * A bot standing dry at (0.5, 0, 0.5) whose own entity holds no metadata, as a login with the air unchanged leaves it
 * (contract check `air-supply-under-water`: nothing is sent while the eye is in air with a full meter). `watched: false`
 * is a bot with no tracker, which every older test builds.
 */
function scene(ticksPerSecond: number, watched = true) {
  const harness = createFakeBot({ position: new Vec3(0.5, 0, 0.5), groundY: null, clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond },
    entities: { 7: { name: "player", position: { x: 5.5, y: 0, z: 0.5 } } } });
  Reflect.set(harness.bot.entity, "metadata", []);
  if (watched) watchAirHistory(harness.bot);
  /** The wall ms of one time packet: 20 server ticks. */
  const packetMs = 20_000 / ticksPerSecond;
  const age = () => harness.bot.time.age;
  const wet = (inWater: boolean) => harness.world.setCell(EYE_CELL, inWater ? "water" : "air");
  return { ...harness, packetMs, age, wet };
}

const airIndex = (bot: Bot) => bot.registry.entitiesByName.player!.metadataKeys!.indexOf("air_supply");

for (const rate of [20, 10]) test(`a dry start has full air 40 server ticks after the first time packet it heard, at ${rate} tps`, async () => {
  const { bot, clock, packetMs, age } = scene(rate);
  bot.emit("login");
  assert.equal(airSupplyTicks(bot), null, "no time packet heard yet");
  await clock.advance(packetMs);
  const first = age()!;
  assert.equal(airSupplyTicks(bot), null, "the packet itself is no answer");
  await clock.advance(packetMs);
  assert.equal(age(), first + 20);
  assert.equal(airSupplyTicks(bot), null, "20 ticks after it");
  await clock.advance(packetMs);
  assert.equal(age(), first + SERVER_ANSWER_TICKS);
  assert.equal(airSupplyTicks(bot), 300, "40 ticks after it: the spawn's metadata packets are handled");
  assert.equal(clock.now(), 3 * packetMs, `${rate} tps: three packets are ${3 * packetMs} ms of wall time`);
});

test("a stopped server proves nothing: the air of a dry start stays unknown past any wall time", async () => {
  const { bot, clock, server, age } = scene(20);
  bot.emit("login");
  server.stop();
  await clock.advance(60_000);
  assert.equal(age(), 24_000);
  assert.equal(airSupplyTicks(bot), null);
});

test("a server stopped after the first packet leaves the air unknown until the world age moves 40", async () => {
  const { bot, clock, server, packetMs, age } = scene(20);
  bot.emit("login");
  await clock.advance(packetMs);
  const first = age()!;
  server.stop();
  await clock.advance(60_000);
  assert.equal(age(), first);
  assert.equal(airSupplyTicks(bot), null);
});

test("a time packet with no login or respawn seen since the tracker attached proves nothing", async () => {
  const { bot, clock, packetMs } = scene(20);
  await clock.advance(10 * packetMs);
  assert.equal(airSupplyTicks(bot), null);
});

for (const rate of [20, 10]) test(`a body whose head was under water stays unknown, at ${rate} tps`, async () => {
  const { bot, clock, packetMs, wet } = scene(rate);
  bot.emit("login");
  await clock.advance(packetMs);
  wet(true);
  bot.emit("physicsTick");
  wet(false);
  await clock.advance(5 * packetMs);
  assert.equal(airSupplyTicks(bot), null, "100 ticks later, dry again: the air may have changed unreported");
});

test("a head under water at the call is unknown even for a body that was dry before", async () => {
  const { bot, clock, packetMs, wet } = scene(20);
  bot.emit("login");
  await clock.advance(3 * packetMs);
  assert.equal(airSupplyTicks(bot), 300);
  wet(true);
  assert.equal(airSupplyTicks(bot), null, "no physics tick needed: the read at the call sees the water");
  wet(false);
  assert.equal(airSupplyTicks(bot), null, "dry again, but a read at the call saw this body's head under water: wet is kept");
});

for (const rate of [20, 10]) test(`the source surface preserves dry air history until the standing eye enters it at ${rate} tps`, async () => {
  const { bot, clock, packetMs, wet } = scene(rate);
  bot.emit("login");
  await clock.advance(3 * packetMs);
  assert.equal(bot.time.age, 24_060);
  wet(true);
  bot.entity.position.y = 0.356;
  bot.emit("physicsTick");
  assert.equal(airSupplyTicks(bot), 300, "source surface below the eye preserves inferred full air");
  bot.entity.position.y = 0.24;
  bot.emit("physicsTick");
  bot.entity.position.y = 0.356;
  assert.equal(airSupplyTicks(bot), null, `a wet tick at ${clock.now()} ms/age ${bot.time.age} is remembered before metadata`);
});

test("a head under water at a read before the 40 ticks are over is kept as wet for the body, a new body starts again", async () => {
  const { bot, clock, packetMs, wet } = scene(20);
  bot.emit("login");
  await clock.advance(packetMs);
  wet(true);
  assert.equal(airSupplyTicks(bot), null, "inside the window, the read at the call still sees the water");
  wet(false);
  await clock.advance(5 * packetMs);
  assert.equal(airSupplyTicks(bot), null, "past the window the dry head does not undo what a read saw");
  Reflect.set(bot.entity, "metadata", []);
  bot.emit("respawn");
  await clock.advance(3 * packetMs);
  assert.equal(airSupplyTicks(bot), 300, "the new body was never wet");
});

test("water seen at a time packet counts as wet when no physics tick runs", async () => {
  const { bot, clock, packetMs, wet } = scene(20);
  bot.emit("login");
  // Emitted by hand inside one server tick: a running fake server would report the air it loses (as the game does) and end the doubt.
  wet(true);
  bot.emit("time");
  wet(false);
  await clock.advance(5 * packetMs);
  assert.equal(airSupplyTicks(bot), null);
});

for (const rate of [20, 10]) test(`a respawn that clears the metadata starts the history again, at ${rate} tps`, async () => {
  const { bot, clock, packetMs, wet } = scene(rate);
  bot.emit("login");
  await clock.advance(packetMs);
  wet(true);
  bot.emit("physicsTick");
  wet(false);
  await clock.advance(5 * packetMs);
  assert.equal(airSupplyTicks(bot), null, "the old body was wet");
  Reflect.set(bot.entity, "metadata", []);
  bot.emit("respawn");
  assert.equal(airSupplyTicks(bot), null, "no packet of the new body yet");
  await clock.advance(packetMs);
  assert.equal(airSupplyTicks(bot), null, "its first packet");
  await clock.advance(packetMs);
  assert.equal(airSupplyTicks(bot), null, "20 ticks after it");
  await clock.advance(packetMs);
  assert.equal(airSupplyTicks(bot), 300, "40 ticks after it: the new body was never wet");
});

test("a body that reported its air and then lost the value without a respawn stays unknown", async () => {
  const { bot, clock, packetMs } = scene(20);
  bot.emit("login");
  Reflect.set(bot.entity.metadata, airIndex(bot), 250);
  assert.equal(airSupplyTicks(bot), 250);
  Reflect.set(bot.entity, "metadata", []);
  await clock.advance(4 * packetMs);
  assert.equal(airSupplyTicks(bot), null);
});

for (const [name, wasWet, expected] of [["dry", false, 300], ["wet", true, null]] as const)
  test(`another entity's air and oxygenLevel are never read: a ${name} bot with no metadata of its own`, async () => {
    const { bot, clock, packetMs, wet } = scene(20);
    Reflect.set(bot.entities[7]!.metadata, airIndex(bot), 120);
    Object.defineProperty(bot, "oxygenLevel", { value: 7, configurable: true });
    bot.emit("login");
    if (wasWet) {
      wet(true);
      bot.emit("physicsTick");
      wet(false);
    }
    await clock.advance(3 * packetMs);
    assert.equal(airSupplyTicks(bot), expected);
  });

test("the bot's own value is returned whatever the history, and a present value that is no integer is unknown", async () => {
  const { bot, wet } = scene(20);
  bot.emit("login");
  Reflect.set(bot.entity.metadata, airIndex(bot), 200);
  assert.equal(airSupplyTicks(bot), 200, "no time packet heard");
  wet(true);
  bot.emit("physicsTick");
  assert.equal(airSupplyTicks(bot), 200, "wet");
  for (const unreadable of [12.5, "300", null, Number.NaN]) {
    Reflect.set(bot.entity.metadata, airIndex(bot), unreadable);
    assert.equal(airSupplyTicks(bot), null, `present but unreadable ${String(unreadable)} is never inferred full`);
  }
});

test("a bot with no tracker keeps today's answer: unknown air stays null", async () => {
  const { bot, clock, packetMs } = scene(20, false);
  bot.emit("login");
  await clock.advance(10 * packetMs);
  assert.equal(airSupplyTicks(bot), null);
  Reflect.set(bot.entity.metadata, airIndex(bot), 120);
  assert.equal(airSupplyTicks(bot), 120);
});

test("the tracker leaves no listener on a bot that has ended, and its air is unknown again", async () => {
  const { bot, clock, packetMs } = scene(20, false);
  const events = ["login", "respawn", "time", "physicsTick", "end"] as const;
  const before = events.map((event) => bot.listenerCount(event));
  watchAirHistory(bot);
  bot.emit("login");
  await clock.advance(5 * packetMs);
  assert.equal(airSupplyTicks(bot), 300);
  bot.emit("end", "Host closed");
  assert.deepEqual(events.map((event) => bot.listenerCount(event)), before, "the four listeners and the end listener are gone");
  assert.equal(airSupplyTicks(bot), null);
});

test("watching a bot twice adds its four listeners once, and an unspawned bot with no entity is read as unknown", () => {
  const { bot } = scene(20);
  const events = ["login", "respawn", "time", "physicsTick"] as const;
  const before = events.map((event) => bot.listenerCount(event));
  watchAirHistory(bot);
  assert.deepEqual(events.map((event) => bot.listenerCount(event)), before);
  Reflect.set(bot, "entity", undefined);
  bot.emit("login");
  assert.doesNotThrow(() => bot.emit("time"));
  assert.doesNotThrow(() => bot.emit("physicsTick"));
  assert.equal(airSupplyTicks(bot), null);
});
