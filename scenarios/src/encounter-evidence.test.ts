import assert from "node:assert/strict";
import test from "node:test";
import { parseEncounterEvidence, parseReflexOutcome, readEncounters, readReflexOutcomes } from "../flat/combat/reflex.ts";
import type { Runtime } from "./runtime.ts";
import type { MineAiScenarioContext } from "./scenario-client.ts";
import { DEFAULT_SURVIVAL_POLICY } from "../../src/survival/policy/contract.js";

const fight = { response: "fight", outcome: "target_died", reason: "healthy", healthBefore: 20, healthAfter: 20,
  attacks: 1, combatStyles: ["melee"], weaponsUsed: ["sword"], shieldRaisedSwings: 0, projectileGuards: 0,
  explosions: 0, finalPosition: { x: 0, y: 64, z: 0 }, finalDistances: [] };
const completed = { response: "fight", decision: {}, cancelled: false, outcome: fight, interrupted: null };
const limit = { response: "fight", decision: {}, cancelled: false,
  outcome: { kind: "limit", limit: "no_progress", elapsedMs: 30000, lastProgress: "hurt" }, interrupted: null };
const failed = { response: "fight", decision: {}, kind: "execution_failed", why: "x" };

test("published limits and failures are distinct from completed encounters, including shield preparation", () => {
  assert.deepEqual(parseReflexOutcome(limit), { kind: "limit", response: "fight", limit: "no_progress", elapsedMs: 30000, lastProgress: "hurt" });
  assert.deepEqual(parseReflexOutcome(failed), { kind: "failed", response: "fight", failure: "execution_failed", why: "x" });
  assert.deepEqual(parseReflexOutcome({ ...failed, kind: "cancelled" }), { kind: "failed", response: "fight", failure: "cancelled", why: "x" });
  assert.deepEqual(parseReflexOutcome(completed), { kind: "encounter", ...fight, interrupted: null });
  assert.deepEqual(parseReflexOutcome({ ...limit, response: "prepare_shield" }), { kind: "limit", response: "prepare_shield", limit: "no_progress", elapsedMs: 30000, lastProgress: "hurt" });
  assert.deepEqual(parseReflexOutcome({ ...failed, response: "prepare_shield" }), { kind: "failed", response: "prepare_shield", failure: "execution_failed", why: "x" });
  assert.equal(parseEncounterEvidence(limit), null);
});

test("mixed event pages separate outcomes while encounter readers retain only encounters", async () => {
  const status = { summary: "safe", request: null, owner: { current: null, reserved: null, connected: true, transfer: null },
    dangers: [], response: null, decisions: [], budgets: [], answered: [], observations: { missing: [], stale: [] },
    policy: { revision: "test", defaults: DEFAULT_SURVIVAL_POLICY, effective: DEFAULT_SURVIVAL_POLICY, overrides: [],
      encounter: null, response: null, settling: false, lastChange: "Default policy.", constraint: null },
    vitals: { health: 20, food: 20, air: null, inWater: false },
    runtime: { liveness: "observed_in_process", observedAt: 1, physicsObservedAt: 1 } };
  const events = [completed, limit, failed].map((evidence, index) => ({ type: "survival_outcome", eventId: index + 1,
    botId: "TestBot", observedAt: "now", summary: "outcome", payload: { kind: "outcome", source: "hostile_reflex", evidence, status } }));
  const reader = () => {
    let unread = events;
    return { actions: [{ name: "read_recent_events" }], run: async () => {
      const page = unread;
      unread = [];
      return { result: { status: "succeeded", source: { queryIds: ["test"] }, readThroughEventId: 3,
        remainingEventCount: 0, events: page } };
    } } as unknown as Runtime;
  };
  const context = { signal: new AbortController().signal } as MineAiScenarioContext;
  const result = await readReflexOutcomes(context, reader());
  assert.equal(result.encounters.length, 1);
  assert.equal(result.limits.length, 1);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(await readEncounters(context, reader()), result.encounters);
});

test("shield preparation is not parsed as a fight, while malformed fights still fail", () => {
  assert.equal(parseEncounterEvidence({ response: "prepare_shield", cancelled: false,
    outcome: { kind: "shield_prepared", equipped: true, error: null }, interrupted: null }), null);
  assert.throws(() => parseEncounterEvidence({ response: "fight", outcome: { kind: "shield_prepared" }, interrupted: null }));
});
