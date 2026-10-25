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
 * the checks state its first push only, for the fake's mobs have no AI.
 *
 * The trials are split in three checks (`attack-mob-knockback`, `-decay`, `-sprint`) so each stays under the 25 s a contract check may take
 * on a shared server: the decay trial alone follows the mob for 12 s (plan 2026-10-23-shared-scenario-server T7d2 item 3).
 */
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import type { Entity } from "prismarine-entity";
import type { ContractFixture } from "../checks.ts";
import { type ContractSubject, holdsWithin } from "../subject.ts";
import { ANSWER_WALL_MS, afterClientTicks, serverQuiet } from "../server-answer.ts";
import { type Mark, READING_TICKS, markNow, restTicksSince, tickOf } from "./server-tick-marks.ts";
import { NIGHT, STILL_MOB_NBT, TICK_MS, holdInHand, mobAt } from "./combat-scene.ts";
import { type LoggedPacket, logPackets } from "./packet-log.ts";

/** The packets that would move a mob. */
const MOVE_PACKETS = ["rel_entity_move", "entity_move_look", "entity_teleport", "sync_entity_position"];
const AI_MOB_NBT = '{PersistenceRequired:1b,attributes:[{id:"minecraft:armor",base:0d}]}';
const VELOCITY_UNIT = 8_000;
const PUSH = 0.4;
const SPRINT_PUSH = 0.5;
const PUSH_TOLERANCE = 0.012;
/**
 * A mob with AI is already moving when the hit lands, and the game's knockback keeps half of the motion it has (`LivingEntity.knockback`:
 * old / 2 plus the push); and the zombie is summoned with a random knockback resistance of a few percent (0.3688 of 0.4 measured). A
 * mob with no AI showed neither (0.4 to the unit). Measured on lanes, 2026-10-24: a walking zombie's own velocity told just before a hit
 * was 0.062 along the ground (one sample: x 0.0419, z -0.0458), half of it 0.031; a push 0.047 off the expected one, and one 0.424 long
 * where the old rule allowed 0.412 (1 of 20 runs). The margin is the half velocity, the resistance (a tenth of the push) and the
 * tolerance of a mob with no AI; more samples of the walking velocity (the packet before the pair) would tighten it.
 */
const MOVING_MOB_WALK_HALF = 0.031;
const MOVING_MOB_PUSH_MARGIN = MOVING_MOB_WALK_HALF + PUSH * 0.1 + PUSH_TOLERANCE;
/**
 * The pair of velocities follows the `damage_event`, a tick later on a server of its own (22 to 51 ms, 3 runs). That wall gap is not
 * asserted: on a lane another lane's clone or a late client loop holds the pair back (a 172 ms gap with the pair's next velocities
 * 199 ms on, 1 run of 60, 2026-10-24), and the packets carry no tick count to read it in ticks instead; the order is.
 */
const FIRST_VELOCITY_MIN_MS = 0;
/** The server holds the swing for its recovery (the sword's 12.5 ticks; the hand's is shorter): the bot rests 13 server ticks after the equip, whatever the wall time they take. */
const SWING_REST_TICKS = 13;
/** One client tick of the bot's own physics (50 ms) sends the look before the hit does, so the server pushes along the new look; the server reads the two in the order sent. */
const LOOK_CLIENT_TICKS = 2;
/** The mob with no AI rests 12 s of server ticks after the hit; a server behind on a shared host takes longer on the wall clock: the watch waits for the zero velocity this long. */
const REST_WAIT_MS = 25_000;
const DECAY_PER_TICK = 0.98;
/** A component under this is dropped to zero each tick, and the tracker looks every 3 ticks (the fake's own list of what was measured: `fake-bot-mob-knockback.ts`). */
const REST_BELOW = 0.003;
const TELL_EVERY_TICKS = 3;
/** The index of the first velocity after the pair of the push. */
const FIRST_AFTER_PAIR = 2;
/** The zero is read when the client hears it: late by its lag, within what the wait's wall bound holds on a server on time. */
const REST_LATE_TICKS = REST_WAIT_MS / TICK_MS;
/** A velocity above this (a twentieth of a block a tick) is large enough for its ratio to say the ticks between two of them. */
const DECAY_CHECKED_ABOVE = 0.05;
const DECAY_TOLERANCE = 0.02;
const BOT_MOVE_TOLERANCE = 0.05;
const MOB_STAYS_TOLERANCE = 0.01;

