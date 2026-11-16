// Survival goals measure their duration independently of wall-clock changes.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGoal, type GoalObserver } from "../../../node_modules/mine-labs/src/trial/goals.ts";

test("a survive goal across a backward wall-clock step passes while the player lives", async () => {
  const startedAt = Date.now();
  const clock = mock.method(Date, "now", () => startedAt - 1_700);
  try {
    const result = await evaluateGoal({ kind: "survive", seconds: 20 }, {
      players: ["Actor"],
      dimension: "overworld",
      observer: { playerDeaths: async () => 0 } as unknown as GoalObserver,
      chat: new Map(),
      completions: new Map(),
      startTick: 0,
      gameTicks: () => 402,
      state: new Map(),
    });
    assert.equal(result.state, "passed");
  } finally {
    clock.mock.restore();
  }
});
