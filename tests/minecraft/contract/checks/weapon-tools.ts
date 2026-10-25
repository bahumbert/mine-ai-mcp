/**
 * What each tool the tests swing costs a mob, and how fast it recovers (Mine Labs 1.21.4, 2026-10-24, 3 runs). The tools are the
 * ones the importers of the fake bot name (`git grep` of the tier_tool names in their tests: the fake throws for a tool it lacks,
 * and no test reaches the throw today, so the list is the tests' own). Each tool is equipped and rested past the slowest swing,
 * then hits three still, unarmored zombies: the first in full (the damage), the second 10 ticks after it (the swing's
 * strength then tells slow tools from fast ones) and the third 2 ticks after that (fast tools from slower ones). A hit costs
 * its damage times `0.2 + 0.8 * strength^2`, strength being the ticks since the last swing (half a tick more) over the swing
 * period (20 / attack speed), capped at 1 (`attack-cooldown-damage`). The zombies stand 3.2 to 4.5 blocks from the bot: a sword's
 * sweep reaches only what is within 3 of the attacker, so no sweep hits a zombie the check reads.
 *
 * The 21 tools take 2.3 to 3 s each on a lane (the rest after the equip, the two gaps and the readings of the server's tick), so the
 * table is split in four checks (`weapon-damage-swords`, `-axes`, `-pickaxes`, `-shovels-hoes`) that each run `weaponToolsCheck` on
 * a part of it: a contract check stays under the 25 s a check may take on a shared server (plan 2026-10-23-shared-scenario-server
 * T7d2 item 3; the first split in three measured 24.6-27.6 s for 8 and 7 tools).
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { ANSWER_WALL_MS } from "../server-answer.ts";
import { type ContractSubject, holdsWithin, settleWithin } from "../subject.ts";
import { NIGHT, STILL_MOB_NBT, TICK_MS, healthOf, holdInHand, mobAt } from "./combat-scene.ts";

/** The attack attribute (the hand's 1 included) and the swings a second of a tool, with the tiers' vanilla numbers. */
export interface Tool {
  readonly name: string;
  readonly damage: number;
  readonly speed: number;
}

/** The tools by kind: the parts of the table are made of whole kinds. */
export const TOOLS_BY_KIND = {
  sword: [
    { name: "wooden_sword", damage: 4, speed: 1.6 },
    { name: "stone_sword", damage: 5, speed: 1.6 },
    { name: "iron_sword", damage: 6, speed: 1.6 },
    { name: "golden_sword", damage: 4, speed: 1.6 },
    { name: "diamond_sword", damage: 7, speed: 1.6 },
  ],
  axe: [
    { name: "wooden_axe", damage: 7, speed: 0.8 },
    { name: "stone_axe", damage: 9, speed: 0.8 },
    { name: "iron_axe", damage: 9, speed: 0.9 },
    { name: "diamond_axe", damage: 9, speed: 1 },
  ],
  pickaxe: [
    { name: "wooden_pickaxe", damage: 2, speed: 1.2 },
    { name: "stone_pickaxe", damage: 3, speed: 1.2 },
    { name: "iron_pickaxe", damage: 4, speed: 1.2 },
    { name: "golden_pickaxe", damage: 2, speed: 1.2 },
    { name: "diamond_pickaxe", damage: 5, speed: 1.2 },
    { name: "netherite_pickaxe", damage: 6, speed: 1.2 },
  ],
  shovel: [
    { name: "wooden_shovel", damage: 2.5, speed: 1 },
    { name: "stone_shovel", damage: 3.5, speed: 1 },
    { name: "diamond_shovel", damage: 5.5, speed: 1 },
  ],
  hoe: [
    { name: "wooden_hoe", damage: 1, speed: 1 },
    { name: "stone_hoe", damage: 1, speed: 2 },
    { name: "iron_hoe", damage: 1, speed: 3 },
  ],
} as const satisfies Record<string, readonly Tool[]>;

/** Every tool the checks swing. */
export const TOOLS: readonly Tool[] = Object.values(TOOLS_BY_KIND).flat();

