import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../src/test-support/fake-bot/index.ts";
import { describeRest, traceToss } from "./toss-trace.ts";

const ITEM_ID = 7;

/** A bot at (0.5, -59, 0.5) with an item entity lying 1.5 blocks east and one block lower, another item 20 blocks away and a cow beside it. */
function tracedBot() {
  const { bot } = createFakeBot({
    position: new Vec3(0.5, -59, 0.5),
    entities: {
      [ITEM_ID]: { name: "item", position: new Vec3(2, -60, 0.5), velocity: new Vec3(0.1, 0, 0) },
      8: { name: "item", position: new Vec3(20, -60, 0.5) },
      9: { name: "cow", position: new Vec3(2, -60, 0.5) },
    },
  });
  bot.entity.yaw = 1.5;
  bot.entity.pitch = 0.25;
  return bot;
}

/** Ticks that pass one by one, so two parallel waits (the call's and the sampler's) each see their own count; `run` pumps them until `work` ends. */
function tickClock() {
  let ticks = 0;
  const waiters: { at: number; wake: () => void }[] = [];
  return {
    waitForTicks: (count: number) => new Promise<void>((wake) => void waiters.push({ at: ticks + count, wake })),
    async run<T>(work: Promise<T>): Promise<T> {
      let done = false;
      const result = work.finally(() => void (done = true));
      result.catch(() => undefined);
      while (!done) {
        await new Promise((resolve) => setImmediate(resolve));
        ticks += 1;
        for (const waiter of waiters.filter((entry) => entry.at <= ticks)) waiter.wake();
        waiters.splice(0, waiters.length, ...waiters.filter((entry) => entry.at > ticks));
      }
      return result;
    },
  };
}

const SAMPLINGS = [
  { every: 5, callTicks: 12, expected: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70], why: "ticks 0, 5, 10 during the call, then 15 .. 70 (60 ticks after the answer)" },
  { every: 1, callTicks: 3, expected: Array.from({ length: 4 + 60 }, (_, tick) => tick), why: "every tick: 0-3 (the answer's own tick is sampled too), then 60 after the answer" },
] as const;

for (const { every, callTicks, expected, why } of SAMPLINGS) {
  test(`traceToss samples the giver and each item within 6 blocks every ${every} tick(s), from the call until 60 ticks after its answer`, async () => {
    const bot = tracedBot();
    const clock = tickClock();
    const { value, lines } = await clock.run(traceToss({ bot, waitForTicks: clock.waitForTicks }, async () => {
      await clock.waitForTicks(callTicks);
      return "answered";
    }, every));
    assert.equal(value, "answered");
    const giverLines = lines.filter((line) => line.includes("giver="));
    assert.deepEqual(giverLines.map((line) => Number(/ t=(\d+) /u.exec(line)![1])), expected, why);
    assert.match(giverLines[0]!, /^TOSS_TRACE t=0 giver=0\.50 -59\.00 0\.50 vel=0\.00 0\.00 0\.00 onGround=\w+ yaw=1\.50 pitch=0\.25$/u);
    assert.ok(lines.some((line) => line === `TOSS_TRACE t=0 item=${ITEM_ID} at=2.00 -60.00 0.50 vel=0.10 0.00 0.00`), lines.join("\n"));
    // The item 20 blocks away and the cow beside the giver are no toss.
    assert.equal(lines.filter((line) => line.includes(" item=")).every((line) => line.includes(` item=${ITEM_ID} `)), true, lines.join("\n"));
  });
}

test("traceToss notes who collected an item, at the last sample taken (the world age is no clock for it: it moves in jumps of 20)", async () => {
  const bot = tracedBot();
  const clock = tickClock();
  const { lines } = await clock.run(traceToss({ bot, waitForTicks: clock.waitForTicks }, async () => {
    await clock.waitForTicks(6);
    bot.emit("playerCollect", { username: "Receiver" } as never, bot.entities[ITEM_ID]!);
  }));
  const index = lines.findIndex((line) => line === `TOSS_TRACE t=5 collected by=Receiver item=${ITEM_ID}`);
  assert.ok(index >= 0, lines.join("\n"));
  assert.ok(lines.slice(0, index).some((line) => line.startsWith("TOSS_TRACE t=5 giver=")), "the collect line follows the sample it is stamped with");
});

test("traceToss removes its collect listener and stops sampling when the call throws", async () => {
  const bot = tracedBot();
  const before = bot.listenerCount("playerCollect");
  const clock = tickClock();
  await assert.rejects(clock.run(traceToss({ bot, waitForTicks: clock.waitForTicks }, async () => { throw new Error("cancelled"); })), /cancelled/u);
  assert.equal(bot.listenerCount("playerCollect"), before);
});

test("traceToss reports the call's own error when a sample cannot be read (the body is gone)", async () => {
  const bot = tracedBot();
  const clock = tickClock();
  const gone = traceToss({ bot, waitForTicks: clock.waitForTicks }, async () => {
    await clock.waitForTicks(6);
    Reflect.set(bot, "entity", undefined);
    await clock.waitForTicks(6);
    throw new Error("the call failed");
  });
  await assert.rejects(clock.run(gone), /the call failed/u);
});

test("describeRest says where the nearest item lies from the bot's feet, or that none is seen", () => {
  assert.equal(describeRest(tracedBot()), "rest_dy=-1.00 rest_dist=1.50 me=0.50 -59.00 0.50 item=2.00 -60.00 0.50");
  assert.equal(describeRest(createFakeBot({ position: new Vec3(0.5, -59, 0.5) }).bot), "no item seen");
});
