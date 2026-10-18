import assert from "node:assert/strict";
import test from "node:test";
import { watchForStall, type StallClock } from "./stall-watch.js";

/** A clock the test steps by hand: `advance` moves time forward one sample at a time, firing the ticks due. */
function manualClock(): StallClock & { advance: (ms: number) => void } {
  let now = 0;
  const ticks = new Set<{ tick: () => void; ms: number; next: number }>();
  return {
    now: () => now,
    every: (tick, ms) => {
      const entry = { tick, ms, next: now + ms };
      ticks.add(entry);
      return () => ticks.delete(entry);
    },
    advance: (ms) => {
      const end = now + ms;
      for (;;) {
        const due = [...ticks].filter((entry) => entry.next <= end).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next;
        due.next += due.ms;
        due.tick();
      }
      now = end;
    },
  };
}

test("a run whose work never changes is stopped, with the distance walked while nothing happened", () => {
  const clock = manualClock();
  let x = 0;
  const watch = watchForStall({
    work: () => 0,
    position: () => ({ x: (x += 1), y: 64, z: 0 }),
    stallMs: 60,
    sampleMs: 5,
    clock,
    describe: ({ seconds, walked }) => `stalled ${seconds} s, walked ${walked}`,
  });
  try {
    clock.advance(150);
    assert.equal(watch.signal.aborted, true);
    assert.match(watch.reason() ?? "", /^stalled 0\.06 s, walked \d+$/u);
    assert.ok(Number(/walked (\d+)/u.exec(watch.reason() ?? "")?.[1]) >= 5, "the walked distance was not summed");
  } finally {
    watch.close();
  }
});

test("a run that keeps working is never stopped", () => {
  const clock = manualClock();
  let work = 0;
  const watch = watchForStall({
    work: () => (work += 1),
    position: () => ({ x: 0, y: 64, z: 0 }),
    stallMs: 40,
    sampleMs: 5,
    clock,
    describe: () => "stalled",
  });
  try {
    clock.advance(120);
    assert.equal(watch.signal.aborted, false);
    assert.equal(watch.reason(), null);
  } finally {
    watch.close();
  }
});

test("closing the watch stops its sampling, so a settled run is never aborted afterwards", () => {
  const clock = manualClock();
  const watch = watchForStall({ work: () => 0, position: () => ({ x: 0, y: 0, z: 0 }), stallMs: 30, sampleMs: 5,
    clock, describe: () => "stalled" });
  watch.close();
  clock.advance(80);
  assert.equal(watch.signal.aborted, false);
});

test("a bot bobbing in water at one x/z walked nothing, however far it moved up and down", () => {
  const clock = manualClock();
  let tick = 0;
  const watch = watchForStall({
    work: () => 0,
    position: () => ({ x: 0.5, y: 56 + (tick++ % 2) * 6, z: 0.5 }),
    inWater: () => true,
    stallMs: 60,
    sampleMs: 5,
    clock,
    describe: ({ walked }) => `walked ${walked}`,
  });
  try {
    clock.advance(150);
    assert.equal(watch.reason(), "walked 0");
  } finally {
    watch.close();
  }
});
