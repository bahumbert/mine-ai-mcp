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
 *
 * The gaps are judged by the server's ticks, each read with `time query gametime` when the client heard the event, and the burns from the read sent right before the shot (`server-tick-marks.ts`):
 * a server behind its schedule or one that stalled and caught up holds a different number of ticks in a second of wall time.
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { ANSWER_WALL_MS, answerSettled, serverQuiet } from "../server-answer.ts";
import { type ContractSubject, type ProjectileName, holdsWithin } from "../subject.ts";
import { type DamageEvent, type HealthPacket, NIGHT, STILL_MOB_NBT, TICK_MS, burning, damageTypeId, mobAt } from "./combat-scene.ts";
import { type LoggedPacket, type PacketLog, logPackets } from "./packet-log.ts";
import { type Mark, READING_TICKS, markNow, tickOf } from "./server-tick-marks.ts";

/** One tick of the server's physics on a player knocked up from the ground: horizontal friction 0.91 * 0.6, then gravity and drag. */
const PUSH_SIDEWAYS = 0.4 * 0.546;
const PUSH_UP = (0.3608 - 0.08) * 0.98;
const VELOCITY_UNIT = 8_000;
const PUSH_TOLERANCE = 0.01;
const LOSS_TOLERANCE = 0.05;
/** Natural regeneration heals 1 every 10 ticks and its `update_health` can share the hit's tick: the packet before the hit then lacks it, and the hit looks 1 cheaper (the fake has no regeneration). */
const REGENERATED_IN_THE_TICK = 1;
/** The hit follows the spawn by 1 to 3 ticks from 3 blocks; 10 is a server's jitter and the client's lag, as the wait of the old 500 ms (a server behind on a shared host stretched it to 317 ms under 12 lanes). */
const FLIGHT_MAX_TICKS = 10;
/** The projectile leaves in the hit's tick and the push comes a tick later (the old wall bounds, 2 and 3 ticks of 50 ms, read in server ticks). */
const GONE_APART_TICKS = 2;
const PUSH_APART_TICKS = 3;
/** The hit is at least a tick after the shot (the projectile has to fly), the fire's first hurt 20 ticks after the hit and one every 20 after: 4 hurts, the flag out at the 100th tick. */
const FLIGHT_MIN_TICKS = 1;
const BURN_EVERY_TICKS = 20;
const BURNS = 4;
/** The wall bound of the fire: 100 ticks and the flight, with a server at 10 ticks a second. Over the 10 s of `ANSWER_WALL_MS` on purpose: the fire is no single answer. */
const FIRE_OUT_WALL_MS = 15_000;
/** A burn is heard late by the client's lag, and the read of it with it; late is not the game: the readings may differ by the ticks the answer wait's wall bound holds. */
const HEARD_LATE_TICKS = ANSWER_WALL_MS / TICK_MS;
/** Two burns are 20 ticks apart whatever the client's lag, both reads being late by the same lag: the difference of their reads is off by the two readings' error and the tick or two of a lag that changed between them. */
const BURN_SPACING_SLACK_TICKS = 2 * READING_TICKS + 2;

/** The two shooters: a skeleton on the east (+x) and a blaze on the west, and what each one's projectile does. */
const CASES: readonly { readonly projectile: ProjectileName; readonly shooter: string; readonly x: number; readonly loss: number; readonly damageType: string; readonly fire: boolean }[] = [
  { projectile: "arrow", shooter: "skeleton", x: 4.5, loss: 3, damageType: "arrow", fire: false },
  { projectile: "small_fireball", shooter: "blaze", x: -4.5, loss: 3.5, damageType: "fireball", fire: true },
];

