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

/** A mob that no record or metadata gives a health has this (a zombie, a creeper); the server's spawn data files it in the `health` metadata of a creature. */
export const DEFAULT_MOB_HEALTH = 20;
/** Entity types that are not creatures a hit hurts (a player, a projectile, an item or a boat is `other`). */
export const NOT_HURTABLE_TYPES: ReadonlySet<string> = new Set(["player", "projectile", "other"]);

/**
 * The hand and the weapons the checks measured (armor off): the iron sword and axe by `attack-cooldown-damage` (6 and 9, speeds from
 * the swing periods of 12.5 and 22 ticks), the others by `weapon-damage-tools`, which hit three zombies per tool (a full swing, 10 ticks
 * after it, 2 ticks after that): the tools the importers' tests name, 3 runs on the 1.21.4 server, vanilla's numbers every time.
 */
const HAND: Weapon = { damage: 1, attackSpeed: 4 };
const SWORD_SPEED = 1.6;
const PICKAXE_SPEED = 1.2;
const MEASURED_WEAPONS: Readonly<Record<string, Weapon>> = {
  wooden_sword: { damage: 4, attackSpeed: SWORD_SPEED },
  stone_sword: { damage: 5, attackSpeed: SWORD_SPEED },
  iron_sword: { damage: 6, attackSpeed: SWORD_SPEED },
  golden_sword: { damage: 4, attackSpeed: SWORD_SPEED },
  diamond_sword: { damage: 7, attackSpeed: SWORD_SPEED },
  wooden_axe: { damage: 7, attackSpeed: 0.8 },
  stone_axe: { damage: 9, attackSpeed: 0.8 },
  iron_axe: { damage: 9, attackSpeed: 0.9 },
  diamond_axe: { damage: 9, attackSpeed: 1 },
  wooden_pickaxe: { damage: 2, attackSpeed: PICKAXE_SPEED },
  stone_pickaxe: { damage: 3, attackSpeed: PICKAXE_SPEED },
  iron_pickaxe: { damage: 4, attackSpeed: PICKAXE_SPEED },
  golden_pickaxe: { damage: 2, attackSpeed: PICKAXE_SPEED },
  diamond_pickaxe: { damage: 5, attackSpeed: PICKAXE_SPEED },
  netherite_pickaxe: { damage: 6, attackSpeed: PICKAXE_SPEED },
  wooden_shovel: { damage: 2.5, attackSpeed: 1 },
  stone_shovel: { damage: 3.5, attackSpeed: 1 },
  diamond_shovel: { damage: 5.5, attackSpeed: 1 },
  wooden_hoe: { damage: 1, attackSpeed: 1 },
  stone_hoe: { damage: 1, attackSpeed: 2 },
  iron_hoe: { damage: 1, attackSpeed: 3 },
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

/** How much of a swing is back `ticksSinceLastSwing` after the last one, 0 to 1 (`Player.getAttackStrengthScale`). */
export function swingStrength(weapon: Weapon, ticksSinceLastSwing: number): number {
  return Math.min(1, Math.max(0, (ticksSinceLastSwing + 0.5) / swingPeriodTicks(weapon)));
}

/** What a swing deals `ticksSinceLastSwing` after the last one: the weapon's damage by `0.2 + 0.8 * strength^2` (`Player.attack`). */
export function swingDamage(weapon: Weapon, ticksSinceLastSwing: number): number {
  const strength = swingStrength(weapon, ticksSinceLastSwing);
  return weapon.damage * (0.2 + 0.8 * strength * strength);
}

/** A sprinting hit with a swing past 0.9 of its strength adds a second push of 0.5 along the way the attacker looks (`Player.attack`; contract check `attack-mob-knockback`: 0.7 in all with the first). */
export const SPRINT_BONUS_ABOVE_STRENGTH = 0.9;
export const SPRINT_KNOCKBACK = 0.5;

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

/** The notchian velocity of a motion as the server's trackers send it: truncated to 1/8000 (3011 for 3011.8; `+ 0` turns a truncated negative zero into the int zero). */
export function notchVelocity(velocity: Vec3): { x: number; y: number; z: number } {
  return { x: Math.trunc(velocity.x * VELOCITY_UNIT) + 0, y: Math.trunc(velocity.y * VELOCITY_UNIT) + 0, z: Math.trunc(velocity.z * VELOCITY_UNIT) + 0 };
}

/** What the client holds of a velocity packet's notch: `fromNotchVelocity` of `entities.js:302-307`. */
export function fromNotchVelocity(notch: { x: number; y: number; z: number }): Vec3 {
  return new Vec3(notch.x / VELOCITY_UNIT, notch.y / VELOCITY_UNIT, notch.z / VELOCITY_UNIT);
}
/** A hit pushes the victim 0.4 away sideways and up by 0.3608 off the ground (measured: x 3200, y 2886 of 8000; 0.4 less half the resting fall speed of 0.0784). */
export const KNOCKBACK_SIDEWAYS = 0.4;
export const KNOCKBACK_UP = 0.3608;

/** The push of a hit on a creature at `victim` from `source`: sideways away from it, and up. */
export function knockbackFrom(source: Vec3, victim: Vec3): Vec3 {
  const away = new Vec3(victim.x - source.x, 0, victim.z - source.z);
  const sideways = away.norm() === 0 ? away : away.normalize().scaled(KNOCKBACK_SIDEWAYS);
  return new Vec3(sideways.x, KNOCKBACK_UP, sideways.z);
}

/** A blast reaches twice its power; a creeper's is 3 (`explosion-knockback`), a fireball's 1 (`deflect-fireball`: the knockback 0.46 at a distance of 1.08). */
const CREEPER_BLAST_POWER = 3;
/** Easy scales an attack's damage down to half and one more, never above itself (`Player.hurtServer`; 3.54 of 5.08 at 5 blocks measured with the difficulty set). */
export function easyDamage(amount: number): number {
  return Math.min(amount / 2 + 1, amount);
}

/** What a blast at `blast` does to a creature whose feet are at `feet` and eye `eyeHeight` above: its push and damage, null out of reach. */
export function blastOn(blast: Vec3, feet: Vec3, eyeHeight: number, power = CREEPER_BLAST_POWER): { readonly knockback: Vec3; readonly damage: number } | null {
  const distance = blast.distanceTo(feet);
  const strength = 1 - distance / (2 * power);
  if (strength < 0) return null;
  const towardEye = feet.offset(0, eyeHeight, 0).minus(blast);
  const knockback = towardEye.norm() === 0 ? new Vec3(0, 0, 0) : towardEye.normalize().scaled(strength);
  return { knockback, damage: easyDamage(((strength * strength + strength) / 2) * 14 * power + 1) };
}

/** What a mob's projectile does to the bot (contract check `projectile-hit-bot`): how fast it flies (blocks a tick, as the check summons it), its damage type and whether it sets her on fire. */
export type ShotProjectile = "arrow" | "small_fireball";
export const SHOTS: Readonly<Record<ShotProjectile, { readonly speed: number; readonly damageType: string; readonly setsFire: boolean }>> = {
  arrow: { speed: 1.6, damageType: "arrow", setsFire: false },
  small_fireball: { speed: 1, damageType: "fireball", setsFire: true },
};
/** Fire lasts 5 s and costs 1 of `on_fire` damage a second, the 4th at 4 s (measured: 1.0, 2.0, 3.0, 4.0 s after the hit, the flag out at 5.0). */
export const FIRE_TICKS = 100;
export const BURN_EVERY_TICKS = 20;
export const BURN_DAMAGE = 1;

const GROUND_FRICTION = 0.91 * 0.6;
const GRAVITY = 0.08;
const VERTICAL_DRAG = 0.98;
/** A push sent after the victim's own tick (a projectile's hit lands before the player ticks): friction on the ground plane, then gravity and drag (measured: 1747 and 2201 of 8000 for 0.4 and 0.3608). */
export function afterOnePhysicsTick(push: Vec3): Vec3 {
  return new Vec3(push.x * GROUND_FRICTION, (push.y - GRAVITY) * VERTICAL_DRAG, push.z * GROUND_FRICTION);
}

/**
 * A ghast's fireball (contract check `deflect-fireball`, Mine Labs 1.21.4, 2026-10-24). Each tick its velocity becomes `0.95 * (v + 0.02 * unit(v))`
 * as launched (`acceleration_power`) and it moves by it; a hit in reach sets it flying along the way the attacker looks at 1 block a
 * tick with an acceleration of 0.1. It hits the bot for 6, which the difficulty does not scale (no living owner), and a blast of power 1 follows.
 */
export const FIREBALL_DRAG = 0.95;
export const FIREBALL_LAUNCH_POWER = 0.02;
export const FIREBALL_DEFLECTED_POWER = 0.1;
export const FIREBALL_DEFLECTED_SPEED = 1;
export const FIREBALL_HIT_DAMAGE = 6;
export const FIREBALL_BLAST_POWER = 1;
