/**
 * What the bot hears of a projectile that a mob shot and that hits her (Mine Labs 1.21.4, 2026-10-24, 3 runs; a NoAI skeleton 4 blocks
 * off and a NoAI blaze on the other side, the difficulty easy; the projectile summoned with its `Owner` 3 blocks from her flying at
 * her chest, an arrow at 1.6 blocks a tick, a small fireball at 1). The client first hears the projectile spawn (`entitySpawn`), 1 to
 * 3 ticks later the hit: one `damage_event` of type `arrow` or `fireball` whose cause is the shooter (id + 1) and whose direct source is the
 * projectile (id + 1), then the projectile is gone (`entityGone`, the same tick) and `update_health` follows with the easy-scaled damage (an
 * arrow of a skeleton 3, a small fireball 3.5). A tick later the bot is pushed: `entity_velocity` away from where the projectile came
 * from, 0.4 sideways and 0.3608 up (a hit on the ground) after one tick of the server's own physics on her (x 0.4 * 0.546 = 0.2184,
 * y (0.3608 - 0.08) * 0.98 = 0.2752). A fireball also sets her on fire (the flags' bit 0, before the `damage_event`): she takes 1 of
 * `on_fire` damage (no source) at 1, 2, 3 and 4 s after the hit and the flag clears at 5 s. An arrow sets no fire.
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import type { ContractSubject, ProjectileName } from "../subject.ts";
import { type DamageEvent, type HealthPacket, NIGHT, STILL_MOB_NBT, TICK_MS, burning, damageTypeId, mobAt } from "./combat-scene.ts";
import { type PacketLog, logPackets } from "./packet-log.ts";

/** One tick of the server's physics on a player knocked up from the ground: horizontal friction 0.91 * 0.6, then gravity and drag. */
const PUSH_SIDEWAYS = 0.4 * 0.546;
const PUSH_UP = (0.3608 - 0.08) * 0.98;
const VELOCITY_UNIT = 8_000;
const PUSH_TOLERANCE = 0.01;
const LOSS_TOLERANCE = 0.05;
/** Natural regeneration heals 1 every 10 ticks and its `update_health` can share the hit's tick: the packet before the hit then lacks it, and the hit looks 1 cheaper (the fake has no regeneration). */
const REGENERATED_IN_THE_TICK = 1;
/** The hit follows the spawn by 1 to 3 ticks from 3 blocks (a tick of jitter either way; a server behind on a shared host stretches it: 317 ms seen under 12 lanes). */
const FLIGHT_MS = { min: TICK_MS - 40, max: 10 * TICK_MS } as const;
const HIT_SETTLE_MS = 400;
const BURN_AT_MS = [1_000, 2_000, 3_000, 4_000];
const BURN_JITTER_MS = 150;
const FIRE_OUT_MS = 5_000;
const FIRE_OUT_JITTER_MS = 300;

/** The two shooters: a skeleton on the east (+x) and a blaze on the west, and what each one's projectile does. */
const CASES: readonly { readonly projectile: ProjectileName; readonly shooter: string; readonly x: number; readonly loss: number; readonly damageType: string; readonly fire: boolean }[] = [
  { projectile: "arrow", shooter: "skeleton", x: 4.5, loss: 3, damageType: "arrow", fire: false },
  { projectile: "small_fireball", shooter: "blaze", x: -4.5, loss: 3.5, damageType: "fireball", fire: true },
];

