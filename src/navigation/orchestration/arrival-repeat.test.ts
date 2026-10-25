import assert from "node:assert/strict";
import test from "node:test";
import { observation } from "../../test-support/navigation.js";
import type { WorldChange } from "../world/world.js";
import { ARRIVAL_REPEAT_CALLS, ARRIVAL_REPEAT_MS, ArrivalRepeat } from "./arrival-repeat.js";

const here = observation(2);
const arrival = (overrides: Partial<Parameters<ArrivalRepeat["note"]>[0]> = {}) => ({
  goalRevision: "goal:1",
  feet: { x: 2, y: 63, z: 0 },
  observation: here,
  ...overrides,
});
const change = (x: number): WorldChange =>
  ({ position: { x, y: 63, z: 0 }, before: {}, after: {}, worldRevision: 2 }) as unknown as WorldChange;

test("three calls in five seconds with one identity fail", () => {
  const repeat = new ArrivalRepeat();
  assert.equal(repeat.note(arrival(), 0), null);
  assert.equal(repeat.note(arrival(), 2_000), null);
  const failure = repeat.note(arrival(), ARRIVAL_REPEAT_MS);
  assert.equal(failure?.kind, "no_progress");
  if (failure?.kind !== "no_progress") return;
  assert.equal(failure.reason, "repeated_arrival");
  assert.match(failure.observation, /goal is reached at 2, 63, 0 but the work there changed nothing for 5 s in the supported stance \(3 tries\)/);
  assert.ok(ARRIVAL_REPEAT_CALLS === 3);
});

test("a changed identity starts over", () => {
  const repeat = new ArrivalRepeat();
  repeat.note(arrival(), 0);
  repeat.note(arrival(), 2_000);
  assert.equal(repeat.note(arrival({ feet: { x: 3, y: 63, z: 0 } }), 6_000), null, "another cell");
  assert.equal(repeat.note(arrival({ goalRevision: "goal:2", feet: { x: 3, y: 63, z: 0 } }), 7_000), null, "another goal");
  assert.equal(repeat.note(arrival({ observation: { ...here, resourceRevision: "2" } }), 8_000), null, "another inventory");
  assert.equal(repeat.note(arrival({ observation: { ...here, resourceRevision: "2" } }), 12_000), null, "two calls only");
});

test("a block changed within reach of the arrival starts over, one far away does not", () => {
  const repeat = new ArrivalRepeat();
  repeat.note(arrival(), 0);
  repeat.worldChanged(change(40));
  repeat.note(arrival(), 2_000);
  repeat.worldChanged(change(4));
  assert.equal(repeat.note(arrival(), 6_000), null, "a dig beside the arrival is work done");
  assert.equal(repeat.note(arrival(), 9_000), null);
  assert.equal(repeat.note(arrival(), 11_000)?.kind, "no_progress");
});

test("two calls over five seconds do not fail", () => {
  const repeat = new ArrivalRepeat();
  repeat.note(arrival(), 0);
  assert.equal(repeat.note(arrival(), 60_000), null);
});

test("reset clears it", () => {
  const repeat = new ArrivalRepeat();
  repeat.note(arrival(), 0);
  repeat.note(arrival(), 2_000);
  repeat.reset();
  assert.equal(repeat.note(arrival(), 6_000), null);
  assert.equal(repeat.note(arrival(), 8_000), null);
});
