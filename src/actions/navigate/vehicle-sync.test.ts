import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { forgetVehicle, recoverPhysics, watchVehicle } from "./vehicle-sync.js";

/** A bot by boat 7, seated in it by the server unless `seated` is false; the client records the positions fed to Mineflayer's own handler. */
async function ridingBot({ seated = true } = {}) {
  const { bot, clock } = createFakeBot({ position: { x: 20.5, y: 62.96, z: 0.5 }, entities: { 7: { name: "oak_boat", position: { x: 20.5, y: 62.46, z: 0.5 } } } });
  const boat = bot.entities[7]!;
  if (seated) {
    bot.mount(boat);
    await clock.advance(50);
  }
  const self = bot.entity;
  const client = bot._client;
  const positions: { x: number; y: number; z: number }[] = [];
  client.on("position", (packet: { x: number; y: number; z: number }) => {
    positions.push(packet);
  });
  const dismounts: unknown[] = [];
  bot.on("dismount", (vehicle: unknown) => {
    dismounts.push(vehicle);
  });
  // Mineflayer's own plugins listen for a death and a respawn too: only the watch's own listeners are counted.
  const ownDeathListeners = bot.listenerCount("death") + bot.listenerCount("respawn");
  const stop = watchVehicle(bot);
  return { bot, self, boat, client, positions, dismounts, stop, ownDeathListeners };
}

// Mineflayer acts only on a passenger list that names the bot: one without her kept the vehicle and physics off for good.
test("the server letting her off (her boat's passenger list without her) forgets the vehicle and turns physics back on", async () => {
  const { bot, self, boat, client, positions, dismounts, stop } = await ridingBot();
  client.emit("set_passengers", { entityId: 7, passengers: [] });
  assert.equal(bot.vehicle, null);
  assert.equal(self.vehicle, null);
  assert.deepEqual(boat.passengers, []);
  assert.deepEqual(dismounts, [boat]);
  assert.equal(positions.length, 1, "physics is switched back on where she is");
  assert.deepEqual([positions[0]!.x, positions[0]!.y, positions[0]!.z], [20.5, 62.96, 0.5]);
  stop();
});

test("a passenger list that still names her, or another entity's, changes nothing", async () => {
  const { bot, boat, client, positions, dismounts, stop } = await ridingBot();
  client.emit("set_passengers", { entityId: 7, passengers: [1] });
  client.emit("set_passengers", { entityId: 9, passengers: [] });
  assert.equal(bot.vehicle, boat);
  assert.deepEqual([positions.length, dismounts.length], [0, 0]);
  stop();
});

test("her boat gone (broken or unloaded) is the same as being let off; nothing once the watch is stopped", async () => {
  const first = await ridingBot();
  first.bot.emit("entityGone", first.boat);
  assert.equal(first.bot.vehicle, null);
  assert.equal(first.positions.length, 1);
  first.stop();
  const second = await ridingBot();
  second.stop();
  second.client.emit("set_passengers", { entityId: 7, passengers: [] });
  assert.equal(second.bot.vehicle, second.boat);
});

test("nothing happens when she rides nothing", async () => {
  const { client, positions, stop } = await ridingBot({ seated: false });
  client.emit("set_passengers", { entityId: 7, passengers: [] });
  assert.equal(positions.length, 0);
  stop();
});

// Run 14b: after a stall nothing turned physics back on, so every later action stalled too (Finn 45 times).
test("a stall's recovery resumes physics where she is, only when she rides nothing and is alive", async () => {
  const { bot, positions, stop } = await ridingBot();
  recoverPhysics(bot);
  assert.equal(positions.length, 0, "a passenger owes no tick: her ride is not touched");
  forgetVehicle(bot);
  bot.health = 0;
  recoverPhysics(bot);
  assert.equal(positions.length, 0, "dead: the respawn's position turns physics on");
  bot.health = 20;
  recoverPhysics(bot);
  assert.equal(positions.length, 1);
  stop();
});

// A death ends the ride on the server too: the respawn brings its own position, so no fake one is fed, and the next
// movement must not find her still "riding" and send a shift for a boat she left.
test("a death while seated forgets the vehicle without a fake position", async () => {
  const { bot, self, boat, positions, dismounts, stop } = await ridingBot();
  bot.emit("death");
  assert.equal(bot.vehicle, null);
  assert.equal(self.vehicle, null);
  assert.deepEqual(dismounts, [boat]);
  bot.emit("respawn");
  assert.equal(positions.length, 0, "the respawn's own position turns physics on");
  stop();
});

test("a respawn while seated forgets the vehicle too, and the listeners go with the watch", async () => {
  const { bot, dismounts, stop, ownDeathListeners } = await ridingBot();
  bot.emit("respawn");
  assert.equal(bot.vehicle, null);
  assert.equal(dismounts.length, 1);
  stop();
  assert.equal(bot.listenerCount("death") + bot.listenerCount("respawn") - ownDeathListeners, 0);
});
