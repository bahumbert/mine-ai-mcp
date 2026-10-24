/**
 * What each tool the tests swing costs a mob, and how fast it recovers (Mine Labs 1.21.4, 2026-10-24, 3 runs). The tools are the
 * ones the importers of the fake bot name (`git grep` of the tier_tool names in their tests: the fake throws for a tool it lacks,
 * and no test reaches the throw today, so the list is the tests' own). Each tool is equipped and rested past the slowest swing,
 * then hits three still, unarmored zombies: the first in full (the damage), the second 10 ticks after it (the swing's
 * strength then tells slow tools from fast ones) and the third 2 ticks after that (fast tools from slower ones). A hit costs
 * its damage times `0.2 + 0.8 * strength^2`, strength being the ticks since the last swing (half a tick more) over the swing
 * period (20 / attack speed), capped at 1 (`attack-cooldown-damage`). The zombies stand 3.2 to 4.5 blocks from the bot: a sword's
 * sweep reaches only what is within 3 of the attacker, so no sweep hits a zombie the check reads.
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import type { ContractSubject } from "../subject.ts";
import { NIGHT, STILL_MOB_NBT, healthOf, holdInHand, mobAt } from "./combat-scene.ts";

/** The attack attribute (the hand's 1 included) and the swings a second of each tool, with the tiers' vanilla numbers. */
const TOOLS: readonly { readonly name: string; readonly damage: number; readonly speed: number }[] = [
  { name: "wooden_sword", damage: 4, speed: 1.6 },
  { name: "stone_sword", damage: 5, speed: 1.6 },
  { name: "iron_sword", damage: 6, speed: 1.6 },
  { name: "golden_sword", damage: 4, speed: 1.6 },
  { name: "diamond_sword", damage: 7, speed: 1.6 },
  { name: "wooden_axe", damage: 7, speed: 0.8 },
  { name: "stone_axe", damage: 9, speed: 0.8 },
  { name: "iron_axe", damage: 9, speed: 0.9 },
  { name: "diamond_axe", damage: 9, speed: 1 },
  { name: "wooden_pickaxe", damage: 2, speed: 1.2 },
  { name: "stone_pickaxe", damage: 3, speed: 1.2 },
  { name: "iron_pickaxe", damage: 4, speed: 1.2 },
  { name: "golden_pickaxe", damage: 2, speed: 1.2 },
  { name: "diamond_pickaxe", damage: 5, speed: 1.2 },
  { name: "netherite_pickaxe", damage: 6, speed: 1.2 },
  { name: "wooden_shovel", damage: 2.5, speed: 1 },
  { name: "stone_shovel", damage: 3.5, speed: 1 },
  { name: "diamond_shovel", damage: 5.5, speed: 1 },
  { name: "wooden_hoe", damage: 1, speed: 1 },
  { name: "stone_hoe", damage: 1, speed: 2 },
  { name: "iron_hoe", damage: 1, speed: 3 },
];

/** Zombies on the lattice cells whose centre is 3.2 to 4.5 blocks from the bot (arena-local). */
const BOT_LOCAL = [0.5, 0.5] as const;
const RING: readonly (readonly [number, number])[] = Array.from({ length: 11 }, (_, row) => Array.from({ length: 11 }, (_, column) => [column - 5, row - 5] as const))
  .flat()
  .filter(([dx, dz]) => dx * dx + dz * dz >= 10 && dx * dx + dz * dz <= 20)
  .map(([dx, dz]) => [BOT_LOCAL[0] + dx, BOT_LOCAL[1] + dz] as const);

/** Rested past the slowest swing (0.8 a second: 25 ticks) after the equip, which starts the swing over. */
const REST_MS = 1_300;
const SECOND_GAP_MS = 500;
const THIRD_GAP_MS = 100;
const SETTLE_MS = 200;
/** A gap on the wall clock is the server's whole ticks give or take one. */
const TICK_JITTER = 1.2;
const FULL_HIT_TOLERANCE = 0.02;
const TICK_MS = 50;

/** The damage a swing `ticks` after the last costs, by the vanilla strength rule. */
function partialDamage(damage: number, speed: number, ticks: number): number {
  const strength = Math.min(1, Math.max(0, (ticks + 0.5) / (20 / speed)));
  return damage * (0.2 + 0.8 * strength * strength);
}

/** The bounds a hit `gapMs` after the last costs for a tool: a tick of jitter either way. */
function partialBounds(damage: number, speed: number, gapMs: number): readonly [number, number] {
  const ticks = gapMs / TICK_MS;
  return [partialDamage(damage, speed, ticks - TICK_JITTER) - FULL_HIT_TOLERANCE, partialDamage(damage, speed, ticks + TICK_JITTER) + FULL_HIT_TOLERANCE];
}

/** The three healthiest zombies (a hit never kills one: the grid holds 30 of 20 health for about 200 of damage). */
function healthiest(subject: ContractSubject, mobs: readonly Entity[]): Entity[] {
  return [...mobs].sort((first, second) => healthOf(subject.bot, second) - healthOf(subject.bot, first)).slice(0, 3);
}

export const weaponDamageTools: ContractCheck = {
  name: "weapon-damage-tools",
  fixture: {
    cells: {},
    carried: Object.fromEntries(TOOLS.map(({ name }) => [name, 1])),
    position: [0.5, -60, 0.5],
    timeOfDay: NIGHT,
    entities: RING.map(([x, z]) => ({ name: "zombie", position: [x, -60, z] as const, nbt: STILL_MOB_NBT })),
  },
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const mobs = await Promise.all(RING.map(([x, z]) => mobAt(subject, "zombie", x, z)));
    const wrong: string[] = [];
    const measured: string[] = [];
    for (const tool of TOOLS) {
      await holdInHand(subject, tool.name);
      await subject.wait(REST_MS);
      const [first, second, third] = healthiest(subject, mobs) as [Entity, Entity, Entity];
      const before = [first, second, third].map((mob) => healthOf(bot, mob));
      bot.attack(first);
      await subject.wait(SECOND_GAP_MS);
      bot.attack(second);
      await subject.wait(THIRD_GAP_MS);
      bot.attack(third);
      await subject.wait(SETTLE_MS);
      const [full, slower, faster] = [first, second, third].map((mob, index) => before[index]! - healthOf(bot, mob)) as [number, number, number];
      measured.push(`${tool.name} ${full.toFixed(2)} ${slower.toFixed(2)} ${faster.toFixed(2)}`);
      if (Math.abs(full - tool.damage) > FULL_HIT_TOLERANCE) wrong.push(`${tool.name}: a full swing cost ${full}, not ${tool.damage}`);
      for (const [cost, gap] of [[slower, SECOND_GAP_MS], [faster, THIRD_GAP_MS]] as const) {
        const [low, high] = partialBounds(tool.damage, tool.speed, gap);
        if (cost < low || cost > high) wrong.push(`${tool.name}: a swing ${gap} ms after the last cost ${cost}, not ${low.toFixed(2)} to ${high.toFixed(2)} (speed ${tool.speed})`);
      }
    }
    assert.deepEqual(wrong, [], `tools measured (name, full, ${SECOND_GAP_MS} ms, ${THIRD_GAP_MS} ms): ${measured.join("; ")}`);
  },
};
