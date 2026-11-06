// Tests of the follow_player skill: a follow ends after ten minutes of silence, in monotonic time.
import assert from "node:assert/strict";
import test from "node:test";
import { stepSchema } from "../actions.ts";
import { runStep } from "../skills.ts";
import { FakeRuntime, steppedClocks } from "../testing.ts";
import { contextFor } from "./skill-fixtures.test.ts";

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
