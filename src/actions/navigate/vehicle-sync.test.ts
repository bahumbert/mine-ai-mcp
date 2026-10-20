import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { recoverPhysics, watchVehicle } from "./vehicle-sync.js";

/** A bot riding boat 7; the client records the positions fed to Mineflayer's own handler. */
function ridingBot() {
  const boat = { id: 7, name: "oak_boat", position: new Vec3(20.5, 62.46, 0.5), passengers: [] as unknown[] };
  const self = { id: 1, position: new Vec3(20.5, 62.96, 0.5), yaw: 0, pitch: 0, vehicle: boat as unknown };
  boat.passengers.push(self);
  const client = new EventEmitter();
  const bot = Object.assign(new EventEmitter(), { entity: self, vehicle: boat as unknown, _client: client });
  const positions: { x: number; y: number; z: number }[] = [];
  client.on("position", (packet: { x: number; y: number; z: number }) => positions.push(packet));
  const dismounts: unknown[] = [];
  bot.on("dismount", (vehicle: unknown) => dismounts.push(vehicle));
  const stop = watchVehicle(bot as unknown as Bot);
  return { bot, self, boat, client, positions, dismounts, stop };
}

// Mineflayer acts only on a passenger list that names the bot: one without her kept the vehicle and physics off for good.
test("the server letting her off (her boat's passenger list without her) forgets the vehicle and turns physics back on", () => {
  const { bot, self, boat, client, positions, dismounts, stop } = ridingBot();
  client.emit("set_passengers", { entityId: 7, passengers: [] });
  assert.equal(bot.vehicle, null);
  assert.equal(self.vehicle, null);
  assert.deepEqual(boat.passengers, []);
  assert.deepEqual(dismounts, [boat]);
  assert.equal(positions.length, 1, "physics is switched back on where she is");
  assert.deepEqual([positions[0]!.x, positions[0]!.y, positions[0]!.z], [20.5, 62.96, 0.5]);
  stop();
});

test("a passenger list that still names her, or another entity's, changes nothing", () => {
  const { bot, boat, client, positions, dismounts, stop } = ridingBot();
  client.emit("set_passengers", { entityId: 7, passengers: [1] });
  client.emit("set_passengers", { entityId: 9, passengers: [] });
  assert.equal(bot.vehicle, boat);
  assert.deepEqual([positions.length, dismounts.length], [0, 0]);
  stop();
});

test("her boat gone (broken or unloaded) is the same as being let off; nothing once the watch is stopped", () => {
  const first = ridingBot();
  first.bot.emit("entityGone", first.boat);
  assert.equal(first.bot.vehicle, null);
  assert.equal(first.positions.length, 1);
  first.stop();
  const second = ridingBot();
  second.stop();
  second.client.emit("set_passengers", { entityId: 7, passengers: [] });
  assert.equal(second.bot.vehicle, second.boat);
});

test("nothing happens when she rides nothing", () => {
  const { bot, self, client, positions, stop } = ridingBot();
  bot.vehicle = null;
  self.vehicle = null;
  client.emit("set_passengers", { entityId: 7, passengers: [] });
  assert.equal(positions.length, 0);
  stop();
});

// Run 14b: after a stall nothing turned physics back on, so every later action stalled too (Finn 45 times).
test("a stall's recovery resumes physics where she is, only when she rides nothing and is alive", () => {
  const { bot, self, positions, stop } = ridingBot();
  recoverPhysics(bot as unknown as Bot);
  assert.equal(positions.length, 0, "a passenger owes no tick: her ride is not touched");
  bot.vehicle = null;
  self.vehicle = null;
  Object.assign(bot, { health: 0 });
  recoverPhysics(bot as unknown as Bot);
  assert.equal(positions.length, 0, "dead: the respawn's position turns physics on");
  Object.assign(bot, { health: 20 });
  recoverPhysics(bot as unknown as Bot);
  assert.equal(positions.length, 1);
  stop();
});

// A death ends the ride on the server too: the respawn brings its own position, so no fake one is fed, and the next
// movement must not find her still "riding" and send a shift for a boat she left.
test("a death while seated forgets the vehicle without a fake position", () => {
  const { bot, self, boat, positions, dismounts, stop } = ridingBot();
  bot.emit("death");
  assert.equal(bot.vehicle, null);
  assert.equal(self.vehicle, null);
  assert.deepEqual(dismounts, [boat]);
  bot.emit("respawn");
  assert.equal(positions.length, 0, "the respawn's own position turns physics on");
  stop();
});

test("a respawn while seated forgets the vehicle too, and the listeners go with the watch", () => {
  const { bot, dismounts, stop } = ridingBot();
  bot.emit("respawn");
  assert.equal(bot.vehicle, null);
  assert.equal(dismounts.length, 1);
  stop();
  assert.equal(bot.listenerCount("death") + bot.listenerCount("respawn"), 0);
});
