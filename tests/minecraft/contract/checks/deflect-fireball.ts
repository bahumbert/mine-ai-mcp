/**
 * A ghast's fireball hit by hand in reach and out of reach (Mine Labs 1.21.4, 2026-10-24, 3 runs; no ghast: a NoAI ghast never shoots,
 * so the fireball is summoned with `acceleration_power` 0.02 and a `Motion` of 0.2 a tick at the bot, from 8 blocks off and from 4).
 * The ball's velocity follows `v = 0.95 * (v + power)` a tick (0.2 at the start, 0.272 after 10 ticks, 0.315 after 20: `0.38 - 0.18 *
 * 0.95^n`). The client hears little of it: a position packet of zero a tick after it appears, then its velocity with a relative
 * move (`entity_move_look`, the delta in 1/4096 of a block) at its 2nd tick, at the 10th and every 10th after. A hit out of reach does
 * nothing: the ball flies on, reaches her at about 1.3 s and hurts her (`damage_event` of type `unattributed_fireball`, the ball the cause and
 * direct source, 6 whatever the difficulty: it has no living owner to scale it), then an `explosion` packet and the ball is destroyed in the same tick. A hit in reach sets
 * the ball flying along the way she looks, 1 block a tick and an acceleration of 0.1 (`v = 1.9 - 0.9 * 0.95^n`): within a tick the client
 * hears its velocity, then a position packet of zero, then the regular ones; it flies away and no packet names an owner. The check runs
 * with no block broken (`mobGriefing` off in the subject while a ball flies): the fake models no crater, and a ball that is not
 * removed flies on into other lanes, so the subject removes them after.
 *
 * The update gaps and the first update's delay are asserted in wall milliseconds: the packets carry no world age (the age comes one
 * packet per 20 ticks, too coarse for a 10-tick gap), so ticks cannot stand in for them. That is sound only on a server no other lane
 * stalls (a lane's `clone` freezes the server thread 0.16-0.9 s and the catch-up ticks then run back to back), so the check stays
 * `exclusive` (its own server, run under the calm rule) and keeps its wall intervals for that reason too.
 * Every other wait here is for a packet that arrives, the client's own physics ticks, or server ticks before an absence.
 */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { ANSWER_WALL_MS, afterClientTicks, answerArrives, serverQuiet } from "../server-answer.ts";
import { holdsWithin } from "../subject.ts";
import { type DamageEvent, type HealthPacket, TICK_MS, damageTypeId } from "./combat-scene.ts";
import { type LoggedPacket, type PacketLog, logPackets } from "./packet-log.ts";

const NAMES = ["entity_velocity", "rel_entity_move", "entity_move_look", "sync_entity_position", "entity_metadata", "explosion", "damage_event", "update_health"];
const VELOCITY_UNIT = 8_000;
const POSITION_UNIT = 4_096;
const LAUNCH_SPEED = 0.2;
const OUT_OF_REACH_BLOCKS = 8;
const IN_REACH_BLOCKS = 4;
/** The updates follow each other by 10 ticks (the first by 8: a tick of jitter either way). */
const UPDATE_GAP_MS = { min: 8 * TICK_MS - 60, max: 10 * TICK_MS + 100 } as const;
const FIRST_UPDATE_MS = { min: TICK_MS, max: 5 * TICK_MS } as const;
const SPEED_TOLERANCE = 0.012;
const DEFLECT_VELOCITY_TOLERANCE = 0.01;
const FLOWN_AWAY_BLOCKS = 15;
/** The spawn tells the ball's velocity in the packets that come with it, a few ms after the client has the entity. */
const SPAWN_PACKETS_MS = 20;
/** A fireball's `entity_metadata` holds the item it shows (key 8) and its entity flags (key 0: it burns); nothing else is sent of it. */
const SENT_KEYS = [0, 8];
const HIT_COST = 6;
const COST_TOLERANCE = 0.1;
/** Natural regeneration heals 1 every 10 ticks and its `update_health` can share the hit's tick: the packet before the hit then lacks it, and the hit looks 1 cheaper. */
const REGENERATED_IN_THE_TICK = 1;
const DAMAGE_TO_EXPLOSION_MS = TICK_MS * 2;
/** A forced look is sent by the client's next physics tick; two make sure it went out, and the server reads packets in order, so the hit that follows has the look. */
const LOOK_SENT_CLIENT_TICKS = 2;
/** The client's physics ticks the bot's knockback from the blast takes to end (the 500 ms this was). */
const KNOCKBACK_CLIENT_TICKS = 10;