/** Zombies on the lattice cells whose centre is 3.2 to 4.5 blocks from the bot (arena-local). */
const BOT_LOCAL = [0.5, 0.5] as const;
const RING: readonly (readonly [number, number])[] = Array.from({ length: 11 }, (_, row) => Array.from({ length: 11 }, (_, column) => [column - 5, row - 5] as const))
  .flat()
  .filter(([dx, dz]) => dx * dx + dz * dz >= 10 && dx * dx + dz * dz <= 20)
  .map(([dx, dz]) => [BOT_LOCAL[0] + dx, BOT_LOCAL[1] + dz] as const);

/** The equip starts the swing over: the first hit waits for its period (20 / speed ticks) and this many ticks more, counted on the server. */
const REST_MARGIN_TICKS = 3;
/** The bot's own gaps between hits, on the wall clock: what the server counts between them is read, not assumed. */
const SECOND_GAP_MS = 500;
const THIRD_GAP_MS = 100;
/** A hit lands a tick or so after the reading sent before it, the same for each of two hits: the ticks between them are the readings' difference give or take this. */
const READING_SPREAD_TICKS = 1;
const FULL_HIT_TOLERANCE = 0.02;

/** The damage a swing `ticks` after the last costs, by the vanilla strength rule (`ticks` fractional: the bounds' spread). */
function partialDamage(damage: number, speed: number, ticks: number): number {
  const strength = Math.min(1, Math.max(0, (ticks + 0.5) / (20 / speed)));
  return damage * (0.2 + 0.8 * strength * strength);
}

/** The bounds a hit `ticks` of the server after the last costs for a tool: the spread of the reading either way. */
function partialBounds(damage: number, speed: number, ticks: number): readonly [number, number] {
  return [partialDamage(damage, speed, ticks - READING_SPREAD_TICKS) - FULL_HIT_TOLERANCE, partialDamage(damage, speed, ticks + READING_SPREAD_TICKS) + FULL_HIT_TOLERANCE];
}

/** The three healthiest zombies (a hit never kills one: the ring holds 40 zombies of 20 health for under 200 of damage in a part). */
function healthiest(subject: ContractSubject, mobs: readonly Entity[]): Entity[] {
  return [...mobs].sort((first, second) => healthOf(subject.bot, second) - healthOf(subject.bot, first)).slice(0, 3);
}

/** The ticks since the last swing a cost of `cost` says, by the strength rule run backwards (null for a full cost: any number of ticks past the period). */
function impliedTicks(tool: Tool, cost: number): number | null {
  const strength = Math.sqrt(Math.max(0, (cost / tool.damage - 0.2) / 0.8));
  return strength >= 1 ? null : strength * (20 / tool.speed) - 0.5;
}

/** The server's tick now, with the clock moving until the answer is in (a reading that is not tied to a hit). */
async function tickNow(subject: ContractSubject): Promise<number> {
  const settled = await settleWithin(subject, subject.serverGameTime(), ANSWER_WALL_MS);
  assert.ok(settled?.value !== undefined, `the server's tick was not read within ${ANSWER_WALL_MS} ms: ${settled?.error?.message ?? "no answer"}`);
  return settled.value;
}

/**
 * Wait until the swing is back (`REST_MARGIN_TICKS` past its period) since the reading `since`, taken right after the equip, which
 * starts the swing over; counted on the server's ticks, so a server behind its schedule rests for longer on the wall clock, up to
 * `ANSWER_WALL_MS`.
 */
async function restUntilSwingBack(subject: ContractSubject, tool: Tool, since: number): Promise<void> {
  const needed = Math.ceil(20 / tool.speed) + REST_MARGIN_TICKS;
  const startedAt = subject.now();
  for (;;) {
    const ran = (await tickNow(subject)) - since;
    if (ran >= needed) return;
    assert.ok(subject.now() - startedAt < ANSWER_WALL_MS, `${tool.name}: the swing was not back ${ANSWER_WALL_MS} ms after the equip: ${ran} ticks of ${needed} on the server`);
    await subject.wait((needed - ran) * TICK_MS);
  }
}

