import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { changeCovers, SERVER_ANSWER_WALL_MS, type ServerBlockChange, subscribeServerBlockChanges, watchServerChange } from "./server-block-changes.js";

/** A 1.21.4 bot on the shared fake, subscribed to the server's block packets: its protocol client carries them. */
function wire() {
  const harness = createFakeBot();
  const client = harness.bot._client;
  const changes: ServerBlockChange[] = [];
  const unsubscribe = subscribeServerBlockChanges(harness.bot, (change) => changes.push(change));
  return { ...harness, client, changes, unsubscribe };
}

/** One record of a 1.21.4 `multi_block_change`: block state, then the cell inside its 16-cube section. */
function record(stateId: number, cellX: number, cellY: number, cellZ: number): number {
  return (stateId << 12) | (cellX << 8) | (cellZ << 4) | cellY;
}

test("mineflayer's own air write is not a server change", () => {
  const { world, changes } = wire();
  // The fork's finished dig sets the cell to air in its own world and emits `blockUpdate`; the server has said nothing.
  world.setCell(new Vec3(3, 63, 4), "air");
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

const CELL = { x: 3, y: 63, z: 4 };

test("a watch answers when the server names its cell, even before anyone waits", async () => {
  const { bot, client, clock } = wire();
  const watch = watchServerChange(bot, CELL);
  client.emit("block_change", { location: CELL, type: 0 });
  assert.equal(await watch.answer(new AbortController().signal, clock), true);
  watch.dispose();
});

test("a watch is not answered by another cell, and gives up when the server clock moves 40 ticks", async () => {
  const { bot, client, clock } = wire();
  const watch = watchServerChange(bot, CELL);
  client.emit("block_change", { location: { ...CELL, x: 9 }, type: 0 });
  const started = bot.time.age;
  // Two time packets (contract check `world-age-per-second`) are the 40 ticks.
  assert.equal(await clock.settle(watch.answer(new AbortController().signal, clock), 2_000), false);
  assert.equal(bot.time.age - started, 40);
  watch.dispose();
});

test("a watch gives up on the wall clock when the server clock never moves", async () => {
  const { bot, clock, server } = wire();
  const watch = watchServerChange(bot, CELL);
  server.stop();
  const started = bot.time.age;
  const answer = watch.answer(new AbortController().signal, clock);
  let over = false;
  void answer.then(() => (over = true));
  await clock.advance(SERVER_ANSWER_WALL_MS - 100);
  assert.equal(over, false, "still waiting inside the wall bound");
  assert.equal(await clock.settle(answer, 100), false);
  assert.equal(bot.time.age, started, "the server clock never moved");
  watch.dispose();
});

test("disposing a watch removes its listeners", () => {
  const { bot, client } = wire();
  const before = client.listenerCount("block_change");
  const watch = watchServerChange(bot, CELL);
  assert.equal(client.listenerCount("block_change"), before + 1);
  watch.dispose();
  watch.dispose();
  assert.equal(client.listenerCount("block_change"), before);
});
