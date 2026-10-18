import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { cellsAround, watchGhostBlocks } from "./ghost-block.js";

interface Packet { readonly name: string; readonly params: Record<string, unknown> }

/** A bot standing at `at`; the clock is ours, the packets and log lines are recorded. */
function standingBot(offHandItem: string | null = null, at = new Vec3(191.5, 79, 292.5)) {
  const packets: Packet[] = [];
  const logs: string[] = [];
  const clock = { ms: 0 };
  const slots: Record<number, { name: string } | null> = { 45: offHandItem === null ? null : { name: offHandItem } };
  const bot = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: at.clone(), vehicle: null as unknown },
    vehicle: null as unknown,
    inventory: { slots },
    registry: { version: { ">=": () => true } },
    _client: { write: (name: string, params: Record<string, unknown>) => packets.push({ name, params }) },
  });
  const stop = watchGhostBlocks(bot as unknown as Bot, { now: () => clock.ms, log: (line) => logs.push(line) });
  /** The server puts her back at (x, y, z), `afterMs` after the previous correction. */
  const correct = (afterMs: number, x = at.x, y = at.y, z = at.z) => {
    clock.ms += afterMs;
    bot.entity.position = new Vec3(x, y, z);
    bot.emit("forcedMove");
  };
  const correctTimes = (count: number, everyMs: number) => { for (let i = 0; i < count; i++) correct(everyMs); };
  return { bot, packets, logs, clock, stop, correct, correctTimes };
}

test("eight corrections at one spot in a second send an off-hand use-item-on to 3 to 12 cells", () => {
  const { packets, correctTimes } = standingBot();
  correctTimes(8, 100);
  assert.ok(packets.length >= 3 && packets.length <= 12, `${packets.length} packets`);
  for (const { name, params } of packets) {
    assert.equal(name, "block_place");
    assert.equal(params.hand, 1);
    assert.equal(params.direction, 1);
    assert.equal(params.insideBlock, false);
    assert.equal(params.worldBorderHit, false);
    assert.equal(typeof params.sequence, "number");
    assert.deepEqual([params.cursorX, params.cursorY, params.cursorZ], [0.5, 1, 0.5]);
  }
});

test("seven corrections do nothing", () => {
  const { packets, correctTimes } = standingBot();
  correctTimes(7, 100);
  assert.equal(packets.length, 0);
});

test("eight corrections spread over three seconds do nothing (a /tp or a respawn is one, a slow fight is not a loop)", () => {
  const { packets, correctTimes } = standingBot();
  correctTimes(8, 400);
  assert.equal(packets.length, 0);
});

test("corrections alternating between two spots never trigger", () => {
  const { packets, correct } = standingBot();
  for (let i = 0; i < 20; i++) correct(50, i % 2 === 0 ? 191.5 : 193.5);
  assert.equal(packets.length, 0);
});

test("corrections while she rides a vehicle do nothing", () => {
  const { bot, packets, correctTimes } = standingBot();
  bot.vehicle = { id: 7 };
  correctTimes(12, 50);
  assert.equal(packets.length, 0);
});

test("an off hand holding dirt sends nothing and logs one line naming the item, however many corrections follow", () => {
  const { packets, logs, correctTimes } = standingBot("dirt");
  correctTimes(24, 100);
  assert.equal(packets.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /ghost block at 191\.5 79 292\.5: off hand holds dirt, not resynced/u);
});

test("an off hand holding a shield or a totem is resynced", () => {
  for (const item of ["shield", "totem_of_undying"]) {
    const { packets, correctTimes } = standingBot(item);
    correctTimes(8, 100);
    assert.ok(packets.length >= 3, item);
  }
});

test("a fourth trigger at the same spot inside 30 s sends nothing and logs 'not resolved' once; after 60 s it resyncs again", () => {
  const { packets, logs, clock, correctTimes } = standingBot();
  correctTimes(8, 100); // trigger 1 (the spot is first seen at the 1st correction)
  const perResync = packets.length;
  correctTimes(8, 100); // 2
  correctTimes(8, 100); // 3
  assert.equal(packets.length, 3 * perResync);
  correctTimes(8, 100); // 4: given up
  assert.equal(packets.length, 3 * perResync);
  assert.equal(logs.filter((line) => line.includes("ghost block not resolved at 191.5 79 292.5")).length, 1);
  correctTimes(16, 100); // still paused: no packet, no second line
  assert.equal(packets.length, 3 * perResync);
  assert.equal(logs.filter((line) => line.includes("not resolved")).length, 1);
  clock.ms += 60_000;
  correctTimes(8, 100);
  assert.equal(packets.length, 4 * perResync);
});

test("a death in the middle of the count starts it again", () => {
  const { bot, packets, correctTimes } = standingBot();
  correctTimes(5, 100);
  bot.emit("death");
  correctTimes(5, 100);
  assert.equal(packets.length, 0);
});

test("a spawn forgets a given-up spot", () => {
  const { bot, packets, correctTimes } = standingBot();
  for (let i = 0; i < 4; i++) correctTimes(8, 100);
  const sent = packets.length;
  bot.emit("spawn");
  correctTimes(8, 100);
  assert.ok(packets.length > sent);
});

test("after the cleanup a correction sends nothing and no listener is left", () => {
  const { bot, packets, stop, correctTimes } = standingBot();
  stop();
  correctTimes(12, 100);
  assert.equal(packets.length, 0);
  for (const event of ["forcedMove", "death", "spawn"]) assert.equal(bot.listenerCount(event), 0, event);
});

test("two bots each count their own corrections", () => {
  const first = standingBot();
  const second = standingBot();
  first.correctTimes(4, 100);
  second.correctTimes(4, 100);
  first.correctTimes(4, 100);
  assert.ok(first.packets.length > 0);
  assert.equal(second.packets.length, 0);
});

test("cellsAround in the middle of one column gives the three levels of that column", () => {
  const cells = cellsAround(new Vec3(10.5, 64, 5.5));
  assert.deepEqual(cells.map((cell) => cell.toArray().join(",")).sort(), ["10,63,5", "10,64,5", "10,65,5"]);
});

test("cellsAround on a corner of four columns gives 12 cells", () => {
  const cells = cellsAround(new Vec3(10.2, 64, 5.8));
  assert.equal(cells.length, 12);
  assert.deepEqual([...new Set(cells.map((cell) => `${cell.x},${cell.z}`))].sort(), ["10,5", "10,6", "9,5", "9,6"]);
});

test("cellsAround with feet just under a block level (63.92) takes the levels of floor(y), not of the block above", () => {
  const cells = cellsAround(new Vec3(10.5, 63.92, 5.5));
  assert.deepEqual(cells.map((cell) => cell.y).sort(), [62, 63, 64]);
});

test("a resync is logged with the spot and the number of cells asked", () => {
  const { packets, logs, correctTimes } = standingBot();
  correctTimes(8, 100);
  assert.deepEqual(logs, [`ghost block at 191.5 79 292.5: resynced ${packets.length} cells`]);
});
