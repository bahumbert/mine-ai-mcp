// Tests of the follow_player skill: a follow ends after ten minutes of silence, in monotonic time.
import assert from "node:assert/strict";
import test from "node:test";
import { skillUsage, stepSchema } from "../actions.ts";
import { styleOrDefault } from "../building/plan.ts";
import { createFakeClock, flush } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { runStep } from "../skills.ts";
import { FakeRuntime, steppedClocks } from "../testing.ts";
import { contextFor } from "./skill-fixtures.test.ts";

test("the follow line shows no minutes literal and names the field", () => {
  assert.equal(skillUsage("follow_player", styleOrDefault(undefined)), '{"skill":"follow_player","player":"<username>","distance":3}  follow that player: asked by them, it lasts until they stop talking to you for 10 minutes (or say stop); on your own, add "minutes":<1-15> for how long');
});

test("a follow asked for by a player ends after ten minutes without a word from them", async () => {
  // Spec 2026-10-04-activity-time-travel-terraforming: following never ended by itself (live: Vex followed Tester until
  // an order came).
  const runtime = new FakeRuntime();
  const quiet = await runStep({ skill: "follow_player", player: "Tom", distance: 3 }, contextFor(runtime, { heardFrom: () => performance.now() - 11 * 60_000 }));
  assert.equal(quiet.status, "done");
  assert.match(quiet.status === "done" ? quiet.detail : "", /Tom; they said nothing for 10 minutes/u);
  assert.equal(stepSchema.safeParse({ skill: "follow_player", player: "Tom", minutes: 16 }).success, false);
  assert.deepEqual(stepSchema.parse({ skill: "follow_player", player: "Tom", minutes: 5 }), { skill: "follow_player", player: "Tom", distance: 3, minutes: 5 });
});

// Plan 2026-10-27-p1-monotonic-clock T7: a follow's own minutes are a duration (the player's silence window is covered
// through the agent in agent/work-loop.test.ts, where `lastHeard` feeds `heardFrom`).
test("a follow of its own minutes ends after them in monotonic time, whatever the wall clock does", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Tom", position: { x: 1, y: 64, z: 0 } }] };
  const clocks = steppedClocks(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const following = runStep({ skill: "follow_player", player: "Tom", distance: 3, minutes: 2 }, contextFor(runtime, { signal: controller.signal }));
  clocks.wall(-90_000);
  clocks.monotonic(2 * 60_000 + 500);
  const result = await Promise.race([following, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 3_000))]);
  assert.notEqual(result, "hung");
  assert.match((result as { detail: string }).detail, /followed Tom for 2 minutes/u);
});

// Plan 2026-11-15-unit-suite-parallel S2: the hold between two polls is a wall timer a mocked clock reaches (`sleepMs`),
// so the second status read comes when the test advances the clock, not after real seconds.
test("a follow that holds beside its player polls again when the mocked clock passes its poll", async (t) => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Tom", position: { x: 1, y: 64, z: 0 } }] };
  const status = t.mock.method(runtime, "status");
  const controller = new AbortController();
  t.after(() => controller.abort());
  const following = runStep({ skill: "follow_player", player: "Tom", distance: 3, minutes: 2 }, contextFor(runtime, { signal: controller.signal }));
  await flush();
  assert.equal(status.mock.callCount(), 1);
  await clock.advance(749);
  assert.equal(status.mock.callCount(), 1, "the poll waits for its full 750 ms of mocked time");
  await clock.advance(1);
  assert.equal(status.mock.callCount(), 2);
  controller.abort();
  assert.deepEqual(await following, { status: "stopped" });
});
