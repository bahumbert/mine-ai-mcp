// The giver tosses only at a recipient who stands still within reach: stillness is the recipient's total displacement over
// ten ticks of the world age, so a stalled server (no age, no moves) never reads as still, and a wait ends on the wall clock.
import assert from "node:assert/strict";
import test from "node:test";
import type { FakeHarness } from "../../test-support/fake-bot/index.js";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { listenersAddedSince } from "../../test-support/fake-bot/listener-counts.js";
import {
  awaitStillRecipient,
  RECIPIENT_STILL_EPSILON,
  RECIPIENT_STILL_TICKS,
  RECIPIENT_WAIT_MS,
  type StillWait,
} from "./recipient-still.js";
import { inHandOverStance } from "./hand-over-stance.js";

const RANGE = 2;
const wait = (harness: FakeHarness, overrides: Partial<StillWait> = {}) =>
  awaitStillRecipient(harness.bot, "Dev", {
    range: RANGE,
    stillTicks: RECIPIENT_STILL_TICKS,
    epsilon: RECIPIENT_STILL_EPSILON,
    maxWallMs: RECIPIENT_WAIT_MS,
    ...overrides,
  });
const beside = (harness: FakeHarness, x: number, y = 0, z = 0) => harness.bot.entity.position.offset(x, y, z);
/** A bot at the origin and the recipient 1.5 blocks east of it. */
function withRecipient() {
  const harness = createFakeBot({ clock: createFakeClock({ mode: "mocked" }) });
  const recipient = harness.otherPlayers.join("Dev", beside(harness, 1.5));
  return { harness, recipient };
}

test("a recipient who stands still is still once the world age has moved 10 ticks", async () => {
  const { harness } = withRecipient();
  using _timers = harness.clock.install();
  assert.equal(await harness.clock.settle(wait(harness), 5_000), "still");
});

test("a server stalled with the client's ticks running never reads as still: the wall bound ends the wait", async () => {
  const { harness } = withRecipient();
  using _timers = harness.clock.install();
  await harness.clock.advance(100);
  harness.server.stop();
  assert.equal(await harness.clock.settle(wait(harness, { maxWallMs: 3_000 }), 6_000), "timeout");
});

test("a slow drift of 0.03 block a tick is not still: the total over the window counts, not each step", async () => {
  const { harness, recipient } = withRecipient();
  using _timers = harness.clock.install();
  let x = 1.0;
  harness.clock.every(() => recipient.moveTo(beside(harness, (x += 0.03))), 50);
  assert.equal(await harness.clock.settle(wait(harness, { maxWallMs: 1_500 }), 4_000), "timeout");
});

test("a recipient who walks for a second and then stops is still", async () => {
  const { harness, recipient } = withRecipient();
  using _timers = harness.clock.install();
  let x = 1.5;
  const walking = harness.clock.every(() => recipient.moveTo(beside(harness, (x = x === 1.5 ? 1.0 : 1.5))), 50);
  harness.clock.after(1_000, walking);
  assert.equal(await harness.clock.settle(wait(harness), 8_000), "still");
});

test("a recipient beyond reach is away", async () => {
  const { harness, recipient } = withRecipient();
  using _timers = harness.clock.install();
  recipient.moveTo(beside(harness, 4));
  await harness.clock.advance(100);
  assert.equal(await harness.clock.settle(wait(harness), 5_000), "away");
});

test("reach is the 3-D distance: 1.5 across and 1.5 up is beyond 2 blocks", async () => {
  const { harness, recipient } = withRecipient();
  using _timers = harness.clock.install();
  recipient.moveTo(beside(harness, 1.5, 1.5));
  await harness.clock.advance(100);
  assert.equal(await harness.clock.settle(wait(harness), 5_000), "away");
});

test("a recipient who never stops is a timeout at the wall bound", async () => {
  const { harness, recipient } = withRecipient();
  using _timers = harness.clock.install();
  let x = 1.5;
  harness.clock.every(() => recipient.moveTo(beside(harness, (x = x === 1.5 ? 1.0 : 1.5))), 50);
  const started = performance.now();
  assert.equal(await harness.clock.settle(wait(harness, { maxWallMs: 2_000 }), 6_000), "timeout");
  assert.ok(performance.now() - started >= 2_000);
});

test("no client ticks: the wall bound still ends the wait", async () => {
  const { harness } = withRecipient();
  using _timers = harness.clock.install();
  harness.bot.physicsEnabled = false;
  assert.equal(await harness.clock.settle(wait(harness, { maxWallMs: 2_000 }), 6_000), "timeout");
});

test("a recipient who logs out mid-wait is left", async () => {
  const { harness, recipient } = withRecipient();
  using _timers = harness.clock.install();
  const waiting = wait(harness);
  harness.clock.after(300, () => recipient.leave());
  assert.equal(await harness.clock.settle(waiting, 5_000), "left");
});

test("a recipient that is not observed at the start is left", async () => {
  const harness = createFakeBot({ clock: createFakeClock({ mode: "mocked" }) });
  using _timers = harness.clock.install();
  assert.equal(await harness.clock.settle(wait(harness), 1_000), "left");
});

test("jitter under 0.1 block is still", async () => {
  const { harness, recipient } = withRecipient();
  using _timers = harness.clock.install();
  let flip = false;
  harness.clock.every(() => recipient.moveTo(beside(harness, 1.5 + ((flip = !flip) ? 0.04 : 0))), 50);
  assert.equal(await harness.clock.settle(wait(harness), 8_000), "still");
});

test("an abort rejects with its reason and leaves no listener or timer", async () => {
  const { harness } = withRecipient();
  using _timers = harness.clock.install();
  const added = listenersAddedSince(harness.bot);
  const timersBefore = harness.clock.pendingTimers();
  const controller = new AbortController();
  const waiting = wait(harness, { signal: controller.signal });
  const settled = assert.rejects(waiting, (reason) => reason === controller.signal.reason);
  harness.clock.after(200, () => controller.abort());
  await harness.clock.settle(settled, 3_000);
  assert.equal(added("physicsTick"), 0);
  assert.equal(harness.clock.pendingTimers(), timersBefore);
  await assert.rejects(wait(harness, { signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/, "already aborted: rejects at once");
});

test("with a stance, reach is the stance's: a recipient 1 block across and 1 up is away although 1.41 blocks off", async () => {
  const { harness, recipient } = withRecipient();
  using _timers = harness.clock.install();
  recipient.moveTo(beside(harness, 1, 1));
  await harness.clock.advance(100);
  assert.equal(await harness.clock.settle(wait(harness, { inStance: inHandOverStance }), 5_000), "away");
});

test("with a stance, a recipient 1.5 across and 1.5 below is still, though 2.1 blocks off in 3-D", async () => {
  const { harness, recipient } = withRecipient();
  using _timers = harness.clock.install();
  recipient.moveTo(beside(harness, 1.5, -1.5));
  await harness.clock.advance(100);
  assert.equal(await harness.clock.settle(wait(harness, { inStance: inHandOverStance }), 5_000), "still");
});
