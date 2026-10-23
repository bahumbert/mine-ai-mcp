import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock, itemOf } from "../test-support/fake-bot/index.js";
import { watch } from "../test-support/pending.js";
import { carriedCount, INVENTORY_SETTLE_WALL_MS, settleInventoryCount } from "./inventory-count.js";

/**
 * A bot on the shared fake whose clock also drives the global timers, so the settle's polls and wall bound run on
 * the clock the test moves. `setCount` redraws the hotbar slot the way the server's `set_slot` does, so a test can put
 * the announcement where the server puts it: after the promise the action awaited has already resolved.
 */
function inventoryBot(itemName: string, count: number) {
  const harness = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), carried: { [itemName]: count } });
  const { inventory, world } = harness;
  // `carried` puts a single stack in the first hotbar slot.
  // `updateSlot` takes the null of a cleared slot, which its typings leave out.
  const setCount = (next: number) => inventory.updateSlot(36, next === 0 ? (null as never) : itemOf(world.registry, itemName, next));
  return { ...harness, setCount };
}

/** Two server ticks, in the wall-clock terms the settle deadline is written in. */
const TWO_TICKS_MS = 100;

/** Two time packets, one a second (contract check `world-age-per-second`): the 40 ticks that end the answer wait. */
const TWO_TIME_PACKETS_MS = 2_000;

test("counts every stack of the named item and nothing else", () => {
  const { bot } = createFakeBot({
    slots: {
      36: { name: "cooked_beef", count: 3 },
      37: { name: "cobblestone", count: 12 },
      38: { name: "cooked_beef", count: 2 },
    },
  });

  assert.equal(carriedCount(bot, "cooked_beef"), 5);
  assert.equal(carriedCount(bot, "bread"), 0);
});

test("returns at once when the count is already the expected one", async () => {
  const { bot, clock } = inventoryBot("cooked_beef", 1);
  using _timers = clock.install();

  const settled = await clock.settle(settleInventoryCount(bot, "cooked_beef", 1), 0);

  assert.deepEqual(settled, { count: 1, confirmed: true }, "an already-right count does not wait for the deadline");
});

test("confirms a slot update that arrives two ticks after the action resolved", async () => {
  const { bot, clock, setCount } = inventoryBot("cooked_beef", 2);
  using _timers = clock.install();
  clock.after(TWO_TICKS_MS, () => setCount(1));

  const settled = await clock.settle(settleInventoryCount(bot, "cooked_beef", 1), TWO_TICKS_MS + 50);

  assert.deepEqual(settled, { count: 1, confirmed: true });
});

test("reports the count it can see, unconfirmed, when the update never arrives", async () => {
  const { bot, clock } = inventoryBot("cooked_beef", 2);
  using _timers = clock.install();

  const settled = await clock.settle(settleInventoryCount(bot, "cooked_beef", 1), TWO_TIME_PACKETS_MS);

  assert.deepEqual(settled, { count: 2, confirmed: false });
});

test("a caller's cancellation ends the wait with the count observed so far", async () => {
  const { bot, clock } = inventoryBot("cobblestone", 3);
  using _timers = clock.install();
  const controller = new AbortController();
  clock.after(TWO_TICKS_MS, () => controller.abort(new Error("stop")));

  const settled = await clock.settle(settleInventoryCount(bot, "cobblestone", 2, { signal: controller.signal }), TWO_TICKS_MS + 50);

  assert.deepEqual(settled, { count: 3, confirmed: false });
});

test("a caller with a slower server can wait longer than the default deadline", async () => {
  const { bot, clock, setCount } = inventoryBot("gravel", 4);
  using _timers = clock.install();
  clock.after(600, () => setCount(0));

  const settled = await clock.settle(settleInventoryCount(bot, "gravel", 0, { timeoutMs: 1_000 }), 650);

  assert.deepEqual(settled, { count: 0, confirmed: true });
});

test("a slot update 600 ms late on a server that has not moved is confirmed", async () => {
  const { bot, clock, setCount } = inventoryBot("cooked_beef", 2);
  using _timers = clock.install();
  const age = bot.time.age;
  clock.after(600, () => setCount(1));

  const settled = await clock.settle(settleInventoryCount(bot, "cooked_beef", 1), 650);

  assert.deepEqual(settled, { count: 1, confirmed: true });
  assert.equal(bot.time.age, age, "the server clock never moved: only the answer ended the wait");
});

test("a count that never comes ends once the world age moved 40 ticks", async () => {
  const { bot, clock, server } = inventoryBot("cooked_beef", 2);
  using _timers = clock.install();
  const sentAt = bot.time.age;
  let jumps = 0;
  server.onTimePacket(() => (jumps += 1));

  const settled = await clock.settle(settleInventoryCount(bot, "cooked_beef", 1), TWO_TIME_PACKETS_MS);

  assert.deepEqual(settled, { count: 2, confirmed: false });
  assert.equal(jumps, 2, "two time packets, no more");
  assert.equal(bot.time.age, sentAt + 40);
  assert.ok(clock.now() < INVENTORY_SETTLE_WALL_MS, "ended on the world age, before the wall bound");
});

test("the wait counts from the send age a caller passes, not from the call", async () => {
  const { bot, clock } = inventoryBot("cooked_beef", 2);
  using _timers = clock.install();

  const settled = await clock.settle(settleInventoryCount(bot, "cooked_beef", 1, { sentAtAge: bot.time.age - 40 }), 0);

  assert.deepEqual(settled, { count: 2, confirmed: false }, "40 ticks had passed since the send: the answer is no");
});

test("a stopped server clock ends the settle at the wall bound", async () => {
  const { bot, clock, server } = inventoryBot("cooked_beef", 2);
  using _timers = clock.install();
  server.stop();
  const settle = settleInventoryCount(bot, "cooked_beef", 1, { timeoutMs: 120 });
  const over = watch(settle);

  await clock.advance(100);
  assert.equal(over.over, false, "still waiting before the 120 ms wall bound");
  const settled = await clock.settle(settle, 50);

  assert.deepEqual(settled, { count: 2, confirmed: false });
  assert.ok(INVENTORY_SETTLE_WALL_MS >= 5_000, "the default wall bound covers a server seconds behind");
});

test("a death during the settle ends it by the age, count unconfirmed", async () => {
  const { bot, clock, setCount } = inventoryBot("cooked_beef", 2);
  using _timers = clock.install();
  clock.after(TWO_TICKS_MS / 10, () => setCount(0));

  const settled = await clock.settle(settleInventoryCount(bot, "cooked_beef", 1), TWO_TIME_PACKETS_MS);

  assert.deepEqual(settled, { count: 0, confirmed: false });
});