export const projectileHitBot: ContractCheck = {
  name: "projectile-hit-bot",
  fixture: {
    cells: {},
    carried: {},
    position: [0.5, -60, 0.5],
    timeOfDay: NIGHT,
    difficulty: "easy",
    entities: CASES.map(({ shooter, x }) => ({ name: shooter, position: [x, -60, 0.5] as const, nbt: STILL_MOB_NBT })),
  },
  withoutRuntime: true,
  exclusive: "a small fireball that missed the bot could set a fire in another lane's arena, which a shared server's lanes would all see",
  async run(subject) {
    const { bot } = subject;
    const shooters = await Promise.all(CASES.map(({ shooter, x }) => mobAt(subject, shooter, x, 0.5)));
    for (const [index, { projectile, loss, damageType, fire, x }] of CASES.entries()) {
      const shooter = shooters[index]!;
      const log = logPackets(subject, ["damage_event", "update_health", "entity_velocity"]);
      const spawned: { entity: Entity; atMs: number }[] = [];
      const gone: { entity: Entity; atMs: number }[] = [];
      const onSpawn = (entity: Entity) => void (entity.name === projectile && spawned.push({ entity, atMs: log.sinceStartMs() }));
      const onGone = (entity: Entity) => void (entity.name === projectile && gone.push({ entity, atMs: log.sinceStartMs() }));
      bot.on("entitySpawn", onSpawn);
      bot.on("entityGone", onGone);
      try {
        assert.equal(burning(bot), false, "the bot burns before the shot");
        const healthBefore = bot.health;
        await subject.shootBot(projectile, shooter.id);
        await subject.wait(HIT_SETTLE_MS);
        assert.equal(spawned.length, 1, `${projectile}: one projectile heard spawning`);
        const flying = spawned[0]!;
        const damage = log.packets.filter(({ name, packet }) => name === "damage_event" && packet.entityId === bot.entity.id);
        assert.equal(damage.length, 1, `${projectile}: one damage_event for the bot`);
        const event = damage[0]!.packet as unknown as DamageEvent;
        const hitAtMs = damage[0]!.atMs;
        assert.deepEqual(
          { type: event.sourceTypeId, cause: event.sourceCauseId, direct: event.sourceDirectId },
          { type: damageTypeId(bot.registry, damageType), cause: shooter.id + 1, direct: flying.entity.id + 1 },
          `${projectile}: the damage_event names the damage type, the shooter as cause and the projectile as direct source`,
        );
        const flight = hitAtMs - flying.atMs;
        assert.ok(flight >= FLIGHT_MS.min && flight <= FLIGHT_MS.max, `${projectile}: the hit came ${flight} ms after the spawn, not ${FLIGHT_MS.min} to ${FLIGHT_MS.max}`);
        assert.equal(gone.length, 1, `${projectile}: the projectile is gone after the hit`);
        assert.ok(Math.abs(gone[0]!.atMs - hitAtMs) <= TICK_MS * 2, `${projectile}: it left ${gone[0]!.atMs - hitAtMs} ms after the hit`);
        const told = log.packets.find(({ name, atMs }) => name === "update_health" && atMs >= hitAtMs);
        assert.ok(told !== undefined, `${projectile}: no update_health after the hit`);
        const previous = log.packets.filter(({ name, atMs }) => name === "update_health" && atMs < hitAtMs).at(-1);
        const lost = (previous === undefined ? healthBefore : (previous.packet as unknown as HealthPacket).health) - (told.packet as unknown as HealthPacket).health;
        assert.ok(lost >= loss - REGENERATED_IN_THE_TICK - LOSS_TOLERANCE && lost <= loss + LOSS_TOLERANCE, `${projectile}: the hit cost ${lost}, not ${loss} (or ${loss - REGENERATED_IN_THE_TICK} with a regeneration in its tick)`);
        const push = log.packets.find(({ name, atMs, packet }) => name === "entity_velocity" && packet.entityId === bot.entity.id && atMs >= hitAtMs);
        assert.ok(push !== undefined, `${projectile}: no push`);
        const velocity = push.packet.velocity as { x: number; y: number; z: number };
        const awayFromShooter = Math.sign(0.5 - x);
        assert.ok(
          Math.abs(velocity.x / VELOCITY_UNIT - awayFromShooter * PUSH_SIDEWAYS) <= PUSH_TOLERANCE && Math.abs(velocity.y / VELOCITY_UNIT - PUSH_UP) <= PUSH_TOLERANCE && Math.abs(velocity.z) / VELOCITY_UNIT <= PUSH_TOLERANCE,
          `${projectile}: the push is ${JSON.stringify(velocity)}, not x ${awayFromShooter * PUSH_SIDEWAYS * VELOCITY_UNIT} y ${PUSH_UP * VELOCITY_UNIT}`,
        );
        assert.ok(push.atMs - hitAtMs <= TICK_MS * 3, `${projectile}: the push came ${push.atMs - hitAtMs} ms after the hit`);
        assert.equal(burning(bot), fire, `${projectile}: ${fire ? "no fire" : "fire"} on the bot after the hit`);
        if (fire) await assertBurns(subject, log, hitAtMs);
        await subject.wait(HIT_SETTLE_MS * 2);
      } finally {
        bot.off("entitySpawn", onSpawn);
        bot.off("entityGone", onGone);
        log.stop();
      }
    }
  },
};

/** The four `on_fire` hurts at whole seconds after the hit (a source of none; each costs 1, measured 18.5 to 17.5 four times, but a regeneration can share its tick, so the amount is not asserted), and the flag out at 5 s. */
async function assertBurns(subject: ContractSubject, log: PacketLog, hitAtMs: number): Promise<void> {
  const { bot } = subject;
  await subject.wait(hitAtMs + FIRE_OUT_MS + FIRE_OUT_JITTER_MS - log.sinceStartMs());
  const onFire = damageTypeId(bot.registry, "on_fire");
  const burns = log.packets.filter(({ name, packet }) => name === "damage_event" && packet.entityId === bot.entity.id && (packet as unknown as DamageEvent).sourceTypeId === onFire);
  assert.equal(burns.length, BURN_AT_MS.length, `${burns.length} on_fire hurts after a fireball, at ${burns.map(({ atMs }) => atMs - hitAtMs).join(", ")} ms: ${BURN_AT_MS.length} at ${BURN_AT_MS.join(", ")} expected`);
  burns.forEach(({ atMs, packet }, index) => {
    assert.ok(Math.abs(atMs - hitAtMs - BURN_AT_MS[index]!) <= BURN_JITTER_MS, `burn ${index + 1} came ${atMs - hitAtMs} ms after the hit, not ${BURN_AT_MS[index]}`);
    const event = packet as unknown as DamageEvent;
    assert.equal(event.sourceCauseId + event.sourceDirectId, 0, "a burn names no source");
  });
  assert.equal(burning(bot), false, "the fire is still on the bot 5 s after the hit");
}
