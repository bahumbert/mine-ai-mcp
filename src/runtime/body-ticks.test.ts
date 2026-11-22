import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../test-support/fake-bot/fake-bot.js";
import { createFakeClock } from "../test-support/fake-bot/fake-clock.js";
import { type BodyTick, onBodyTick, SEATED_TICK_MS } from "./body-ticks.js";

const BOAT_ID = 7;

/** The events the pace and its listeners own: each must have no listener once the bot's pace is over. */
const BODY_EVENTS = ["physicsTick", "mount", "dismount", "death", "end"] as const;

/**
 * A fake bot with a boat (entity 7) beside it; seated, it rides that boat. Its own clock is not the installed one: it is
 * manual and never moves, so only the test's emitted events tick it (the fake's physics runs on its clock's slices).
 */
function seatBot(seated = false): Bot {
  const { bot } = createFakeBot({
    simulatePhysics: false,
    entities: { [BOAT_ID]: { name: "oak_boat", position: { x: 0.5, y: 64, z: 0.5 } } },
  });
  if (seated) setVehicle(bot, boatOf(bot));
  return bot;
}

function boatOf(bot: Bot): Entity {
  const boat = bot.entities[BOAT_ID];
  if (boat === undefined) throw new Error("the fake bot has no boat entity");
  return boat;
}

/** Mineflayer's `vehicle` is not in the Bot type the pace reads it through: the object is assigned, never cast. */
function setVehicle(bot: Bot, vehicle: Entity | null): void {
  Object.assign(bot, { vehicle });
}

function mount(bot: Bot): void {
  setVehicle(bot, boatOf(bot));
  bot.emit("mount");
}

function dismount(bot: Bot): void {
  const boat = boatOf(bot);
  setVehicle(bot, null);
  bot.emit("dismount", boat);
}

function recordTicks(bot: Bot): { readonly ticks: BodyTick[]; readonly stop: () => void } {
  const ticks: BodyTick[] = [];
  return { ticks, stop: onBodyTick(bot, (tick) => ticks.push(tick)) };
}

/** The listeners on the body events: compared with the count before the pace, since the fake keeps some of its own. */
function bodyListeners(bot: Bot): number[] {
  return BODY_EVENTS.map((event) => bot.listenerCount(event));
}

/** Counts the setInterval and clearInterval calls made after the install (the clock's mock timers under them). */
function countIntervals(): { readonly started: () => number; readonly cleared: () => number } {
  const counts = { started: 0, cleared: 0 };
  const set = globalThis.setInterval;
  const clear = globalThis.clearInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    counts.started += 1;
    return set(...args);
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => {
    counts.cleared += 1;
    clear(id);
  }) as typeof clearInterval;
  return { started: () => counts.started, cleared: () => counts.cleared };
}

test("physics ticks pass through as not seated", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const bot = seatBot();
  const { ticks } = recordTicks(bot);
  bot.emit("physicsTick");
  bot.emit("physicsTick");
  assert.deepEqual(ticks, [{ seated: false }, { seated: false }]);
  await clock.advance(SEATED_TICK_MS * 4);
  assert.equal(ticks.length, 2, "no pace while walking");
});

test("seated with no physics ticks, the listener runs every 50 ms", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const bot = seatBot();
  const { ticks } = recordTicks(bot);
  mount(bot);
  await clock.advance(49);
  assert.equal(ticks.length, 0, "no tick before 50 ms of clock");
  await clock.advance(1);
  assert.equal(ticks.length, 1, "the first pace tick lands at 50 ms");
  await clock.advance(100);
  assert.deepEqual(ticks, [{ seated: true }, { seated: true }, { seated: true }]);
});

test("a listener added while already seated starts the pace", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const bot = seatBot(true);
  const { ticks } = recordTicks(bot);
  await clock.advance(49);
  assert.equal(ticks.length, 0, "no tick before 50 ms of clock");
  await clock.advance(1);
  assert.deepEqual(ticks, [{ seated: true }]);
});

test("a physics tick while seated is passed once and takes the place of that slot's pace tick", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const bot = seatBot(true);
  const { ticks } = recordTicks(bot);
  bot.emit("physicsTick");
  assert.deepEqual(ticks, [{ seated: true }]);
  await clock.advance(SEATED_TICK_MS);
  assert.equal(ticks.length, 1, "the slot already had its tick");
  await clock.advance(SEATED_TICK_MS);
  assert.equal(ticks.length, 2, "the next slot is paced again");
});

test("the pace stops at dismount", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const calls = countIntervals();
  const bot = seatBot(true);
  const { ticks } = recordTicks(bot);
  dismount(bot);
  await clock.advance(SEATED_TICK_MS * 4);
  assert.equal(ticks.length, 0);
  assert.equal(calls.cleared(), 1);
});

