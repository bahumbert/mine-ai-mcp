/**
 * What a second hit does to a mob already hurt, told by the server ticks between the hits (Mine Labs 1.21.4, 2026-10-24, an iron
 * axe: 9 damage). A hit inside the mob's hurt window (it holds the damage of the last hit for 10 ticks) changes nothing, no packet.
 * Past the window the second hit costs its damage times `0.2 + 0.8 * strength^2`, the strength being the ticks since the attacker's
 * last hit (and a changed held item starts the count over) plus a half, over the swing period of 22.2 ticks (the axe's 0.9 attacks a
 * second). Measured, each damage read from the mob's health and the ticks from `time query gametime`: 17 ticks apart cost 6.27 (the
 * rule: 6.27), 13 cost 4.46 (4.46), 2 after a swap cost 1.89, 32 cost 9.
 *
 * The bot keeps its wall gaps (what it does); the damage is judged by the server ticks that really passed between the hits, each read
 * with `time query gametime` sent right before the act: a lane's server that stalls while another lane arranges (E4) held 17 ticks in
 * a 1000 ms gap, and neither is a fault of the game. The rest of the swing between two sequences is counted in server ticks too.
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { ANSWER_WALL_MS } from "../server-answer.ts";
import { type ContractSubject, settleWithin } from "../subject.ts";
import { CALL_WALL_MS, NIGHT, STILL_MOB_NBT, TICK_MS, ZOMBIE_HEALTH, healthOf, holdInHand, listenToFight, mobAt } from "./combat-scene.ts";

const AXE_DAMAGE = 9;
/** The axe's swing period in ticks: 20 over its attack speed of 0.9. */
const SWING_TICKS = 20 / 0.9;
/** Ticks a mob holds the damage of its last hit: a hit inside takes nothing. */
const HURT_WINDOW_TICKS = 10;
/** Ticks a swing rests to be full: the period and a margin for the readings. */
const REST_TICKS = 24;
/** A reading of `time query gametime` sent right before an act is off the act's own tick by at most 1 (the server runs the two in one batch of packets), so the difference of two readings is off by at most this much each way (reasoned, not measured: the readings of hits 50 ms apart were 1 to 3 apart on lanes, 5 once with the client 76 ms late). */
const READING_TICKS = 2;
/** Gaps between the first hit and the second: inside the hurt window, past it with half a swing, almost a full swing, a full swing (on a server on time). */
const GAPS_MS: readonly number[] = [50, 600, 1_000, 1_600];
/** What the second hit costs, by the server ticks between the hits. */
const RULE = "nothing inside the hurt window, past it the damage x (0.2 + 0.8 strength^2)";
/** The swing after the held item changed. */
const AFTER_SWAP_MS = 100;
/** Float noise of a health read in metadata. */
const DAMAGE_MARGIN = 0.05;

const MOB_PLACES: readonly (readonly [number, number])[] = [[0.5, 2.5], [2.5, 0.5], [-2.5, 0.5], [0.5, -2.5], [2.5, 2.5]];

/** What the axe costs a mob that is not in its hurt window, `ticks` after the attacker's swing started over. */
function damageAfter(ticks: number): number {
  const strength = Math.min(1, Math.max(0, (ticks + 0.5) / SWING_TICKS));
  return AXE_DAMAGE * (0.2 + 0.8 * strength ** 2);
}

/** What a hit `ticks` (+-`READING_TICKS`) after the last may cost; `inHurtWindow`: the mob took a hit `ticks` ago. */
function damageBounds(ticks: number, inHurtWindow: boolean): readonly [number, number] {
  const low = inHurtWindow && ticks - READING_TICKS < HURT_WINDOW_TICKS ? 0 : damageAfter(ticks - READING_TICKS);
  const high = inHurtWindow && ticks + READING_TICKS < HURT_WINDOW_TICKS ? 0 : damageAfter(ticks + READING_TICKS);
  return [low - DAMAGE_MARGIN, high + DAMAGE_MARGIN];
}

/** A moment of the run: when the client acted (wall) and the server's tick then, asked right before so the server runs both in one tick or in neighbouring ones; null if the server answered nothing. */
interface Mark {
  readonly tick: Promise<number | null>;
  readonly atMs: number;
}

function markNow(subject: ContractSubject): Mark {
  return { tick: subject.serverGameTime().catch(() => null), atMs: subject.now() };
}

async function tickOf(subject: ContractSubject, mark: Mark): Promise<number> {
  const tick = (await settleWithin(subject, mark.tick, CALL_WALL_MS))?.value ?? null;
  assert.ok(tick !== null, "the server answered no game time (is the bot op? or the server stalled)");
  return tick;
}

