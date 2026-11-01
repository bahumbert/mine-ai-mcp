/**
 * A ghast's fireball hit by hand in reach and out of reach (Mine Labs 1.21.4, 2026-10-24, 3 runs; no ghast: a NoAI ghast never shoots,
 * so the fireball is summoned with `acceleration_power` 0.02 and a `Motion` of 0.2 a tick at the bot, from 8 blocks off and from 4).
 * The ball's velocity follows `v = 0.95 * (v + power)` a tick (0.2 at the start, 0.272 after 10 ticks, 0.315 after 20: `0.38 - 0.18 *
 * 0.95^n`). The client hears little of it: a position packet of zero a tick after it appears, then its velocity with a relative
 * move (`entity_move_look`, the delta in 1/4096 of a block) at its 2nd tick, at the 10th and every 10th after. A hit out of reach does
 * nothing: the ball flies on, reaches her at about 1.3 s and hurts her (`damage_event` of type `unattributed_fireball`, the ball the cause and
 * direct source, 6 whatever the difficulty: it has no living owner to scale it), then an `explosion` packet and the ball is destroyed in the same tick. A hit in reach sets
 * the ball flying along the way she looks, 1 block a tick and an acceleration of 0.1 (`v = 1.9 - 0.9 * 0.95^n`): within a tick the client
 * hears its velocity, then a position packet (a move of zero, or the old flight's catch-up since the last position told: `assertMoveWithDeflection`), then the regular ones; it flies away and no packet names an owner. The check runs
 * with no block broken (`mobGriefing` off in the subject while a ball flies): the fake models no crater, and a ball that is not
 * removed flies on into other lanes, so the subject removes them after.
 *
 * The updates' ticks and the moves that come with a velocity are judged in server ticks (plan 2026-10-30-contract-batch-timing
 * T2b): the packets carry no world age (the age comes one packet per 20 ticks, too coarse for a 10-tick gap), so each update the check reads
 * carries the server's tick as of its hearing (`logPackets(..., markedNames)`, `heardAt`), as `projectile-hit-bot` does. A wall gap would fail
 * a server below 20 ticks a second (8 ticks a second stretches the 10-tick gap to 1.25 s) and a stall that catches up. What stays in wall
 * time is only the order of the packets on the client's log. The check stays `exclusive` for its game rule.
 * Since T7i an update is not judged by the gap between two reads (a stall's catch-up puts two updates 10 ticks apart 1 tick or 23 apart in the reads): its speed
 * says the tick of the flight it was sent at, which fixes the server tick it was sent at from the read before the launch (or at the hit), and the read when it was heard is judged against that
 * (`assertUpdatesToldOnTime`, `assertToldEveryTenTicks`); a read the catch-up made late throws the ball away.
 * Every other wait here is for a packet that arrives, the client's own physics ticks, or server ticks before an absence.
 */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { ANSWER_WALL_MS, afterClientTicks, answerArrives, serverQuiet } from "../server-answer.ts";
import { holdsWithin } from "../subject.ts";
import { type DamageEvent, type HealthPacket, damageTypeId } from "./combat-scene.ts";
import { type LoggedPacket, type PacketLog, logPackets } from "./packet-log.ts";
import { type Mark, READING_TICKS, markNow, roundTripTicks, tickOf } from "./server-tick-marks.ts";
import { assertTicksApart } from "./ticks-apart.ts";

