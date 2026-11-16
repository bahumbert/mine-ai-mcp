import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { onCombatResourceReceipt } from "../../runtime/combat-resource-receipts.js";
import { carriedCountField } from "../../test-support/carried-counts.js";
import { type FakeClock, type FakeServer, createFakeBot, createFakeClock, itemOf } from "../../test-support/fake-bot/index.js";
import { watch } from "../../test-support/pending.js";
import { parseEatFoodRequest, type EatFoodResult } from "./contract.js";
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
  await clock.advance(15_000 - 50);
  assert.equal(state.over, false, "still awaiting the answer before the whole-action wall bound");
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

// Mineflayer's refusal ("Food is full", `inventory.js:116-118`) comes before it activates the hand: a refusal with the hand
// in use is no state it reaches (the old stub of this test), and a rejection with the hand in use is the lag case, below.
// The refusal's own test is "a full stomach is refused at once" below, on Mineflayer's real `consume`.

/** One request's attempts: `begin` once, then an executor call per attempt with its own signal. */
function eatRequest(bot: ReturnType<typeof hungryBot>["bot"], dependencies?: EatFoodDependencies) {
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

// A lagging server (spec 2026-11-08-p4-eat-lag): Mineflayer's own `consume` gives up at 2500 ms of wall clock but leaves
// the bite running, so the bite is waited for in server ticks.

/** The wall bound `eatFood` puts on a bite, measured from its start (`EAT_WALL_MS`). */
const WALL_MS = 15_000;
const BEEF = { foodName: "cooked_beef" };

/** A hungry bot on a server running `ticksPerSecond`, with the fake's real Mineflayer `consume`; the caller installs `clock`. */
function lagBot(clock: FakeClock, ticksPerSecond: number, extra: { count?: number; food?: number; lagMs?: number } = {}) {
  const harness = createFakeBot({
    clock,
    food: extra.food ?? 10,
    carried: { cooked_beef: extra.count ?? 2 },
    server: { ticksPerSecond },
    ...(extra.lagMs && { lagMs: extra.lagMs }),
  });
  harness.bot.foodSaturation = 2;
  return { ...harness, carried: carriedCountField(harness, "cooked_beef") };
}

/** Run `work` on the clock until it settles; its value and the clock's milliseconds it took. */
async function timed<T>(clock: FakeClock, work: Promise<T>, maxMs: number): Promise<{ value: T; ms: number }> {
  const startedAt = clock.now();
  const value = await clock.settle(work, maxMs);
  return { value, ms: clock.now() - startedAt };
}

const usesSent = (server: FakeServer) => server.packets.filter(({ name }) => name === "use_item").length;

test("at 5 ticks a second the bite is waited for past Mineflayer's 2.5 s bound and eaten", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, carried } = lagBot(clock, 5);

  const { value: result, ms } = await timed(clock, eatFood(bot, BEEF, {}), WALL_MS);

  assert.equal(result.status, "succeeded");
  assert.ok(ms > 2_500, `${ms} ms: the bite is 32 server ticks, 6.4 s at 5 a second`);
  assert.equal(carried.count, 1);
  assert.ok(bot.food > 10);
  assert.equal(bot.usingHeldItem, false);
  assert.deepEqual([result.eating.inventoryBefore, result.eating.inventoryAfter, result.eating.confirmed, result.eating.consumed], [2, 1, true, true]);
});

test("a server stalled for 10 s mid-bite and then resumed still ends in a meal", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, carried, server } = lagBot(clock, 20);
  server.onPacket("use_item", () => {
    server.stop();
    clock.after(10_000, () => server.resume());
  });

  const { value: result, ms } = await timed(clock, eatFood(bot, BEEF, {}), WALL_MS);

  assert.equal(result.status, "succeeded");
  assert.ok(ms >= 10_000 && ms < WALL_MS, `${ms} ms`);
  assert.equal(carried.count, 1);
});

test("at 20 a second the meal ends when the bite does, within 32 + 20 ticks of the use", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, carried } = lagBot(clock, 20);

  const { value: result, ms } = await timed(clock, eatFood(bot, BEEF, {}), 2_600);

  assert.equal(result.status, "succeeded");
  assert.ok(ms <= 2_600, `${ms} ms`);
  assert.equal(carried.count, 1);
});

test("a server stopped after the use and never resumed ends at the wall bound, the hand released", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, carried, server } = lagBot(clock, 20);
  server.onPacket("use_item", () => server.stop());

  const { value: result, ms } = await timed(clock, eatFood(bot, BEEF, {}), WALL_MS + 1_000);

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /^\[EAT_NOT_OBSERVED\]/);
  assert.ok(ms >= WALL_MS && ms < WALL_MS + 200, `${ms} ms from the start`);
  assert.equal(result.eating.consumed, false);
  assert.equal(carried.count, 2);
  assert.equal(bot.usingHeldItem, false);
});

test("a use the server ignores ends not observed after the bite plus 40 world-age ticks, and the next eat succeeds", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, carried } = lagBot(clock, 20);
  // Sets the hand in use, sends nothing, and rejects at Mineflayer's own bound.
  const ignoredUse: EatFoodDependencies = {
    equip: bot.equip.bind(bot),
    consume: () => {
      bot.usingHeldItem = true;
      return new Promise<void>((_resolve, reject) => clock.after(2_500, () => reject(new Error("Promise timed out."))));
    },
  };
  const ageAtStart = bot.time.age!;

  const { value: result, ms } = await timed(clock, eatFood(bot, BEEF, {}, ignoredUse), WALL_MS);

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /^\[EAT_NOT_OBSERVED\].*\d+ server ticks/);
  assert.ok(bot.time.age! - ageAtStart >= 32 + 40, `world age moved ${bot.time.age! - ageAtStart} ticks`);
  assert.ok(ms >= (32 + 40) * 50 && ms < WALL_MS, `${ms} ms`);
  assert.equal(bot.usingHeldItem, false);

  const next = await timed(clock, eatFood(bot, BEEF, {}), WALL_MS);
  assert.equal(next.value.status, "succeeded");
  assert.equal(carried.count, 1);
});

