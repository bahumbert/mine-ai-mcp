import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock, itemOf } from "../test-support/fake-bot/index.js";
import { watch } from "../test-support/pending.js";
import { carriedCount, settleInventoryCount } from "./inventory-count.js";

/**
 * A bot on the shared fake whose clock also drives the global timers, so the settle's polls and wall bound run on
 * the clock the test moves. `setCount` redraws the hotbar slot the way the server's `set_slot` does, so a test can put
 * the announcement where the server puts it: after the promise the action awaited has already resolved.
 */
function inventoryBot(itemName: string, count: number, ticksPerSecond = 20) {
  const harness = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), carried: { [itemName]: count }, server: { ticksPerSecond } });
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

for (const { delayMs, ticksPerSecond } of [
  { delayMs: 100, ticksPerSecond: 20 },
  { delayMs: 600, ticksPerSecond: 20 },
  { delayMs: 7_000, ticksPerSecond: 5 },
]) {
  test(`inventory answered at ${delayMs} ms at ${ticksPerSecond} tps is confirmed`, async () => {
    const { bot, clock, setCount } = inventoryBot("cooked_beef", 2, ticksPerSecond);
    using _timers = clock.install();
    const age = bot.time.age;
    clock.after(delayMs, () => setCount(1));

    const settled = await clock.settle(settleInventoryCount(bot, "cooked_beef", 1), delayMs + 50);

    assert.deepEqual(settled, { count: 1, confirmed: true });
    if (delayMs < 1_000) assert.equal(bot.time.age, age, "only the answer ended the wait");
  });
}

test("a caller's cancellation ends the wait with the count observed so far", async () => {
  const { bot, clock } = inventoryBot("cobblestone", 3);
  using _timers = clock.install();
  const controller = new AbortController();
  clock.after(TWO_TICKS_MS, () => controller.abort(new Error("stop")));

  const settled = await clock.settle(settleInventoryCount(bot, "cobblestone", 2, { signal: controller.signal }), TWO_TICKS_MS + 50);

  assert.deepEqual(settled, { count: 3, confirmed: false });
});

test("a correction within an explicit inventory ceiling is confirmed", async () => {
  const { bot, clock, setCount } = inventoryBot("gravel", 4);
  using _timers = clock.install();
  clock.after(600, () => setCount(0));

  const settled = await clock.settle(settleInventoryCount(bot, "gravel", 0, { timeoutMs: 1_000 }), 650);

  assert.deepEqual(settled, { count: 0, confirmed: true });
});

test("a count that never comes ends once the world age moved 40 ticks", async () => {
  const { bot, clock } = inventoryBot("cooked_beef", 2);
  using _timers = clock.install();
  const sentAt = bot.time.age;

  const settled = await clock.settle(settleInventoryCount(bot, "cooked_beef", 1), TWO_TIME_PACKETS_MS);

  assert.deepEqual(settled, { count: 2, confirmed: false });
  assert.equal(bot.time.age, sentAt + 40);
});

test("the wait counts from the send age a caller passes, not from the call", async () => {
  const { bot, clock } = inventoryBot("cooked_beef", 2);
  using _timers = clock.install();

  const settled = await clock.settle(settleInventoryCount(bot, "cooked_beef", 1, { sentAtAge: bot.time.age - 40 }), 0);

  assert.deepEqual(settled, { count: 2, confirmed: false }, "40 ticks had passed since the send: the answer is no");
});

test("a stopped server clock ends the settle after 20 s", async () => {
  const { bot, clock, server } = inventoryBot("cooked_beef", 2);
  using _timers = clock.install();
  server.stop();
  const settle = settleInventoryCount(bot, "cooked_beef", 1);
  const over = watch(settle);

  await clock.advance(19_950);
  assert.equal(over.over, false, "still waiting before 20 s of stopped clock");
  const settled = await clock.settle(settle, 50);

  assert.deepEqual(settled, { count: 2, confirmed: false });
});

test("a death during the settle ends it by the age, count unconfirmed", async () => {
  const { bot, clock, setCount } = inventoryBot("cooked_beef", 2);
  using _timers = clock.install();
  clock.after(TWO_TICKS_MS / 10, () => setCount(0));

  const settled = await clock.settle(settleInventoryCount(bot, "cooked_beef", 1), TWO_TIME_PACKETS_MS);

  assert.deepEqual(settled, { count: 0, confirmed: false });
});