/** The ball's speed `ticks` ticks after a start at `speed`: `v = (v + power) * 0.95`, steady at `power * 0.95 / 0.05`. */
function speedAfter(ticks: number, speed: number, power: number): number {
  const steady = (power * 0.95) / 0.05;
  return steady - (steady - speed) * 0.95 ** ticks;
}

/** Whether `measured` is the flight's speed for the ticks the clock says passed, a tick more or less (the jitter of a wall clock). */
function followsFlight(measured: number, elapsedMs: number, speed: number, power: number): boolean {
  const ticks = Math.round(elapsedMs / TICK_MS);
  return [-1, 0, 1, 2].some((offset) => Math.abs(measured - speedAfter(Math.max(0, ticks + offset), speed, power)) <= SPEED_TOLERANCE * Math.max(1, speedAfter(ticks + offset, speed, power)));
}

/** The updates of `ball` after `fromMs` on the log: its velocity and the blocks the position packet with it moved it along x (0 for none). The spawn tells the velocity too, at once. */
function updatesOf(log: PacketLog, ball: Entity, fromMs: number): { atMs: number; speed: number; moved: number }[] {
  return log.packets
    .filter(({ name, atMs, packet }) => name === "entity_velocity" && packet.entityId === ball.id && atMs > fromMs)
    .map(({ atMs, packet }) => {
      const velocity = packet.velocity as { x: number; y: number; z: number };
      const move = log.packets.find(({ name, atMs: at, packet: other }) => at >= atMs && at <= atMs + 20 && other.entityId === ball.id && (name === "entity_move_look" || name === "sync_entity_position"));
      return { atMs, speed: Math.hypot(velocity.x, velocity.y, velocity.z) / VELOCITY_UNIT, moved: move === undefined ? 0 : movedBlocks(move) };
    });
}

/** The blocks a position packet moves the ball by along x (a relative move's delta, or an absolute one's x). */
function movedBlocks({ name, packet }: LoggedPacket): number {
  return name === "entity_move_look" ? (packet.dX as number) / POSITION_UNIT : (packet.x as number);
}

export const deflectFireball: ContractCheck = {
  name: "deflect-fireball",
  fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5], difficulty: "easy" },
  withoutRuntime: true,
  exclusive: "the ball's blast must break no block, so the subject turns the mobGriefing game rule off (a server-wide rule) while a fireball flies; a ball that is missed flies on into other lanes; and the check asserts the ball's update gaps in wall ms, which another lane's clone stall would break",
  async run(subject) {
    try {
      await hitOutOfReach(subject);
      await hitInReach(subject);
    } finally {
      await subject.clearFireballs();
    }
  },
};

