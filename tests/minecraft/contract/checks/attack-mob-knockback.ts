/**
 * What the client hears of a mob that the bot hit (Mine Labs 1.21.4, 2026-10-24, 3 runs; a zombie with no AI and no armor at 2 blocks, by
 * hand and with an iron sword, in the open and with a wall behind it, and a zombie with AI summoned at the same 2 blocks).
 * The `damage_event` comes with the hit; a tick later (22 to 51 ms) the mob's `entity_velocity` twice, around its health metadata:
 * 0.4 away from the bot along the ground (x 3200 of 8000 for a mob straight off), no up. A sprinting hit with a rested swing adds a
 * second push, half the first and 0.5 along her look (0.7 in all along it): the server clears her sprint with it, so the next hit
 * with the key still down is a plain 0.4 again; the server uses the look it last received, so a hit sent in the same tick as `lookAt` pushes
 * along the old one. A mob with no AI never moves: its velocity decays by 0.98 a tick, told every 3 ticks (a change under 0.0003 waits for the
 * 6th), a component under 0.003 is dropped and the last velocity told is zero, 12 s after the hit; every move packet it gets has a delta of zero
 * (now and then one with `onGround` false); wall or no wall makes no difference to it. The bot's own place does not change by her hit.
 * A mob with AI takes the same first push but 0.36 up as well, then walks, falls and turns on its own (a position packet each tick or two):
 * the check states its first push only, for the fake's mobs have no AI.
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { type ContractSubject, holdsWithin } from "../subject.ts";
import { NIGHT, STILL_MOB_NBT, TICK_MS, holdInHand, mobAt } from "./combat-scene.ts";
import { type LoggedPacket, logPackets } from "./packet-log.ts";

const AI_MOB_NBT = '{PersistenceRequired:1b,attributes:[{id:"minecraft:armor",base:0d}]}';
const VELOCITY_UNIT = 8_000;
const PUSH = 0.4;
const SPRINT_PUSH = 0.5;
const PUSH_TOLERANCE = 0.012;
/** A mob with AI walks while the check looks and hits: its push points away from where it is then, a few degrees off the place the check saw (the angle is in radians). */
const MOVING_MOB_ANGLE = 0.25;
/** A zombie with AI is summoned with a random knockback resistance of a few percent (0.3688 of 0.4 measured), which a mob with no AI did not show (0.4 to the unit). */
const MOVING_MOB_PUSH = { min: 0.3, max: 0.4 + PUSH_TOLERANCE } as const;
/** The pair of velocities follows the `damage_event` by a tick (22 to 51 ms measured). */
const FIRST_VELOCITY_MS = { min: 0, max: 3 * TICK_MS } as const;
const SWING_REST_MS = 1_500;
const LOOK_SETTLE_MS = 150;
const WATCH_MS = 2_500;
/** The decay is followed for this long on the first mob, which rests 12 s after the hit. */
const REST_WATCH_MS = 14_500;
/** A server behind on a shared host rests later: the watch waits for the zero velocity this long, and the rest may come up to 1.6 times later. */
const REST_WAIT_MS = 25_000;
const REST_AT_MS = { min: 10_500, max: 20_000 } as const;
const DECAY_PER_TICK = 0.98;
/** A velocity above this (a twentieth of a block a tick) is large enough for its ratio to say the ticks between two of them. */
const DECAY_CHECKED_ABOVE = 0.05;
const DECAY_TOLERANCE = 0.02;
const BOT_MOVE_TOLERANCE = 0.05;
const MOB_STAYS_TOLERANCE = 0.01;

interface Trial {
  readonly label: string;
  /** The mob stands at this arena-local x z; the AI mob is summoned there, the others are in the fixture. */
  readonly at: readonly [number, number];
  readonly ai?: true;
  readonly held: "hand" | "iron_sword";
  readonly sprint?: true;
  readonly watchMs: number;
}
/** The wall: stone cells at x 3 (the mob at 2.5 has its east side against it). */
const WALL_CELLS = { "3,-60,0": "stone", "3,-59,0": "stone", "3,-58,0": "stone" } as const;
const TRIALS: readonly Trial[] = [
  { label: "by hand in the open", at: [-1.5, 0.5], held: "hand", watchMs: REST_WATCH_MS },
  { label: "with a sword, mob on the diagonal", at: [-1.5, -1.5], held: "iron_sword", watchMs: WATCH_MS },
  { label: "with a sword, a wall behind the mob", at: [2.5, 0.5], held: "iron_sword", watchMs: WATCH_MS },
  { label: "sprinting with a sword", at: [-1.5, 3.5], held: "iron_sword", sprint: true, watchMs: WATCH_MS },
  { label: "a mob with AI, with a sword", at: [-1.5, 2.5], ai: true, held: "iron_sword", watchMs: WATCH_MS },
];