const NAMES = ["entity_velocity", "rel_entity_move", "entity_move_look", "sync_entity_position", "entity_metadata", "explosion", "damage_event", "update_health"];
/** The packets whose server tick is read as they are heard: the updates, the move of zero that comes with a velocity, the hit and its blast (a few a ball, not one a tick). */
const MARKED_NAMES = ["entity_velocity", "rel_entity_move", "entity_move_look", "damage_event", "explosion"];
const VELOCITY_UNIT = 8_000;
const POSITION_UNIT = 4_096;
const LAUNCH_SPEED = 0.2;
const OUT_OF_REACH_BLOCKS = 8;
/** Where a ball is when the swing is read: it flies on while the swing is on its way, so a ball starts `blocksFlown(roundTrip + READING_TICKS)` further off (`roundTripTicks`, the speeds measured 2026-10-24: 0.2 to 0.315 a tick over the first 20). */
const IN_REACH_BLOCKS = 4;
/** The ball's ticks at which the server tells its velocity and position: the 2nd, then the 10th and every 10th after (measured 2026-10-24, 3 runs). */
const FIRST_UPDATE_AGE = 2;
const UPDATE_EVERY_TICKS = 10;
/** The age a speed says is the flight's `speedAfter` at a whole tick, to the 1/8000 the velocity packet counts in (0.07 of a tick at the 30th) and one tick for which tick a count starts at. */
const AGE_TOLERANCE_TICKS = 1;
/** A packet that comes in the same server tick as another, or the next one, read each with `READING_TICKS` of error. */
const NEXT_TICK_READ = 1 + READING_TICKS;
/** The server answers the hit with the new velocity within 3 ticks (the old wall bound `TICK_MS * 3`). */
const DEFLECT_WITHIN_TICKS = 3 + READING_TICKS;
const DEFLECT_VELOCITY_TOLERANCE = 0.01;
const FLOWN_AWAY_BLOCKS = 15;
/** A fireball's `entity_metadata` holds the item it shows (key 8) and its entity flags (key 0: it burns); nothing else is sent of it. */
const SENT_KEYS = [0, 8];
const HIT_COST = 6;
const COST_TOLERANCE = 0.1;
/** Natural regeneration heals 1 every 10 ticks and its `update_health` can share the hit's tick: the packet before the hit then lacks it, and the hit looks 1 cheaper. */
const REGENERATED_IN_THE_TICK = 1;
/** A forced look is sent by the client's next physics tick; two make sure it went out, and the server reads packets in order, so the hit that follows has the look. */
const LOOK_SENT_CLIENT_TICKS = 2;
/** The client's physics ticks the bot's knockback from the blast takes to end (the 500 ms this was). */
const KNOCKBACK_CLIENT_TICKS = 10;

/** The ball's speed `ticks` ticks after a start at `speed`: `v = (v + power) * 0.95`, steady at `power * 0.95 / 0.05`. */
function speedAfter(ticks: number, speed: number, power: number): number {
  const steady = (power * 0.95) / 0.05;
  return steady - (steady - speed) * 0.95 ** ticks;
}

/** The most the old flight goes on between two positions told: 10 ticks (`fake-bot-fireballs.ts` TELL_EVERY_TICKS) at its steady speed `0.38 = power * 0.95 / 0.05` (the header's `0.38 - 0.18 * 0.95^n`). */
const CATCH_UP_MAX_BLOCKS = 10 * 0.38;

/**
 * The position packet that comes in the tick of the new velocity is the ball's move since the last position the client was told: zero when the hit came
 * right after one (3 of 3 runs of 2026-10-24), else what the old flight went on since, back toward her along x (`entity_move_look -856 0`, 0.21 blocks, one
 * tick at 0.2, in 2 of 24 runs of 2026-10-30), `CATCH_UP_MAX_BLOCKS` at most. It never moves the ball along her look yet (the next tick's packet does:
 * `4281 0`) nor off the old flight's line (up, down or sideways).
 */
export function assertMoveWithDeflection(move: LoggedPacket | undefined): asserts move is LoggedPacket {
  assert.ok(move !== undefined, "a position packet comes with the new velocity: none heard");
  const along = movedBlocks(move);
  assert.ok(along <= 0, `a position packet comes with the new velocity: ${move.name} moved it ${along} blocks along x, forward along her look instead of the old flight's catch-up`);
  assert.ok(along >= -CATCH_UP_MAX_BLOCKS, `a position packet comes with the new velocity: ${move.name} moved it ${along} blocks back along x, more than the old flight's ${CATCH_UP_MAX_BLOCKS} blocks since the last position told`);
  assert.ok((move.packet.dZ ?? 0) === 0 && (move.packet.dY ?? 0) === 0, `a position packet comes with the new velocity: ${move.name} moved it off the old flight's line (dY ${move.packet.dY ?? 0}, dZ ${move.packet.dZ ?? 0})`);
}

