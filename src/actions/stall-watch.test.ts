import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../test-support/fake-bot/index.js";
import { watchForStall, type StallFacts } from "./stall-watch.js";

test("unchanged work reports distance walked but no distance for vertical bobbing in water", async () => {
  for (const inWater of [false, true]) {
    const clock = createFakeClock({ mode: "manual" });
    let step = 0;
    let facts: StallFacts | undefined;
    const watch = watchForStall({
      work: () => 0,
      position: () => inWater ? { x: 0.5, y: 56 + (step++ % 2) * 6, z: 0.5 } : { x: ++step, y: 64, z: 0 },
      inWater: () => inWater,
      stallTicks: 200, worldAge: () => null, sampleMs: 500, clock,
      describe: (value) => { facts = value; return "stalled"; },
    });
    try {
      await clock.advance(15_000, 500);
      assert.equal(watch.signal.aborted, true);
      assert.equal(facts?.seconds, 10);
      assert.equal(facts?.ticks, null);
      if (inWater) assert.equal(facts?.walked, 0);
      else assert.ok((facts?.walked ?? 0) >= 5, "the walked distance was not summed");
      assert.equal(clock.pendingTimers(), 0);
    } finally { watch.close(); }
  }
});

test("a run that keeps working is never stopped", async () => {
  const clock = createFakeClock({ mode: "manual" });
  let work = 0;
  const watch = watchForStall({
    work: () => (work += 1),
    position: () => ({ x: 0, y: 64, z: 0 }),
    stallTicks: 200, worldAge: () => null,
    sampleMs: 500,
    clock,
    describe: () => "stalled",
  });
  try {
    await clock.advance(12_000, 500);
    assert.equal(watch.signal.aborted, false);
    assert.equal(watch.reason(), null);
  } finally {
    watch.close();
  }
});

test("closing the watch stops its sampling, so a settled run is never aborted afterwards", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const watch = watchForStall({ work: () => 0, position: () => ({ x: 0, y: 0, z: 0 }), stallTicks: 200, worldAge: () => null, sampleMs: 500,
    clock, describe: () => "stalled" });
  watch.close();
  await clock.advance(60_000);
  assert.equal(watch.signal.aborted, false);
  assert.equal(clock.pendingTimers(), 0);
});

for (const { ticksPerSecond, expiresMs, ticks } of [
  { ticksPerSecond: 20, expiresMs: 12_000, ticks: 220 },
  { ticksPerSecond: 10, expiresMs: 23_000, ticks: 220 },
  { ticksPerSecond: 5, expiresMs: 33_000, ticks: 160 }, // Stress: the wall backstop ends before 200 ticks.
]) {
  test(`unchanged work at ${ticksPerSecond} tps${ticksPerSecond === 5 ? " (stress)" : ""} ends on its tick or wall budget and releases its sampling`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot } = createFakeBot({ clock, server: { ticksPerSecond } });
    const age = bot.time.age;
    const added = listenersAddedSince(bot);
    let facts: StallFacts | null = null;
    let described = 0;
    const watch = watchForStall({
      work: () => 0, position: () => bot.entity.position, worldAge: () => bot.time.age,
      stallTicks: 200, sampleMs: 1_000, clock,
      describe: (value) => { facts = value; described += 1; return "stalled"; },
    });
    try {
      await clock.advance(expiresMs - 1);
      assert.equal(watch.signal.aborted, false, `not stalled at ${expiresMs - 1} ms, age +${bot.time.age - age}`);
      await clock.advance(1);
      assert.equal(watch.signal.aborted, true);
      assert.deepEqual(facts, { seconds: expiresMs / 1_000, ticks, walked: 0 });
      await clock.advance(60_000);
      assert.equal(described, 1);
      assert.equal(clock.pendingTimers(), 0);
      assert.equal(added("physicsTick"), 0);
    } finally { watch.close(); }
  });
}

test("a work change restarts the window from the age read at that sample", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot } = createFakeBot({ clock });
  const age = bot.time.age;
  let work = 0;
  let facts: StallFacts | null = null;
  const watch = watchForStall({
    work: () => work, position: () => bot.entity.position, worldAge: () => bot.time.age,
    stallTicks: 200, sampleMs: 1_000, clock,
    describe: (value) => { facts = value; return "stalled"; },
  });
  try {
    await clock.advance(7_000);
    work = 1;
    await clock.advance(1_000);
    // Timers run before the packet due at 8 s: the watch reads A + 140 (2026-11-18).
    assert.equal(bot.time.age - age, 160);
    await clock.advance(10_000);
    assert.equal(watch.signal.aborted, false, "18 s sample still reads A + 340");
    await clock.advance(1_000);
    assert.equal(watch.signal.aborted, true);
    assert.deepEqual(facts, { seconds: 11, ticks: 220, walked: 0 });
  } finally { watch.close(); }
});

test("a stopped server keeps the old ten-second bound, including its last sample", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, server } = createFakeBot({ clock });
  server.stop();
  let facts: StallFacts | null = null;
  const watch = watchForStall({
    work: () => 0, position: () => bot.entity.position, worldAge: () => bot.time.age,
    stallTicks: 200, sampleMs: 1_000, clock,
    describe: (value) => { facts = value; return "stalled"; },
  });
  try {
    await clock.advance(9_000);
    assert.equal(watch.signal.aborted, false);
    await clock.advance(1_000);
    assert.equal(watch.signal.aborted, true);
    assert.deepEqual(facts, { seconds: 10, ticks: 0, walked: 0 });
  } finally { watch.close(); }
});

test("a throwing description releases the sampling even when the caller closes again", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const failure = new Error("cannot describe");
  const watch = watchForStall({
    work: () => 0, position: () => ({ x: 0, y: 64, z: 0 }), worldAge: () => null,
    stallTicks: 200, clock,
    describe: () => { throw failure; },
  });
  await assert.rejects(clock.advance(10_000), (error) => error === failure);
  assert.equal(clock.pendingTimers(), 0);
  watch.close();
  await clock.advance(60_000);
  assert.equal(watch.signal.aborted, false);
});
