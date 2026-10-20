import assert from "node:assert/strict";
import test from "node:test";
import { botFixture } from "../test-support/bot.js";
import { startServerClock } from "../test-support/server-clock.js";
import { carriedCount, INVENTORY_SETTLE_WALL_MS, settleInventoryCount } from "./inventory-count.js";

/**
 * A bot whose inventory announces a slot change the way Mineflayer's does, so
 * a test can put the announcement where the server puts it: after the promise
 * the action awaited has already resolved.
 */
function inventoryBot(itemName: string, count: number) {
  const items = [{ name: itemName, count }];
  const bot = botFixture({ items });
  const setCount = (next: number) => {
    items[0]!.count = next;
    bot.inventory.emit("updateSlot");
  };
  return { bot, setCount };
}

/** Two server ticks, in the wall-clock terms the settle deadline is written in. */
const TWO_TICKS_MS = 100;

/** The server this many ms of wall clock per time packet (20 ticks), so two packets end the answer wait. */
const SERVER_PACKET_MS = 10;

test("counts every stack of the named item and nothing else", () => {
  const bot = botFixture({
    items: [
      { name: "cooked_beef", count: 3 },
      { name: "cobblestone", count: 12 },
      { name: "cooked_beef", count: 2 },
    ],
  });

  assert.equal(carriedCount(bot, "cooked_beef"), 5);
  assert.equal(carriedCount(bot, "bread"), 0);
});

test("returns at once when the count is already the expected one", async () => {
  const { bot } = inventoryBot("cooked_beef", 1);
  const started = Date.now();

  const settled = await settleInventoryCount(bot, "cooked_beef", 1);

  assert.deepEqual(settled, { count: 1, confirmed: true });
  assert.ok(Date.now() - started < 100, "an already-right count does not wait for the deadline");
});

test("confirms a slot update that arrives two ticks after the action resolved", async () => {
  const { bot, setCount } = inventoryBot("cooked_beef", 2);
  setTimeout(() => setCount(1), TWO_TICKS_MS);

  const settled = await settleInventoryCount(bot, "cooked_beef", 1);

  assert.deepEqual(settled, { count: 1, confirmed: true });
});

test("reports the count it can see, unconfirmed, when the update never arrives", async () => {
  const { bot } = inventoryBot("cooked_beef", 2);
  const stopClock = startServerClock(bot, SERVER_PACKET_MS);

  const settled = await settleInventoryCount(bot, "cooked_beef", 1);
  stopClock();

  assert.deepEqual(settled, { count: 2, confirmed: false });
});

test("a caller's cancellation ends the wait with the count observed so far", async () => {
  const { bot } = inventoryBot("cobblestone", 3);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("stop")), TWO_TICKS_MS);

  const settled = await settleInventoryCount(bot, "cobblestone", 2, { signal: controller.signal });

  assert.deepEqual(settled, { count: 3, confirmed: false });
});

test("a caller with a slower server can wait longer than the default deadline", async () => {
  const { bot, setCount } = inventoryBot("gravel", 4);
  setTimeout(() => setCount(0), 600);

  const settled = await settleInventoryCount(bot, "gravel", 0, { timeoutMs: 1_000 });

  assert.deepEqual(settled, { count: 0, confirmed: true });
});

test("a slot update 600 ms late on a server that has not moved is confirmed", async () => {
  const { bot, setCount } = inventoryBot("cooked_beef", 2);
  const age = bot.time.age;
  setTimeout(() => setCount(1), 600);

  const settled = await settleInventoryCount(bot, "cooked_beef", 1);

  assert.deepEqual(settled, { count: 1, confirmed: true });
  assert.equal(bot.time.age, age, "the server clock never moved: only the answer ended the wait");
});

test("a count that never comes ends once the world age moved 40 ticks", async () => {
  const { bot } = inventoryBot("cooked_beef", 2);
  const sentAt = bot.time.age;
  let jumps = 0;
  const timer = setInterval(() => {
    bot.time.age += 20;
    jumps += 1;
  }, SERVER_PACKET_MS);

  const started = Date.now();
  const settled = await settleInventoryCount(bot, "cooked_beef", 1);
  clearInterval(timer);

  assert.deepEqual(settled, { count: 2, confirmed: false });
  assert.equal(jumps, 2, "two time packets, no more");
  assert.equal(bot.time.age, sentAt + 40);
  assert.ok(Date.now() - started < 1_000);
});

test("the wait counts from the send age a caller passes, not from the call", async () => {
  const { bot } = inventoryBot("cooked_beef", 2);
  const started = Date.now();

  const settled = await settleInventoryCount(bot, "cooked_beef", 1, { sentAtAge: bot.time.age - 40 });

  assert.deepEqual(settled, { count: 2, confirmed: false });
  assert.ok(Date.now() - started < 200, "40 ticks had passed since the send: the answer is no");
});

test("a stopped server clock ends the settle at the wall bound", async () => {
  const { bot } = inventoryBot("cooked_beef", 2);
  const started = Date.now();

  const settled = await settleInventoryCount(bot, "cooked_beef", 1, { timeoutMs: 120 });

  assert.deepEqual(settled, { count: 2, confirmed: false });
  assert.ok(Date.now() - started >= 100 && Date.now() - started < 1_000);
  assert.ok(INVENTORY_SETTLE_WALL_MS >= 5_000, "the default wall bound covers a server seconds behind");
});

test("a death during the settle ends it by the age, count unconfirmed", async () => {
  const { bot } = inventoryBot("cooked_beef", 2);
  const stopClock = startServerClock(bot, SERVER_PACKET_MS);
  setTimeout(() => {
    (bot.inventory.items() as unknown[]).length = 0;
    bot.inventory.emit("updateSlot");
  }, TWO_TICKS_MS / 10);

  const settled = await settleInventoryCount(bot, "cooked_beef", 1);
  stopClock();

  assert.deepEqual(settled, { count: 0, confirmed: false });
});
