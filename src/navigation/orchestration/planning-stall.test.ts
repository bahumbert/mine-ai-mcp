import assert from "node:assert/strict";
import test from "node:test";
import { observation } from "../../test-support/navigation.js";
import { PlanningStall } from "./planning-stall.js";

test("restarts, small jitter and surface bobbing do not renew the twenty-second planning window", () => {
  const stall = new PlanningStall();
  const start = observation();
  stall.begin(start, 0);
  for (let now = 1_000; now < 20_000; now += 1_000) {
    const bob = { ...start, position: { ...start.position, y: start.position.y + (now % 2_000 ? 1.1 : 0) } };
    stall.begin(bob, now);
    assert.equal(stall.check(bob, now), null);
  }
  const failure = stall.check(start, 20_000);
  assert.equal(failure?.kind, "no_progress");
  assert.match(failure && "observation" in failure ? failure.observation : "", /20000 ms/);
});

test("actual displacement renews planning and committed execution consumes none of the next window", () => {
  const stall = new PlanningStall();
  const start = observation();
  stall.begin(start, 0);
  const moved = { ...start, position: { ...start.position, x: start.position.x + 1 } };
  assert.equal(stall.check(moved, 19_999), null);
  assert.equal(stall.check(moved, 30_000), null);
  stall.committed();
  assert.equal(stall.check(moved, 600_000), null, "long execution is not a search stall");
  stall.begin(moved, 600_000);
  assert.equal(stall.check(moved, 619_999), null);
  assert.equal(stall.check(moved, 620_000)?.kind, "no_progress");
});

/** The start moved `blocks` east, so the anchor renews exactly as a body carried by a current does. */
const carried = (from: ReturnType<typeof observation>, blocks: number, rise = 0) => ({
  ...from,
  position: { ...from.position, x: from.position.x + blocks, y: from.position.y + rise },
});

test("a body carried one block every two seconds for twenty seconds fails drifting", () => {
  const stall = new PlanningStall();
  const start = observation();
  stall.begin(start, 0);
  for (let second = 2; second < 20; second += 2) assert.equal(stall.check(carried(start, second / 2), second * 1_000), null);
  const failure = stall.check(carried(start, 10), 20_000);
  assert.equal(failure?.kind, "no_progress");
  assert.equal(failure?.kind === "no_progress" ? failure.reason : "", "drifting");
  assert.match(failure && "observation" in failure ? failure.observation : "", /Carried 10 blocks in 20 s .* no route was committed/);
});

test("a fall of ten blocks does not count as drift", () => {
  const stall = new PlanningStall();
  const start = observation();
  stall.begin(start, 0);
  for (let second = 2; second <= 40; second += 2)
    assert.equal(stall.check(carried(start, 0, -10 * (second / 2)), second * 1_000), null, `fall at ${second} s`);
});

test("six quick shoves in two seconds do not fail", () => {
  const stall = new PlanningStall();
  const start = observation();
  stall.begin(start, 0);
  for (let shove = 1; shove <= 8; shove += 1) assert.equal(stall.check(carried(start, shove), shove * 250), null);
});

test("a commit resets the drift", () => {
  const stall = new PlanningStall();
  const start = observation();
  stall.begin(start, 0);
  for (let second = 2; second <= 18; second += 2) stall.check(carried(start, second / 2), second * 1_000);
  stall.committed();
  stall.begin(carried(start, 9), 19_000);
  // Without the reset the first renewal after 20 s would fail; the new window has only its own.
  assert.equal(stall.check(carried(start, 10), 20_500), null);
  assert.equal(stall.check(carried(start, 11), 22_500), null);
});