test("an abort one second into a bite at 5 ticks a second rejects with the reason, releases the hand and leaves no unhandled rejection", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, carried, server } = lagBot(clock, 5);
  const owner = new AbortController();
  const reason = new Error("fall reflex");
  server.onPacket("use_item", () => void clock.after(1_000, () => owner.abort(reason)));

  await assert.rejects(clock.settle(eatFood(bot, BEEF, { signal: owner.signal }), WALL_MS), (error) => error === reason);

  assert.equal(bot.usingHeldItem, false);
  // Mineflayer's consume times out later and rejects: nothing of ours is left to leave that unhandled.
  await clock.advance(3_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(carried.count, 2, "released before the bite ended: the stack is kept");
});

test("a full stomach is refused at once, not after a wait", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, carried } = lagBot(clock, 5, { food: 20 });

  const { value: result, ms } = await timed(clock, eatFood(bot, BEEF, {}), WALL_MS);

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /^\[EAT_REJECTED\].*Food is full/);
  assert.ok(ms < 50, `${ms} ms`);
  assert.equal(bot.usingHeldItem, false);
  assert.equal(carried.count, 2);
});

// With the last food, a death empties the slot as a bite would, and the respawn brings full health back: none of the three
// places a death can fall (in the bite, in the wait for the slot, between two attempts) may read as a meal.
function assertNoMeal(result: EatFoodResult, receipts: readonly string[]) {
  assert.notEqual(result.status, "succeeded");
  assert.equal(result.eating.consumed, false);
  assert.deepEqual(receipts, []);
}

test("a death mid-bite with the last food is no meal, even once she respawned", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, combat, server } = lagBot(clock, 20, { count: 1 });
  const receipts: string[] = [];
  onCombatResourceReceipt(bot, (receipt) => receipts.push(receipt.kind));
  server.onPacket("use_item", () => void clock.after(500, () => combat.hurtBot(100, null)));

  const { value: result } = await timed(clock, eatFood(bot, BEEF, {}), WALL_MS);

  assertNoMeal(result, receipts);
  if (result.status === "failed") assert.match(result.error, /^\[EAT_DIED\]/);
});

test("a death while the bite's slot is awaited is no meal, even once she respawned", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, combat } = lagBot(clock, 20, { count: 1 });
  const receipts: string[] = [];
  onCombatResourceReceipt(bot, (receipt) => receipts.push(receipt.kind));
  // The bite resolved with no change: the slot is awaited for one server answer time, and she dies inside it.
  clock.after(300, () => combat.hurtBot(100, null));

  const result = await clock.settle(eatFood(bot, BEEF, {}, { equip: async () => {}, consume: async () => {} }), WALL_MS);

  assertNoMeal(result, receipts);
});

test("a request resumed after a death with the last food bites again instead of crediting the empty slot", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, combat, server } = lagBot(clock, 20, { count: 1 });
  const owner = new AbortController();
  server.onPacket("use_item", () => void clock.after(500, () => {
    combat.hurtBot(100, null);
    owner.abort(new Error("died"));
  }));
  const attempt = eatRequest(bot);

  await assert.rejects(clock.settle(attempt(owner.signal), WALL_MS), /died/);
  await clock.advance(2_000);
  const resumed = await clock.settle(attempt(new AbortController().signal), WALL_MS);

  assert.notEqual(resumed.status, "succeeded", "the respawned bot carries nothing to eat: no meal happened");
  assert.equal(resumed.eating.consumed, false);
});

test("a same-food stack picked up into another slot mid-bite does not hide the meal", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, server } = lagBot(clock, 20, { count: 1 });
  server.onPacket("use_item", () => bot.inventory.updateSlot(9, itemOf(bot.registry, "cooked_beef", 1)));

  const { value: result } = await timed(clock, eatFood(bot, BEEF, {}), WALL_MS);

  assert.equal(result.status, "succeeded");
  assert.equal(result.eating.consumed, true);
  assert.equal(result.eating.confirmed, true);
  assert.equal(bot.inventory.slots[36], null, "the bitten stack is spent");
});

test("a bite that aborted mid-way and was eaten by the server anyway is not bitten twice by the resumed attempt", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  // Every answer takes 0.3 s: the server reads the use at 0.3 s, ends the bite at 1.9 s (38 ticks after the send, inside the
  // 40 the resumed attempt waits), and reads our release, sent at 1.7 s, at 2 s.
  const { bot, carried, server } = lagBot(clock, 20, { lagMs: 300 });
  const owner = new AbortController();
  server.onPacket("use_item", () => void clock.after(1_700, () => owner.abort(new Error("hunger reflex"))));
  const attempt = eatRequest(bot);

  await assert.rejects(clock.settle(attempt(owner.signal), WALL_MS), /hunger reflex/);
  const resumed = await timed(clock, attempt(new AbortController().signal), WALL_MS);

  assert.equal(resumed.value.status, "succeeded");
  assert.equal(usesSent(server), 1);
  assert.equal(carried.count, 1);
});

test("a bite that resolved with no change at all ends not observed after the settle", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, carried } = hungryBot("cooked_beef", 2, clock);

  const result = await clock.settle(
    eatFood(bot, BEEF, {}, { equip: async () => {}, consume: async () => {} }),
    WALL_MS,
  );

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /^\[EAT_NOT_OBSERVED\]/);
  assert.equal(carried.count, 2);
  assert.equal(result.eating.confirmed, false);
});
