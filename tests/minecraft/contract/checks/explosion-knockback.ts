/**
 * A creeper blowing up 5 blocks from the bot (Mine Labs 1.21.4, 2026-10-23, 3 runs; the explosion's power 3, so it reaches
 * 6 blocks): the `explosion` packet carries the bot's knockback, the push away from the blast of the vanilla rule
 * `(1 - distance / 6)` along the line from the blast to her eye; `damage_event` (type `player_explosion`: the creeper targets a player; cause the creeper) and
 * her health lowered by the easy-scaled `(d * d + d) / 2 * 42 + 1` for that `d` (a float; the fixture sets easy: an unset world gave 2.54); the creeper is removed. The check runs with no block
 * broken (`mobGriefing` off in the subject): the fake models no crater.
 */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { answerArrives, answerSettled } from "../server-answer.ts";
import { type DamageEvent, type PacketListening, damageTypeId } from "./combat-scene.ts";

/** Arena-local; `subject.world` puts it in the lane. */
const BLAST_LOCAL = [-4.5, -60, 0.5] as const;
const REACH = 6;
const KNOCKBACK_TOLERANCE = 0.02;
const EYE_HEIGHT = 1.62;
/** On easy the blast costs `min(raw / 2 + 1, raw)` of `raw = (d * d + d) / 2 * 42 + 1` (3.54 for 5.08 at 5 blocks, a float). */
const easy = (raw: number) => Math.min(raw / 2 + 1, raw);
const LOSS_TOLERANCE = 0.2;

interface ExplosionPacket {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly playerKnockback?: { readonly x: number; readonly y: number; readonly z: number };
}

export const explosionKnockback: ContractCheck = {
  name: "explosion-knockback",
  fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5], difficulty: "easy" },
  withoutRuntime: true,
  exclusive: "the subject turns the mobGriefing game rule off around the creeper (a server-wide rule) so no crater leaves the arena",
  async run(subject) {
    const { bot } = subject;
    const blast = subject.world(BLAST_LOCAL);
    const packets: ExplosionPacket[] = [];
    const hurts: { entity: Entity; source: Entity | undefined }[] = [];
    const gone: Entity[] = [];
    const onExplosion = (packet: ExplosionPacket) => void packets.push(packet);
    const onHurt = (entity: Entity, source?: Entity) => void hurts.push({ entity, source });
    const onGone = (entity: Entity) => void gone.push(entity);
    const damage: DamageEvent[] = [];
    const onDamage = (event: DamageEvent) => void (event.entityId === bot.entity.id && damage.push(event));
    const client = bot._client as unknown as PacketListening;
    client.on("damage_event", onDamage);
    client.on("explosion", onExplosion);
    bot.on("entityHurt", onHurt);
    bot.on("entityGone", onGone);
    try {
      const feet = bot.entity.position.clone();
      await subject.explode(blast);
      await answerArrives(subject, () => bot.health < 20, "the blast did not hurt the bot");
      const lost = 20 - bot.health;
      // The rest of the answer (the packet, the hurt, the damage event, the creeper's removal) comes in the same tick or the next; each is awaited, then the server runs on to show there is no second one.
      const answered = () => packets.length > 0 && hurts.some(({ entity }) => entity === bot.entity) && damage.length > 0 && gone.some((entity) => entity.name === "creeper");
      await answerSettled(subject, answered, `the blast's answer (${packets.length} packets, ${hurts.length} hurts, ${damage.length} damage events, ${gone.length} removals)`);
      assert.equal(packets.length, 1, "one explosion packet");
      const packet = packets[0]!;
      assert.ok(blast.distanceTo(new Vec3(packet.x, packet.y, packet.z)) < 0.1, `the explosion is at ${packet.x} ${packet.y} ${packet.z}, not ${blast}`);
      const strength = 1 - blast.distanceTo(feet) / REACH;
      const expected = feet.offset(0, EYE_HEIGHT, 0).minus(blast).normalize().scaled(strength);
      const knock = packet.playerKnockback;
      assert.ok(knock !== undefined && Math.hypot(knock.x - expected.x, knock.y - expected.y, knock.z - expected.z) < KNOCKBACK_TOLERANCE, `the knockback is ${JSON.stringify(knock)}, not ${expected} (strength ${strength.toFixed(3)})`);
      const expectedLoss = easy(((strength * strength + strength) / 2) * 42 + 1);
      assert.ok(Math.abs(lost - expectedLoss) <= LOSS_TOLERANCE, `the bot lost ${lost}, not ${expectedLoss}`);
      const botHurt = hurts.filter(({ entity }) => entity === bot.entity);
      assert.equal(botHurt.length, 1, "one hurt for the bot");
      assert.equal(botHurt[0]!.source?.name, "creeper", "the hurt names the creeper");
      assert.equal(damage.length, 1);
      assert.equal(damage[0]!.sourceTypeId, damageTypeId(bot.registry, "player_explosion"), "the blast's damage type");
      assert.equal(damage[0]!.sourceCauseId, botHurt[0]!.source!.id + 1);
      assert.ok(gone.some((entity) => entity.name === "creeper"), "the creeper is still on the client");
    } finally {
      client.off("explosion", onExplosion);
      client.off("damage_event", onDamage);
      bot.off("entityHurt", onHurt);
      bot.off("entityGone", onGone);
    }
  },
};
