import assert from "node:assert/strict";
import test from "node:test";
import { serverTicksIn } from "./server-tick-marks.ts";

test("serverTicksIn counts the ticks of a server on time in a wall time: up counts one that has begun, down only those that have ended", () => {
  assert.equal(serverTicksIn(101, "up"), 3);
  assert.equal(serverTicksIn(120, "down"), 2);
});
