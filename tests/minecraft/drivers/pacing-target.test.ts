// The timing driver rejects pacing fights that never limit or retry before the escalating pause.
import assert from "node:assert/strict";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import { ExecutionScope } from "../../../src/execution/execution-scope.ts";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { SurvivalPolicyState } from "../../../src/survival/state/survival-policy.ts";
import { arenaFrame } from "../arena/frame.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import type { ScenarioCall } from "../scenario.ts";
import { run } from "./pacing-target.ts";

test("pacing timing checks run in any lane and reject early retries or missing limits", async () => {
  for (const [third, secondEnd, limit, rejects] of [[90_000, 70_050, "no_progress", false], [80_000, 70_050, "no_progress", true],
    [90_000, 70_050, "ceiling", true], [90_000, 80_050, "no_progress", true]] as const) {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    const { bot } = createFakeBot({ clock });
    const status = { summary: "safe", request: null,
      owner: { current: null, reserved: null, connected: true, transfer: null }, dangers: [], response: null,
      decisions: [], budgets: [], answered: [], observations: { missing: [], stale: [] },
      policy: new SurvivalPolicyState(bot).snapshot(), vitals: { health: 20, food: 20, air: null, inWater: false },
      runtime: { liveness: "observed_in_process", observedAt: 0, physicsObservedAt: null } };
    const unread: unknown[] = [];
    let id = 0;
    for (const [at, end] of [[50, 30_050], [40_050, secondEnd], [third + 50, third + 100]]) clock.after(at!, () => {
      const scope = new ExecutionScope({ bot: bot.username, operation: "combat", targetId: 7 });
      scope.runSync("swing", () => {});
      clock.after(end! - at!, () => scope[Symbol.dispose]());
    });
    for (const at of [30_050, secondEnd]) clock.after(at, () => unread.push({
      eventId: ++id, botId: bot.username, type: "survival_outcome", observedAt: new Date().toISOString(), summary: "limit",
      payload: { kind: "outcome", source: "hostile_reflex", evidence: { outcome: { kind: "limit", limit } }, status },
    }));
    const context = scenarioTestContext({ bot, arena: arenaFrame({ x: 64, z: 1536 }),
      scenario: scenarioDefinitionSchema.parse({ goal: { kind: "completion" } }),
      call: async () => ({ action: "read_recent_events", durationMs: 0, summary: "trace", result: {
        status: "succeeded", source: { queryIds: ["unread-events-page"] }, events: unread.splice(0), readThroughEventId: id, remainingEventCount: 0,
      } }) as ScenarioCall,
    });
    const completion = clock.settle(run(context, clock.sleep), 100_000);
    if (rejects) await assert.rejects(completion, assert.AssertionError);
    else assert.equal((await completion).status, "succeeded");
  }
});
