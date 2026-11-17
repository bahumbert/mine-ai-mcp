// Engagement-scoped quarry clocks survive response interruptions without buying a fresh wait.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock } from "../../../test-support/fake-bot/index.js";
import { Budgets } from "../../state/budgets.js";
import { EndermanProgress } from "./enderman-progress.js";

for (const ticksPerSecond of [20, 10]) {
  test(`an Enderman roof keeps 200 ticks across a fight interruption at ${ticksPerSecond} server tps with 20 Hz physics`, async () => {
    const { bot, clock } = createFakeBot({ server: { ticksPerSecond }, clock: createFakeClock({ mode: "mocked" }) });
    using _timers = clock.install();
    using progress = new EndermanProgress(new Budgets(), 300);
    const tick = () => progress.tick(false);
    bot.on("physicsTick", tick);
    try {
      progress.open("roof", 54, "0,64,0");
      await clock.advance(10_000);
      progress.leave();
      await clock.advance(60_000);
      const window = progress.open("roof", 54, "0,64,0");
      assert.equal(window.remaining, 100, "a 60000 ms deflect spends neither ticks nor the wall twin");
      await clock.advance(4_950);
      assert.equal(window.remaining, 1, "299 active physics ticks at fake 74950 ms, after the paused 60000 ms");
      assert.equal(bot.time.age, ticksPerSecond === 20 ? 25_480 : 24_740);
      await clock.advance(50);
      assert.equal(window.exhausted, true, "300 active physics ticks at fake 75000 ms");
      assert.equal(bot.time.age, ticksPerSecond === 20 ? 25_500 : 24_740);
    } finally { bot.off("physicsTick", tick); }
  });
}

for (const renewal of ["none", "damage", "reentry"] as const) {
  test(`the Enderman wall twin expires at 30000 running ms with no tick (${renewal})`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    using progress = new EndermanProgress(new Budgets(), 300);
    let window = progress.open("roof", 54, "A");
    for (let tick = 0; tick < 10; tick++) progress.tick(false);
    if (renewal === "damage") {
      await clock.advance(20_000);
      progress.confirmedTargetDamage(54);
    }
    if (renewal === "reentry") {
      await clock.advance(10_000);
      progress.leave();
      await clock.advance(60_000);
      window = progress.open("roof", 54, "A");
    }
    await clock.advance(renewal === "reentry" ? 19_999 : 29_999);
    assert.equal(window.exhausted, false, "29999 running ms; no physics tick has advanced");
    await clock.advance(1);
    assert.equal(window.exhausted, true, "30000 running ms, including time banked before re-entry");
    assert.equal(progress.ticks("roof:54:A"), renewal === "damage" ? 0 : 10,
      "receipts report actual ticks even when the wall twin ended first");
  });
}

test("only confirmed damage to this quarry renews all its active windows at 250 ticks", () => {
  using progress = new EndermanProgress(new Budgets(), 300);
  const roof = progress.open("roof", 54, "A");
  const held = progress.open("return", 54, null);
  for (let tick = 0; tick < 250; tick++) progress.tick(false);
  progress.confirmedTargetDamage(55);
  assert.deepEqual([roof.remaining, held.remaining], [50, 50]);
  progress.confirmedTargetDamage(54);
  assert.deepEqual([roof.remaining, held.remaining], [300, 300]);
  progress.leave();
  const resumed = progress.open("roof", 54, "A");
  for (let tick = 0; tick < 299; tick++) progress.tick(false);
  assert.equal(resumed.exhausted, false, "tick 549, including the 250 before confirmed damage");
  progress.tick(false);
  assert.equal(resumed.exhausted, true, "tick 550");
});

test("recovery pauses every active Enderman clock and cells and targets keep independent windows", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  using progress = new EndermanProgress(new Budgets(), 300);
  const roof = progress.open("roof", 54, "A");
  const held = progress.open("return", 54, null);
  progress.tick(false);
  progress.tick(true);
  await clock.advance(60_000);
  assert.deepEqual([roof.remaining, held.remaining], [299, 299]);
  assert.equal(progress.open("roof", 54, "B").remaining, 300);
  assert.equal(progress.open("roof", 55, "A").remaining, 300);
  progress.tick(false);
  assert.deepEqual([roof.remaining, held.remaining], [298, 298]);
  progress.close("roof:54:A");
  assert.equal(progress.open("roof", 54, "A").remaining, 298, "closing the roof keeps its spent clock");
});

for (const exit of ["close", "leave", "dispose", "throw"] as const) {
  test(`Enderman ${exit} removes every active budget and preserves banked ticks until engagement disposal`, () => {
    const budgets = new Budgets();
    using progress = new EndermanProgress(budgets, 300);
    progress.open("provocation", 54, "A");
    progress.tick(false);
    if (exit === "close") progress.close("provocation:54:A");
    else if (exit === "leave") progress.leave();
    else if (exit === "dispose") progress[Symbol.dispose]();
    else assert.throws(() => { try { throw new Error("fight threw"); } finally { progress.leave(); } }, /fight threw/);
    assert.deepEqual(budgets.snapshot(), []);
    if (exit !== "dispose") assert.equal(progress.open("provocation", 54, "A").remaining, 299);
  });
}

test("the Enderman client physics budget still counts with a stopped server (P4-35 tick source unchanged)", async () => {
  const { bot, clock, server } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }) });
  using _timers = clock.install();
  using progress = new EndermanProgress(new Budgets(), 300);
  const window = progress.open("return", 54, null);
  const tick = () => progress.tick(false);
  server.stop();
  const age = bot.time.age;
  bot.on("physicsTick", tick);
  try {
    await clock.advance(14_950);
    assert.equal(window.exhausted, false);
    await clock.advance(50);
    assert.equal(window.exhausted, true);
    assert.equal(bot.time.age, age, "world age is stopped at fake 15000 ms; physics ticks counted to 300");
  } finally { bot.off("physicsTick", tick); }
});
