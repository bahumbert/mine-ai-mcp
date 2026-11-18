// Engagement-scoped Enderman windows count complete world-age packet intervals.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../test-support/fake-bot/index.js";
import { Budgets } from "../../state/budgets.js";
import { EndermanProgress } from "./enderman-progress.js";

/** Drive windows through the shared fake's time packets and 20 Hz client physics. */
function endermanClock(ticksPerSecond: number) {
  const harness = createFakeBot({ server: { ticksPerSecond }, clock: createFakeClock({ mode: "mocked" }) });
  const budgets = new Budgets();
  const progress = new EndermanProgress(budgets, 300);
  const added = listenersAddedSince(harness.bot);
  let recovering = false;
  const tick = () => progress.tick(recovering, harness.bot.time.age);
  harness.bot.on("physicsTick", tick);
  return { ...harness, budgets, progress,
    pause(value: boolean) { recovering = value; tick(); },
    observe(value: boolean) {
      harness.bot.off("physicsTick", tick);
      if (value) harness.bot.on("physicsTick", tick);
    },
    where: () => `fake ${harness.clock.now()} ms, age ${harness.bot.time.age}, game ${harness.server.gameTime}`,
    [Symbol.dispose]() {
      harness.bot.off("physicsTick", tick);
      progress[Symbol.dispose]();
      assert.equal(added("physicsTick"), 0);
      assert.deepEqual(budgets.snapshot(), []);
    },
  };
}

for (const rate of [20, 10]) {
  const msPerTick = 1_000 / rate;
  test(`a provocation opened seven ticks into a packet ends after 300 credited world ticks (${rate} tps)`, async () => {
    using fixture = endermanClock(rate);
    using _timers = fixture.clock.install();
    await fixture.clock.advance(7 * msPerTick);
    const window = fixture.progress.open("provocation", 54, "A");
    assert.equal(fixture.progress.open("provocation", 54, "A"), window);
    await fixture.clock.advance(300 * msPerTick);
    assert.equal(fixture.bot.time.age, 24_300, fixture.where());
    assert.equal(window.exhausted, false, "the wall must allow a mid-packet 10 tps window past 30000 ms");
    assert.equal(fixture.progress.ticks("provocation:54:A"), 280, fixture.where());
    await fixture.clock.advance(13 * msPerTick - 50);
    assert.equal(window.remaining, 20, fixture.where());
    await fixture.clock.advance(50);
    assert.equal(fixture.bot.time.age, 24_320, fixture.where());
    assert.equal(fixture.clock.now(), rate === 20 ? 16_000 : 32_000);
    assert.equal(window.exhausted, true, fixture.where());
    assert.equal(fixture.progress.ticks("provocation:54:A"), 300, fixture.where());
  });

  test(`only this quarry's mid-packet hit renews all its windows (${rate} tps)`, async () => {
    using fixture = endermanClock(rate);
    using _timers = fixture.clock.install();
    await fixture.clock.advance(7 * msPerTick);
    const roof = fixture.progress.open("roof", 54, "A");
    const held = fixture.progress.open("return", 54, null);
    const other = fixture.progress.open("roof", 55, "A");
    await fixture.clock.advance(220 * msPerTick);
    fixture.progress.confirmedTargetDamage(55);
    assert.deepEqual([roof.remaining, held.remaining, other.remaining], [100, 100, 300], fixture.where());
    fixture.progress.confirmedTargetDamage(54);
    assert.deepEqual([roof.remaining, held.remaining], [300, 300]);
    await fixture.clock.advance(13 * msPerTick);
    assert.equal(fixture.bot.time.age, 24_240, fixture.where());
    assert.deepEqual([roof.remaining, held.remaining], [300, 300], "the hit's partial packet earns no credit");
    fixture.observe(false);
    await fixture.clock.advance(20 * msPerTick);
    assert.equal(fixture.bot.time.age, 24_260, fixture.where());
    fixture.progress.confirmedTargetDamage(54);
    fixture.observe(true);
    await fixture.clock.advance(20 * msPerTick);
    assert.deepEqual([roof.remaining, held.remaining], [300, 300],
      "a time packet received before the damage event and next physics observation earns no partial credit");
    await fixture.clock.advance(300 * msPerTick - 50);
    assert.deepEqual([roof.exhausted, held.exhausted], [false, false], fixture.where());
    await fixture.clock.advance(50);
    assert.equal(fixture.bot.time.age, 24_580, fixture.where());
    assert.deepEqual([roof.exhausted, held.exhausted], [true, true], fixture.where());
  });

  for (const interruption of ["recovery", "reentry"] as const) {
    test(`${interruption} mid-packet keeps spent ticks and discards partial intervals (${rate} tps)`, async () => {
      using fixture = endermanClock(rate);
      using _timers = fixture.clock.install();
      await fixture.clock.advance(7 * msPerTick);
      let window = fixture.progress.open("roof", 54, "A");
      let held = fixture.progress.open("return", 54, null);
      await fixture.clock.advance(220 * msPerTick);
      assert.deepEqual([window.remaining, held.remaining], [100, 100], fixture.where());
      if (interruption === "recovery") fixture.pause(true);
      else {
        fixture.progress.leave();
        fixture.observe(false);
      }
      await fixture.clock.advance(700 * msPerTick);
      assert.deepEqual([window.remaining, held.remaining], [100, 100], fixture.where());
      if (interruption === "recovery") fixture.pause(false);
      else {
        window = fixture.progress.open("roof", 54, "A");
        held = fixture.progress.open("return", 54, null);
        fixture.observe(true);
      }
      assert.deepEqual([window.remaining, held.remaining], [100, 100]);
      assert.equal(fixture.progress.open("roof", 54, "B").remaining, 300, "another cell has its own clock");
      await fixture.clock.advance(13 * msPerTick);
      assert.equal(fixture.bot.time.age, 24_940, fixture.where());
      assert.deepEqual([window.remaining, held.remaining], [100, 100],
        "the first packet after resuming earns no partial credit in either window");
      await fixture.clock.advance(100 * msPerTick - 50);
      assert.deepEqual([window.exhausted, held.exhausted], [false, false], fixture.where());
      await fixture.clock.advance(50);
      assert.equal(fixture.bot.time.age, 25_040, fixture.where());
      assert.deepEqual([window.exhausted, held.exhausted], [true, true], fixture.where());
    });
  }

  for (const renewal of ["none", "damage", "reentry", "recovery"] as const) {
    test(`a stopped server ends on the 48000 active ms wall (${renewal}, ${rate} tps)`, async () => {
      using fixture = endermanClock(rate);
      using _timers = fixture.clock.install();
      await fixture.clock.advance(7 * msPerTick);
      let window = fixture.progress.open("roof", 54, "A");
      await fixture.clock.advance(220 * msPerTick);
      let spentMs = 220 * msPerTick;
      if (renewal === "damage") {
        fixture.progress.confirmedTargetDamage(54);
        spentMs = 0;
      }
      if (renewal === "reentry" || renewal === "recovery") {
        if (renewal === "reentry") fixture.progress.close("roof:54:A");
        else fixture.pause(true);
        await fixture.clock.advance(60_000);
        if (renewal === "reentry") window = fixture.progress.open("roof", 54, "A");
        else fixture.pause(false);
      }
      const age = fixture.bot.time.age;
      const ticks = fixture.progress.ticks("roof:54:A");
      fixture.server.stop();
      await fixture.clock.advance(48_000 - spentMs - 1);
      assert.equal(window.exhausted, false, fixture.where());
      await fixture.clock.advance(1);
      assert.equal(fixture.bot.time.age, age, fixture.where());
      assert.equal(window.exhausted, true, fixture.where());
      assert.equal(fixture.progress.ticks("roof:54:A"), ticks, "a stopped server earns no ticks");
      fixture.progress.close("roof:54:A");
      await fixture.clock.advance(48_001);
      assert.deepEqual(fixture.budgets.snapshot(), [], "the old wall cannot reopen a disposed budget");
    });
  }
}