/**
 * One tool's three hits: the first after a rest, the second and third after the wall gaps. Each is sent right after the question of the
 * server's tick (`serverGameTime` sends it before it returns), so the server answers both in one tick or neighbouring ones and the two
 * readings of two hits bound the ticks between them. The answers are read at the end: the waits move the clock that runs them.
 */
async function hitThreeMobs(subject: ContractSubject, tool: Tool, mobs: readonly Entity[]) {
  const { bot } = subject;
  await holdInHand(subject, tool.name);
  const equipped = await tickNow(subject);
  const hit = healthiest(subject, mobs) as [Entity, Entity, Entity];
  const before = hit.map((mob) => healthOf(bot, mob));
  await restUntilSwingBack(subject, tool, equipped);
  const readings = [subject.serverGameTime()];
  bot.attack(hit[0]);
  await subject.wait(SECOND_GAP_MS);
  readings.push(subject.serverGameTime());
  bot.attack(hit[1]);
  await subject.wait(THIRD_GAP_MS);
  readings.push(subject.serverGameTime());
  bot.attack(hit[2]);
  // An unanswered question rejects when awaited below, not as an unhandled rejection on the way.
  readings.forEach((reading) => void reading.catch(() => undefined));
  // Every hit of a tool costs something, so each mob's health tells that its answer came; a hit that never lands is read as a cost of 0.
  await holdsWithin(subject, () => hit.every((mob, index) => healthOf(bot, mob) < before[index]!), ANSWER_WALL_MS);
  const [full, slower, faster] = hit.map((mob, index) => before[index]! - healthOf(bot, mob)) as [number, number, number];
  const [first, second, third] = (await Promise.all(readings)) as [number, number, number];
  return { full, slower, faster, ticksBetween: [second - first, third - second] as const };
}

/** Swing every tool of `tools` at three zombies and state what each hit cost. */
async function swingTools(subject: ContractSubject, tools: readonly Tool[]): Promise<void> {
  const mobs = await Promise.all(RING.map(([x, z]) => mobAt(subject, "zombie", x, z)));
  const wrong: string[] = [];
  const measured: string[] = [];
  for (const tool of tools) {
    const { full, slower, faster, ticksBetween } = await hitThreeMobs(subject, tool, mobs);
    measured.push(`${tool.name} ${full.toFixed(2)} ${slower.toFixed(2)} (${ticksBetween[0]} ticks) ${faster.toFixed(2)} (${ticksBetween[1]} ticks)`);
    if (Math.abs(full - tool.damage) > FULL_HIT_TOLERANCE) wrong.push(`${tool.name}: a full swing cost ${full}, not ${tool.damage}`);
    for (const [cost, ticks] of [[slower, ticksBetween[0]], [faster, ticksBetween[1]]] as const) {
      const [low, high] = partialBounds(tool.damage, tool.speed, ticks);
      if (cost < low || cost > high) wrong.push(`${tool.name}: a swing ${ticks} server ticks after the last cost ${cost} (${impliedTicks(tool, cost)?.toFixed(1) ?? "a full swing"} ticks), not ${low.toFixed(2)} to ${high.toFixed(2)} (speed ${tool.speed})`);
    }
  }
  assert.deepEqual(wrong, [], `tools measured (name, full, ${SECOND_GAP_MS} ms gap, ${THIRD_GAP_MS} ms gap; ticks are the server's between the hits): ${measured.join("; ")}`);
}

/** The contract check that swings `tools` (a part of the table) at the zombie ring. */
export function weaponToolsCheck(name: string, tools: readonly Tool[]): ContractCheck {
  return {
    name,
    fixture: {
      cells: {},
      carried: Object.fromEntries(tools.map((tool) => [tool.name, 1])),
      position: [0.5, -60, 0.5],
      timeOfDay: NIGHT,
      entities: RING.map(([x, z]) => ({ name: "zombie", position: [x, -60, z] as const, nbt: STILL_MOB_NBT })),
    },
    withoutRuntime: true,
    run: (subject) => swingTools(subject, tools),
  };
}
