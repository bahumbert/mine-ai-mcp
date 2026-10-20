import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { serverSeatWatchOf, watchServerSeat } from "./server-seat-watch.js";
import { NO_TELEPORT } from "./vehicle-sync.js";

/** A bot with the events the watch reads, standing at `at`; the boat she left stood at (100.5, 62.5, 100.5). */
function botAt(at: Vec3) {
  const client = new EventEmitter();
  const bot = Object.assign(new EventEmitter(), { entity: { id: 1, position: at }, _client: client });
  const boat = { id: 7, name: "oak_boat", position: new Vec3(100.5, 62.5, 100.5) };
  // Mineflayer's own position handler moves the client first-come; the watch must read the place before it.
  client.on("position", (packet: { x: number; y: number; z: number }) => {
    bot.entity.position = new Vec3(packet.x, packet.y, packet.z);
  });
  return { bot: bot as unknown as Bot, raw: bot, client, boat };
}

const serverPosition = (x: number, z: number, teleportId = 3) => ({ x, y: 63, z, yaw: 0, pitch: 0, flags: { x: false, y: false, z: false, yaw: false, pitch: false }, teleportId });

test("no seat is held before a get-off", () => {
  const { bot } = botAt(new Vec3(100.5, 63, 160.5));
  assert.equal(watchServerSeat(bot).heldAt(), null);
});

test("after a get-off, a client that crossed 2 chunk borders with no server chunk centre is held where the boat was", () => {
  const { bot, raw, boat } = botAt(new Vec3(100.5, 63, 100.5));
  const watch = watchServerSeat(bot);
  raw.emit("dismount", boat);
  assert.equal(watch.heldAt(), null, "still at the boat");
  raw.entity.position = new Vec3(100.5, 63, 100.5 + 16);
  assert.equal(watch.heldAt(), null, "one border: the server's chunk centre would have moved too");
  raw.entity.position = new Vec3(100.5, 63, 100.5 + 40);
  assert.deepEqual(watch.heldAt()?.toArray(), [100.5, 62.5, 100.5]);
});

test("a chunk centre update from the server says it let her off", () => {
  const { bot, raw, client, boat } = botAt(new Vec3(100.5, 63, 100.5));
  const watch = watchServerSeat(bot);
  raw.emit("dismount", boat);
  client.emit("update_view_position", { chunkX: 6, chunkZ: 7 });
  raw.entity.position = new Vec3(100.5, 63, 200.5);
  assert.equal(watch.heldAt(), null);
});

test("a portal teleport far from the boat is not a held seat", () => {
  const { bot, raw, client, boat } = botAt(new Vec3(100.5, 63, 100.5));
  const watch = watchServerSeat(bot);
  raw.emit("dismount", boat);
  client.emit("position", serverPosition(-800.5, 40.5));
  raw.entity.position = new Vec3(-800.5, 63, 200.5);
  assert.equal(watch.heldAt(), null);
});

test("the client's own physics-resuming position is not the server speaking", () => {
  const { bot, raw, client, boat } = botAt(new Vec3(100.5, 63, 100.5));
  const watch = watchServerSeat(bot);
  raw.emit("dismount", boat);
  client.emit("position", serverPosition(100.5, 100.5, NO_TELEPORT));
  raw.entity.position = new Vec3(100.5, 63, 200.5);
  assert.notEqual(watch.heldAt(), null);
});

test("a server position back at the boat while her client is 16+ blocks away is a held seat (moved too quickly)", () => {
  const { bot, raw, client, boat } = botAt(new Vec3(100.5, 63, 100.5));
  const watch = watchServerSeat(bot);
  raw.emit("dismount", boat);
  raw.entity.position = new Vec3(100.5, 63, 130.5);
  client.emit("position", serverPosition(100.5, 101.5));
  // Mineflayer's handler has moved her client to the snapped place by now; the watch read it before.
  assert.deepEqual(raw.entity.position.toArray(), [100.5, 63, 101.5]);
  assert.notEqual(watch.heldAt(), null);
});

test("a server position back at the boat with her client close is just the server putting her down", () => {
  const { bot, raw, client, boat } = botAt(new Vec3(100.5, 63, 100.5));
  const watch = watchServerSeat(bot);
  raw.emit("dismount", boat);
  raw.entity.position = new Vec3(100.5, 63, 108.5);
  client.emit("position", serverPosition(100.5, 101.5));
  assert.equal(watch.heldAt(), null);
});

test("a death, a respawn and a new mount each clear the watch", () => {
  for (const event of ["death", "respawn", "mount"]) {
    const { bot, raw, boat } = botAt(new Vec3(100.5, 63, 100.5));
    const watch = watchServerSeat(bot);
    raw.emit("dismount", boat);
    raw.entity.position = new Vec3(100.5, 63, 200.5);
    assert.notEqual(watch.heldAt(), null, event);
    raw.emit(event);
    assert.equal(watch.heldAt(), null, event);
  }
});

test("release forgets the held seat once the server answered", () => {
  const { bot, raw, boat } = botAt(new Vec3(100.5, 63, 100.5));
  const watch = watchServerSeat(bot);
  raw.emit("dismount", boat);
  raw.entity.position = new Vec3(100.5, 63, 200.5);
  watch.release();
  assert.equal(watch.heldAt(), null);
});

test("each bot has its own watch and stop leaves no listener behind", () => {
  const first = botAt(new Vec3(0, 63, 0));
  const second = botAt(new Vec3(0, 63, 0));
  const watch = watchServerSeat(first.bot);
  const other = watchServerSeat(second.bot);
  assert.equal(serverSeatWatchOf(first.bot), watch);
  assert.equal(serverSeatWatchOf(second.bot), other);
  first.raw.emit("dismount", first.boat);
  first.raw.entity.position = new Vec3(0, 63, 100);
  assert.notEqual(watch.heldAt(), null);
  assert.equal(other.heldAt(), null, "the other bot never got off");
  watch.stop();
  assert.equal(serverSeatWatchOf(first.bot), undefined);
  const counts = (entry: ReturnType<typeof botAt>) => ["dismount", "mount", "death", "respawn"].reduce((sum, name) => sum + entry.raw.listenerCount(name), 0) + entry.client.listenerCount("update_view_position") + entry.client.listenerCount("position");
  assert.equal(counts(first), 1, "only the test's own position handler remains");
});