test("missing or rolled-back age never buys physics credit or charges an unknown interval", () => {
  using progress = new EndermanProgress(new Budgets(), 300);
  const window = progress.open("provocation", 54, "A");
  progress.tick(false, 24_000);
  progress.tick(false, 24_020);
  progress.tick(false, 24_040);
  assert.equal(window.remaining, 280);
  for (let index = 0; index < 300; index++) progress.tick(false);
  assert.equal(window.remaining, 280, "missing age cannot spend client ticks");
  progress.tick(false, 24_080);
  assert.equal(window.remaining, 280, "the gap without age earns no credit");
  progress.tick(false, 24_100);
  assert.equal(window.remaining, 280, "discard the unknown partial interval after age becomes available");
  progress.tick(false, 24_120);
  assert.equal(window.remaining, 260);
  progress.tick(false, 24_000);
  assert.equal(window.remaining, 260, "a rollback earns no credit");
  progress.tick(false, 24_020);
  assert.equal(window.remaining, 260, "the first packet after rollback reanchors the window");
  progress.tick(false, 24_040);
  assert.equal(window.remaining, 240);
});

for (const exit of ["close", "leave", "dispose", "throw"] as const) {
  test(`Enderman ${exit} removes its budgets and retains spent ticks until engagement disposal`, () => {
    const budgets = new Budgets();
    using progress = new EndermanProgress(budgets, 300);
    progress.open("provocation", 54, "A");
    for (const age of [24_000, 24_020, 24_040]) progress.tick(false, age);
    if (exit === "close") progress.close("provocation:54:A");
    else if (exit === "leave") progress.leave();
    else if (exit === "dispose") progress[Symbol.dispose]();
    else assert.throws(() => { try { throw new Error("fight threw"); } finally { progress.leave(); } }, /fight threw/);
    assert.deepEqual(budgets.snapshot(), []);
    assert.equal(progress.open("provocation", 54, "A").remaining, exit === "dispose" ? 300 : 280);
    progress.tick(false, 24_060);
    assert.equal(progress.ticks("provocation:54:A"), exit === "dispose" ? 0 : 20,
      "a reopened handle starts a fresh packet interval");
  });
}
