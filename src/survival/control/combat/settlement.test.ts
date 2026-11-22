import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { encounterBaseline, type EncounterEvidence, type FightResponseResult, type HostileResponseResult } from "./response-result.js";
import { completeResponse, describeResponse, encounterReceipt, responseContinuation, responseFailure } from "./settlement.js";

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
  const hide = { ...evidence, response: "hide" as const, followUp: null };
  const shelter = { dug: 0, walled: 0, capped: false, enclosed: true, margin: { placed: 0, ticks: 0, skipped: [] }, ate: null, swings: 0,
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
    { ...hide, result: { ...shelter, kind: "failed", recovery: null, error: "No enclosure", refusal: {
      cause: "no_floor", feet: { x: 0, y: 64, z: 0 }, position: { x: 0.5, y: 64, z: 0.5 }, onGround: true,
      floor: null, shell: [], margin: [], occupied: [], intruders: [], hazard: null, projectiles: [], worldAge: null,
    } } },
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
    if (physical.response === "hide" && physical.result.kind === "failed") {
      const hide = encounterReceipt(completed).hide;
      assert.equal(hide?.kind, "failed");
      if (hide?.kind !== "failed") throw new Error("expected failed hide receipt");
      assert.deepEqual(hide.refusal, physical.result.refusal);
    }
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

test("a withheld deflection retains its bystander reason as a capability limit and per-shot failure", () => {
  const physical = responseResults()[3]!;
  assert.equal(physical.response, "deflect");
  if (physical.response !== "deflect") return;
  const observation = "Deflection withheld: enderman#61 stands on the return line.";
  const settlement = completeResponse({ ...physical, result: { kind: "withheld", attacks: 0, observation } },
    new AbortController().signal);
  assert.equal(encounterReceipt(settlement).outcome, "capability_limit");
  assert.equal(encounterReceipt(settlement).error, observation);
  assert.deepEqual(responseFailure(settlement), { kind: "deflection_unobserved", why: observation });
  assert.equal(responseContinuation(settlement).kind, "hold");
});

// A fight ended by the request it continued is no lost target (plan 2026-11-18-scenario-reds-part3-a4 T18j).
test("a fight released by its request's goal or stall resumes with no remembered failure and names the release", () => {
  const lost = completeResponse(responseResults()[6]!, new AbortController().signal);
  assert.deepEqual([responseFailure(lost)?.kind, responseContinuation(lost).kind, "released" in encounterReceipt(lost)],
    ["target_lost", "resume", false]);
  for (const released of ["goal_met", "stalled"] as const) {
    const settlement = { ...lost, released };
    assert.equal(responseFailure(settlement), null, released);
    assert.deepEqual(responseContinuation(settlement), { kind: "resume" }, released);
    assert.equal(encounterReceipt(settlement).released, released);
    const facts = describeResponse(settlement);
    assert.ok(typeof facts === "object" && facts !== null && !Array.isArray(facts), "the description is a record");
    assert.equal((facts as { readonly released?: unknown }).released, released);
    assert.equal(encounterReceipt(settlement).outcome, "target_lost");
  }
});

test("an occupied hide settles its one follow-up without losing the refusal", () => {
  const original = responseResults()[15]!;
  if (original.response !== "hide" || original.result.kind !== "failed" || !original.result.refusal)
    throw new Error("expected failed hide fixture");
  const hide = { ...original, result: { ...original.result,
    refusal: { ...original.result.refusal, cause: "occupied" as const } } };
  for (const index of [1, 5, 0, 7]) {
    const followUp = responseResults()[index]!;
    if (followUp.response !== "fight" && followUp.response !== "evade") throw new Error("expected physical follow-up fixture");
    const physical = { ...hide, followUp };
    const settlement = completeResponse(physical, new AbortController().signal);
    const receipt = encounterReceipt(settlement);
    const succeeded = index === 1 || index === 5;
    assert.equal(receipt.outcome, succeeded ? index === 1 ? "safe_separation" : "target_died" : "capability_limit");
    assert.equal(receipt.response, succeeded ? followUp.response : "hide");
    assert.deepEqual(receipt.hide, hide.result, "a follow-up never forges a recovered hide");
    assert.deepEqual(receipt.followUp, followUp);
    assert.equal(responseContinuation(settlement).kind, succeeded ? "resume" : "return");
    assert.equal(responseContinuation(completeResponse(physical, AbortSignal.abort("cancelled"))).kind, "return");
    assert.equal(responseContinuation(completeResponse({ ...physical, healthAfter: 0 }, new AbortController().signal)).kind, "return");
  }
});
