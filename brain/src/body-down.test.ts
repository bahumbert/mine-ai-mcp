import assert from "node:assert/strict";
import test from "node:test";
import { bodyDownState, bodyDownWait } from "./body-down.ts";

const NOW = Date.parse("2026-11-08T10:00:00.000Z");
const at = (msAhead: number, attempt = 2) => ({ at: new Date(NOW + msAhead).toISOString(), attempt, of: 6 });

test("a body down with a restart time says when it starts again and which try that is", () => {
  assert.equal(bodyDownState(at(30_000), NOW), "my body is down; it starts again at 10:00Z (try 2 of 6)");
});

test("a body whose restart time has passed is starting again; one that gave up is down until the host restarts", () => {
  assert.equal(bodyDownState(at(-1_000), NOW), "my body is starting again");
  assert.equal(bodyDownState(null, NOW), "my body is down until the host restarts");
});

test("a restart time that is not a date still says the body is down", () => {
  assert.equal(bodyDownState({ at: "soon", attempt: 1, of: 6 }, NOW), "my body is down");
  assert.equal(bodyDownWait(8_000, { at: "soon", attempt: 1, of: 6 }, 100, NOW), 8_000);
});

test("the wait is cut to the restart time, but never under one poll and never past the usual wait", () => {
  assert.equal(bodyDownWait(60_000, at(2_000), 100, NOW), 2_000);
  assert.equal(bodyDownWait(60_000, at(10), 100, NOW), 100, "a poll at least");
  assert.equal(bodyDownWait(60_000, at(-5_000), 100, NOW), 100, "past its time: a poll");
  assert.equal(bodyDownWait(500, at(30_000), 100, NOW), 500, "never longer than the usual wait");
  assert.equal(bodyDownWait(60_000, null, 100, NOW), 60_000, "no restart to come: the usual wait");
});