/** One update the client heard of the ball: its velocity packet, the speed in it and the blocks the position packet with it moved it along x (0 for none). */
interface Update {
  readonly packet: LoggedPacket;
  readonly speed: number;
  readonly moved: number;
}

/**
 * The updates of `ball` that came after `after` on the log, in the order heard: the velocity packet and the position packet that follows it
 * before the ball's next velocity (the server sends them in one tick). The spawn tells the velocity too, at once: callers start after it.
 */
function updatesAfter(log: PacketLog, ball: Entity, after: LoggedPacket): Update[] {
  const own = log.packets.filter(({ packet }) => packet.entityId === ball.id);
  const heard = own.slice(own.indexOf(after) + 1);
  const updates: Update[] = [];
  for (const [index, packet] of heard.entries()) {
    if (packet.name !== "entity_velocity") continue;
    const next = heard.findIndex(({ name }, other) => other > index && name === "entity_velocity");
    const move = heard.slice(index + 1, next < 0 ? undefined : next).find(({ name }) => name === "entity_move_look" || name === "sync_entity_position");
    const velocity = packet.packet.velocity as { x: number; y: number; z: number };
    updates.push({ packet, speed: Math.hypot(velocity.x, velocity.y, velocity.z) / VELOCITY_UNIT, moved: move === undefined ? 0 : movedBlocks(move) });
  }
  return updates;
}

/** The server tick a packet was heard at (it was logged with its name in `MARKED_NAMES`). */
function heardTick(subject: Parameters<ContractCheck["run"]>[0], { heardAt, name }: LoggedPacket): Promise<number> {
  assert.ok(heardAt !== undefined, `${name} was logged with no server tick`);
  return tickOf(subject, heardAt);
}

/**
 * The updates of a ball set flying by the hit come at the ball's 2nd tick and every 10th from the 10th (`fake-bot-fireballs.ts` FIRST_TOLD_TICK, TELL_EVERY_TICKS), whatever tick of its age the hit fell on: the first is told
 * within 10 ticks of the hit and the others 10 after the one before (8 when the first was the 2nd tick and the next the 10th), in the ticks of the flight its speeds say (`ageOfSpeed` from the hit): no two reads of a
 * server that stalled are asked to be 10 ticks apart.
 */
export function assertToldEveryTenTicks(ages: readonly number[]): void {
  ages.forEach((age, index) => {
    const gap = age - (ages[index - 1] ?? 0);
    const allowed = index === 0 ? gap > 0 && gap <= UPDATE_EVERY_TICKS + AGE_TOLERANCE_TICKS : Math.abs(gap - UPDATE_EVERY_TICKS) <= AGE_TOLERANCE_TICKS || Math.abs(gap - (UPDATE_EVERY_TICKS - FIRST_UPDATE_AGE)) <= AGE_TOLERANCE_TICKS;
    assert.ok(allowed, `after the hit, update ${index + 1}: its speed is the flight's at tick ${age.toFixed(1)} after the hit${index === 0 ? ", not within the first 10" : `, ${gap.toFixed(1)} after the update before (tick ${ages[index - 1]!.toFixed(1)}), not ${UPDATE_EVERY_TICKS} (or ${UPDATE_EVERY_TICKS - FIRST_UPDATE_AGE} after a 2nd tick)`}`);
  });
}

/** The blocks a position packet moves the ball by along x (a relative move's delta, or an absolute one's x). */
function movedBlocks({ name, packet }: LoggedPacket): number {
  return name === "entity_move_look" || name === "rel_entity_move" ? (packet.dX as number) / POSITION_UNIT : (packet.x as number);
}

