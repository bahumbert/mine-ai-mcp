import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import { registry } from "../../test-support/bot.js";
import { changeCovers, SERVER_ANSWER_WALL_MS, type ServerBlockChange, subscribeServerBlockChanges, watchServerChange } from "./server-block-changes.js";

/** A bot with the protocol client and the feature table of 1.21.4: only the wire is real, nothing else is read. */
function wire() {
  const client = new EventEmitter();
  const bot = Object.assign(new EventEmitter(), {
    _client: client,
    supportFeature: (feature: string) => registry.supportFeature(feature as never),
  }) as unknown as Bot & EventEmitter;
  const changes: ServerBlockChange[] = [];
  const unsubscribe = subscribeServerBlockChanges(bot, (change) => changes.push(change));
  return { bot, client, changes, unsubscribe };
}

/** One record of a 1.21.4 `multi_block_change`: block state, then the cell inside its 16-cube section. */
function record(stateId: number, cellX: number, cellY: number, cellZ: number): number {
  return (stateId << 12) | (cellX << 8) | (cellZ << 4) | cellY;
}

test("mineflayer's own air write is not a server change", () => {
  const { bot, changes } = wire();
  // The fork's finished dig sets the cell to air in its own world and emits this; the server has said nothing.
  bot.emit("blockUpdate", { position: { x: 3, y: 63, z: 4 }, stateId: 0 }, { position: { x: 3, y: 63, z: 4 }, stateId: 0 });
  assert.deepEqual(changes, []);
});

test("a block_change packet is a server change of its cell", () => {
  const { client, changes } = wire();
  client.emit("block_change", { location: { x: 3, y: 63, z: 4 }, type: 1 });
  assert.equal(changes.length, 1);
  assert.ok(changeCovers(changes[0]!, { x: 3, y: 63, z: 4 }));
  assert.ok(!changeCovers(changes[0]!, { x: 3, y: 62, z: 4 }), "only the cell the packet names");
});

test("a multi_block_change covering the cell is a server change of that cell, and only of the cells it lists", () => {
  const { client, changes } = wire();
  // Section (0, 3, 0) is y 48..63: cell (3, 15, 4) inside it is the world cell (3, 63, 4).
  client.emit("multi_block_change", { chunkCoordinates: { x: 0, y: 3, z: 0 }, records: [record(1, 3, 15, 4), record(0, 5, 15, 4)] });
  assert.ok(changes.some((change) => changeCovers(change, { x: 3, y: 63, z: 4 })));
  assert.ok(changes.some((change) => changeCovers(change, { x: 5, y: 63, z: 4 })));
  assert.ok(!changes.some((change) => changeCovers(change, { x: 4, y: 63, z: 4 })), "a cell the packet does not list");
});

test("a resent chunk answers every cell of its column and no other column", () => {
  const { client, changes } = wire();
  client.emit("map_chunk", { x: -1, z: 2 });
  assert.equal(changes.length, 1);
  assert.ok(changeCovers(changes[0]!, { x: -16, y: 5, z: 32 }));
  assert.ok(changeCovers(changes[0]!, { x: -1, y: 120, z: 47 }));
  assert.ok(!changeCovers(changes[0]!, { x: 0, y: 5, z: 32 }), "the next column east");
});

test("the unsubscribe removes every listener it added, once or twice", () => {
  const { client, unsubscribe } = wire();
  const names = ["block_change", "multi_block_change", "map_chunk"];
  assert.ok(names.every((name) => client.listenerCount(name) === 1));
  unsubscribe();
  unsubscribe();
  assert.ok(names.every((name) => client.listenerCount(name) === 0));
});

/** A bot whose world age the test moves, over the same wire. */
function watched() {
  const fixture = wire();
  const bot = Object.assign(fixture.bot, { time: { age: 100 } }) as unknown as Parameters<typeof watchServerChange>[0];
  return { ...fixture, bot };
}

const CELL = { x: 3, y: 63, z: 4 };
const instantClock = { now: () => 0, sleep: async () => undefined };

test("a watch answers when the server names its cell, even before anyone waits", async () => {
  const { bot, client } = watched();
  const watch = watchServerChange(bot, CELL);
  client.emit("block_change", { location: CELL, type: 0 });
  assert.equal(await watch.answer(new AbortController().signal), true);
  watch.dispose();
});

test("a watch is not answered by another cell, and gives up when the server clock moves 40 ticks", async () => {
  const { bot, client } = watched();
  const watch = watchServerChange(bot, CELL);
  client.emit("block_change", { location: { ...CELL, x: 9 }, type: 0 });
  const aging = { ...instantClock, sleep: async () => void ((bot as unknown as { time: { age: number } }).time.age += 20) };
  assert.equal(await watch.answer(new AbortController().signal, aging), false);
  watch.dispose();
});

test("a watch gives up on the wall clock when the server clock never moves", async () => {
  const { bot } = watched();
  const watch = watchServerChange(bot, CELL);
  let wall = 0;
  const slow = { now: () => wall, sleep: async () => void (wall += 500) };
  assert.equal(await watch.answer(new AbortController().signal, slow), false);
  assert.ok(wall >= SERVER_ANSWER_WALL_MS && wall < SERVER_ANSWER_WALL_MS + 1_000, `waited ${wall} ms`);
  watch.dispose();
});

test("disposing a watch removes its listeners", () => {
  const { bot, client } = watched();
  const before = client.listenerCount("block_change");
  const watch = watchServerChange(bot, CELL);
  assert.equal(client.listenerCount("block_change"), before + 1);
  watch.dispose();
  watch.dispose();
  assert.equal(client.listenerCount("block_change"), before);
});
