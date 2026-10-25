/**
 * What the bot is told when another actor hurts her (`/damage`, Mine Labs 1.21.4, 2026-10-23, 3 runs). By a zombie:
 * `damage_event` {entityId the bot, type `mob_attack`, cause and direct = the zombie's id + 1} (Mineflayer's `entityHurt(bot,
 * zombie)`), `update_health` with the new health, a knockback `entity_velocity` away from the zombie (0.4 sideways). With no
 * source: type `generic`, cause 0 (`entityHurt(bot)`). The difficulty is easy (a mob's attack scales with it).
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { ANSWER_WALL_MS, afterServerTicks, answerArrives } from "../server-answer.ts";
import { holdsWithin } from "../subject.ts";
import { type DamageEvent, NIGHT, STILL_MOB_NBT, damageTypeId, mobAt } from "./combat-scene.ts";

const DAMAGE = 2;
/** A second damage of the same size inside the first ten ticks is ignored (the hurt window the mobs have too): the 3 s wait of the first run saw no event. */
const HURT_WINDOW_TICKS = 10;
/** Natural regeneration heals a point every 10 ticks at full food (not modelled by the fake): a read a tick late may show it. */
const REGENERATED = 1;
/** Notchian velocity is 1/8000 of a block per tick. */
const VELOCITY_UNIT = 8_000;
const KNOCKBACK_SIDEWAYS = 0.4;
const KNOCKBACK_TOLERANCE = 0.05;

interface VelocityPacket {
  readonly entityId: number;
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number };
}
type Listening = { on(event: string, listener: (packet: never) => void): void; off(event: string, listener: (packet: never) => void): void };

/** The four fields the check states (the packet also holds a `sourcePosition`, undefined for these sources). */
function fieldsOf({ entityId, sourceTypeId, sourceCauseId, sourceDirectId }: DamageEvent): DamageEvent {
  return { entityId, sourceTypeId, sourceCauseId, sourceDirectId };
}

export const damageEventToBot: ContractCheck = {
  name: "damage-event-to-bot",
  fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5], timeOfDay: NIGHT, entities: [{ name: "zombie", position: [2.5, -60, 0.5], nbt: STILL_MOB_NBT }] },
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const zombie: Entity = await mobAt(subject, "zombie", 2.5, 0.5);
    const events: DamageEvent[] = [];
    const velocities: VelocityPacket[] = [];
    const hurts: { entity: Entity; source: Entity | undefined }[] = [];
    let healthEvents = 0;
    const onDamage = (event: DamageEvent) => void events.push(event);
    const onVelocity = (packet: VelocityPacket) => void (packet.entityId === bot.entity.id && velocities.push(packet));
    const onHurt = (entity: Entity, source?: Entity) => void hurts.push({ entity, source });
    const onHealth = () => void (healthEvents += 1);
    const client = bot._client as unknown as Listening;
    client.on("damage_event", onDamage);
    client.on("entity_velocity", onVelocity);
    bot.on("entityHurt", onHurt);
    bot.on("health", onHealth);
    try {
      await subject.hurtBot(DAMAGE, zombie.id);
      assert.ok(await holdsWithin(subject, () => bot.health <= 20 - DAMAGE + REGENERATED, ANSWER_WALL_MS), `health is ${bot.health} after ${DAMAGE} damage`);
      assert.ok(bot.health >= 20 - DAMAGE, `health is ${bot.health}, below ${20 - DAMAGE}`);
      assert.equal(events.length, 1);
      assert.deepEqual(fieldsOf(events[0]!), { entityId: bot.entity.id, sourceTypeId: damageTypeId(bot.registry, "mob_attack"), sourceCauseId: zombie.id + 1, sourceDirectId: zombie.id + 1 });
      assert.deepEqual(hurts, [{ entity: bot.entity, source: zombie }], "entityHurt names the bot and the zombie");
      assert.ok(healthEvents >= 1, "no health update");
      const knock = velocities[0];
      assert.ok(knock !== undefined, "no knockback velocity");
      const sideways = knock.velocity.x / VELOCITY_UNIT;
      assert.ok(Math.abs(sideways + KNOCKBACK_SIDEWAYS) < KNOCKBACK_TOLERANCE && Math.abs(knock.velocity.z) / VELOCITY_UNIT < KNOCKBACK_TOLERANCE, `the knockback is ${JSON.stringify(knock.velocity)}, not ${KNOCKBACK_SIDEWAYS} away from the zombie`);

      events.length = 0;
      hurts.length = 0;
      healthEvents = 0;
      // The first damage's answers all came (health, hurt, velocity: the same tick); the window is server ticks, not a wall time.
      await afterServerTicks(subject, HURT_WINDOW_TICKS, "the hurt window");
      await subject.hurtBot(DAMAGE, null);
      await answerArrives(subject, () => events.length >= 1 && hurts.length >= 1, "the second damage sent no damage_event or entityHurt");
      assert.deepEqual(events.map(fieldsOf), [{ entityId: bot.entity.id, sourceTypeId: damageTypeId(bot.registry, "generic"), sourceCauseId: 0, sourceDirectId: 0 }]);
      assert.deepEqual(hurts, [{ entity: bot.entity, source: undefined }]);
      await answerArrives(subject, () => healthEvents >= 1, "the second damage sent no health update");
    } finally {
      client.off("damage_event", onDamage);
      client.off("entity_velocity", onVelocity);
      bot.off("entityHurt", onHurt);
      bot.off("health", onHealth);
    }
  },
};