export const deflectFireball: ContractCheck = {
  name: "deflect-fireball",
  fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5], difficulty: "easy" },
  withoutRuntime: true,
  exclusive: "the ball's blast must break no block, so the subject turns the mobGriefing game rule off (a server-wide rule) while a fireball flies; and a ball that is missed flies on into other lanes",
  async run(subject) {
    try {
      const roundTrip = await roundTripTicks(subject);
      const thrownAway = [...(await hitOutOfReach(subject, roundTrip)), ...(await hitInReach(subject, roundTrip))];
      return ballsRecorded(thrownAway);
    } finally {
      await subject.clearFireballs();
    }
  },
};

type Subject = Parameters<ContractCheck["run"]>[0];

/** What a passing run returns of its balls (the driver puts it in the trial's completion detail, so a batch's `results.json` counts the balls a server's stalls threw away): the two judged balls plus each thrown away, with the reason of each. */
function ballsRecorded(thrownAway: readonly string[]): string {
  return [`balls: launched=${2 + thrownAway.length} thrownAway=${thrownAway.length}`, ...thrownAway].join(" | ");
}

/**
 * A server that stalls between the launch of a ball and the swing at it runs the ticks it owes back to back (`fake-server.ts` stall
 * rule, from `MinecraftServer.runServer`), so the ball flies on, at 0.2 to 0.3 blocks a tick, before the swing is read: a 700 ms stall
 * on the launch is 14 ticks, a ball launched 8 blocks off 4.4 off (read on the fake, plan 2026-10-30-contract-batch-timing T7f), a ball
 * launched 4 off meeting the bot. The ticks between the launch and the swing are read, and a ball the flight put where the check
 * needs it not is thrown away for a new one, and a third is the last (three in a row is a server that does not run, or answers later than
 * the starts allow for). The relaunch answers a game fact (the catch-up of owed ticks, source `MinecraftServer.runServer`, unmeasured), not a
 * cause left open: on the real server no ball was thrown away in 40 runs (2026-11-01, plan 2026-11-01-stabilize-review-fixes R4: 20 alone,
 * 20 inside the whole contract batch run 20 times, 1100 of 1100 trials passed). Both sets ran on a server of the check's own (it is
 * `exclusive`, so another lane's `clone` can never stall it: the stalls this guards against there are its own server's), so a stall long enough
 * has not fallen on a launch; the 3 is a bound that no run has yet reached. The note a passing run returns (`ballsRecorded`) names the balls
 * thrown away, to grep in a batch's `results.json`.
 */
const BALL_ATTEMPTS = 3;
/** A ball that meets the bot costs her `HIT_COST` (the hit and its blast share the hurt window); no ball is launched when she has no more health than a ball takes. */
const BALL_ON_BOT_COST = HIT_COST;
/** The nearest point of the ball's box is in the server's reach of 6 (`fake-bot-entity-reach.ts` ENTITY_REACH, contract check `attack-out-of-reach`: 5.9 hit, 6.1 not); the box is 1 wide, so its centre must be past 6.5. */
const CENTRE_BEYOND_REACH_BLOCKS = 6.5;
/** The ball meets the bot when their boxes (1 and 0.6 wide) touch: centres 0.8 apart. */
const CENTRE_AT_BOT_BLOCKS = 0.8;
const LAUNCH_POWER = 0.02;
/** The blocks a ball launched at `LAUNCH_SPEED` flies in `ticks` ticks (each tick's move is its speed after the tick: `0.38 - 0.18 * 0.95^n`). */
export function blocksFlown(ticks: number): number {
  let blocks = 0;
  for (let tick = 1; tick <= ticks; tick += 1) blocks += speedAfter(tick, LAUNCH_SPEED, LAUNCH_POWER);
  return blocks;
}

/** A ball launched `startBlocks` off along x and swung at: the client's x of it, the swing's place in the log, its mark, and the server ticks between the launch and the swing. */
interface Swing {
  readonly ball: Entity;
  readonly startX: number;
  readonly hitAtMs: number;
  readonly hit: Mark;
  /** The read sent right before the launch, which the server handles in the launch's own tick. */
  readonly launched: Mark;
  readonly flownTicks: Promise<number>;
}

