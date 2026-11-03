import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { enterPortal } from "./portal-entry.js";

// Plan 2026-10-27-p1-monotonic-clock T4: the entry's `elapsedMs` is a duration, so it reads the monotonic clock.
test("a portal entry that ends 200 ms in, after the wall clock stepped back 0.8 s, reports a duration of 200 ms and never a negative one", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({
    position: new Vec3(-0.5, 65, 0.5), groundY: 64, clock,
    cells: { "0,64,0": "end_portal", "-1,64,0": "stone" },
  });
  using _timers = clock.install();
  const result = enterPortal(harness.bot, new Vec3(0, 64, 0), "end_portal", new AbortController().signal);
  await clock.advance(200);
  clock.stepWallClock(-800);
  harness.world.setCell(new Vec3(0, 64, 0), "air");
  const outcome = await clock.settle(result, 2_000);
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.status === "stopped" ? outcome.reason : "", /NAVIGATION_PORTAL_ENTRY_STOPPED/u);
  assert.ok(outcome.elapsedMs >= 200 && outcome.elapsedMs < 800, `elapsedMs ${outcome.elapsedMs}`);
});
