import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { waitForServerAnswer, waitForWorldAge } from "./world-age.js";

/** A bot whose server clock is `age`, and a fake wall clock the injected sleep moves by `step` ms. */
function fakeWorld(age = 1_000) {
  const bot = { time: { age } } as unknown as Bot;
  let wall = 0;
  const clock = {
    now: () => wall,
    sleep: async (ms: number) => {
      wall += ms;
      onSleep(wall);
    },
  };
  let onSleep: (wall: number) => void = () => {};
  return { bot, clock, setOnSleep: (fn: (wall: number) => void) => (onSleep = fn), wall: () => wall };
}

test("resolves moved when the server age advanced the asked ticks, seen in jumps of 20", async () => {
  const world = fakeWorld();
  world.setOnSleep(() => ((world.bot.time as { age: number }).age += 20));
  assert.equal(await waitForWorldAge(world.bot, 40, { wallMs: 10_000, ...world.clock }), "moved");
});

test("resolves until when the condition becomes true before the age moves", async () => {
  const world = fakeWorld();
  let done = false;
  world.setOnSleep((wall) => (done = wall >= 100));
  assert.equal(await waitForWorldAge(world.bot, 40, { wallMs: 10_000, until: () => done, ...world.clock }), "until");
});

test("times out on the wall clock when the world age never moves", async () => {
  const world = fakeWorld();
  assert.equal(await waitForWorldAge(world.bot, 40, { wallMs: 10_000, ...world.clock }), "timeout");
  assert.ok(world.wall() >= 10_000);
});

test("a server seconds behind: age frozen 10 s then +200 still reports moved within a longer bound", async () => {
  const world = fakeWorld();
  world.setOnSleep((wall) => {
    if (wall === 10_000) (world.bot.time as { age: number }).age += 200;
  });
  assert.equal(await waitForWorldAge(world.bot, 40, { wallMs: 15_000, ...world.clock }), "moved");
});

test("an until already true resolves at once, and an aborted signal rejects", async () => {
  const world = fakeWorld();
  assert.equal(await waitForWorldAge(world.bot, 40, { wallMs: 1_000, until: () => true, ...world.clock }), "until");
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(waitForWorldAge(world.bot, 40, { wallMs: 1_000, signal: controller.signal, ...world.clock }), /cancelled/);
});

test("works with the real clock", async () => {
  const bot = { time: { age: 0 } } as unknown as Bot;
  assert.equal(await waitForWorldAge(bot, 40, { wallMs: 120 }), "timeout");
});

test("the server answer counts ticks from the send, not from the call", async () => {
  const world = fakeWorld(140);
  assert.equal(await waitForServerAnswer(world.bot, 100, { wallMs: 10_000, until: () => false, ...world.clock }), "moved");
  assert.equal(world.wall(), 0, "40 ticks had already passed since the send: no wait at all");
});

test("the server answer without a send age counts from the call", async () => {
  const world = fakeWorld();
  world.setOnSleep(() => ((world.bot.time as { age: number }).age += 20));
  assert.equal(await waitForServerAnswer(world.bot, undefined, { wallMs: 10_000, until: () => false, ...world.clock }), "moved");
  assert.ok(world.wall() > 0 && world.wall() < 10_000);
});

test("a stopped server clock ends the answer wait on the wall clock", async () => {
  const world = fakeWorld();
  assert.equal(await waitForServerAnswer(world.bot, 1_000, { wallMs: 5_000, until: () => false, ...world.clock }), "timeout");
  assert.ok(world.wall() >= 5_000);
});

test("the awaited change wins over the world age in the server answer wait", async () => {
  const world = fakeWorld(140);
  assert.equal(await waitForServerAnswer(world.bot, 100, { wallMs: 5_000, until: () => true, ...world.clock }), "until");
});

test("a bot without a world age waits on the wall clock only", async () => {
  const world = fakeWorld();
  const bot = {} as unknown as Bot;
  assert.equal(await waitForServerAnswer(bot, 0, { wallMs: 1_000, until: () => false, ...world.clock }), "timeout");
});
