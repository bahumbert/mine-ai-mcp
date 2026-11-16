import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { carriedCountField } from "../../test-support/carried-counts.js";
import { type FakeClock, createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { watch } from "../../test-support/pending.js";
import { SERVER_CLOCK_STOPPED_MS } from "../../world/world-age.js";
import { parseEatFoodRequest } from "./contract.js";
import { beginEatFood, formatEatFoodResult, eatFood, type EatFoodDependencies } from "./eat-food.js";

/** A hungry bot carrying one stack of the named item; `clock` when the test drives the settle's global timers. */
function hungryBot(name = "cooked_beef", count = 2, clock?: FakeClock, ticksPerSecond = 20) {
  const harness = createFakeBot({
    ...(clock && { clock }),
    server: { ticksPerSecond },
    food: 10,
    carried: count > 0 ? { [name]: count } : {},
    overrides: { consume: async () => undefined },
  });
  const { bot } = harness;
  bot.foodSaturation = 2;
  return { bot, harness, carried: carriedCountField(harness, name) };
}

/** A mocked clock for the settle's polling (global `setTimeout`, `performance.now`) and the world age together. */
const mockedClock = () => createFakeClock({ mode: "mocked" });

test("cancellation releases a native bite without waiting for consume's bookkeeping timeout", async () => {
  const { bot } = hungryBot();
  const owner = new AbortController();
  const reason = new Error("Incoming dragon requires the body now");
  let released = false, rejectNative: (reason: Error) => void = () => {};
  bot.deactivateItem = () => { released = true; bot.usingHeldItem = false; };
  const pending = eatFood(bot, { foodName: "cooked_beef" }, { signal: owner.signal }, {
    equip: async () => {},
    consume: () => {
      bot.usingHeldItem = true;
      const native = new Promise<void>((_resolve, reject) => { rejectNative = reject; });
      queueMicrotask(() => owner.abort(reason));
      return native;
    },
  });
  await assert.rejects(pending, error => error === reason);
  assert.equal(released, true);
  assert.equal(bot.usingHeldItem, false);
  rejectNative(new Error("Late native consume timeout"));
  await new Promise(resolve => setImmediate(resolve));
});

test("parses one normalized exact food name", () => {
  assert.deepEqual(parseEatFoodRequest({ food_name: "Minecraft:Cooked Beef" }), {
    foodName: "cooked_beef",
  });
});

test("equips and consumes one named food while reporting observed changes", async () => {
  const { bot, carried } = hungryBot();
  let equipped: string | null = null;
  const dependencies: EatFoodDependencies = {
    equip: async (item, destination) => {
      assert.notEqual(typeof item, "number");
      equipped = typeof item === "number" ? String(item) : item.name;
      assert.equal(destination, "hand");
    },
    consume: async () => {
      carried.count -= 1;
      bot.food = 18;
      bot.foodSaturation = 14.8;
    },
  };

  const result = await eatFood(bot, { foodName: "cooked_beef" }, {}, dependencies);

  assert.equal(result.status, "succeeded");
  assert.equal(equipped, "cooked_beef");
  assert.deepEqual(result.eating, {
    food: "cooked_beef",
    inventoryBefore: 2,
    inventoryAfter: 1,
    confirmed: true,
    hungerBefore: 10,
    hungerAfter: 18,
    saturationBefore: 2,
    saturationAfter: 14.8,
    consumed: true,
  });
  assert.match(formatEatFoodResult(result), /Consumed one \*\*cooked_beef\*\*/);
});

for (const { delayMs, ticksPerSecond, ageDelta } of [
  { delayMs: 350, ticksPerSecond: 20, ageDelta: 0 },
  { delayMs: 2_000, ticksPerSecond: 20, ageDelta: 40 },
  { delayMs: 4_000, ticksPerSecond: 10, ageDelta: 40 },
  { delayMs: 8_000, ticksPerSecond: 5, ageDelta: 40 },
]) {
  test(`confirms consumption at ${delayMs} ms, world age +${ageDelta}, at ${ticksPerSecond} tps`, async () => {
    const clock = mockedClock();
    using _installed = clock.install();
    const { bot, carried } = hungryBot("cooked_beef", 2, clock, ticksPerSecond);
    const sentAtAge = bot.time.age;
    const dependencies: EatFoodDependencies = {
      equip: async () => {},
      consume: async () => {
        // A held-item update resolved consume, but the server is still eating (the slot update announces the bite).
        clock.after(delayMs, () => {
          carried.count -= 1;
          bot.food = 18;
        });
      },
    };

    const result = await clock.settle(eatFood(bot, { foodName: "cooked_beef" }, {}, dependencies), delayMs);

    assert.equal(result.status, "succeeded");
    assert.equal(result.eating.inventoryBefore, 2);
    assert.equal(result.eating.inventoryAfter, 1);
    assert.equal(result.eating.confirmed, true);
    assert.equal(result.eating.hungerAfter, 18);
    assert.equal(bot.time.age, sentAtAge + ageDelta);
  });
}

test("cancellation rejects after consume resolves while inventory confirmation is pending", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, carried, harness } = hungryBot("cooked_beef", 2, clock, 5);
  let deactivations = 0;
  const deactivate = bot.deactivateItem.bind(bot);
  bot.deactivateItem = () => { deactivations += 1; deactivate(); };
  const slotListeners = bot.inventory.listenerCount("updateSlot");
  const controller = new AbortController();
  const pending = eatFood(bot, { foodName: "cooked_beef" }, { signal: controller.signal }, {
    equip: async () => {},
    // Unverified defensive dependency state; native consume resolving with this flag set needs a contract measurement.
    consume: async () => { bot.usingHeldItem = true; },
  });
  const clearTimer = mock.method(globalThis, "clearTimeout");
  // Abort between polls, while the 25 ms sleep still owns a timer.
  clock.after(4_010, () => controller.abort(new Error("stop the bite")));
  try {
    await assert.rejects(clock.settle(pending, 4_010, 10), /stop the bite/);
    assert.equal(clearTimer.mock.callCount(), 1, "abort clears the inventory poll's pending timer");
  } finally {
    clearTimer.mock.restore();
  }
  assert.equal(carried.count, 2);
  assert.equal(deactivations, 1);
  assert.equal(harness.server.packets.filter((packet) => packet.name === "block_dig" && (packet.data as { status: number }).status === 5).length, 1);
  assert.equal(bot.usingHeldItem, false);
  // The harness's window keeps its own slot listeners: the bite leaves none of its own behind.
  assert.equal(bot.inventory.listenerCount("updateSlot"), slotListeners);
});

