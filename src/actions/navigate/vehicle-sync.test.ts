import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { forgetVehicle, recoverPhysics, ridersOf, watchVehicle } from "./vehicle-sync.js";

/** A bot by boat 7, seated in it by the server unless `seated` is false; the client records the positions fed to Mineflayer's own handler. */
async function ridingBot({ seated = true } = {}) {
  const { bot, clock, entities } = createFakeBot({ position: { x: 20.5, y: 62.96, z: 0.5 }, entities: { 7: { name: "oak_boat", position: { x: 20.5, y: 62.46, z: 0.5 } } } });
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
  const added = listenersAddedSince(bot);
  const stop = watchVehicle(bot);
  return { bot, self, boat, client, positions, dismounts, stop, added, entities };
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
  assert.deepEqual([positions[0]!.x, positions[0]!.y, positions[0]!.z], self.position.toArray(), "where she is: at the seat the server put her client at");
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
  first.entities.remove(7);
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
  const { bot, dismounts, stop, added } = await ridingBot();
  bot.emit("respawn");
  assert.equal(bot.vehicle, null);
  assert.equal(dismounts.length, 1);
  stop();
  assert.equal(added("death") + added("respawn"), 0);
});

// Mineflayer moves a passenger between vehicles but never removes one a list leaves out (entities.js:794-811): the riders
// are what the server last listed, not `entity.passengers`.
test("the riders of a boat are the last passenger list the server sent for it; none heard, none; gone with the boat and the watch", async () => {
  const { bot, client, entities, stop } = await ridingBot({ seated: false });
  assert.deepEqual(ridersOf(bot, 7), [], "no list heard");
  client.emit("set_passengers", { entityId: 7, passengers: [31, 1] });
  assert.deepEqual(ridersOf(bot, 7), [31, 1]);
  client.emit("set_passengers", { entityId: 7, passengers: [1] });
  assert.deepEqual(ridersOf(bot, 7), [1], "the later list replaces the earlier");
  client.emit("set_passengers", { entityId: 9, passengers: [5] });
  assert.deepEqual(ridersOf(bot, 7), [1], "another boat's list is not hers");
  client.emit("set_passengers", { entityId: 7, passengers: [] });
  assert.deepEqual(ridersOf(bot, 7), [], "a list that leaves everyone out is kept as sent");
  client.emit("set_passengers", { entityId: 7, passengers: [31] });
  entities.remove(7);
  assert.deepEqual(ridersOf(bot, 7), [], "the boat gone (unloaded or broken)");
  client.emit("set_passengers", { entityId: 9, passengers: [5] });
  stop();
  assert.deepEqual(ridersOf(bot, 9), [], "nothing is kept once the watch is stopped");
});

// Mineflayer neither clears its entities nor emits entityGone at a respawn: a list heard before the death would outlive a
// boat emptied meanwhile, and pin her on it.
test("the passenger lists heard before a death or a respawn are forgotten", async () => {
  const { bot, client, stop } = await ridingBot({ seated: false });
  client.emit("set_passengers", { entityId: 7, passengers: [31] });
  bot.emit("respawn");
  assert.deepEqual(ridersOf(bot, 7), []);
  client.emit("set_passengers", { entityId: 7, passengers: [31] });
  bot.emit("death");
  assert.deepEqual(ridersOf(bot, 7), []);
  stop();
});
