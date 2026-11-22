// Packet-origin quarry time excludes pauses and survives physical-fight interruptions.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../test-support/fake-bot/index.js";
import { serverPacedWallMs } from "../../../world/world-age.js";
import { Budgets } from "../../state/budgets.js";
import { QuarryProgress } from "./quarry-progress.js";

/** The real time packets and physics tick order of the shared fake drive the clock. */
function quarryClock(ticksPerSecond: number, noAge = false) {
  const harness = createFakeBot({ server: { ticksPerSecond }, clock: createFakeClock({ mode: "mocked" }) });
  const budgets = new Budgets();
  const added = listenersAddedSince(harness.bot);
  const progress = new QuarryProgress(budgets, 7, 300, () => noAge ? null : harness.bot.time.age);
  let paused = false;
  const tick = () => progress.tick(paused);
  harness.bot.on("physicsTick", tick);
  return { ...harness, progress, budgets, pause(value: boolean) { paused = value; progress.tick(value); },
    where: () => `fake ${harness.clock.now()} ms, age ${harness.bot.time.age}, game ${harness.server.gameTime}`,
    [Symbol.dispose]() {
      harness.bot.off("physicsTick", tick);
      progress[Symbol.dispose]();
      assert.equal(added("physicsTick"), 0);
      assert.deepEqual(budgets.snapshot(), []);
    } };
}

for (const rate of [20, 10]) {
  const msPerTick = 1_000 / rate;
  test(`300 server ticks without a confirmed hit exhaust at the packet of age +320 (${rate} tps)`, async () => {
    using fixture = quarryClock(rate);
    using _timers = fixture.clock.install();
    const budget = fixture.progress.open();
    assert.equal(fixture.progress.open(), budget);
    await fixture.clock.advance(320 * msPerTick - 50);
    assert.equal(budget.exhausted, false, fixture.where());
    assert.equal(fixture.bot.time.age, 24_300, fixture.where());
    await fixture.clock.advance(50);
    assert.equal(fixture.bot.time.age, 24_320, fixture.where());
    assert.equal(fixture.clock.now(), rate === 20 ? 16_000 : 32_000);
    assert.equal(budget.exhausted, true, fixture.where());
  });

  test(`confirmed hits at +250 and +500 renew quarry time (${rate} tps)`, async () => {
    using fixture = quarryClock(rate);
    using _timers = fixture.clock.install();
    const budget = fixture.progress.open();
    await fixture.clock.advance(250 * msPerTick);
    fixture.progress.confirmedTargetDamage();
    await fixture.clock.advance(250 * msPerTick);
    fixture.progress.confirmedTargetDamage();
    await fixture.clock.advance(200 * msPerTick);
    assert.equal(fixture.bot.time.age, 24_700, fixture.where());
    assert.equal(budget.exhausted, false, fixture.where());
    await fixture.clock.advance(120 * msPerTick);
    assert.equal(fixture.bot.time.age, 24_820, fixture.where());
    assert.equal(budget.exhausted, true, fixture.where());
  });

  test(`a deflect between fights pauses the retained count (${rate} tps)`, async () => {
    using fixture = quarryClock(rate);
    using _timers = fixture.clock.install();
    fixture.progress.open();
    await fixture.clock.advance(220 * msPerTick);
    assert.equal(fixture.progress.ticks(), 200, fixture.where());
    fixture.progress.leave();
    await fixture.clock.advance(400 * msPerTick);
    const next = fixture.progress.open();
    assert.equal(next.remaining, 100, fixture.where());
    await fixture.clock.advance(100 * msPerTick);
    assert.equal(next.exhausted, false, fixture.where());
    await fixture.clock.advance(20 * msPerTick);
    assert.equal(fixture.bot.time.age, 24_740, fixture.where());
    assert.equal(next.exhausted, true, fixture.where());
  });

  test(`recovery and guard pause ticks and the wall twin for 700 server ticks (${rate} tps)`, async () => {
    using fixture = quarryClock(rate);
    using _timers = fixture.clock.install();
    const budget = fixture.progress.open();
    await fixture.clock.advance(220 * msPerTick);
    fixture.pause(true);
    const ticks = fixture.progress.ticks();
    await fixture.clock.advance(700 * msPerTick);
    assert.equal(fixture.progress.ticks(), ticks, fixture.where());
    assert.equal(budget.exhausted, false, fixture.where());
    fixture.pause(false);
    await fixture.clock.advance(100 * msPerTick);
    assert.equal(budget.exhausted, false, fixture.where());
    await fixture.clock.advance(20 * msPerTick);
    assert.equal(budget.exhausted, true, fixture.where());
  });

  for (const offset of [0, 1, 19]) {
    test(`a boundary ${offset} ticks before a packet never charges paused time (${rate} tps)`, async () => {
      using fixture = quarryClock(rate);
      using _timers = fixture.clock.install();
      await fixture.clock.advance((20 - offset) * msPerTick);
      fixture.progress.open();
      let active = 0;
      let boundaries = 1;
      const check = () => {
        const spent = fixture.progress.ticks();
        const unheard = fixture.server.gameTime - fixture.bot.time.age;
        assert.ok(spent <= active && active - spent <= 20 * boundaries + unheard,
          `${fixture.where()}; active ${active}, spent ${spent}, boundaries ${boundaries}`);
      };
      const advanceActive = async (ticks: number) => {
        await fixture.clock.advance(ticks * msPerTick);
        active += ticks;
        check();
      };
      await advanceActive(39);
      fixture.progress.confirmedTargetDamage(); // first hit, one tick before a time packet when offset is zero
      active = 0; boundaries = 1;
      for (let recovery = 0; recovery < 5; recovery++) {
        await advanceActive(5);
        fixture.pause(true);
        await fixture.clock.advance(5 * msPerTick);
        check();
        fixture.pause(false);
        boundaries++;
      }
      await advanceActive(80);
    });
  }
}

test("a bot that has heard no age counts one tick per physics tick", async () => {
  using fixture = quarryClock(20, true);
  using _timers = fixture.clock.install();
  const budget = fixture.progress.open();
  await fixture.clock.advance(14_950);
  assert.equal(fixture.progress.ticks(), 299, fixture.where());
  assert.equal(budget.exhausted, false);
  await fixture.clock.advance(50);
  assert.equal(fixture.progress.ticks(), 300, fixture.where());
  assert.equal(budget.exhausted, true);
});

for (const rate of [20, 10]) for (const resumed of [false, true]) {
test(`the ${resumed ? "resumed" : "initial"} wall twin ends a stopped-server wait (${rate} tps)`, async () => {
  using fixture = quarryClock(rate);
  using _timers = fixture.clock.install();
  const budget = fixture.progress.open();
  const spentMs = resumed ? 1_000 : 0;
  if (resumed) {
    await fixture.clock.advance(spentMs);
    fixture.pause(true);
    await fixture.clock.advance(700 * 1_000 / rate);
    fixture.pause(false);
  }
  const age = fixture.bot.time.age, ticks = fixture.progress.ticks();
  fixture.server.stop();
  await fixture.clock.advance(serverPacedWallMs(300) - spentMs - 50);
  assert.equal(budget.exhausted, false, fixture.where());
  await fixture.clock.advance(50);
  assert.equal(fixture.bot.time.age, age, fixture.where());
  assert.equal(fixture.progress.ticks(), ticks, "wall expiry does not fabricate server progress");
  assert.equal(budget.exhausted, true, fixture.where());
});
}