/** Launch a ball `startBlocks` off and swing at it. The tick is read before the launch, where the server runs the two in one tick: a read after it comes after a stall's burst. */
async function launchAndSwing(subject: Subject, log: PacketLog, feet: Vec3, startBlocks: number): Promise<Swing> {
  const launched = markNow(subject);
  const ball = await subject.launchFireball(feet.offset(startBlocks, 0.9, 0), new Vec3(-LAUNCH_SPEED, 0, 0));
  const startX = ball.position.x;
  const hitAtMs = log.sinceStartMs();
  const hit = markNow(subject);
  subject.bot.attack(ball);
  return { ball, startX, hitAtMs, hit, launched, flownTicks: Promise.all([tickOf(subject, hit), tickOf(subject, launched)]).then(([swung, launchedTick]) => swung - launchedTick) };
}

/** What a judge reads of a ball that was as planned: the swing, the packets logged since its launch and the bot's health before it. */
type Seen = Swing & { readonly log: PacketLog; readonly healthBefore: number };

/** Judges a ball, or says why its readings cannot judge it (a reason, as `untilBallAsPlanned` words it) so another is launched. */
type Judge = (seen: Seen) => Promise<string | undefined>;

/**
 * Launch a ball `startBlocks` off and swing at it. When the server ticks between the two (`asPlanned` of them) show the flight put the ball
 * where the check does not want it (`notPlanned` says how), or `judge` finds its readings too late to judge, return the reason; else return `undefined`.
 */
async function swingAtNewBall(subject: Subject, startBlocks: number, planned: { readonly asPlanned: (flownTicks: number) => boolean; readonly notPlanned: string }, judge: Judge): Promise<string | undefined> {
  const { bot } = subject;
  const feet = bot.entity.position.clone();
  await bot.lookAt(feet.offset(5, 1.62, 0), true);
  await afterClientTicks(subject, LOOK_SENT_CLIENT_TICKS, "the look sent");
  const healthBefore = bot.health;
  const log = logPackets(subject, NAMES, MARKED_NAMES);
  try {
    const swing = await launchAndSwing(subject, log, feet, startBlocks);
    const flownTicks = await swing.flownTicks;
    if (!planned.asPlanned(flownTicks)) return `launched ${startBlocks.toFixed(1)} blocks off ${planned.notPlanned} (the swing was read ${flownTicks} server ticks after the launch)`;
    return await judge({ ...swing, log, healthBefore });
  } finally {
    log.stop();
  }
}

/** Swing at a new ball (`swingAtNewBall`) until one can be judged; one that could not is cleared (it flew away deflected, or blew up on the bot, whose knockback ends first). */
async function untilBallAsPlanned(subject: Subject, what: string, swingAtBall: () => Promise<string | undefined>): Promise<string[]> {
  const reasons: string[] = [];
  let thrownAway: string | undefined;
  for (let tries = 1; tries <= BALL_ATTEMPTS; tries += 1) {
    thrownAway = await swingAtBall();
    if (thrownAway === undefined) return reasons;
    reasons.push(`${what}: ${thrownAway}`);
    if (tries === BALL_ATTEMPTS) break;
    assert.ok(subject.bot.health > BALL_ON_BOT_COST, `${tries} ball(s) thrown away, the last one ${thrownAway}, and the bot has ${subject.bot.health} health left: another ball could kill her, so none is launched`);
    await subject.clearFireballs();
    await afterClientTicks(subject, KNOCKBACK_CLIENT_TICKS, "the knockback of a blast the stall let through");
  }
  assert.fail(`${BALL_ATTEMPTS} balls in a row thrown away, the last one ${thrownAway}: the server's ticks come in bursts or its answers come later than the starting distance and the reading window allow for (read the server log for "Can't keep up", then run the check alone)`);
}

async function hitOutOfReach(subject: Subject, roundTrip: number): Promise<string[]> {
  const startBlocks = OUT_OF_REACH_BLOCKS + blocksFlown(roundTrip + READING_TICKS);
  const beyondReach = (flownTicks: number) => startBlocks - blocksFlown(flownTicks + READING_TICKS) > CENTRE_BEYOND_REACH_BLOCKS;
  return untilBallAsPlanned(subject, "out of reach", () => swingAtNewBall(subject, startBlocks, { asPlanned: beyondReach, notPlanned: "was in reach or at the bot when the swing was read" }, (seen) => judgeMissedBall(subject, roundTrip, seen)));
}

