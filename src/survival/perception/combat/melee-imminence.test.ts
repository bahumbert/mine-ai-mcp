import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, itemOf } from "../../../test-support/fake-bot/index.js";
import { decideCombatTactic } from "../../policy/combat/tactics.js";
import { observeProjectileDefence } from "../../weapons/shield-facing.js";
import { CombatPerception } from "./observations.js";

/** A sword-armed fortress skeleton, inside its own reach, in the open. */
function closingMeleeFixture() {
  const { bot } = createFakeBot({
    position: { x: 0, y: 64, z: 0 },
    groundY: null,
    entities: {
      31: {
        name: "wither_skeleton", eyeHeight: 2.1,
        // Two blocks off: inside a wither skeleton's attack reach, with nothing
        // in between.
        position: { x: 0, y: 64, z: 2 },
        headYaw: 0,
      },
    },
  });
  const skeleton = bot.entities[31]!;
  skeleton.setEquipment(0, itemOf(bot.registry, "stone_sword"));
  return { bot, skeleton };
}

test("an armed hostile in reach is observed as imminent before it swings, not after", () => {
  const { bot, skeleton } = closingMeleeFixture();
  using perception = new CombatPerception(bot);

  const before = perception.read().find((entry) => entry.id === skeleton.id);
  assert.notEqual(before, undefined, "the skeleton is observed as a threat");
  assert.equal(before!.distance < 3, true, "it is already inside melee reach");
  assert.equal(before!.visible, true, "with a clear line to the bot");

  // Every forward-looking field the perception layer offers is about shooting.
  assert.equal(before!.windingUp, false, "windingUp is a bow draw or a blaze charge, never a raised arm");
  assert.equal(before!.firstShotInTicks, null);
  assert.equal(before!.phase, "unknown");
  assert.equal(observeProjectileDefence(bot, 0, 1000), null, "and no projectile is coming");

  // So the only melee signal left is the retrospective one, and it is false.
  assert.equal(before!.hasHitUs, false, "and it has not hit us yet");
  assert.equal(before!.meleeImminent, true, "the swing is observed before it lands");

  // Which is what the guard decision reads: no projectile means no guard.
  const facts = {
    footingRecovery: false, creepers: [], stationaryCommitment: false, clearancePending: false,
    retreatPermitted: true, escapeAvailable: true, counterTarget: null, counterReady: false, barrier: null,
    projectile: null, meleeImminent: true, shield: { available: true, raised: false },
  };
  assert.deepEqual(decideCombatTactic(facts), { kind: "guard" }, "an adjacent sword is answered by guarding first");
  // Once the guard is up the fight proceeds: melee is fought shield in hand.
  assert.deepEqual(
    decideCombatTactic({ ...facts, shield: { available: true, raised: true } }), { kind: "act" },
    "a raised shield does not stop the bot attacking",
  );

  // Attribution still works, and is no longer the only melee signal.
  bot.emit("entityHurt", bot.entity, skeleton as never);
  assert.equal(
    perception.read().find((entry) => entry.id === skeleton.id)!.hasHitUs, true,
    "melee threat becomes observable only once the damage is already taken",
  );
});