test("says so rather than presenting a count the server never confirmed", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, harness } = hungryBot("cooked_beef", 2, clock);
  const dependencies: EatFoodDependencies = { equip: async () => {}, consume: async () => {} };

  // The server is stopped: neither a count nor a time packet can end the wait.
  harness.server.stop();
  const pending = eatFood(bot, { foodName: "cooked_beef" }, {}, dependencies);
  const state = watch(pending);
  await clock.advance(SERVER_CLOCK_STOPPED_MS - 50);
  assert.equal(state.over, false, "still awaiting the answer before the stopped-clock bound");
  const result = await clock.settle(pending, 50);

  assert.equal(result.status, "failed");
  assert.equal(result.eating.consumed, false);
  if (result.status === "failed") assert.match(result.error, /^\[EAT_NOT_OBSERVED\]/);
  assert.deepEqual(
    [result.eating.inventoryBefore, result.eating.inventoryAfter, result.eating.confirmed],
    [2, 2, false],
  );
  assert.match(formatEatFoodResult(result), /had not confirmed this count within the deadline/);
});

test("refuses what is not food and what is not carried", async () => {
  const stone = await eatFood(hungryBot("cobblestone", 1).bot, { foodName: "cobblestone" }, {});
  assert.equal(stone.status, "failed");
  if (stone.status === "failed") assert.match(stone.error, /^\[EAT_UNKNOWN_FOOD\]/);
  assert.equal(stone.eating.consumed, false);

  const missing = await eatFood(hungryBot("apple", 0).bot, { foodName: "apple" }, {});
  assert.equal(missing.status, "failed");
  if (missing.status === "failed") assert.match(missing.error, /^\[EAT_FOOD_MISSING\]/);
});