async function hitOutOfReach(subject: Parameters<ContractCheck["run"]>[0]): Promise<void> {
  const { bot } = subject;
  const feet = bot.entity.position.clone();
  await bot.lookAt(feet.offset(5, 1.62, 0), true);
  await afterClientTicks(subject, LOOK_SENT_CLIENT_TICKS, "the look sent");
  const healthBefore = bot.health;
  const log = logPackets(subject, NAMES);
  try {
    const ball = await subject.launchFireball(feet.offset(OUT_OF_REACH_BLOCKS, 0.9, 0), new Vec3(-LAUNCH_SPEED, 0, 0));
    const spawnedAtMs = log.sinceStartMs();
    bot.attack(ball);
    // A missed ball is destroyed at her: the server removes it on arrival.
    await answerArrives(subject, () => subject.bot.entities[ball.id] === undefined, "the ball that was out of reach never reached the bot");
    // The hit's packets came in the ball's last tick, before its removal; the wait is for the log to hold them, not for 4 ticks of wall time.
    await answerArrives(subject, () => hitAnswered(log, bot.entity.id), "the packets of the ball's hit on the bot");
    const zero = log.packets.find(({ name, packet }) => name === "rel_entity_move" && packet.entityId === ball.id);
    assert.ok(zero !== undefined && zero.packet.dX === 0 && zero.packet.dY === 0 && zero.packet.dZ === 0, "a move of zero comes first");
    const updates = updatesOf(log, ball, spawnedAtMs + SPAWN_PACKETS_MS);
    assert.ok(updates.length >= 3, `${updates.length} updates before it arrived: the first at a tick or two, then every 10 ticks`);
    assert.ok(updates[0]!.atMs - spawnedAtMs >= FIRST_UPDATE_MS.min && updates[0]!.atMs - spawnedAtMs <= FIRST_UPDATE_MS.max, `the first update came ${updates[0]!.atMs - spawnedAtMs} ms after the spawn`);
    updates.forEach(({ atMs, speed, moved }, index) => {
      assert.ok(followsFlight(speed, atMs - spawnedAtMs + TICK_MS / 2, LAUNCH_SPEED, 0.02), `update ${index + 1}: the speed ${speed} at ${atMs - spawnedAtMs} ms is not the flight's`);
      if (index > 0) {
        const gap = atMs - updates[index - 1]!.atMs;
        assert.ok(gap >= UPDATE_GAP_MS.min && gap <= UPDATE_GAP_MS.max, `update ${index + 1} came ${gap} ms after the one before`);
      }
      assert.ok(moved < 0, `update ${index + 1}: the ball did not move toward the bot (${moved})`);
    });
    const hits = log.packets.filter(({ name, packet }) => name === "damage_event" && packet.entityId === bot.entity.id);
    assert.equal(hits.length, 1, "one damage_event for the bot");
    const event = hits[0]!.packet as unknown as DamageEvent;
    assert.deepEqual({ type: event.sourceTypeId, cause: event.sourceCauseId, direct: event.sourceDirectId }, { type: damageTypeId(bot.registry, "unattributed_fireball"), cause: ball.id + 1, direct: ball.id + 1 }, "the fireball's hit names itself");
    const blast = log.packets.find(({ name }) => name === "explosion");
    assert.ok(blast !== undefined && blast.atMs - hits[0]!.atMs <= DAMAGE_TO_EXPLOSION_MS, "the explosion follows the hit in its tick");
    const told = log.packets.find(({ name, atMs }) => name === "update_health" && atMs >= hits[0]!.atMs);
    const previous = log.packets.filter(({ name, atMs }) => name === "update_health" && atMs < hits[0]!.atMs).at(-1);
    const lost = (previous === undefined ? healthBefore : (previous.packet as unknown as HealthPacket).health) - (told!.packet as unknown as HealthPacket).health;
    assert.ok(lost >= HIT_COST - REGENERATED_IN_THE_TICK - COST_TOLERANCE && lost <= HIT_COST + COST_TOLERANCE, `the ball cost ${lost}, not ${HIT_COST} (or ${HIT_COST - REGENERATED_IN_THE_TICK} with a regeneration in its tick)`);
  } finally {
    log.stop();
  }
  await afterClientTicks(subject, KNOCKBACK_CLIENT_TICKS, "the knockback of the blast");
}

/** Whether the log holds the bot's `damage_event`, an `explosion` and the `update_health` that came with the hit or after it. */
function hitAnswered(log: PacketLog, botId: number): boolean {
  const hit = log.packets.find(({ name, packet }) => name === "damage_event" && packet.entityId === botId);
  return hit !== undefined && log.packets.some(({ name }) => name === "explosion") && log.packets.some(({ name, atMs }) => name === "update_health" && atMs >= hit.atMs);
}

