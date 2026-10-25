import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { type TestContext } from "node:test";
import { type BodyTick, onBodyTick, SEATED_TICK_MS } from "./body-ticks.js";

type SeatedBot = Bot & { vehicle: object | null };

function seatBot(seated = false): SeatedBot {
  const bot = Object.assign(new EventEmitter(), { vehicle: seated ? { id: 7 } : null, entity: { id: 1, vehicle: null } });
  return bot as unknown as SeatedBot;
}

/** Events the real Bot types do not let a fake emit bare. */
function emit(bot: SeatedBot, event: string): void {
  (bot as unknown as EventEmitter).emit(event);
}

function listenerCount(bot: SeatedBot, event: string): number {
  return (bot as unknown as EventEmitter).listenerCount(event);
}

function mount(bot: SeatedBot): void {
  bot.vehicle = { id: 7 };
  emit(bot, "mount");
}

function dismount(bot: SeatedBot): void {
  bot.vehicle = null;
  emit(bot, "dismount");
}

function recordTicks(bot: SeatedBot): { readonly ticks: BodyTick[]; readonly stop: () => void } {
  const ticks: BodyTick[] = [];
  return { ticks, stop: onBodyTick(bot, (tick) => ticks.push(tick)) };
}

/** Fake timers, with every setInterval and clearInterval call counted. */
function intervalCalls(context: TestContext): { readonly started: () => number; readonly cleared: () => number } {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const set = context.mock.method(globalThis, "setInterval");
  const clear = context.mock.method(globalThis, "clearInterval");
  return { started: () => set.mock.callCount(), cleared: () => clear.mock.callCount() };
}

test("physics ticks pass through as not seated", (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const bot = seatBot();
  const { ticks } = recordTicks(bot);
  emit(bot, "physicsTick");
  emit(bot, "physicsTick");
  assert.deepEqual(ticks, [{ seated: false }, { seated: false }]);
  context.mock.timers.tick(SEATED_TICK_MS * 4);
  assert.equal(ticks.length, 2, "no pace while walking");
});

test("seated with no physics ticks, the listener runs every 50 ms", (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const bot = seatBot();
  const { ticks } = recordTicks(bot);
  mount(bot);
  context.mock.timers.tick(SEATED_TICK_MS * 3);
  assert.deepEqual(ticks, [{ seated: true }, { seated: true }, { seated: true }]);
});

test("a listener added while already seated starts the pace", (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const bot = seatBot(true);
  const { ticks } = recordTicks(bot);
  context.mock.timers.tick(SEATED_TICK_MS);
  assert.deepEqual(ticks, [{ seated: true }]);
});

test("a physics tick while seated is passed once and takes the place of that slot's pace tick", (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const bot = seatBot(true);
  const { ticks } = recordTicks(bot);
  emit(bot, "physicsTick");
  assert.deepEqual(ticks, [{ seated: true }]);
  context.mock.timers.tick(SEATED_TICK_MS);
  assert.equal(ticks.length, 1, "the slot already had its tick");
  context.mock.timers.tick(SEATED_TICK_MS);
  assert.equal(ticks.length, 2, "the next slot is paced again");
});

test("the pace stops at dismount", (context) => {
  const calls = intervalCalls(context);
  const bot = seatBot(true);
  const { ticks } = recordTicks(bot);
  dismount(bot);
  context.mock.timers.tick(SEATED_TICK_MS * 4);
  assert.equal(ticks.length, 0);
  assert.equal(calls.cleared(), 1);
});

test("the pace stops at death and does not come back for a bot that is no longer seated", (context) => {
  const calls = intervalCalls(context);
  const bot = seatBot(true);
  const { ticks } = recordTicks(bot);
  emit(bot, "death");
  bot.vehicle = null;
  emit(bot, "respawn");
  context.mock.timers.tick(SEATED_TICK_MS * 4);
  assert.equal(ticks.length, 0);
  assert.equal(calls.cleared(), 1);
});