/** One hit on a mob and what is stated of it. */
export interface Trial {
  readonly label: string;
  /** The mob stands at this arena-local x z; the AI mob is summoned there, the others are in the fixture. */
  readonly at: readonly [number, number];
  readonly ai?: true;
  readonly held: "hand" | "iron_sword";
  readonly sprint?: true;
  /** `decay`: the mob is followed until its velocity is zero; otherwise until the push is heard and the server has run on (`serverQuiet`). */
  readonly watch: "decay" | "push";
}

/** The wall: stone cells at x 3 (the mob at 2.5 has its east side against it). */
export const WALL_CELLS = { "3,-60,0": "stone", "3,-59,0": "stone", "3,-58,0": "stone" } as const;
export const DECAY_TRIAL: Trial = { label: "by hand in the open", at: [-1.5, 0.5], held: "hand", watch: "decay" };
export const DIAGONAL_TRIAL: Trial = { label: "with a sword, mob on the diagonal", at: [-1.5, -1.5], held: "iron_sword", watch: "push" };
export const WALL_TRIAL: Trial = { label: "with a sword, a wall behind the mob", at: [2.5, 0.5], held: "iron_sword", watch: "push" };
export const SPRINT_TRIAL: Trial = { label: "sprinting with a sword", at: [-1.5, 3.5], held: "iron_sword", sprint: true, watch: "push" };
export const AI_TRIAL: Trial = { label: "a mob with AI, with a sword", at: [-1.5, 2.5], ai: true, held: "iron_sword", watch: "push" };

/** The fixture of a check that runs `trials`: the bot with an iron sword at the centre and, for each trial with no AI, a zombie that stays where it is. */
export function knockbackFixture(trials: readonly Trial[], cells: ContractFixture["cells"] = {}): ContractFixture {
  return {
    cells,
    carried: { iron_sword: 1 },
    position: [0.5, -60, 0.5],
    timeOfDay: NIGHT,
    entities: trials.filter(({ ai }) => ai === undefined).map(({ at }) => ({ name: "zombie", position: [at[0], -60, at[1]] as const, nbt: STILL_MOB_NBT })),
  };
}

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

/** One hit on a mob and what the client hears of it until the watch is over. */
async function hitAndWatch(subject: ContractSubject, mob: Entity, watch: Trial["watch"]) {
  const { bot } = subject;
  const botBefore = bot.entity.position.clone();
  const mobBefore = mob.position.clone();
  const log = logPackets(subject, ["entity_velocity", ...MOVE_PACKETS, "damage_event", "entity_status", "entity_metadata"]);
  const forMob = ({ name, packet }: LoggedPacket, wanted: string) => name === wanted && packet.entityId === mob.id;
  /** The server's tick right before the hit and when the client heard the mob rest (a decay watch only: the push's watch reads no tick). */
  let restTicks: { hit: Mark; rest: Mark } | undefined;
  try {
    const hitMark = markNow(subject);
    bot.attack(mob);
    if (watch === "decay") {
      await holdsWithin(subject, () => log.packets.some((heard) => forMob(heard, "entity_velocity") && Math.hypot(...Object.values(heard.packet.velocity as Record<string, number>)) === 0), REST_WAIT_MS);
      restTicks = { hit: hitMark, rest: markNow(subject) };
    } else {
      const answered = await holdsWithin(subject, () => log.packets.some((heard) => forMob(heard, "damage_event")) && log.packets.filter((heard) => forMob(heard, "entity_velocity")).length >= 2, ANSWER_WALL_MS);
      const nearby = Object.values(bot.entities).filter((entity) => entity !== bot.entity && entity.position.distanceTo(bot.entity.position) < 12).map((entity) => `${entity.name} ${entity.id} at ${entity.position}`);
      assert.ok(answered, `the hit on ${mob.name} ${mob.id} (entities within 12 blocks: ${nearby.join("; ")};${bot.entity.position.distanceTo(mob.position).toFixed(2)} blocks off, sprint key ${bot.controlState.sprint}, bot at ${bot.entity.position}, mob at ${mob.position}) was not answered in ${ANSWER_WALL_MS} ms; heard: ${log.packets.map((heard) => `${heard.atMs.toFixed(0)} ${heard.name} ${heard.packet.entityId}`).join(", ") || "nothing"}`);
      await serverQuiet(subject, "the hit");
    }
  } finally {
    log.stop();
  }
  const damage = log.packets.find((heard) => forMob(heard, "damage_event"));
  return { log, damage, restTicks, velocities: log.packets.filter((heard) => forMob(heard, "entity_velocity")), botMoved: bot.entity.position.distanceTo(botBefore), mobMoved: mob.position.distanceTo(mobBefore) };
}

