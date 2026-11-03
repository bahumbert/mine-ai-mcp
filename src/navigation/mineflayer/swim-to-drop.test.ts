import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { swimToDrop } from "./swim-to-drop.js";

// Plan 2026-10-27-p1-monotonic-clock T4: the swim's time limit is a deadline, so it counts monotonic time.
for (const row of [
  { name: "a wall step back of 0.8 s does not stretch it", wallStepMs: -800 },
  { name: "a wall step forward of 1.2 s does not cut it short", wallStepMs: 1_200 },
]) {
  test(`a swim to a drop that never gets nearer gives up after its 3 s: ${row.name}`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    const { bot } = createFakeBot({ position: new Vec3(0.5, 64, 0.5), clock, entities: { 9: { name: "item", position: new Vec3(3.5, 64, 0.5) } } });
    Object.assign(bot.entities[9]!, { getDroppedItem: () => ({ name: "oak_boat" }) });
    using _timers = clock.install();
    let finished = false;
    const swim = swimToDrop(bot, () => true, 8, () => false, 3_000).then(() => { finished = true; });
    await clock.advance(1_000);
    clock.stepWallClock(row.wallStepMs);
    await clock.advance(1_900);
    assert.equal(finished, false, "2.9 s in: still swimming");
    await clock.advance(300);
    assert.equal(finished, true, "3.2 s in: gave up");
    await swim;
  });
}