/** An entity the client heard appear or leave, and the server's tick then. */
interface HeardEntity {
  readonly entity: Entity;
  readonly heardAt: Mark;
}

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
      const log = logPackets(subject, ["damage_event", "update_health", "entity_velocity"], ["damage_event", "entity_velocity"]);
      const spawned: HeardEntity[] = [];
      const gone: HeardEntity[] = [];
      const onSpawn = (entity: Entity) => void (entity.name === projectile && spawned.push({ entity, heardAt: markNow(subject) }));
      const onGone = (entity: Entity) => void (entity.name === projectile && gone.push({ entity, heardAt: markNow(subject) }));
      bot.on("entitySpawn", onSpawn);
      bot.on("entityGone", onGone);
      try {
        assert.equal(burning(bot), false, "the bot burns before the shot");
        const healthBefore = bot.health;
        const shot = markNow(subject);
        await subject.shootBot(projectile, shooter.id);
        await awaitHitAnswer(subject, log, gone, projectile);
        assert.equal(spawned.length, 1, `${projectile}: one projectile heard spawning`);
        const flying = spawned[0]!;
        // A fireball's fire hurts her too (`on_fire`, 1 s on): only the projectile's own damage type is the hit.
        const hitType = damageTypeId(bot.registry, damageType);
        const damage = log.packets.filter(({ name, packet }) => name === "damage_event" && packet.entityId === bot.entity.id && (packet as unknown as DamageEvent).sourceTypeId === hitType);
        assert.equal(damage.length, 1, `${projectile}: one ${damageType} damage_event for the bot`);
        const event = damage[0]!.packet as unknown as DamageEvent;
        const hitAtMs = damage[0]!.atMs;
        assert.deepEqual(
          { type: event.sourceTypeId, cause: event.sourceCauseId, direct: event.sourceDirectId },
          { type: damageTypeId(bot.registry, damageType), cause: shooter.id + 1, direct: flying.entity.id + 1 },
          `${projectile}: the damage_event names the damage type, the shooter as cause and the projectile as direct source`,
        );
        assert.equal(gone.length, 1, `${projectile}: the projectile is gone after the hit`);
        // The log's own clock only orders the packets here: the gaps between them are the server's ticks (`assertHitTicks`).
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
        await assertHitTicks(subject, projectile, { spawn: flying.heardAt, hit: damage[0]!.heardAt!, gone: gone[0]!.heardAt, push: push.heardAt! });
        assert.equal(burning(bot), fire, `${projectile}: ${fire ? "no fire" : "fire"} on the bot after the hit`);
        if (fire) await assertBurns(subject, log, shot, projectile);
      } finally {
        bot.off("entitySpawn", onSpawn);
        bot.off("entityGone", onGone);
        log.stop();
      }
    }
  },
};

/** The server's tick as the client heard each event of one hit: the spawn, the `damage_event`, the removal and the push. */
interface HitHearings {
  readonly spawn: Mark;
  readonly hit: Mark;
  readonly gone: Mark;
  readonly push: Mark;
}

/**
 * The hit follows the spawn within `FLIGHT_MAX_TICKS`, the projectile is gone in the hit's tick and the push comes within `PUSH_APART_TICKS`:
 * ticks the server ran between the readings of each hearing (heard in order, so never negative), where a wall gap would count a stalled
 * server's catch-up as no time and a slow server's few ticks as many.
 */
async function assertHitTicks(subject: ContractSubject, projectile: ProjectileName, hearings: HitHearings): Promise<void> {
  const [spawn, hit, gone, push] = await Promise.all([hearings.spawn, hearings.hit, hearings.gone, hearings.push].map((mark) => tickOf(subject, mark)));
  const readings = `server ticks read at the spawn ${spawn}, the hit ${hit}, the removal ${gone}, the push ${push}`;
  assert.ok(hit - spawn >= 0 && hit - spawn <= FLIGHT_MAX_TICKS, `${projectile}: the hit came ${hit - spawn} server ticks after the spawn, not 0 to ${FLIGHT_MAX_TICKS} (${readings})`);
  assert.ok(Math.abs(gone - hit) <= GONE_APART_TICKS, `${projectile}: it left ${gone - hit} server ticks after the hit, not within ${GONE_APART_TICKS} (${readings})`);
  assert.ok(push - hit >= 0 && push - hit <= PUSH_APART_TICKS, `${projectile}: the push came ${push - hit} server ticks after the hit, not 0 to ${PUSH_APART_TICKS} (${readings})`);
}

/**
 * The shot's answer, awaited and then seen to be the only one: the projectile gone, the `update_health` and the push after the hit
 * (the awaited values), then the server runs on (`serverQuiet`) so a second spawn, hit or removal would have been heard, and past the 10 ticks of the bot's hurt window for the next shot.
 */