/** The first push of a hit: two equal velocities a tick after the `damage_event`, the push as expected. */
export function assertFirstPush(label: string, damage: LoggedPacket | undefined, velocities: LoggedPacket[], expected: { x: number; z: number }, upDown: "none" | "any"): void {
  const looseDirection = upDown === "any";
  assert.ok(damage !== undefined && velocities.length >= 2, `${label}: no damage_event or no velocity`);
  const heardList = `the first velocities, with ms after the damage_event: ${velocities.slice(0, 4).map((heard) => `${heard.atMs - damage.atMs} ${JSON.stringify(velocityOf(heard))}`).join("; ")}`;
  // A mob with AI also gets velocities of its own (walking, falling), one of them in the hit's tick before the `damage_event`: the push is the first pair of equal ones.
  const pairAt = looseDirection ? velocities.findIndex((heard, index) => isDeepStrictEqual(heard.packet.velocity, velocities[index + 1]?.packet.velocity)) : 0;
  assert.ok(pairAt >= 0, `${label}: no two equal velocities (${heardList})`);
  const [first, second] = velocities.slice(pairAt) as [LoggedPacket, LoggedPacket];
  const delay = first.atMs - damage.atMs;
  assert.ok(delay >= FIRST_VELOCITY_MIN_MS, `${label}: the first velocity came ${delay} ms after the damage_event, before it (${heardList})`);
  assert.deepEqual(second.packet.velocity, first.packet.velocity, `${label}: the second velocity differs from the first`);
  assert.ok(second.atMs - first.atMs <= TICK_MS, `${label}: the second velocity came ${second.atMs - first.atMs} ms after the first`);
  const push = velocityOf(first);
  const agrees = looseDirection
    ? Math.hypot(push.x - expected.x, push.z - expected.z) <= MOVING_MOB_PUSH_MARGIN
    : Math.abs(push.x - expected.x) <= PUSH_TOLERANCE && Math.abs(push.z - expected.z) <= PUSH_TOLERANCE;
  assert.ok(agrees, `${label}: the push is ${JSON.stringify(push)}, not ${JSON.stringify(expected)} (${heardList})`);
  if (upDown === "none") assert.equal(push.y, 0, `${label}: a mob with no AI is pushed up`);
}

/** Server ticks a push whose largest component is `push` takes to fall under the rest threshold: the tick its component is dropped (`0.4 * 0.98 ^ 242` is still 0.003004). */
function ticksToRest(push: { x: number; y: number; z: number }): number {
  return Math.ceil(Math.log(REST_BELOW / Math.max(Math.abs(push.x), Math.abs(push.y), Math.abs(push.z))) / Math.log(DECAY_PER_TICK));
}

/**
 * Every velocity after the pair is the one before it decayed by 0.98 for the ticks between them, and the ticks are the ratio's own (a wall gap
 * between two packets is not the ticks a server ran: a stall or a slower server changes it); the tracker tells every 3rd tick of the server's count, so the ticks are a multiple of 3 (the first velocity after the pair 1 to 3: its look has a phase; only large
 * velocities count: a small one rounds to the unit). The last is zero, and the mob rested after the ticks its push takes to fall under the rest threshold,
 * as the server's tick read right before the hit and the one read at the zero say (never early by more than the readings' error and the tracker's look).
 */