test("the pace stops at end and the bot keeps no listener", (context) => {
  const calls = intervalCalls(context);
  const bot = seatBot(true);
  const { ticks } = recordTicks(bot);
  emit(bot, "end");
  context.mock.timers.tick(SEATED_TICK_MS * 4);
  assert.equal(ticks.length, 0);
  assert.equal(calls.cleared(), 1);
  for (const event of ["physicsTick", "mount", "dismount", "death", "end"]) assert.equal(listenerCount(bot, event), 0, event);
});

test("the pace ends by itself when mineflayer forgot the vehicle without a dismount event", (context) => {
  const calls = intervalCalls(context);
  const bot = seatBot(true);
  const { ticks } = recordTicks(bot);
  bot.vehicle = null;
  context.mock.timers.tick(SEATED_TICK_MS);
  assert.equal(ticks.length, 0, "a bot no longer seated gets no seated tick");
  assert.equal(calls.cleared(), 1);
});

test("two listeners share one interval", (context) => {
  const calls = intervalCalls(context);
  const bot = seatBot();
  const first = recordTicks(bot);
  const second = recordTicks(bot);
  mount(bot);
  context.mock.timers.tick(SEATED_TICK_MS);
  assert.equal(calls.started(), 1);
  assert.equal(first.ticks.length, 1);
  assert.equal(second.ticks.length, 1);
});

test("a second mount while paced does not start a second interval", (context) => {
  const calls = intervalCalls(context);
  const bot = seatBot();
  recordTicks(bot);
  mount(bot);
  mount(bot);
  assert.equal(calls.started(), 1);
});

test("removing the last listener clears the interval and the bot's listeners", (context) => {
  const calls = intervalCalls(context);
  const bot = seatBot(true);
  const first = recordTicks(bot);
  const second = recordTicks(bot);
  first.stop();
  assert.equal(calls.cleared(), 0, "another listener still needs the pace");
  context.mock.timers.tick(SEATED_TICK_MS);
  assert.equal(second.ticks.length, 1);
  assert.equal(first.ticks.length, 0);
  second.stop();
  assert.equal(calls.cleared(), 1);
  for (const event of ["physicsTick", "mount", "dismount", "death", "end"]) assert.equal(listenerCount(bot, event), 0, event);
});

test("stopping twice is harmless and a later subscription starts a fresh pace", (context) => {
  const calls = intervalCalls(context);
  const bot = seatBot(true);
  const first = recordTicks(bot);
  first.stop();
  first.stop();
  assert.equal(calls.cleared(), 1);
  const second = recordTicks(bot);
  context.mock.timers.tick(SEATED_TICK_MS);
  assert.equal(second.ticks.length, 1);
  assert.equal(calls.started(), 2);
});

test("a listener removed during a tick is not called again, and one that throws does not starve the others", (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const bot = seatBot(true);
  const seen: string[] = [];
  const stopFirst = onBodyTick(bot, () => {
    seen.push("first");
    stopFirst();
    throw new Error("first listener broke");
  });
  onBodyTick(bot, () => seen.push("second"));
  assert.throws(() => emit(bot, "physicsTick"), /first listener broke/);
  assert.deepEqual(seen, ["first", "second"]);
  emit(bot, "physicsTick");
  assert.deepEqual(seen, ["first", "second", "second"]);
});

test("20 bots each get their own pace and none outlives its bot", (context) => {
  const calls = intervalCalls(context);
  const bots = Array.from({ length: 20 }, () => seatBot(true));
  const recorded = bots.map(recordTicks);
  assert.equal(calls.started(), 20);
  context.mock.timers.tick(SEATED_TICK_MS);
  assert.deepEqual(recorded.map((entry) => entry.ticks.length), Array(20).fill(1));
  emit(bots[3] as SeatedBot, "end");
  dismount(bots[4] as SeatedBot);
  context.mock.timers.tick(SEATED_TICK_MS);
  assert.deepEqual(recorded.map((entry) => entry.ticks.length), recorded.map((_, index) => (index === 3 || index === 4 ? 1 : 2)));
  for (const bot of bots) emit(bot, "end");
  assert.equal(calls.cleared(), 20);
  context.mock.timers.tick(SEATED_TICK_MS * 4);
  assert.deepEqual(recorded.map((entry) => entry.ticks.length), recorded.map((_, index) => (index === 3 || index === 4 ? 1 : 2)));
});
