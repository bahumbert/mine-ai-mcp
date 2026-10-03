import assert from "node:assert/strict";
import test from "node:test";
import { watchForStall } from "./stall-watch.js";

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("a run whose work never changes is stopped, with the distance walked while nothing happened", async () => {
  let x = 0;
  const watch = watchForStall({
    work: () => 0,
    position: () => ({ x: (x += 1), y: 64, z: 0 }),
    stallMs: 60,
    sampleMs: 5,
    describe: ({ seconds, walked }) => `stalled ${seconds} s, walked ${walked}`,
  });
  try {
    await pause(150);
    assert.equal(watch.signal.aborted, true);
    assert.match(watch.reason() ?? "", /^stalled 0\.06 s, walked \d+$/u);
    assert.ok(Number(/walked (\d+)/u.exec(watch.reason() ?? "")?.[1]) >= 5, "the walked distance was not summed");
  } finally {
    watch.close();
  }
});

test("a run that keeps working is never stopped", async () => {
  let work = 0;
  const watch = watchForStall({
    work: () => (work += 1),
    position: () => ({ x: 0, y: 64, z: 0 }),
    stallMs: 40,
    sampleMs: 5,
    describe: () => "stalled",
  });
  try {
    await pause(120);
    assert.equal(watch.signal.aborted, false);
    assert.equal(watch.reason(), null);
  } finally {
    watch.close();
  }
});

test("closing the watch stops its sampling, so a settled run is never aborted afterwards", async () => {
  const watch = watchForStall({ work: () => 0, position: () => ({ x: 0, y: 0, z: 0 }), stallMs: 30, sampleMs: 5, describe: () => "stalled" });
  watch.close();
  await pause(80);
  assert.equal(watch.signal.aborted, false);
});