export function assertDecay(label: string, velocities: LoggedPacket[], restedAfterTicks: number): void {
  const norms = velocities.map((packet) => {
    const { x, y, z } = velocityOf(packet);
    return Math.hypot(x, y, z);
  });
  for (let index = FIRST_AFTER_PAIR; index < velocities.length; index += 1) {
    if (norms[index - 1]! < DECAY_CHECKED_ABOVE || norms[index]! === 0) continue;
    const ratio = norms[index]! / norms[index - 1]!;
    const ticks = Math.round(Math.log(ratio) / Math.log(DECAY_PER_TICK));
    // The pair is sent in the hit's tick; the first velocity after it waits for the tracker's next look, 1 to 3 ticks on (the fake has no phase: 4 of 5 real decays had 2, lanes 2026-10-24).
    const everyThird = index === FIRST_AFTER_PAIR ? ticks >= 1 && ticks <= TELL_EVERY_TICKS : ticks > 0 && ticks % TELL_EVERY_TICKS === 0;
    assert.ok(everyThird && Math.abs(ratio - DECAY_PER_TICK ** ticks) <= DECAY_TOLERANCE, `${label}: velocity ${index + 1} is ${ratio.toFixed(3)} of the one before, ${ticks} ticks of decay: the mob is told every ${TELL_EVERY_TICKS} ticks (the first after the pair 1 to ${TELL_EVERY_TICKS}), not ${DECAY_PER_TICK ** ticks}`);
  }
  assert.equal(norms.at(-1), 0, `${label}: the last velocity is not zero`);
  const earliest = ticksToRest(velocityOf(velocities[0]!)) - READING_TICKS - TELL_EVERY_TICKS;
  const latest = ticksToRest(velocityOf(velocities[0]!)) + READING_TICKS + TELL_EVERY_TICKS + REST_LATE_TICKS;
  assert.ok(restedAfterTicks >= earliest && restedAfterTicks <= latest, `${label}: the mob rested ${restedAfterTicks} server ticks after the hit (the readings +-${READING_TICKS}), not ${earliest} to ${latest}`);
}

/** The bot holds what the trial names, rested, looking at the mob (a sprint key down for a sprinting trial); nothing of it is left to undo but the key. */
async function standReadyToHit(subject: ContractSubject, trial: Trial, mob: Entity): Promise<void> {
  const { bot } = subject;
  if (trial.held === "hand") await bot.unequip("hand");
  else await holdInHand(subject, "iron_sword");
  await restTicksSince(subject, markNow(subject), SWING_REST_TICKS, "the swing");
  await bot.lookAt(mob.position.offset(0, 1.2, 0), true);
  await afterClientTicks(subject, LOOK_CLIENT_TICKS, "the look");
  if (trial.sprint) bot.setControlState("sprint", true);
}

/** Hit the mob of each trial and state what the client heard. */
export async function runKnockbackTrials(subject: ContractSubject, trials: readonly Trial[]): Promise<void> {
  const { bot } = subject;
  for (const trial of trials) {
    const mob = trial.ai ? await subject.summonMob("zombie", subject.world([trial.at[0], -60, trial.at[1]]), AI_MOB_NBT) : await mobAt(subject, "zombie", trial.at[0], trial.at[1]);
    try {
      await standReadyToHit(subject, trial, mob);
      const expected = expectedPush(subject, mob, trial.sprint === true);
      const { damage, velocities, botMoved, mobMoved, log, restTicks } = await hitAndWatch(subject, mob, trial.watch);
      assertFirstPush(trial.label, damage, velocities, expected, trial.ai ? "any" : "none");
      if (!trial.ai) {
        const moves = log.packets.filter(({ name, packet }) => MOVE_PACKETS.includes(name) && packet.entityId === mob.id);
        assert.ok(moves.every(({ packet }) => ["dX", "dY", "dZ"].every((field) => (packet[field] ?? 0) === 0) && packet.x === undefined), `${trial.label}: a mob with no AI got a move packet that moves it`);
        assert.ok(mobMoved <= MOB_STAYS_TOLERANCE, `${trial.label}: the mob moved ${mobMoved} blocks`);
      }
      if (!trial.sprint && !trial.ai) assert.ok(botMoved <= BOT_MOVE_TOLERANCE, `${trial.label}: the bot moved ${botMoved} blocks by hitting`);
      if (restTicks !== undefined) assertDecay(trial.label, velocities, (await tickOf(subject, restTicks.rest)) - (await tickOf(subject, restTicks.hit)));
      if (trial.sprint) await assertSprintSpent(subject, trial);
    } finally {
      if (trial.sprint) bot.setControlState("sprint", false);
      if (trial.ai) await subject.removeMob(mob);
    }
  }
}

/** The server cleared her sprint with the bonus hit: a second rested hit with the key still down is a plain 0.4. */
async function assertSprintSpent(subject: ContractSubject, trial: Trial): Promise<void> {
  const again: Trial = { ...trial, label: `${trial.label}, the key still down`, at: [-2.5, 2.5] };
  const second = await subject.summonMob("zombie", subject.world([again.at[0], -60, again.at[1]]), STILL_MOB_NBT);
  try {
    await standReadyToHit(subject, again, second);
    const expected = expectedPush(subject, second, false);
    const { damage, velocities } = await hitAndWatch(subject, second, again.watch);
    assertFirstPush(again.label, damage, velocities, expected, "none");
  } finally {
    await subject.removeMob(second);
  }
}
