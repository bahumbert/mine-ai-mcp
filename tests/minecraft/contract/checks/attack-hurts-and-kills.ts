/**
 * A zombie with no AI and no armor hit with an iron sword (6 damage) dies of the 4th hit and by hand (1 damage) loses 1 a
 * hit (Mine Labs 1.21.4, 2026-10-23, 3 runs). Each hit is one `damage_event` (type `player_attack`, source the bot) at the
 * hit's tick, then its health in metadata; the killing hit is a `damage_event` then `entity_status` 3 (`entityDead`), and the
 * mob stays on the client for its death animation (945 ms measured) before `entity_destroy` (`entityGone`, `isValid` false).
 * A hit on a dead mob changes nothing. The hits are 600 ms apart, past the mob's hurt window and the sword's cooldown.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { holdsWithin } from "../subject.ts";
import { CALL_WALL_MS, type DamageEvent, NIGHT, type PacketListening, STILL_MOB_NBT, ZOMBIE_HEALTH, damageTypeId, finishWithin, healthOf, listenToFight, mobAt } from "./combat-scene.ts";

const SWORD_DAMAGE = 6;
const HAND_DAMAGE = 1;
const HITS_TO_KILL = 4;
const HIT_GAP_MS = 600;
/** The death animation keeps the mob on the client this long after `entityDead` (945 ms measured). */
const DEATH_ANIMATION_MS = { min: 600, max: 1_500 } as const;
/** The health the client holds is a float32 of the server's: a hundredth is the bound. */
const HEALTH_TOLERANCE = 0.01;
/** The metadata packet follows the `damage_event` by a tick; the check reads the health this long after the hit. */
const SETTLE_MS = 150;
/** The server has the new selected slot this long after the packet. */
const SLOT_CHANGE_SETTLE_MS = 300;

export const attackHurtsAndKills: ContractCheck = {
  name: "attack-hurts-and-kills",
  fixture: {
    cells: {},
    carried: { iron_sword: 1 },
    position: [0.5, -60, 0.5],
    timeOfDay: NIGHT,
    entities: [
      { name: "zombie", position: [0.5, -60, 2.5], nbt: STILL_MOB_NBT },
      { name: "zombie", position: [-2.5, -60, 0.5], nbt: STILL_MOB_NBT },
    ],
  },
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const struck = await mobAt(subject, "zombie", 0.5, 2.5);
    const handled = await mobAt(subject, "zombie", -2.5, 0.5);
    assert.equal(bot.heldItem?.name, "iron_sword", "the first hotbar slot holds the sword");
    const sword = listenToFight(subject, struck);
    const healths: number[] = [];
    const events: DamageEvent[] = [];
    const onDamage = (event: DamageEvent) => void (event.entityId === struck.id && events.push(event));
    const client = bot._client as unknown as PacketListening;
    client.on("damage_event", onDamage);
    try {
      for (let hit = 1; hit <= HITS_TO_KILL; hit += 1) {
        bot.attack(struck);
        await subject.wait(SETTLE_MS);
        if (hit < HITS_TO_KILL) healths.push(healthOf(bot, struck));
        await subject.wait(HIT_GAP_MS - SETTLE_MS);
      }
      assert.equal(sword.heard.hurts.length, HITS_TO_KILL, `${sword.heard.hurts.length} hurts for ${HITS_TO_KILL} hits`);
      assert.ok(sword.heard.hurts.every(({ source }) => source === bot.entity), "a hurt did not name the bot as its source");
      const attack = { entityId: struck.id, sourceTypeId: damageTypeId(bot.registry, "player_attack"), sourceCauseId: bot.entity.id + 1, sourceDirectId: bot.entity.id + 1 };
      assert.deepEqual(events.map(({ entityId, sourceTypeId, sourceCauseId, sourceDirectId }) => ({ entityId, sourceTypeId, sourceCauseId, sourceDirectId })), Array(HITS_TO_KILL).fill(attack), "the damage_event fields");
      healths.forEach((health, index) => {
        const expected = ZOMBIE_HEALTH - SWORD_DAMAGE * (index + 1);
        assert.ok(Math.abs(health - expected) < HEALTH_TOLERANCE, `after hit ${index + 1} the zombie has ${health}, not ${expected}`);
      });
      assert.equal(sword.heard.deaths.length, 1, "the fourth hit did not kill it exactly once");
      assert.ok(Math.abs(sword.heard.deaths[0]! - sword.heard.hurts[HITS_TO_KILL - 1]!.atMs) < 100, "the death came apart from the killing hit");
      await holdsWithin(subject, () => sword.heard.gone.length > 0, DEATH_ANIMATION_MS.max * 2);
      const stayedMs = sword.heard.gone[0]! - sword.heard.deaths[0]!;
      assert.ok(stayedMs >= DEATH_ANIMATION_MS.min && stayedMs <= DEATH_ANIMATION_MS.max, `the dead mob stayed ${stayedMs} ms, not ${DEATH_ANIMATION_MS.min} to ${DEATH_ANIMATION_MS.max}`);
      assert.equal(struck.isValid, false, "a removed mob stays valid");
      assert.equal(bot.entities[struck.id], undefined, "a removed mob is still on the bot");
      bot.attack(struck);
      await subject.wait(HIT_GAP_MS);
      assert.equal(sword.heard.hurts.length, HITS_TO_KILL, "a hit on a removed mob hurt it");
    } finally {
      client.off("damage_event", onDamage);
      sword.stop();
    }
    await finishWithin(subject, bot.unequip("hand"), CALL_WALL_MS, "unequip");
    assert.equal(bot.heldItem, null, "the hand is empty after the unequip");
    // A hit written in the same breath as the slot change was the old slot's (the sword's 6 where the hand does 1; seen twice): the server applies the change a tick or more later. Not modelled by the fake.
    await subject.wait(SLOT_CHANGE_SETTLE_MS);
    const hand = listenToFight(subject, handled);
    try {
      for (let hit = 1; hit <= 2; hit += 1) {
        bot.attack(handled);
        await subject.wait(HIT_GAP_MS);
        const expected = ZOMBIE_HEALTH - HAND_DAMAGE * hit;
        assert.ok(Math.abs(healthOf(bot, handled) - expected) < HEALTH_TOLERANCE, `after ${hit} hand hits the zombie has ${healthOf(bot, handled)}, not ${expected}`);
      }
      assert.equal(hand.heard.hurts.length, 2);
    } finally {
      hand.stop();
    }
  },
};