async function awaitHitAnswer(subject: ContractSubject, log: PacketLog, gone: readonly unknown[], projectile: ProjectileName): Promise<void> {
  const { bot } = subject;
  const hitAt = () => log.packets.find(({ name, packet }) => name === "damage_event" && packet.entityId === bot.entity.id)?.atMs;
  const heardSinceHit = (wanted: (heard: LoggedPacket) => boolean) => {
    const hit = hitAt();
    return hit !== undefined && log.packets.some((heard) => heard.atMs >= hit && wanted(heard));
  };
  const answered = () => gone.length > 0 && heardSinceHit(({ name }) => name === "update_health") && heardSinceHit(({ name, packet }) => name === "entity_velocity" && packet.entityId === bot.entity.id);
  await answerSettled(subject, answered, `${projectile}: the hit's answer (hit ${hitAt() !== undefined}, gone ${gone.length})`);
}

/**
 * The four `on_fire` hurts (a source of none; each costs 1, measured 18.5 to 17.5 four times, but a regeneration can share its tick, so the amount is not asserted) and the flag out:
 * awaited as the answer, then the server runs on so a fifth would have been heard. Each hurt is 20 ticks after the one before and the first 20 after the hit, which is at least
 * a tick after the shot: no burn is heard sooner than that many server ticks after the read sent right before the shot (never early: the late side is the client's lag),
 * and two burns are read 20 ticks apart give or take `BURN_SPACING_SLACK_TICKS`, which the lag does not widen: a fire that burns every 25 ticks is red.
 */
async function assertBurns(subject: ContractSubject, log: PacketLog, shot: Mark, projectile: ProjectileName): Promise<void> {
  const { bot } = subject;
  const onFire = damageTypeId(bot.registry, "on_fire");
  const burnsHeard = () => log.packets.filter(({ name, packet }) => name === "damage_event" && packet.entityId === bot.entity.id && (packet as unknown as DamageEvent).sourceTypeId === onFire);
  assert.ok(await holdsWithin(subject, () => burnsHeard().length >= BURNS && !burning(bot), FIRE_OUT_WALL_MS), `${projectile}: ${burnsHeard().length} on_fire hurts and ${burning(bot) ? "the fire still on" : "the fire out"} after ${FIRE_OUT_WALL_MS} ms`);
  await serverQuiet(subject, `${projectile}: after the fire`);
  const burns = burnsHeard();
  assert.equal(burns.length, BURNS, `${projectile}: ${burns.length} on_fire hurts after a fireball, ${BURNS} expected`);
  const shotTick = await tickOf(subject, shot);
  let previousBurn: number | undefined;
  for (const [index, { heardAt, packet }] of burns.entries()) {
    const heardTick = await tickOf(subject, heardAt!);
    const earliest = BURN_EVERY_TICKS * (index + 1) + FLIGHT_MIN_TICKS - READING_TICKS;
    const latest = BURN_EVERY_TICKS * (index + 1) + FLIGHT_MAX_TICKS + READING_TICKS + HEARD_LATE_TICKS;
    const afterShot = heardTick - shotTick;
    assert.ok(afterShot >= earliest && afterShot <= latest, `${projectile}: burn ${index + 1} heard at server tick ${heardTick}, ${afterShot} ticks after the shot at tick ${shotTick}: the burn is ${BURN_EVERY_TICKS * (index + 1)} ticks after the hit, so not less than ${earliest} (readings +-${READING_TICKS}) and not more than ${latest}`);
    if (previousBurn !== undefined) {
      const apart = heardTick - previousBurn;
      assert.ok(Math.abs(apart - BURN_EVERY_TICKS) <= BURN_SPACING_SLACK_TICKS, `${projectile}: burn ${index + 1} heard at server tick ${heardTick}, ${apart} ticks after burn ${index} at tick ${previousBurn}: the fire burns every ${BURN_EVERY_TICKS} ticks, so not less than ${BURN_EVERY_TICKS - BURN_SPACING_SLACK_TICKS} and not more than ${BURN_EVERY_TICKS + BURN_SPACING_SLACK_TICKS} (readings +-${READING_TICKS})`);
    }
    previousBurn = heardTick;
    const event = packet as unknown as DamageEvent;
    assert.equal(event.sourceCauseId + event.sourceDirectId, 0, "a burn names no source");
  }
  assert.equal(burning(bot), false, "the fire is still on the bot after the hurts");
}
