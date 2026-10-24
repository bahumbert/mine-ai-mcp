/**
 * A zombie with no AI and no armor hit with an iron sword (6 damage) dies of the 4th hit and by hand (1 damage) loses 1 a
 * hit (Mine Labs 1.21.4, 2026-10-23, 3 runs). Each hit is one `damage_event` (type `player_attack`, source the bot) at the
 * hit's tick, then its health in metadata; the killing hit is a `damage_event` then `entity_status` 3 (`entityDead`), and the
 * mob stays on the client for its death animation (945 ms measured) before `entity_destroy` (`entityGone`, `isValid` false).
 * A hit on a dead mob changes nothing. Each hit is read when its answer has arrived, and the next one is sent 40 observed
 * server ticks later (at least 21 server ticks: past the mob's 10-tick hurt window and the sword's cooldown, whatever a
 * lane's stalls do to the wall clock).
 */
import assert from "node:assert/strict";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { type ContractSubject, holdsWithin } from "../subject.ts";
import { CALL_WALL_MS, type DamageEvent, NIGHT, type PacketListening, STILL_MOB_NBT, ZOMBIE_HEALTH, damageTypeId, finishWithin, healthOf, listenToFight, mobAt } from "./combat-scene.ts";

const SWORD_DAMAGE = 6;
const HAND_DAMAGE = 1;
const HITS_TO_KILL = 4;
/** The server's answer to a hit (the `damage_event`, then the health in metadata a tick later) reaches the client within this wall time. */
const ANSWER_WALL_MS = 2_000;
/** Observed ticks that prove at least 21 server ticks: the mob's hurt window is 10 and the sword's cooldown 12.5. */
const HIT_GAP_TICKS = 40;
/** The wall bound of those ticks (40 take 2 s on a server on time). */
const HIT_GAP_WALL_MS = 5_000;
/** The death animation keeps the mob on the client this long after `entityDead` (945 ms measured). */
const DEATH_ANIMATION_MS = { min: 600, max: 1_500 } as const;
/** The health the client holds is a float32 of the server's: a hundredth is the bound. */
const HEALTH_TOLERANCE = 0.01;
/** The server has the new selected slot this many observed ticks after the packet. */
const SLOT_CHANGE_TICKS = 40;

/** The mob's health when the client holds one (the metadata comes with the spawn), else undefined. */
function healthIfKnown(bot: Bot, mob: Entity): number | undefined {
  try {
    return healthOf(bot, mob);
  } catch {
    return undefined;
  }
}

/** Let the server run `HIT_GAP_TICKS` (observed) from now, or fail: a hit sent sooner could land inside the mob's hurt window. */
async function letHurtWindowPass(subject: ContractSubject, after: string): Promise<void> {
  assert.ok(await subject.serverTicks(HIT_GAP_TICKS, HIT_GAP_WALL_MS), `${after}: the server ran fewer than ${HIT_GAP_TICKS} ticks in ${HIT_GAP_WALL_MS} ms`);
}

/** Hit `mob`, wait for the health the server files after it (below `before`), and let the hurt window pass; the health read. */
async function hitAndReadHealth(subject: ContractSubject, mob: Entity, before: number, hit: number): Promise<number> {
  const { bot } = subject;
  bot.attack(mob);
  const answered = await holdsWithin(subject, () => (healthIfKnown(bot, mob) ?? before) < before, ANSWER_WALL_MS);
  assert.ok(answered, `hit ${hit} not answered: the zombie still has ${healthIfKnown(bot, mob)} after ${ANSWER_WALL_MS} ms`);
  const health = healthIfKnown(bot, mob)!;
  await letHurtWindowPass(subject, `after hit ${hit}`);
  return health;
}

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
      // The swing starts over when the body joins or takes the sword in hand (`Player.tick`) and recharges in server ticks (12.5 for the sword): a first hit sent at once on a server behind its schedule is weak (a lane batch: 1.2 of 6).
      await letHurtWindowPass(subject, "before the first hit");
      for (let hit = 1; hit < HITS_TO_KILL; hit += 1) healths.push(await hitAndReadHealth(subject, struck, healths.at(-1) ?? ZOMBIE_HEALTH, hit));
      // The killing hit's answer is the death (`entity_status` 3), not a health to read: a mob that dies is waited for.
      bot.attack(struck);
      assert.ok(await holdsWithin(subject, () => sword.heard.deaths.length > 0, ANSWER_WALL_MS), `hit ${HITS_TO_KILL} not answered: the zombie did not die in ${ANSWER_WALL_MS} ms; health after hits 1-${HITS_TO_KILL - 1}: ${healths.join(", ")}; now ${healthIfKnown(bot, struck)}; ${sword.heard.hurts.length} hurts; ${bot.entity.position.distanceTo(struck.position).toFixed(2)} blocks away`);
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
      await letHurtWindowPass(subject, "after the hit on a removed mob");
      assert.equal(sword.heard.hurts.length, HITS_TO_KILL, "a hit on a removed mob hurt it");
    } finally {
      client.off("damage_event", onDamage);
      sword.stop();
    }
    await finishWithin(subject, bot.unequip("hand"), CALL_WALL_MS, "unequip");
    assert.equal(bot.heldItem, null, "the hand is empty after the unequip");
    // A hit written in the same breath as the slot change was the old slot's (the sword's 6 where the hand does 1; seen twice): the server applies the change a tick or more later. Not modelled by the fake.
    assert.ok(await subject.serverTicks(SLOT_CHANGE_TICKS, HIT_GAP_WALL_MS), `after the unequip: the server ran fewer than ${SLOT_CHANGE_TICKS} ticks in ${HIT_GAP_WALL_MS} ms`);
    const hand = listenToFight(subject, handled);
    try {
      let health = ZOMBIE_HEALTH;
      for (let hit = 1; hit <= 2; hit += 1) {
        health = await hitAndReadHealth(subject, handled, health, hit);
        const expected = ZOMBIE_HEALTH - HAND_DAMAGE * hit;
        assert.ok(Math.abs(health - expected) < HEALTH_TOLERANCE, `after ${hit} hand hits the zombie has ${health}, not ${expected}`);
      }
      assert.equal(hand.heard.hurts.length, 2);
    } finally {
      hand.stop();
    }
  },
};
