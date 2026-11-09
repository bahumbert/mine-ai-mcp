// Compatibility of combat decisions recorded before assessments and fight margins existed.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_COMBAT_POLICY } from "./contract.js";
import { replayCombatDecision } from "./replay.js";

test("old creeper and zombie incidents replay with legacy weapons and renamed explosive reasons", () => {
  for (const name of ["creeper", "zombie"]) {
    const contact = { id: 7, name, position: { x: 2, y: 64, z: 0 }, distance: 2,
      relationship: { avoid: true, defend: true, attention: "on_sight" }, inContact: true, inReach: true,
      defendsOnContact: false, ranged: false,
      utility: { inReach: true, visible: true, hasHitUs: false, safeDropGround: true, distance: 2 } };
    const policy = { ...DEFAULT_COMBAT_POLICY };
    Reflect.deleteProperty(policy, "fight_margin");
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
