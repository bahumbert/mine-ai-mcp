/**
 * The numbers of a fight as the 1.21.4 server gives them (contract checks `attack-hurts-and-kills`, `attack-cooldown-damage`,
 * `attack-out-of-reach`, `explosion-knockback`, `damage-event-to-bot`, Mine Labs 2026-10-23): the damage a swing deals by the
 * ticks since the last one, the hurt window a mob keeps after a hit, and a blast's push and damage. Vanilla's rules where the
 * checks measured them; the weapons are the measured ones (the fake throws for a tool it does not know).
 */
import { Vec3 } from "vec3";

/** A held item's hit: its damage (the attack attribute, the hand's included) and the swings a second it allows. */
export interface Weapon {
  readonly damage: number;
  readonly attackSpeed: number;
}

/** The hand and the weapons the checks measured (6 and 9 with the armor off, speeds from the swing periods of 12.5 and 22 ticks). */
const HAND: Weapon = { damage: 1, attackSpeed: 4 };
const MEASURED_WEAPONS: Readonly<Record<string, Weapon>> = {
  iron_sword: { damage: 6, attackSpeed: 1.6 },
  iron_axe: { damage: 9, attackSpeed: 0.9 },
};
/** Items whose hit differs from the hand's and that no check measured. */
const UNMEASURED_TOOL = /_(sword|axe|pickaxe|shovel|hoe)$|^(trident|mace)$/u;

/** The weapon a held item is; an item that is not a tool hits as the hand does. */
export function weaponOf(heldName: string | undefined): Weapon {
  if (heldName === undefined) return HAND;
  const known = MEASURED_WEAPONS[heldName];
  if (known !== undefined) return known;
  if (UNMEASURED_TOOL.test(heldName)) throw new Error(`the fake bot does not know the damage of ${heldName}: add a measured weapon to fake-bot-combat-rules.ts with a contract check`);
  return HAND;
}

const TICKS_PER_SECOND = 20;

/** The swing's recovery in ticks (`Player.getCurrentItemAttackStrengthDelay`). */
function swingPeriodTicks(weapon: Weapon): number {
  return TICKS_PER_SECOND / weapon.attackSpeed;
}

/** What a swing deals `ticksSinceLastSwing` after the last one: the weapon's damage by `0.2 + 0.8 * strength^2` (`Player.attack`). */
export function swingDamage(weapon: Weapon, ticksSinceLastSwing: number): number {
  const strength = Math.min(1, Math.max(0, (ticksSinceLastSwing + 0.5) / swingPeriodTicks(weapon)));
  return weapon.damage * (0.2 + 0.8 * strength * strength);
}

/** A mob keeps this many ticks of invulnerability after a hit, and takes a fresh hit in full once it is down to `HURT_WINDOW_OPEN_BELOW` (measured: 100 ms none, 520 ms full). */
export const HURT_WINDOW_TICKS = 20;
const HURT_WINDOW_OPEN_BELOW = 10;

/** What a hurt does to a creature that was `invulnerableTicks` into its hurt window with `lastHurt` taken (`LivingEntity.hurtServer`): nothing, the excess of a bigger hit, or all of it. */
/** Whether a hurt now opens the window afresh and is told to the client; inside it only the excess of a bigger hit counts and nothing is told. */
export function opensHurtWindow(invulnerableTicks: number): boolean {
  return invulnerableTicks <= HURT_WINDOW_OPEN_BELOW;
}

export function damageTaken(amount: number, invulnerableTicks: number, lastHurt: number): number {
  if (opensHurtWindow(invulnerableTicks)) return amount;
  return amount > lastHurt ? amount - lastHurt : 0;
}

/** Notchian velocity is sent in 1/8000 of a block per tick. */
export const VELOCITY_UNIT = 8_000;
/** A hit pushes the victim 0.4 away sideways and up by 0.36 off the ground (measured: x 3200, y 2886 of 8000). */
export const KNOCKBACK_SIDEWAYS = 0.4;
export const KNOCKBACK_UP = 0.36;

/** The push of a hit on a creature at `victim` from `source`: sideways away from it, and up. */
export function knockbackFrom(source: Vec3, victim: Vec3): Vec3 {
  const away = new Vec3(victim.x - source.x, 0, victim.z - source.z);
  const sideways = away.norm() === 0 ? away : away.normalize().scaled(KNOCKBACK_SIDEWAYS);
  return new Vec3(sideways.x, KNOCKBACK_UP, sideways.z);
}

/** A creeper's blast reaches twice its power of 3 (`explosion-knockback`). */
const BLAST_REACH = 6;
/** Easy scales an attack's damage down to half and one more, never above itself (`Player.hurtServer`; 3.54 of 5.08 at 5 blocks measured with the difficulty set). */
function easyDamage(amount: number): number {
  return Math.min(amount / 2 + 1, amount);
}

/** What a blast at `blast` does to a creature whose feet are at `feet` and eye `eyeHeight` above: its push and damage, null out of reach. */
export function blastOn(blast: Vec3, feet: Vec3, eyeHeight: number): { readonly knockback: Vec3; readonly damage: number } | null {
  const distance = blast.distanceTo(feet);
  const strength = 1 - distance / BLAST_REACH;
  if (strength < 0) return null;
  const towardEye = feet.offset(0, eyeHeight, 0).minus(blast);
  const knockback = towardEye.norm() === 0 ? new Vec3(0, 0, 0) : towardEye.normalize().scaled(strength);
  return { knockback, damage: easyDamage(((strength * strength + strength) / 2) * 42 + 1) };
}