/** The velocity of a packet in blocks a tick. */
const velocityOf = ({ packet }: LoggedPacket): { x: number; y: number; z: number } => {
  const { x, y, z } = packet.velocity as { x: number; y: number; z: number };
  return { x: x / VELOCITY_UNIT, y: y / VELOCITY_UNIT, z: z / VELOCITY_UNIT };
};

/** The horizontal unit vector from the bot to the mob. */
function awayFrom(subject: ContractSubject, mob: Entity): { x: number; z: number } {
  const dx = mob.position.x - subject.bot.entity.position.x;
  const dz = mob.position.z - subject.bot.entity.position.z;
  const length = Math.hypot(dx, dz);
  return { x: dx / length, z: dz / length };
}

/** The first push a hit gives: 0.4 away, and with the sprint bonus half of it and 0.5 along the bot's look. */
function expectedPush(subject: ContractSubject, mob: Entity, sprintBonus: boolean): { x: number; z: number } {
  const away = awayFrom(subject, mob);
  if (!sprintBonus) return { x: away.x * PUSH, z: away.z * PUSH };
  const { yaw } = subject.bot.entity;
  return { x: (away.x * PUSH) / 2 + -Math.sin(yaw) * SPRINT_PUSH, z: (away.z * PUSH) / 2 + -Math.cos(yaw) * SPRINT_PUSH };
}

/** One hit on a mob and what the client hears of it for `watchMs`. */
async function hitAndWatch(subject: ContractSubject, mob: Entity, watchMs: number) {
  const { bot } = subject;
  const botBefore = bot.entity.position.clone();
  const mobBefore = mob.position.clone();
  const log = logPackets(subject, ["entity_velocity", "rel_entity_move", "entity_move_look", "entity_teleport", "sync_entity_position", "damage_event"]);
  bot.attack(mob);
  if (watchMs === REST_WATCH_MS) await holdsWithin(subject, () => log.packets.some(({ name, packet }) => name === "entity_velocity" && packet.entityId === mob.id && Math.hypot(...Object.values(packet.velocity as Record<string, number>)) === 0), REST_WAIT_MS);
  else await subject.wait(watchMs);
  log.stop();
  const damage = log.packets.find(({ name, packet }) => name === "damage_event" && packet.entityId === mob.id);
  return { log, damage, velocities: log.packets.filter(({ name, packet }) => name === "entity_velocity" && packet.entityId === mob.id), botMoved: bot.entity.position.distanceTo(botBefore), mobMoved: mob.position.distanceTo(mobBefore) };
}

/** The first push of a hit: two equal velocities a tick after the `damage_event`, the push as expected. */
function assertFirstPush(label: string, damage: LoggedPacket | undefined, velocities: LoggedPacket[], expected: { x: number; z: number }, upDown: "none" | "any"): void {
  const looseDirection = upDown === "any";
  assert.ok(damage !== undefined && velocities.length >= 2, `${label}: no damage_event or no velocity`);
  const [first, second] = velocities as [LoggedPacket, LoggedPacket];
  const delay = first.atMs - damage.atMs;
  assert.ok(delay >= FIRST_VELOCITY_MS.min && delay <= FIRST_VELOCITY_MS.max, `${label}: the first velocity came ${delay} ms after the damage_event`);
  assert.deepEqual(second.packet.velocity, first.packet.velocity, `${label}: the second velocity differs from the first`);
  assert.ok(second.atMs - first.atMs <= TICK_MS, `${label}: the second velocity came ${second.atMs - first.atMs} ms after the first`);
  const push = velocityOf(first);
  const agrees = looseDirection
    ? Math.hypot(push.x, push.z) >= MOVING_MOB_PUSH.min && Math.hypot(push.x, push.z) <= MOVING_MOB_PUSH.max && Math.abs(Math.atan2(push.z, push.x) - Math.atan2(expected.z, expected.x)) <= MOVING_MOB_ANGLE
    : Math.abs(push.x - expected.x) <= PUSH_TOLERANCE && Math.abs(push.z - expected.z) <= PUSH_TOLERANCE;
  assert.ok(agrees, `${label}: the push is ${JSON.stringify(push)}, not ${JSON.stringify(expected)}`);
  if (upDown === "none") assert.equal(push.y, 0, `${label}: a mob with no AI is pushed up`);
}

