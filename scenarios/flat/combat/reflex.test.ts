import assert from "node:assert/strict";
import test from "node:test";
import { awaitEncounters, readReflexOutcomes } from "./reflex.ts";
import type { Runtime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { DEFAULT_SURVIVAL_POLICY } from "../../../src/survival/policy/contract.js";
import type { SurvivalReceipt } from "../../../src/survival/evidence/contract.js";

test("a failed event read reports the runtime error instead of a schema error", async () => {
  const runtime = {
    actions: [{ name: "read_recent_events" }],
    run: async () => ({ action: "read_recent_events", durationMs: 1,
      result: { kind: "runtime_failure", status: "failed", error: "[MINECRAFT_DISCONNECTED] socket closed" } }),
  } as unknown as Runtime;
  const context = { signal: new AbortController().signal } as MineAiScenarioContext;
  await assert.rejects(readReflexOutcomes(context, runtime), /\[MINECRAFT_DISCONNECTED\] socket closed/);
});

test("an encounter settled during the final observation sleep is still read", async () => {
  let busy = true;
  const payload = {
    response: "fight",
    outcome: "target_died",
    reason: "healthy",
    interrupted: null,
    threats: [{ id: 7, name: "skeleton" }],
    healthBefore: 20,
    healthAfter: 20,
    killedTargetIds: [7],
    attacks: 4,
    combatStyles: ["shielded_melee"],
    weaponsUsed: ["iron_sword"],
    shieldRaisedSwings: 0,
    projectileGuards: 1,
    explosions: 0,
    finalPosition: { x: 0, y: 64, z: 0 },
    finalDistances: [{ id: 7, distance: 2 }],
  };
  const receipt: SurvivalReceipt = {
    kind: "outcome", source: "hostile_reflex",
    evidence: { outcome: payload, interrupted: null },
    status: {
      summary: "safe", request: null,
      owner: { current: null, reserved: null, connected: true, transfer: null },
      dangers: [], response: null, decisions: [], budgets: [], answered: [],
      observations: { missing: [], stale: [] },
      policy: { revision: "test", defaults: DEFAULT_SURVIVAL_POLICY, effective: DEFAULT_SURVIVAL_POLICY,
        overrides: [], encounter: null, response: null, settling: false, lastChange: "Default policy.", constraint: null },
      vitals: { health: 20, food: 20, air: null, inWater: false },
      runtime: { liveness: "observed_in_process", observedAt: 1, physicsObservedAt: 1 },
    },
  };
  const runtime = {
    status: () => ({ busy }),
    actions: [{ name: "read_recent_events" }],
    run: async () => ({
      result: {
        status: "succeeded",
        source: { queryIds: ["test"] },
        readThroughEventId: 1,
        remainingEventCount: 0,
        events: [
          {
            type: "survival_outcome",
            eventId: 1,
            botId: "TestBot",
            observedAt: "now",
            summary: "fight finished",
            payload: receipt,
          },
        ],
      },
    }),
  } as unknown as Runtime;
  const context = {
    signal: new AbortController().signal,
    bot: {
      waitForTicks: async () => {
        busy = false;
      },
    },
  } as unknown as MineAiScenarioContext;
  const encounters = await awaitEncounters(context, runtime, 1, 5);
  assert.equal(encounters.length, 1);
  assert.equal(encounters[0]?.outcome, "target_died");
});
