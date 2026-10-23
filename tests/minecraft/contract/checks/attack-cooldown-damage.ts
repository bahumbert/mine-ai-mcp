/**
 * What a second hit does to a mob already hurt, told by the gap between the hits (Mine Labs 1.21.4, 2026-10-23, 3 runs; an iron
 * axe: 9 damage, a swing worth a full hit after ~22 ticks). A hit a tick after the first changes nothing, no packet (the
 * mob's hurt window: it holds the damage of the last hit for 10 ticks). Past the window the second hit costs its damage times
 * `0.2 + 0.8 * strength^2`, the strength being the ticks since the attacker's last hit over the swing period (a 600 ms gap:
 * about a half, so 4 of 9; 1 s: nearly full; 1.6 s: full), and changing the held item starts the count over (a swing 100 ms
 * after the swap costs 2).
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import type { ContractSubject } from "../subject.ts";
import { NIGHT, STILL_MOB_NBT, ZOMBIE_HEALTH, healthOf, holdInHand, mobAt } from "./combat-scene.ts";

const AXE_DAMAGE = 9;
/** A gap, the damage the second hit then costs (min, max: a gap of a tick more or less moves it), and why. */
const GAPS_MS: readonly { readonly gap: number; readonly second: readonly [number, number]; readonly why: string }[] = [
  { gap: 50, second: [0, 0.01], why: "inside the hurt window the mob takes nothing" },
  { gap: 600, second: [3.4, 4.9], why: "past the window with half a swing" },
  { gap: 1_000, second: [7.2, 8.9], why: "almost a full swing" },
  { gap: 1_600, second: [8.95, 9.05], why: "a full swing" },
];
/** The swing after the held item changed: 2 or 3 ticks of a 22-tick swing. */
const AFTER_SWAP_MS = 100;
const AFTER_SWAP_DAMAGE: readonly [number, number] = [1.6, 2.6];
/** A swing rested this long is full (more than the axe's period). */
const REST_MS = 1_500;
const SETTLE_MS = 150;

const MOB_PLACES: readonly (readonly [number, number])[] = [[0.5, 2.5], [2.5, 0.5], [-2.5, 0.5], [0.5, -2.5], [2.5, 2.5]];

/** The health `mob` loses to `hits` (each `waitMs` before the next) and the settle after. */
async function healthLostAfter(subject: ContractSubject, mob: Entity, waitsMs: readonly number[]): Promise<number> {
  const { bot } = subject;
  for (const waitMs of waitsMs) {
    bot.attack(mob);
    await subject.wait(waitMs);
  }
  await subject.wait(SETTLE_MS);
  return ZOMBIE_HEALTH - healthOf(bot, mob);
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
    await holdInHand(subject, "iron_axe");
    await subject.wait(REST_MS);
    for (const [index, { gap, second, why }] of GAPS_MS.entries()) {
      const lost = await healthLostAfter(subject, mobs[index]!, [gap, 0]);
      const secondHit = lost - AXE_DAMAGE;
      assert.ok(lost >= AXE_DAMAGE - 0.01, `the first hit cost ${lost}, not ${AXE_DAMAGE}`);
      assert.ok(secondHit >= second[0] && secondHit <= second[1], `a second hit ${gap} ms after the first cost ${secondHit}, not ${second[0]} to ${second[1]} (${why})`);
      await subject.wait(REST_MS);
    }
    await holdInHand(subject, "iron_sword");
    await subject.wait(REST_MS);
    await holdInHand(subject, "iron_axe");
    await subject.wait(AFTER_SWAP_MS);
    const swapped = await healthLostAfter(subject, mobs[GAPS_MS.length]!, [0]);
    assert.ok(swapped >= AFTER_SWAP_DAMAGE[0] && swapped <= AFTER_SWAP_DAMAGE[1], `a hit ${AFTER_SWAP_MS} ms after the swap cost ${swapped}, not ${AFTER_SWAP_DAMAGE.join(" to ")}: a changed item starts the swing over`);
  },
};
