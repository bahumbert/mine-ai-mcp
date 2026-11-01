import assert from "node:assert/strict";
import test from "node:test";
import { CATCH_UP_TICKS, latenessRecorded, readingWindow } from "./late-reading-window.ts";
import { READING_TICKS } from "./server-tick-marks.ts";

test("the lateness recorded repeats the failing text's values, and the catch-up ticks used are what the span, the readings' error and the round trip do not explain", () => {
  const roundTripMs = 120;
  const { max, lateTicks } = readingWindow(32, roundTripMs);
  assert.equal(lateTicks, 3 + CATCH_UP_TICKS);
  assert.equal(latenessRecorded(32, 32, roundTripMs), `late-reading: tookTicks=32 roundTripMs=120 lateTicks=${lateTicks} catchUpUsed=${-READING_TICKS - 3}`);
  assert.match(latenessRecorded(32, max, roundTripMs), /catchUpUsed=18$/u, "a reading at the window's top used all 18");
  assert.match(latenessRecorded(32, max + 1, roundTripMs), /catchUpUsed=19$/u, "one past the top is over");
});