test("reports Mineflayer's refusal and releases an active use", async () => {
  const { bot } = hungryBot("apple", 1);
  let deactivated = false;
  bot.deactivateItem = () => {
    deactivated = true;
    bot.usingHeldItem = false;
  };
  const dependencies: EatFoodDependencies = {
    equip: async () => {},
    consume: async () => {
      bot.usingHeldItem = true;
      throw new Error("Food is full");
    },
  };

  const result = await eatFood(bot, { foodName: "apple" }, {}, dependencies);

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /Food is full/);
  assert.equal(deactivated, true);
  assert.equal(result.eating.inventoryAfter, 1);
});

/** One request's attempts: `begin` once, then an executor call per attempt with its own signal. */
function eatRequest(bot: ReturnType<typeof hungryBot>["bot"], dependencies: EatFoodDependencies) {
  const run = beginEatFood(bot, { foodName: "cooked_beef" }, () => {}, dependencies);
  return (signal?: AbortSignal) => run({ signal });
}

test("a bite aborted before the bite ends is eaten once by the resumed attempt", async () => {
  const { bot, carried } = hungryBot();
  const owner = new AbortController();
  let bites = 0;
  const attempt = eatRequest(bot, {
    equip: async () => {},
    consume: async () => {
      bites += 1;
      if (bites === 1) { owner.abort(new Error("hunger reflex")); return; }
      carried.count -= 1;
    },
  });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.equal(carried.count, 1);
  assert.equal(result.eating.inventoryBefore, 2);
  assert.equal(result.eating.inventoryAfter, 1);
});

test("a bite that landed while the first attempt was aborted in the settle is not eaten twice", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, carried } = hungryBot("cooked_beef", 2, clock);
  const owner = new AbortController();
  let bites = 0;
  const attempt = eatRequest(bot, {
    equip: async () => {},
    consume: async () => {
      bites += 1;
      clock.after(20, () => owner.abort(new Error("fall reflex")));
      clock.after(60, () => { carried.count -= 1; bot.food = 18; });
    },
  });

  await assert.rejects(clock.settle(attempt(owner.signal), 20), /fall reflex/);
  await clock.advance(80);
  const result = await attempt(new AbortController().signal);

  assert.equal(bites, 1);
  assert.equal(result.status, "succeeded");
  assert.deepEqual([result.eating.inventoryBefore, result.eating.inventoryAfter, result.eating.consumed], [2, 1, true]);
});

test("food a reflex ate between attempts, before our bite was made, is not our bite: the resume eats again", async () => {
  const { bot, carried } = hungryBot("cooked_beef", 2);
  let bites = 0;
  const attempt = eatRequest(bot, { equip: async () => {}, consume: async () => { bites += 1; carried.count -= 1; } });
  const owner = new AbortController();
  owner.abort(new Error("hunger reflex"));
  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  carried.count -= 1; // the hunger reflex's own meal of the same food: one carried fewer, our consume never ran
  bot.food = 20;

  const result = await attempt(new AbortController().signal);

  assert.equal(bites, 1);
  assert.equal(result.status, "succeeded");
  assert.equal(carried.count, 0);
  assert.equal(result.eating.inventoryBefore, 2);
  assert.equal(result.eating.inventoryAfter, 0);
});

test("food that a reflex ate after our bite resolved but was cut in the settle counts as eaten", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, carried } = hungryBot("cooked_beef", 1, clock);
  let bites = 0;
  const owner = new AbortController();
  const attempt = eatRequest(bot, {
    equip: async () => {},
    consume: async () => { bites += 1; clock.after(10, () => owner.abort(new Error("fall reflex"))); },
  });
  await assert.rejects(clock.settle(attempt(owner.signal), 10), /fall reflex/);
  carried.count = 0; // the bite landed (or a reflex ate): the one carried is gone

  const result = await attempt(new AbortController().signal);

  assert.equal(bites, 1);
  assert.equal(result.status, "succeeded");
  assert.equal(result.eating.inventoryAfter, 0);
});

test("a second call after a completed bite succeeds without acting", async () => {
  const { bot, carried } = hungryBot();
  let bites = 0;
  const attempt = eatRequest(bot, { equip: async () => {}, consume: async () => { bites += 1; carried.count -= 1; } });

  const first = await attempt();
  const second = await attempt();

  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "succeeded");
  assert.equal(bites, 1);
  assert.equal(carried.count, 1);
  assert.equal(second.eating.inventoryBefore, 2);
});
