import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock, type FakeBot } from "../../test-support/fake-bot/index.js";
import { listenersAddedSince } from "../../test-support/fake-bot/listener-counts.js";
import { startWalkBound } from "./walk-bound.js";

const BOUND = { maxBlocks: 12, maxMs: 5_000 };

/** A body that moves `blocks` along x in one client tick. */
function walk(bot: FakeBot, blocks: number): void {
  bot.entity.position.x += blocks;
  bot.emit("physicsTick");
}

function setup() {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, position: { x: 0.5, y: 64, z: 0.5 } });
  return { clock, bot: harness.bot };
}

test("13 blocks of path -> aborted \"walk bound: 13 blocks walked\"", () => {
  const { clock, bot } = setup();
  using _timers = clock.install();
  using bound = startWalkBound(bot, BOUND);
  for (let step = 0; step < 12; step++) walk(bot, 1);
  assert.equal(bound.signal.aborted, false, "12 blocks are within the bound");
  walk(bot, 1);
  assert.equal(bound.signal.aborted, true);
  assert.equal(bound.signal.reason, "walk bound: 13 blocks walked");
  assert.equal(bound.walked(), 13);
});

test("a path that circles back counts every block walked, not the distance from the start", () => {
  const { clock, bot } = setup();
  using _timers = clock.install();
  using bound = startWalkBound(bot, BOUND);
  for (let step = 0; step < 7; step++) walk(bot, step % 2 === 0 ? 2 : -2);
  assert.equal(bound.walked(), 14);
  assert.equal(bound.signal.aborted, true);
});

test("a 50-block server reposition counts", () => {
  const { clock, bot } = setup();
  using _timers = clock.install();
  using bound = startWalkBound(bot, BOUND);
  walk(bot, 50);
  assert.equal(bound.signal.aborted, true);
  assert.equal(bound.signal.reason, "walk bound: 50 blocks walked");
});

test("a fall counts as walked: the displacement is three-dimensional", () => {
  const { clock, bot } = setup();
  using _timers = clock.install();
  using bound = startWalkBound(bot, BOUND);
  bot.entity.position.y -= 15;
  bot.emit("physicsTick");
  assert.equal(bound.signal.aborted, true);
});

test("no client ticks -> aborted at 5 s with the wall-clock reason", async () => {
  const { clock, bot } = setup();
  using _timers = clock.install();
  using bound = startWalkBound(bot, BOUND);
  await clock.advance(4_900);
  assert.equal(bound.signal.aborted, false);
  await clock.advance(200);
  assert.equal(bound.signal.aborted, true);
  assert.equal(bound.signal.reason, "walk bound: 5000 ms");
});

test("under both bounds -> not aborted; dispose leaves no physicsTick listener and no timer", async () => {
  const { clock, bot } = setup();
  using _timers = clock.install();
  const added = listenersAddedSince(bot);
  let signal: AbortSignal;
  {
    using bound = startWalkBound(bot, BOUND);
    signal = bound.signal;
    assert.equal(added("physicsTick"), 1);
    walk(bot, 3);
    assert.equal(bound.walked(), 3);
  }
  assert.equal(added("physicsTick"), 0);
  await clock.advance(10_000);
  assert.equal(signal.aborted, false, "the timer was cleared by dispose");
});