/** The ball's age, in its ticks, at which a velocity of `speed` is its flight's (`speedAfter` inverted, from a start at `speed0`). */
export function ageOfSpeed(speed: number, speed0: number, power: number): number {
  const steady = (power * 0.95) / 0.05;
  return Math.log((steady - speed) / (steady - speed0)) / Math.log(0.95);
}

/**
 * The updates of a ball that flew out of reach come at its 2nd tick, then at its 10th and every 10th after (`fake-bot-fireballs.ts` FIRST_TOLD_TICK, TELL_EVERY_TICKS), and each update's speed
 * says which tick of the flight it was sent at (`ageOfSpeed`). The server tick it was sent at is then the launch's plus that age, whatever the server did between the updates; the tick read when
 * the client heard it is that tick or later, by the round trip and the readings' error (a stall between the launch and the hit made the old origin, the read at the swing, late by the stall: red from 1950 to
 * 3550 ms of a 700 ms stall at 450 ms of lag, T7i). A read earlier than the update was sent is a failure. One later than the round trip and the error allow for is a stall that ran its owed ticks
 * between the update and its read (a 700 ms stall: 15 ticks late): the read says nothing of the update's own tick, so the reason is returned and the ball is thrown away for a new one.
 */
export function assertUpdatesToldOnTime(heard: readonly { readonly tick: number; readonly speed: number }[], launchTick: number, roundTrip: number): string | undefined {
  const ages = heard.map(({ speed }) => ageOfSpeed(speed, LAUNCH_SPEED, LAUNCH_POWER));
  ages.forEach((age, index) => {
    const told = index === 0 ? FIRST_UPDATE_AGE : index * UPDATE_EVERY_TICKS;
    assert.ok(Math.abs(age - told) <= AGE_TOLERANCE_TICKS, `out of reach, update ${index + 1}: its speed ${heard[index]!.speed} is the flight's at tick ${age.toFixed(1)}, not the tick ${told} the server tells it at`);
  });
  return updatesReadTooLate("out of reach", heard, ages.map(Math.round), launchTick, roundTrip + READING_TICKS);
}

/** The reason when an update was read more than `maxLate` ticks after the tick it was sent at (`originTick` plus the ball's age at the update); a read before it was sent is a failure. */
export function updatesReadTooLate(what: string, heard: readonly { readonly tick: number }[], ages: readonly number[], originTick: number, maxLate: number): string | undefined {
  let tooLate: string | undefined;
  heard.forEach(({ tick }, index) => {
    const late = tick - originTick - ages[index]!;
    assert.ok(late >= -READING_TICKS, `${what}, update ${index + 1}: read at tick ${tick}, ${-late} server ticks before it was sent (the ball's tick ${ages[index]}, from tick ${originTick})`);
    if (late > maxLate) tooLate ??= `had its update ${index + 1} read ${late} server ticks after it was sent (${what}: the ball's tick ${ages[index]}, from tick ${originTick}), more than ${maxLate}: the round trip and the readings' error allow for no more`;
  });
  return tooLate;
}