test("the pace stops at death and does not come back for a bot that is no longer seated", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const calls = countIntervals();
  const bot = seatBot(true);
  const { ticks } = recordTicks(bot);
  bot.emit("death");
  setVehicle(bot, null);
  bot.emit("respawn");
  await clock.advance(SEATED_TICK_MS * 4);
  assert.equal(ticks.length, 0);
  assert.equal(calls.cleared(), 1);
});

test("the pace stops at end and the bot keeps no listener", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const calls = countIntervals();
  const bot = seatBot(true);
  const baseline = bodyListeners(bot);
  const { ticks } = recordTicks(bot);
  bot.emit("end", "test over");
  await clock.advance(SEATED_TICK_MS * 4);
  assert.equal(ticks.length, 0);
  assert.equal(calls.cleared(), 1);
  assert.deepEqual(bodyListeners(bot), baseline, "the pace leaves the bot's own listeners only");
});

test("the pace ends by itself when mineflayer forgot the vehicle without a dismount event", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const calls = countIntervals();
  const bot = seatBot(true);
  const { ticks } = recordTicks(bot);
  setVehicle(bot, null);
  await clock.advance(SEATED_TICK_MS);
  assert.equal(ticks.length, 0, "a bot no longer seated gets no seated tick");
  assert.equal(calls.cleared(), 1);
});

test("two listeners share one interval", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const calls = countIntervals();
  const bot = seatBot();
  const first = recordTicks(bot);
  const second = recordTicks(bot);
  mount(bot);
  await clock.advance(SEATED_TICK_MS);
  assert.equal(calls.started(), 1);
  assert.equal(first.ticks.length, 1);
  assert.equal(second.ticks.length, 1);
});

test("a second mount while paced does not start a second interval", () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const calls = countIntervals();
  const bot = seatBot();
  recordTicks(bot);
  mount(bot);
  mount(bot);
  assert.equal(calls.started(), 1);
});

test("removing the last listener clears the interval and the bot's listeners", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const calls = countIntervals();
  const bot = seatBot(true);
  const baseline = bodyListeners(bot);
  const first = recordTicks(bot);
  const second = recordTicks(bot);
  first.stop();
  assert.equal(calls.cleared(), 0, "another listener still needs the pace");
  await clock.advance(SEATED_TICK_MS);
  assert.equal(second.ticks.length, 1);
  assert.equal(first.ticks.length, 0);
  second.stop();
  assert.equal(calls.cleared(), 1);
  assert.deepEqual(bodyListeners(bot), baseline, "the pace leaves the bot's own listeners only");
});

test("stopping twice is harmless and a later subscription starts a fresh pace", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const calls = countIntervals();
  const bot = seatBot(true);
  const first = recordTicks(bot);
  first.stop();
  first.stop();
  assert.equal(calls.cleared(), 1);
  const second = recordTicks(bot);
  await clock.advance(SEATED_TICK_MS);
  assert.equal(second.ticks.length, 1);
  assert.equal(calls.started(), 2);
});

test("a listener removed during a tick is not called again, and one that throws does not starve the others", () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const bot = seatBot(true);
  const seen: string[] = [];
  const stopFirst = onBodyTick(bot, () => {
    seen.push("first");
    stopFirst();
    throw new Error("first listener broke");
  });
  onBodyTick(bot, () => seen.push("second"));
  assert.throws(() => bot.emit("physicsTick"), /first listener broke/);
  assert.deepEqual(seen, ["first", "second"]);
  bot.emit("physicsTick");
  assert.deepEqual(seen, ["first", "second", "second"]);
});

test("20 bots each get their own pace and none outlives its bot", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const calls = countIntervals();
  const bots = Array.from({ length: 20 }, () => seatBot(true));
  const recorded = bots.map(recordTicks);
  assert.equal(calls.started(), 20);
  await clock.advance(SEATED_TICK_MS);
  assert.deepEqual(recorded.map((entry) => entry.ticks.length), Array(20).fill(1));
  bots[3]?.emit("end", "run over");
  const fifth = bots[4];
  assert.ok(fifth, "bot 4 exists");
  dismount(fifth);
  await clock.advance(SEATED_TICK_MS);
  assert.deepEqual(recorded.map((entry) => entry.ticks.length), recorded.map((_, index) => (index === 3 || index === 4 ? 1 : 2)));
  for (const bot of bots) bot.emit("end", "run over");
  assert.equal(calls.cleared(), 20);
  await clock.advance(SEATED_TICK_MS * 4);
  assert.deepEqual(recorded.map((entry) => entry.ticks.length), recorded.map((_, index) => (index === 3 || index === 4 ? 1 : 2)));
});
