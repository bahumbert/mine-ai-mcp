import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock, type FakeClock } from "../../../test-support/fake-bot/index.js";
import { Budgets } from "../../state/budgets.js";
import { ProtectedAttackProgress } from "./attack-progress.js";

test("temporary exposure and alternating refuges cannot reopen a spent position wait", () => {
  const budgets = new Budgets();
  using progress = new ProtectedAttackProgress(budgets, 7, 300);
  for (let visit = 0; visit < 3; visit++) {
    const window = progress.enter("A");
    for (let tick = 0; tick < 100; tick++) progress.tick(false);
    assert.equal(window.remaining, 200 - visit * 100);
    progress.leave();
    assert.equal(budgets.snapshot().length, 0);
    progress.enter("B");
    progress.tick(false);
  }
  assert.equal(progress.enter("A").exhausted, true);
  assert.equal(progress.enter("B").remaining, 297);
});

test("recovery pauses spending and only confirmed quarry damage renews its position", () => {
  const budgets = new Budgets();
  using progress = new ProtectedAttackProgress(budgets, 7, 300);
  const window = progress.enter("A");
  for (let tick = 0; tick < 100; tick++) progress.tick(false);
  for (let tick = 0; tick < 1000; tick++) progress.tick(true);
  assert.equal(window.remaining, 200);
  progress.confirmedTargetDamage();
  assert.equal(window.remaining, 300);
  progress.tick(false);
  progress.leave();
  assert.equal(progress.enter("A").remaining, 299);
});

const SLOW_TICK_MS = 200;

/** Physics ticks of a slow server: the clock moves 200 ms, then the progress counts the tick. */
async function slowTicks(clock: FakeClock, progress: ProtectedAttackProgress, count: number, recovering = false) {
  for (let tick = 0; tick < count; tick++) {
    await clock.advance(SLOW_TICK_MS, SLOW_TICK_MS);
    progress.tick(recovering);
  }
}

test("the protected wait's wall time pauses while recovering and resets on damage, as its ticks do", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  using progress = new ProtectedAttackProgress(new Budgets(), 7, 300);
  const window = progress.enter("A");
  await slowTicks(clock, progress, 100);
  await slowTicks(clock, progress, 500, true);
  assert.equal(window.exhausted, false, "100 s of recovery do not spend the wait");
  await slowTicks(clock, progress, 49);
  assert.equal(window.exhausted, false, "20 s + 9.8 s");
  await slowTicks(clock, progress, 1);
  assert.equal(window.exhausted, true, "150 ticks at 200 ms are 30 s, not the 60 s of 300 ticks");
  progress.confirmedTargetDamage();
  assert.equal(window.exhausted, false, "damage renewed the wall time too");
  await slowTicks(clock, progress, 149);
  assert.equal(window.exhausted, false);
  await slowTicks(clock, progress, 1);
  assert.equal(window.exhausted, true);
});

test("the protected wait's wall time adds up per cell across leaving and entering", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  using progress = new ProtectedAttackProgress(new Budgets(), 7, 300);
  progress.enter("A");
  await slowTicks(clock, progress, 100);
  progress.leave();
  await clock.advance(120_000, SLOW_TICK_MS);
  assert.equal(progress.enter("A").exhausted, false, "time away from the cell is not spent there");
  await slowTicks(clock, progress, 49);
  assert.equal(progress.enter("A").exhausted, false);
  await slowTicks(clock, progress, 1);
  assert.equal(progress.enter("A").exhausted, true, "100 + 50 ticks at 200 ms");
});

test("a protected wait whose ticks stopped still ends by wall time", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  using progress = new ProtectedAttackProgress(new Budgets(), 7, 300);
  const window = progress.enter("A");
  progress.tick(false);
  await clock.advance(30_000, SLOW_TICK_MS);
  assert.equal(window.exhausted, true, "one tick counted, 30 s passed with no tick");
});