async function hitInReach(subject: Parameters<ContractCheck["run"]>[0]): Promise<void> {
  const { bot } = subject;
  const feet = bot.entity.position.clone();
  await bot.lookAt(feet.offset(5, 1.62, 0), true);
  await afterClientTicks(subject, LOOK_SENT_CLIENT_TICKS, "the look sent");
  const healthBefore = bot.health;
  const log = logPackets(subject, NAMES);
  try {
    const ball = await subject.launchFireball(feet.offset(IN_REACH_BLOCKS, 0.9, 0), new Vec3(-LAUNCH_SPEED, 0, 0));
    const startX = ball.position.x;
    const hitAtMs = log.sinceStartMs();
    bot.attack(ball);
    const ownPackets = () => log.packets.filter(({ packet }) => packet.entityId === ball.id);
    const deflectedOf = () => ownPackets().find(({ name, atMs, packet }) => name === "entity_velocity" && atMs >= hitAtMs && (packet.velocity as { x: number }).x > 0);
    // The ball is flown away once it was set flying and updated twice; the absences below (no owner, no hurt) are read after server ticks on top.
    await holdsWithin(subject, () => {
      const first = deflectedOf();
      return first !== undefined && updatesOf(log, ball, first.atMs).length >= 2 && ball.position.x - startX >= FLOWN_AWAY_BLOCKS;
    }, ANSWER_WALL_MS);
    await serverQuiet(subject, "after the ball flew away");
    const own = ownPackets();
    const deflected = deflectedOf();
    assert.ok(deflected !== undefined && deflected.atMs - hitAtMs <= TICK_MS * 3, `the ball's new velocity came ${deflected === undefined ? "never" : `${deflected.atMs - hitAtMs} ms after the hit`}`);
    const velocity = deflected.packet.velocity as { x: number; y: number; z: number };
    assert.ok(Math.abs(velocity.x / VELOCITY_UNIT - 1) <= DEFLECT_VELOCITY_TOLERANCE && Math.abs(velocity.y) / VELOCITY_UNIT <= DEFLECT_VELOCITY_TOLERANCE && Math.abs(velocity.z) / VELOCITY_UNIT <= DEFLECT_VELOCITY_TOLERANCE, `the deflected velocity ${JSON.stringify(velocity)} is not 1 along her look`);
    const still = own.find(({ name, atMs }) => name === "rel_entity_move" && atMs >= deflected.atMs && atMs <= deflected.atMs + TICK_MS);
    assert.ok(still !== undefined && still.packet.dX === 0 && still.packet.dZ === 0, "a move of zero follows the new velocity");
    const updates = updatesOf(log, ball, deflected.atMs);
    assert.ok(updates.length >= 2, `${updates.length} updates after the hit`);
    updates.forEach(({ atMs, speed }, index) => {
      assert.ok(followsFlight(speed, atMs - deflected.atMs + TICK_MS / 2, 1, 0.1), `after the hit, update ${index + 1}: the speed ${speed} at ${atMs - deflected.atMs} ms is not the deflected flight's`);
      if (index > 0) assert.ok(atMs - updates[index - 1]!.atMs >= UPDATE_GAP_MS.min && atMs - updates[index - 1]!.atMs <= UPDATE_GAP_MS.max, `update ${index + 1} after the hit came ${atMs - updates[index - 1]!.atMs} ms after the one before`);
    });
    assert.ok(ball.position.x - startX >= FLOWN_AWAY_BLOCKS, `the ball moved ${ball.position.x - startX} blocks away along her look, not ${FLOWN_AWAY_BLOCKS}`);
    const metadataKeys = own.filter(({ name, atMs }) => name === "entity_metadata" && atMs >= hitAtMs).flatMap(({ packet }) => (packet.metadata as { key: number }[]).map(({ key }) => key));
    assert.ok(metadataKeys.every((key) => SENT_KEYS.includes(key)), `metadata keys ${metadataKeys} after the hit: only the flags and the displayed item (${SENT_KEYS}), no owner`);
    assert.equal(log.packets.filter(({ name, packet }) => name === "damage_event" && packet.entityId === bot.entity.id).length, 0, "the bot was not hurt");
    assert.equal(bot.health >= healthBefore, true, "the bot lost health");
  } finally {
    log.stop();
  }
}
