import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { encounterBaseline, type EncounterEvidence, type FightResponseResult, type HostileResponseResult } from "./response-result.js";
import { completeResponse, responseContinuation } from "./settlement.js";

test("a survived explosion preserves request reassessment after a completed fight", () => {
  const { bot } = createFakeBot();
  const physical: FightResponseResult = {
    ...encounterBaseline(bot, { kind: "fight", targetId: 7, threats: [] }, 20),
    response: "fight", result: { kind: "contact_ended" }, killedTargetIds: [7],
    attacks: 1, combatStyles: [], weaponsUsed: [], shieldRaisedSwings: 0, projectileGuards: 0, explosions: 1,
  };
  assert.deepEqual(responseContinuation(completeResponse(physical, new AbortController().signal)), { kind: "resume" });
  assert.equal(responseContinuation(completeResponse({ ...physical, healthAfter: 0 }, new AbortController().signal)).kind, "return");
});

/** Contract results from physical responders; no server answer is simulated here. */
function responseResults(): HostileResponseResult[] {
  const evidence: EncounterEvidence = {
    reason: "hurt", threats: [], healthBefore: 11, healthAfter: 11,
    finalPosition: { x: 0, y: 64, z: 0 }, finalDistances: [], killedTargetIds: [],
    attacks: 0, combatStyles: [], weaponsUsed: [], shieldRaisedSwings: 0, projectileGuards: 0, explosions: 0,
  };
  const evade = { ...evidence, response: "evade" as const, elapsedMs: 15_000, elapsedTicks: 300,
    startPosition: { x: 0, y: 64, z: 0 }, goalRefreshes: 1, ends: [] };
  const fight = { ...evidence, response: "fight" as const };
  const result = { targetId: 8, attacks: 0, stylesUsed: [], weaponsUsed: [],
    shieldRaisedSwings: 0, projectileGuards: 0, explosions: 0 };
  const hide = { ...evidence, response: "hide" as const };
  const shelter = { dug: 0, walled: 0, capped: false, enclosed: true, ate: null, swings: 0,
    healthAfter: 11, hungerAfter: 20 };
  return [
    { ...evade, result: { kind: "exhausted", reason: "Still following" } },
    { ...evade, result: { kind: "separated" } },
    { ...evade, result: { kind: "failed", reason: "Cleanup failed" } },
    { ...evidence, response: "deflect", result: { kind: "unobserved", attacks: 0,
      observation: "Fireball disappeared before defense began." } },
    { ...evidence, response: "deflect", result: { kind: "reflected", attacks: 1, observation: "Observed reversal" } },
    { ...fight, result: { ...result, kind: "died" } },
    { ...fight, result: { ...result, kind: "target_lost" } },
    { ...fight, result: { ...result, kind: "unreachable", observation: "No route" } },
    { ...fight, result: { kind: "contact_ended" } },
    { ...fight, result: { ...result, kind: "capability_blocked", reason: "policy", observation: "Pursuit prohibited" } },
    { ...fight, result: { ...result, kind: "defence_required", observation: "Another danger" } },
    { ...fight, result: { ...result, kind: "failed", observation: "Execution failed" } },
    { ...fight, result: { ...result, kind: "bot_died" } },
    { ...fight, result: { ...result, kind: "cancelled" } },
    { ...hide, result: { ...shelter, kind: "recovered", recovery: { kind: "recovered", ate: null } } },
    { ...hide, result: { ...shelter, kind: "failed", recovery: null, error: "No enclosure" } },
    { ...hide, result: { ...shelter, kind: "held", recovery: null, error: "No food" } },
  ];
}

test("only exhausted evades and unreflected deflections hold a living request; all other settlement rows keep their verdict", () => {
  const expected = [
    { kind: "hold", reason: "[HOSTILE_SETTLED] evade ended with capability_limit at health 11: Still following." },
    { kind: "resume" }, { kind: "return" },
    { kind: "hold", reason: "[HOSTILE_SETTLED] deflect ended with capability_limit at health 11: Fireball disappeared before defense began.." },
    { kind: "resume" }, { kind: "resume" }, { kind: "resume" }, { kind: "resume" }, { kind: "resume" },
    { kind: "return" }, { kind: "return" }, { kind: "return" }, { kind: "return" }, { kind: "return" },
    { kind: "resume" }, { kind: "return" }, { kind: "return" },
  ];
  for (const [index, physical] of responseResults().entries()) {
    const completed = completeResponse(physical, new AbortController().signal);
    const label = `${physical.response} ${physical.result.kind}`;
    const want = expected[index]!;
    if (want.kind === "return") assert.equal(responseContinuation(completed).kind, want.kind, label);
    else assert.deepEqual(responseContinuation(completed), want, label);
    assert.equal(responseContinuation(completeResponse({ ...physical, healthAfter: 0 }, new AbortController().signal)).kind,
      "return", `${label} after death`);
    assert.equal(responseContinuation(completeResponse(physical, AbortSignal.abort("Cancelled"))).kind,
      "return", `${label} after cancellation`);
  }
});

test("a chain's successful last response resumes with a receipt naming the whole chain", () => {
  const completed = completeResponse(responseResults()[5]!, new AbortController().signal);
  const chain = { threatId: 8, name: "zombie", responses: 2, evades: 1, seconds: 25, gained: 3.1 };
  assert.deepEqual(responseContinuation({ ...completed, chain }), {
    kind: "resume",
    reason: "[HOSTILE_SETTLED] fight ended with target_died at health 11; 2nd response to zombie#8 in 25 s, 1 evades, gained 3.1 blocks overall.",
  });
});