/** Let the swing rest `REST_TICKS` server ticks after the act marked, whatever the wall time they take; fails at the wall bound (a server that barely ticks). */
async function restSince(subject: ContractSubject, since: Mark): Promise<void> {
  const sinceTick = await tickOf(subject, since);
  const startedAt = subject.now();
  for (let ticksLeft = REST_TICKS; ticksLeft > 0; ) {
    assert.ok(subject.now() - startedAt < ANSWER_WALL_MS, `the swing rested ${REST_TICKS - ticksLeft} of ${REST_TICKS} server ticks in ${ANSWER_WALL_MS} ms: the server is stalled`);
    await subject.wait(ticksLeft * TICK_MS);
    ticksLeft = REST_TICKS - ((await tickOf(subject, markNow(subject))) - sinceTick);
  }
}

/** What the two sides saw of the acts: the server's tick at each, when the client did each and heard the mob hurt. */
function describeActs(marks: readonly Mark[], ticks: readonly number[], hurtAtMs: readonly number[]): string {
  const since = (atMs: number) => `+${Math.round(atMs - marks[0]!.atMs)} ms`;
  return `server ticks at the acts ${ticks.join(", ")} (${ticks.at(-1)! - ticks[0]!} from the first to the last, +-${READING_TICKS}); the client acted at ${marks.map(({ atMs }) => since(atMs)).join(", ")} and heard the mob hurt at ${hurtAtMs.map(since).join(", ") || "no time"}`;
}

/** The health a mob lost to the hits, the server ticks from the first act (the hit, or the swap before it) to the last hit, and what both sides saw. */
interface HitsOutcome {
  readonly lost: number;
  readonly ticksApart: number;
  readonly seen: string;
}

/**
 * `hits` on `mob` (each `waitMs` before the next), then the swing rests. `after` is an act just before the first hit that the ticks are
 * counted from (a swap). The ticks between two acts are not bound by the wall time between them: a server that stalled before the first
 * ran 24 ticks between acts 1000 ms apart while it caught up (measured on lanes), and the damage follows the ticks.
 */
async function hitsAndHealthLost(subject: ContractSubject, mob: Entity, waitsMs: readonly number[], after?: Mark): Promise<HitsOutcome> {
  const { bot } = subject;
  const fight = listenToFight(subject, mob);
  const marks: Mark[] = after === undefined ? [] : [after];
  try {
    for (const waitMs of waitsMs) {
      marks.push(markNow(subject));
      bot.attack(mob);
      await subject.wait(waitMs);
    }
    const ticks = await Promise.all(marks.map((mark) => tickOf(subject, mark)));
    const lastHit = marks.at(-1)!;
    await restSince(subject, lastHit);
    const ticksApart = ticks.at(-1)! - ticks[0]!;
    const seen = describeActs(marks, ticks, fight.heard.hurts.map(({ atMs }) => atMs));
    return { lost: ZOMBIE_HEALTH - healthOf(bot, mob), ticksApart, seen };
  } finally {
    fight.stop();
  }
}

export const attackCooldownDamage: ContractCheck = {
  name: "attack-cooldown-damage",
  fixture: {
    cells: {},
    carried: { iron_sword: 1, iron_axe: 1 },
    position: [0.5, -60, 0.5],
    timeOfDay: NIGHT,
    entities: MOB_PLACES.map(([x, z]) => ({ name: "zombie", position: [x, -60, z], nbt: STILL_MOB_NBT })),
  },
  withoutRuntime: true,
  async run(subject) {
    const mobs = await Promise.all(MOB_PLACES.map(([x, z]) => mobAt(subject, "zombie", x, z)));
    const equipped = markNow(subject);
    await holdInHand(subject, "iron_axe");
    await restSince(subject, equipped);
    for (const [index, gap] of GAPS_MS.entries()) {
      const { lost, ticksApart, seen } = await hitsAndHealthLost(subject, mobs[index]!, [gap, 0]);
      const secondHit = lost - AXE_DAMAGE;
      const [low, high] = damageBounds(ticksApart, true);
      assert.ok(lost >= AXE_DAMAGE - DAMAGE_MARGIN, `the first hit cost ${lost}, not ${AXE_DAMAGE}: ${seen}`);
      assert.ok(secondHit >= low && secondHit <= high, `a second hit ${gap} ms (${ticksApart} server ticks) after the first cost ${secondHit}, not ${low.toFixed(2)} to ${high.toFixed(2)} (${RULE}): ${seen}`);
    }
    const swordHeld = markNow(subject);
    await holdInHand(subject, "iron_sword");
    await restSince(subject, swordHeld);
    const swapped = markNow(subject);
    await holdInHand(subject, "iron_axe");
    await subject.wait(AFTER_SWAP_MS);
    const { lost, ticksApart, seen } = await hitsAndHealthLost(subject, mobs[GAPS_MS.length]!, [0], swapped);
    const [low, high] = damageBounds(ticksApart, false);
    assert.ok(lost >= low && lost <= high, `a hit ${AFTER_SWAP_MS} ms (${ticksApart} server ticks) after the swap cost ${lost}, not ${low.toFixed(2)} to ${high.toFixed(2)}: a changed item starts the swing over (${seen})`);
  },
};
