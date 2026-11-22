// Combat evidence preserves current exclusions and replays recordings predating policy fields.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_COMBAT_POLICY } from "./contract.js";
import { DEFAULT_MINECRAFT_VERSION } from "../../../server/config.js";
import { combatDecisionEvidence, decideCombatResponse, type CombatDecisionFacts } from "./decision.js";
import { decideFightBoundary } from "./fight-boundary.js";
import { decideHostileReflex } from "./reflex-decision.js";
import { legacyAssessment, recordedCombatPolicySchema, replayCombatDecision } from "./replay.js";

test("old recordings inherit missing evade ranges and new recordings keep their ranges", () => {
  const old = { ...DEFAULT_COMBAT_POLICY, evade_safe_range: 36 };
  Reflect.deleteProperty(old, "evade_clear_range");
  Reflect.deleteProperty(old, "evade_cover_range");
  for (const [input, expected] of [
    [old, [36, 36]], [{ ...old, evade_clear_range: 12, evade_cover_range: 6 }, [12, 6]],
    [{ ...old, evade_clear_range: 12 }, [12, 36]],
  ] as const) {
    const parsed = recordedCombatPolicySchema.parse(input);
    assert.deepEqual([parsed.evade_clear_range, parsed.evade_cover_range], expected);
  }
});

test("old incidents inherit the missing quarry policy default and replay legacy decisions", () => {
  for (const name of ["creeper", "zombie"]) {
    const contact = { id: 7, name, position: { x: 2, y: 64, z: 0 }, distance: 2,
      relationship: { avoid: true, defend: true, attention: "on_sight" }, inContact: true, inReach: true,
      defendsOnContact: false, ranged: false,
      utility: { inReach: true, visible: true, hasHitUs: false, safeDropGround: true, distance: 2 } };
    const policy = { ...DEFAULT_COMBAT_POLICY };
    Reflect.deleteProperty(policy, "fight_margin");
    Reflect.deleteProperty(policy, "quarry_wait_ticks");
    assert.equal(recordedCombatPolicySchema.parse(policy).quarry_wait_ticks, DEFAULT_COMBAT_POLICY.quarry_wait_ticks);
    const threats = [{ id: 7, name, position: contact.position, distance: 2 }];
    const recorded = { inputs: { policy, health: 20, burning: false, hideAllowed: false, recoveryAvailable: true,
      weapon: false, rangedWeapon: false, shield: false, contacts: [contact], fireball: null,
      unreachable: [], answered: [] }, purpose: { kind: "automatic" },
      decision: name === "creeper" ? { kind: "evade", threats, safeRange: 36, reason: "creeper" }
        : { kind: "fight", targetId: 7, threats } };
    assert.deepEqual(replayCombatDecision(recorded), name === "creeper"
      ? { ...recorded.decision, reason: "explosive" } : recorded.decision);
    assert.deepEqual(replayCombatDecision({ ...recorded, inputs: { ...recorded.inputs, weapon: true } }),
      { kind: "fight", targetId: 7, threats });
  }
});

for (const boundary of ["selection", "fight", "reflex"] as const) {
  test(`${boundary} evidence replays a reachable quarry's retained no-damage answer`, () => {
    const contacts: CombatDecisionFacts["contacts"] = [{ id: 7, name: "zombie", position: { x: 2, y: 64, z: 0 }, distance: 2,
      relationship: { avoid: true, defend: true, attention: "on_sight" }, inContact: true, inReach: true,
      defendsOnContact: false, ranged: false,
      utility: { inReach: true, visible: true, hasHitUs: false, safeDropGround: true, distance: 2 } }];
    const facts: CombatDecisionFacts = { policy: DEFAULT_COMBAT_POLICY, contacts,
      assessment: legacyAssessment(contacts, true, DEFAULT_MINECRAFT_VERSION), health: 20, burning: false, hideAllowed: false,
      recoveryAvailable: true, weapon: true, rangedWeapon: false, shield: false, fireball: null,
      answered: new Set(), answeredFights: new Map([[7, 1]]), quarryAnsweredFights: new Set([7]) };
    const purpose = { kind: "contact_defence", targetId: 7 } as const;
    const directive = decideCombatResponse(facts, purpose);
    assert.equal(directive.kind, "evade");
    const selection = combatDecisionEvidence(facts, purpose, directive);
    const protection = { returnable: false, atProtection: false, foodLow: false, foodAvailable: false };
    const reflex = { settling: false, combatOwnsBody: false, entries: [] };
    const [recorded, expected] = boundary === "fight"
      ? [{ boundary: "fight", selection, protection }, decideFightBoundary(facts, purpose, protection)]
      : boundary === "reflex"
        ? [{ selection, ...reflex }, decideHostileReflex({ facts, directive, ...reflex })]
        : [selection, directive];
    assert.deepEqual(replayCombatDecision(JSON.parse(JSON.stringify(recorded))), expected);
  });
}

test("legacy unreachable receipt fields are optional and ignored", () => {
  const contact = { id: 7, name: "skeleton", position: { x: 6, y: 68, z: 0 }, distance: 7,
    relationship: { avoid: true, defend: true, attention: "on_sight" }, inContact: true, inReach: false,
    defendsOnContact: false, ranged: true,
    utility: { inReach: false, visible: true, hasHitUs: true, safeDropGround: true, distance: 7 } };
  const inputs = { policy: DEFAULT_COMBAT_POLICY, health: 20, burning: false, hideAllowed: false,
    recoveryAvailable: true, weapon: true, rangedWeapon: false, shield: false, contacts: [contact],
    fireball: null, answered: [] };
  for (const legacy of [{}, { unreachable: [7] }]) {
    const result = replayCombatDecision({ inputs: { ...inputs, ...legacy }, purpose: { kind: "automatic" } });
    assert.equal(result.kind, "fight");
  }
});
