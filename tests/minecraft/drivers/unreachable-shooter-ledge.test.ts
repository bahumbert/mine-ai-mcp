// The ledge driver must reject unchecked tail fights and evades outside a fight pair.
import assert from "node:assert/strict";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import { ExecutionScope } from "../../../src/execution/execution-scope.ts";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { survivalResources } from "../../../src/survival/state/resources.ts";
import { SurvivalPolicyState } from "../../../src/survival/state/survival-policy.ts";
import { DEFAULT_SURVIVAL_POLICY } from "../../../src/survival/policy/contract.ts";
import { responseScope } from "../../../src/survival/control/combat/scopes/response.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import type { ScenarioCall } from "../scenario.ts";
import { run } from "./unreachable-shooter-ledge.ts";

/** Feed schema-valid settled receipts in their real claim order; this tests observation, not game physics. */
function driverTrace(observeMs: number, minimumRetryMs: number, trace: readonly (readonly [number, "fight" | "evade"])[]) {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot } = createFakeBot({ clock, username: "Actor", overrides: { chat: () => {} },
    entities: { 7: { name: "skeleton", position: { x: 6, y: 68, z: 0 } },
      8: { name: "arrow", position: { x: 3, y: 66, z: 0 } } } });
  const policy = new SurvivalPolicyState(bot).snapshot();
  const survival = survivalResources();
  survival.answered.remember(responseScope(bot, () => DEFAULT_SURVIVAL_POLICY, "fight", 7),
    { kind: "unreachable", why: "No route reached the pillar." },
    { premise: "unreachable", ticks: 600, why: "No route reached the pillar." });
  const status = { summary: "safe", request: null, owner: { current: null, reserved: null, connected: true, transfer: null },
    dangers: [], response: null, decisions: [], budgets: [], answered: survival.answered.snapshot(),
    observations: { missing: [], stale: [] }, policy, vitals: { health: 20, food: 20, air: null, inWater: false },
    runtime: { liveness: "observed_in_process", observedAt: 0, physicsObservedAt: null } };
  const unread: unknown[] = [];
  let eventId = 0;
  for (const [at, kind] of trace) clock.after(at, () => {
    if (kind === "fight") {
      using scope = new ExecutionScope({ bot: bot.username, operation: "combat", targetId: 7 });
      scope.runSync("approach", () => {});
    }
    unread.push({ eventId: ++eventId, botId: bot.username, type: "survival_outcome", observedAt: new Date().toISOString(),
      summary: kind, payload: { kind: "outcome", source: "hostile_reflex", evidence: { outcome: { response: kind } }, status } });
  });
  // An arrow packet is irrelevant to these ordering guards, but required by the driver at completion.
  clock.after(50, () => { bot.emit("entitySpawn", bot.entities[8]!); });
  const context = scenarioTestContext({ bot, scenario: scenarioDefinitionSchema.parse({ goal: { kind: "completion" },
    params: { observeMs, minimumRetryMs, shooter: [6, 68, 0], steps: [[0, 64, 0], [1, 64, 0]] } }), call: async (action) => {
    const result = action === "read_recent_events"
      ? { status: "succeeded", source: { queryIds: ["unread-events-page"] }, events: unread.splice(0), readThroughEventId: eventId, remainingEventCount: 0 }
      : { status: "succeeded" };
    return { action, durationMs: 0, result, summary: "driver fixture", survival: status, survivalPolicy: policy } as ScenarioCall;
  } });
  return { clock, context };
}

test("the ledge driver checks final-wait fights and requires an evade inside each adjacent pair", async (t) => {
  for (const row of [
    { observeMs: 80, minimumRetryMs: 30_000, trace: [[50, "fight"], [50, "fight"]], rejects: true },
    { observeMs: 250, minimumRetryMs: 1, trace: [[50, "fight"], [150, "fight"], [170, "evade"]], rejects: true },
    { observeMs: 250, minimumRetryMs: 1, trace: [[50, "fight"], [100, "evade"], [150, "fight"]], rejects: false },
  ] as const) {
    await t.test(JSON.stringify(row.trace), async () => {
      const { clock, context } = driverTrace(row.observeMs, row.minimumRetryMs, row.trace);
      using _installed = clock.install();
      const completion = clock.settle(run(context, clock.sleep), 500);
      if (row.rejects) await assert.rejects(completion, assert.AssertionError);
      else assert.equal((await completion).status, "succeeded");
    });
  }
});