/** Every velocity after the pair is the one before it decayed by 0.98 for the ticks between them (a tick of jitter: only large ones count), the last is zero. */
function assertDecay(label: string, velocities: LoggedPacket[], hitAtMs: number): void {
  const norms = velocities.map((packet) => {
    const { x, y, z } = velocityOf(packet);
    return Math.hypot(x, y, z);
  });
  for (let index = 2; index < velocities.length; index += 1) {
    if (norms[index - 1]! < DECAY_CHECKED_ABOVE || norms[index]! === 0) continue;
    const ticks = (velocities[index]!.atMs - velocities[index - 1]!.atMs) / TICK_MS;
    const ratio = norms[index]! / norms[index - 1]!;
    assert.ok(Math.abs(ratio - DECAY_PER_TICK ** Math.round(ticks)) <= DECAY_TOLERANCE, `${label}: velocity ${index + 1} is ${ratio.toFixed(3)} of the one before ${ticks.toFixed(1)} ticks earlier, not ${DECAY_PER_TICK ** Math.round(ticks)}`);
  }
  const last = velocities.at(-1)!;
  assert.equal(norms.at(-1), 0, `${label}: the last velocity is not zero`);
  const restedAfter = last.atMs - hitAtMs;
  assert.ok(restedAfter >= REST_AT_MS.min && restedAfter <= REST_AT_MS.max, `${label}: the mob rested ${restedAfter} ms after the hit`);
}

export const attackMobKnockback: ContractCheck = {
  name: "attack-mob-knockback",
  fixture: {
    cells: WALL_CELLS,
    carried: { iron_sword: 1 },
    position: [0.5, -60, 0.5],
    timeOfDay: NIGHT,
    entities: TRIALS.filter(({ ai }) => ai === undefined).map(({ at }) => ({ name: "zombie", position: [at[0], -60, at[1]] as const, nbt: STILL_MOB_NBT })),
  },
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    for (const trial of TRIALS) {
      const mob = trial.ai ? await subject.summonMob("zombie", subject.world([trial.at[0], -60, trial.at[1]]), AI_MOB_NBT) : await mobAt(subject, "zombie", trial.at[0], trial.at[1]);
      try {
        if (trial.held === "hand") await bot.unequip("hand");
        else await holdInHand(subject, "iron_sword");
        await subject.wait(SWING_REST_MS);
        await bot.lookAt(mob.position.offset(0, 1.2, 0), true);
        await subject.wait(LOOK_SETTLE_MS);
        if (trial.sprint) bot.setControlState("sprint", true);
        const expected = expectedPush(subject, mob, trial.sprint === true);
        const { damage, velocities, botMoved, mobMoved, log } = await hitAndWatch(subject, mob, trial.watchMs);
        assertFirstPush(trial.label, damage, velocities, expected, trial.ai ? "any" : "none");
        if (!trial.ai) {
          const moves = log.packets.filter(({ name, packet }) => name !== "entity_velocity" && name !== "damage_event" && packet.entityId === mob.id);
          assert.ok(moves.every(({ packet }) => ["dX", "dY", "dZ"].every((field) => (packet[field] ?? 0) === 0) && packet.x === undefined), `${trial.label}: a mob with no AI got a move packet that moves it`);
          assert.ok(mobMoved <= MOB_STAYS_TOLERANCE, `${trial.label}: the mob moved ${mobMoved} blocks`);
        }
        if (!trial.sprint && !trial.ai) assert.ok(botMoved <= BOT_MOVE_TOLERANCE, `${trial.label}: the bot moved ${botMoved} blocks by hitting`);
        if (trial.watchMs === REST_WATCH_MS) assertDecay(trial.label, velocities, damage!.atMs);
        if (trial.sprint) await assertSprintSpent(subject, trial);
      } finally {
        if (trial.sprint) bot.setControlState("sprint", false);
        if (trial.ai) await subject.removeMob(mob);
      }
    }
  },
};

/** The server cleared her sprint with the bonus hit: a second rested hit with the key still down is a plain 0.4. */
async function assertSprintSpent(subject: ContractSubject, trial: Trial): Promise<void> {
  const second = await subject.summonMob("zombie", subject.world([-2.5, -60, 2.5]), STILL_MOB_NBT);
  try {
    await subject.wait(SWING_REST_MS);
    await subject.bot.lookAt(second.position.offset(0, 1.2, 0), true);
    await subject.wait(LOOK_SETTLE_MS);
    const expected = expectedPush(subject, second, false);
    const { damage, velocities } = await hitAndWatch(subject, second, WATCH_MS);
    assertFirstPush(`${trial.label}, the key still down`, damage, velocities, expected, "none");
  } finally {
    await subject.removeMob(second);
  }
}