/** The ball out of reach flies on to the bot and hurts her: what the client hears of it, in server ticks. */
async function judgeMissedBall(subject: Subject, roundTrip: number, seen: Seen): Promise<string | undefined> {
  const { bot } = subject;
  const { log, ball, healthBefore } = seen;
  // A missed ball is destroyed at her: the server removes it on arrival.
  await answerArrives(subject, () => subject.bot.entities[ball.id] === undefined, "the ball that was out of reach never reached the bot");
  // The hit's packets came in the ball's last tick, before its removal; the wait is for the log to hold them, not for 4 ticks of wall time.
  await answerArrives(subject, () => hitAnswered(log, bot.entity.id), "the packets of the ball's hit on the bot");
  const zero = log.packets.find(({ name, packet }) => name === "rel_entity_move" && packet.entityId === ball.id);
  assert.ok(zero !== undefined && zero.packet.dX === 0 && zero.packet.dY === 0 && zero.packet.dZ === 0, "a move of zero comes first");
  // The spawn's own velocity came before the move of zero (a tick after the spawn); the updates are what follows it.
  const updates = updatesAfter(log, ball, zero);
  assert.ok(updates.length >= 3, `${updates.length} updates before it arrived: the first at a tick or two, then every 10 ticks`);
  const heard = await Promise.all(updates.map(async ({ packet, speed }) => ({ tick: await heardTick(subject, packet), speed })));
  const unjudged = assertUpdatesToldOnTime(heard, await tickOf(subject, seen.launched), roundTrip);
  if (unjudged !== undefined) return unjudged;
  updates.forEach(({ moved }, index) => assert.ok(moved < 0, `update ${index + 1}: the ball did not move toward the bot (${moved})`));
  const hits = log.packets.filter(({ name, packet }) => name === "damage_event" && packet.entityId === bot.entity.id);
  assert.equal(hits.length, 1, "one damage_event for the bot");
  const event = hits[0]!.packet as unknown as DamageEvent;
  assert.deepEqual({ type: event.sourceTypeId, cause: event.sourceCauseId, direct: event.sourceDirectId }, { type: damageTypeId(bot.registry, "unattributed_fireball"), cause: ball.id + 1, direct: ball.id + 1 }, "the fireball's hit names itself");
  const blast = log.packets.find(({ name }) => name === "explosion");
  assert.ok(blast !== undefined, "an explosion follows the hit");
  assertTicksApart("the explosion after the hit, in its tick", await heardTick(subject, hits[0]!), await heardTick(subject, blast), { min: 0, max: NEXT_TICK_READ });
  const told = log.packets.find(({ name, atMs }) => name === "update_health" && atMs >= hits[0]!.atMs);
  const previous = log.packets.filter(({ name, atMs }) => name === "update_health" && atMs < hits[0]!.atMs).at(-1);
  const lost = (previous === undefined ? healthBefore : (previous.packet as unknown as HealthPacket).health) - (told!.packet as unknown as HealthPacket).health;
  assert.ok(lost >= HIT_COST - REGENERATED_IN_THE_TICK - COST_TOLERANCE && lost <= HIT_COST + COST_TOLERANCE, `the ball cost ${lost}, not ${HIT_COST} (or ${HIT_COST - REGENERATED_IN_THE_TICK} with a regeneration in its tick)`);
  await afterClientTicks(subject, KNOCKBACK_CLIENT_TICKS, "the knockback of the blast");
  return undefined;
}

/** Whether the log holds the bot's `damage_event`, an `explosion` and the `update_health` that came with the hit or after it. */
function hitAnswered(log: PacketLog, botId: number): boolean {
  const hit = log.packets.find(({ name, packet }) => name === "damage_event" && packet.entityId === botId);
  return hit !== undefined && log.packets.some(({ name }) => name === "explosion") && log.packets.some(({ name, atMs }) => name === "update_health" && atMs >= hit.atMs);
}

async function hitInReach(subject: Subject, roundTrip: number): Promise<string[]> {
  const startBlocks = IN_REACH_BLOCKS + blocksFlown(roundTrip);
  const beforeBot = (flownTicks: number) => startBlocks - blocksFlown(flownTicks + READING_TICKS) > CENTRE_AT_BOT_BLOCKS;
  return untilBallAsPlanned(subject, "in reach", () => swingAtNewBall(subject, startBlocks, { asPlanned: beforeBot, notPlanned: "met the bot before the swing was read" }, (seen) => judgeDeflectedBall(subject, roundTrip, seen)));
}

