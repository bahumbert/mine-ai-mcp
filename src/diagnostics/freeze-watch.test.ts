import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// The wedge is counted on the monotonic clock, as the watch measures: `Atomics.wait` keeps its deadline on the wall clock.
import { blockThread as wedge } from "../test-support/block-thread.js";
import { createFakeClock } from "../test-support/fake-bot/index.js";
import { freezeClockMs, markPhase, offsetToMainClockMs, stalledForMs, startFreezeWatch, wallMinusFreezeClockMs } from "./freeze-watch.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withWatch(run: (dir: string, watch: ReturnType<typeof startFreezeWatch>) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "freeze-watch-"));
  const watch = startFreezeWatch({ dir, botName: "Kenji", stallMs: 1000 });
  try {
    await run(dir, watch);
  } finally {
    watch[Symbol.dispose]();
    await rm(dir, { recursive: true, force: true });
  }
}

test("a wedged main thread leaves one freeze file holding the last marker", async () => {
  await withWatch(async (dir, watch) => {
    markPhase("progress: swim: moving");
    await sleep(300);
    markPhase("physicsTick: swim");
    wedge(2500);
    await sleep(600);
    const files = (await readdir(dir)).filter((name) => name.startsWith("freeze-"));
    assert.equal(files.length, 1);
    const record = JSON.parse(await readFile(path.join(dir, files[0]!), "utf8"));
    assert.equal(record.bot, "Kenji");
    assert.equal(record.markers.at(-1).text, "physicsTick: swim");
    assert.equal(record.markers[0].text, "progress: swim: moving");
    assert.ok(record.stalledForMs >= 1000);
    assert.ok(record.memory.rss > 0);
    assert.equal(typeof record.stack, "string");
    assert.equal(watch.lastRecord(), path.join(dir, files[0]!));
  });
});

test("no freeze file is written without a stall", async () => {
  await withWatch(async (dir) => {
    markPhase("idle");
    await sleep(1500);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("the marker ring wraps and keeps the newest 64 oldest first", async () => {
  await withWatch(async (dir) => {
    for (let index = 0; index < 100; index++) markPhase(`marker ${index} ${"x".repeat(400)}`);
    wedge(2300);
    await sleep(600);
    const [file] = (await readdir(dir)).filter((name) => name.startsWith("freeze-"));
    const record = JSON.parse(await readFile(path.join(dir, file!), "utf8"));
    assert.equal(record.markers.length, 64);
    assert.match(record.markers[0].text, /^marker 36 /);
    assert.match(record.markers.at(-1).text, /^marker 99 /);
    assert.ok(Buffer.byteLength(record.markers[0].text) <= 144);
  });
});

test("identical consecutive markers share one slot and count their repeats", async () => {
  await withWatch(async (dir) => {
    markPhase("before");
    for (let index = 0; index < 100; index++) markPhase("physicsTick: swim s1");
    markPhase("after");
    wedge(2300);
    await sleep(600);
    const [file] = (await readdir(dir)).filter((name) => name.startsWith("freeze-"));
    const record = JSON.parse(await readFile(path.join(dir, file!), "utf8"));
    assert.deepEqual(
      record.markers.map((marker: { text: string; repeats: number }) => [marker.text, marker.repeats]),
      [["before", 1], ["physicsTick: swim s1", 100], ["after", 1]],
    );
  });
});

// WSL steps its wall clock back ~2 s about every 30 s. The watch's stall (a 3 s threshold in production) is a difference
// of two readings of one clock that both threads share; on `Date.now()` a step hides a freeze or invents one.
for (const stepMs of [-2000, 1200]) {
  test(`a 3 s stall is measured as 3 s across a wall clock step of ${stepMs} ms`, async () => {
    const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
    using _installed = clock.install();
    const heartbeat = freezeClockMs();
    await clock.advance(1500);
    clock.stepWallClock(stepMs);
    await clock.advance(1500);
    assert.equal(stalledForMs(heartbeat), 3000);
  });
}

// Real threads: a fake clock would freeze the `performance.now` the heartbeat reads, so the main thread's wall step is a
// `Date.now` offset here (what `stepWallClock` does to the mock `Date`), undone in `finally`.
async function withMainThreadWallStep(stepMs: number, run: () => Promise<void>) {
  const realNow = Date.now;
  Date.now = () => realNow() + stepMs;
  try {
    await run();
  } finally {
    Date.now = realNow;
  }
}

test("a wall clock step back of the main thread alone writes no freeze file for a thread that beats", async () => {
  await withWatch(async (dir) => {
    await sleep(300);
    await withMainThreadWallStep(-2500, () => sleep(1500));
    assert.deepEqual(await readdir(dir), []);
  });
});

test("a wall clock step forward of the main thread does not hide a wedge", async () => {
  await withWatch(async (dir) => {
    await sleep(300);
    await withMainThreadWallStep(5000, async () => {
      await sleep(300);
      wedge(2300);
      await sleep(600);
    });
    const files = (await readdir(dir)).filter((name) => name.startsWith("freeze-"));
    assert.equal(files.length, 1);
    const record = JSON.parse(await readFile(path.join(dir, files[0]!), "utf8"));
    assert.ok(record.stalledForMs >= 1000 && record.stalledForMs < 2000, `detected at the 1 s threshold, not later: ${record.stalledForMs}`);
  });
});

/**
 * Makes this thread's `freezeClockMs()` read the wall clock now, as a thread's does at its start: its `timeOrigin` is the
 * wall clock at that moment (`Date.now()` minus the clock's own `performance.now()`, which the fake clock holds since its
 * start). The fake clock has one `performance`; calling this again stands for the next thread starting.
 */
function startThreadClock(): void {
  Object.defineProperty(performance, "timeOrigin", { value: Date.now() - performance.now(), configurable: true });
}

// Each thread's `timeOrigin` is the wall clock at its own start, so a wall step after the main thread started and before
// the worker did puts the worker's sum off the main thread's by the step, for good. The main thread reads its "wall
// minus clock" when it spawns the worker (the step is in it), the worker reads its own at its start (the step is in its
// origin, so 0): their difference is minus the step, and the worker adds it to age a stamp of the main clock. A step
// back gives the opposite sign. (A step between the main thread's reading and the worker's own origin is the watch-list
// race, not this case: both threads read 0.)
for (const stepMs of [1500, -1500]) {
  test(`a worker started after a wall step of ${stepMs} ms reads the main thread's clock with the offset ${-stepMs} ms`, async () => {
    const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
    using _installed = clock.install();
    using _origin = { [Symbol.dispose]: () => void delete (performance as { timeOrigin?: number }).timeOrigin };
    startThreadClock();
    const heartbeat = freezeClockMs();
    clock.stepWallClock(stepMs);
    const mainWallMinusClockMs = wallMinusFreezeClockMs();
    startThreadClock();
    const offsetToMain = offsetToMainClockMs(mainWallMinusClockMs);
    await clock.advance(3000);
    assert.equal(stalledForMs(heartbeat, offsetToMain), 3000, "the stamp ages by the time that passed, not by the step");
    assert.equal(stalledForMs(heartbeat), 3000 + stepMs, "without the offset the worker would read the step as a stall");
  });
}
