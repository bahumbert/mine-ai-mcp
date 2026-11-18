// Drop-rate boundaries are game time, independent of the server's real-time tick rate.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock } from "../../src/test-support/fake-bot/index.ts";
import { dropsPerGameMinute, judgeDrops } from "./game-rate.ts";

test("drop rates enforce both boundaries, cap surplus loot and floor the observed span at one tick", () => {
  for (const elapsedTicks of [7_200, 7_201]) {
    const result = judgeDrops({ gained: 6, requested: 6, startAge: 1_000, endAge: 1_000 + elapsedTicks, minimumPerMinute: 1 });
    assert.equal(result.passed, elapsedTicks === 7_200);
    assert.equal(result.elapsedTicks, elapsedTicks);
    assert.equal(result.dropsPerMinute, 7_200 / elapsedTicks);
    assert.equal(result.reason, null);
  }
  assert.equal(judgeDrops({ gained: 5, requested: 6, startAge: 0, endAge: 1_000, minimumPerMinute: 0 }).passed, false);
  assert.equal(dropsPerGameMinute(8, 6, 0, 7_200), 1);
  assert.equal(dropsPerGameMinute(6, 6, 5, 5), 7_200);
});

for (const ticksPerSecond of [20, 10]) {
  test(`six drops cross the game-minute boundary equally at ${ticksPerSecond} tps`, async () => {
    const clock = createFakeClock({ mode: "manual" });
    const { bot } = createFakeBot({ clock, server: { startAge: 1_000, ticksPerSecond } });
    const startAge = bot.time.age;
    await clock.advance(7_200 * 1_000 / ticksPerSecond, 1_000);
    assert.equal(clock.now(), ticksPerSecond === 20 ? 360_000 : 720_000);
    assert.equal(bot.time.age - startAge, 7_200);
    assert.equal(judgeDrops({ gained: 6, requested: 6, startAge, endAge: bot.time.age, minimumPerMinute: 1 }).passed, true);
  });
}

test("missing world age cannot qualify loot as a successful rate", () => {
  for (const [startAge, endAge] of [[null, 8_200], [1_000, null]] as const) {
    const result = judgeDrops({ gained: 6, requested: 6, startAge, endAge, minimumPerMinute: 1 });
    assert.equal(result.passed, false);
    assert.equal(result.reason, "no world age heard");
    assert.equal(result.elapsedTicks, null);
    assert.equal(result.dropsPerMinute, null);
  }
});