/** The ball in reach is set flying away along her look: what the client hears of it, in server ticks. */
async function judgeDeflectedBall(subject: Subject, roundTrip: number, seen: Seen): Promise<string | undefined> {
  const { bot } = subject;
  const { log, ball, startX, hitAtMs, hit, healthBefore } = seen;
  const ownPackets = () => log.packets.filter(({ packet }) => packet.entityId === ball.id);
  const deflectedOf = () => ownPackets().find(({ name, atMs, packet }) => name === "entity_velocity" && atMs >= hitAtMs && (packet.velocity as { x: number }).x > 0);
  // The ball is flown away once it was set flying and updated twice; the absences below (no owner, no hurt) are read after server ticks on top.
  await holdsWithin(subject, () => {
    const first = deflectedOf();
    return first !== undefined && updatesAfter(log, ball, first).length >= 2 && ball.position.x - startX >= FLOWN_AWAY_BLOCKS;
  }, ANSWER_WALL_MS);
  await serverQuiet(subject, "after the ball flew away");
  const own = ownPackets();
  const deflected = deflectedOf();
  assert.ok(deflected !== undefined, "the ball's new velocity never came");
  const deflectedTick = await heardTick(subject, deflected);
  // The hit is read with its act, the velocity when it was heard: a round trip later (`roundTripTicks`), and later still when a stall ran its owed ticks between the two: that ball is thrown away.
  const hitTick = await tickOf(subject, hit);
  const maxLate = DEFLECT_WITHIN_TICKS + roundTrip;
  if (deflectedTick - hitTick > maxLate) return `had its new velocity read ${deflectedTick - hitTick} server ticks after the hit, more than ${maxLate} (the round trip of ${roundTrip} and the server's answer within ${DEFLECT_WITHIN_TICKS}): a stall's catch-up ran between, or the server answered the hit late`;
  assert.ok(deflectedTick >= hitTick, `the ball's new velocity after the hit: read at tick ${deflectedTick}, before the hit's read at tick ${hitTick}`);
  const velocity = deflected.packet.velocity as { x: number; y: number; z: number };
  assert.ok(Math.abs(velocity.x / VELOCITY_UNIT - 1) <= DEFLECT_VELOCITY_TOLERANCE && Math.abs(velocity.y) / VELOCITY_UNIT <= DEFLECT_VELOCITY_TOLERANCE && Math.abs(velocity.z) / VELOCITY_UNIT <= DEFLECT_VELOCITY_TOLERANCE, `the deflected velocity ${JSON.stringify(velocity)} is not 1 along her look`);
  const still = own.slice(own.indexOf(deflected) + 1).find(({ name }) => name === "rel_entity_move" || name === "entity_move_look");
  assertMoveWithDeflection(still);
  assertTicksApart("the position packet after the new velocity", deflectedTick, await heardTick(subject, still), { min: 0, max: NEXT_TICK_READ });
  const updates = updatesAfter(log, ball, deflected);
  assert.ok(updates.length >= 2, `${updates.length} updates after the hit`);
  const heard = await Promise.all(updates.map(async ({ packet, speed }) => ({ tick: await heardTick(subject, packet), speed })));
  const ages = heard.map(({ speed }) => ageOfSpeed(speed, 1, 0.1));
  assertToldEveryTenTicks(ages);
  const unjudged = updatesReadTooLate("after the hit", heard, ages.map(Math.round), hitTick, maxLate);
  if (unjudged !== undefined) return unjudged;
  assert.ok(ball.position.x - startX >= FLOWN_AWAY_BLOCKS, `the ball moved ${ball.position.x - startX} blocks away along her look, not ${FLOWN_AWAY_BLOCKS}`);
  const metadataKeys = own.filter(({ name, atMs }) => name === "entity_metadata" && atMs >= hitAtMs).flatMap(({ packet }) => (packet.metadata as { key: number }[]).map(({ key }) => key));
  assert.ok(metadataKeys.every((key) => SENT_KEYS.includes(key)), `metadata keys ${metadataKeys} after the hit: only the flags and the displayed item (${SENT_KEYS}), no owner`);
  assert.equal(log.packets.filter(({ name, packet }) => name === "damage_event" && packet.entityId === bot.entity.id).length, 0, "the bot was not hurt");
  assert.equal(bot.health >= healthBefore, true, "the bot lost health");
  return undefined;
}
