// Pure threat assessment: measured mob damage, the bot's armour and weapon and the mob count become one fight margin.
import type { DamageScaling, ItemAttack, MobCombatData } from "../../../world/combat-data.js";

/** Ticks between a mob's melee hits: vanilla `MeleeAttackGoal`, decompiled 1.21.4, unmeasured (P4-06a T6 measures). */
export const MOB_MELEE_INTERVAL_TICKS = 20;
/** Ticks a hurt entity ignores hits no stronger than the last: vanilla `LivingEntity` invulnerableTime / 2, unmeasured. */
export const HURT_IMMUNITY_TICKS = 10;
/** Vanilla `Mob` default `max_health`, used when neither the metadata nor the data gives one. */
export const UNKNOWN_MOB_HEALTH = 20;
/** Server ticks per second, to turn an attack speed (swings per second) into a swing interval. */
const TICKS_PER_SECOND = 20;

export type Difficulty = "peaceful" | "easy" | "normal" | "hard";

export interface ContactAssessment {
  readonly id: number;
  readonly species: string;
  /** Health this contact takes from the bot per hit, after armour and difficulty; null: it does not melee and no hit was seen. */
  readonly damagePerHit: number | null;
  readonly damageSource: "observed" | "attribute" | "none";
  /** The measured melee damage varies by individual and this bot has not yet observed its hit cost. */
  readonly unknownMelee: boolean;
  /** Ticks between its hits: observed, else the vanilla melee interval. */
  readonly hitIntervalTicks: number;
  /** Its health now (its `health` metadata), else its measured max_health. */
  readonly health: number;
  /** The bot's hits needed, with the weapon of `bot.weapon`, after the contact's armour. */
  readonly hitsToKill: number;
  readonly ticksToKill: number;
  /** The bot's hits it survives from this contact alone; null when it deals nothing. */
  readonly hitsToKillBot: number | null;
  /** Self-explosion data (radius, fuse ticks), the fuse left (null unobserved) and the blast damage at the bot's melee
   * reach after armour; null when it has none. Such a contact has `damagePerHit` null and stays out of the totals. */
  readonly explosion: {
    readonly radius: number;
    readonly fuseTicks: number;
    readonly fuseRemainingTicks: number | null;
    readonly damageAtReach: number;
  } | null;
  readonly inContact: boolean;
}

export interface ThreatAssessment {
  readonly bot: { readonly effectiveHealth: number; readonly armor: number; readonly toughness: number };
  readonly weapon: { readonly item: string | null; readonly damage: number; readonly intervalTicks: number };
  readonly contacts: readonly ContactAssessment[];
  /** Over the contacts in contact: ticks until the bot dies if all of them keep hitting; null when none deals damage. */
  readonly ticksToDie: number | null;
  /** Ticks the bot needs to kill every damaging contact in contact, one after the other. */
  readonly ticksToClear: number;
  /** Health the bot loses while it kills them one by one, nearest first, each still alive hitting at its rate, the
   * summed rate capped by the bot's hurt window. */
  readonly healthLostToClear: number;
  /** effectiveHealth / healthLostToClear; null when nothing in contact deals damage or every
   * damaging contact is already at 0 health (JSON keeps null, not Infinity).
   * The number `fight_margin` is compared with. */
  readonly margin: number | null;
  readonly source: { readonly version: string; readonly measured: boolean };
}

export interface AssessmentInput {
  readonly bot: { readonly health: number; readonly absorption: number; readonly armor: number; readonly toughness: number };
  readonly difficulty: Difficulty;
  /** Damage type `mob_attack`'s scaling. */
  readonly mobAttackScaling: DamageScaling | null;
  /** Damage type `explosion`'s scaling. */
  readonly explosionScaling: DamageScaling | null;
  readonly weapon: { readonly item: string | null; readonly attack: ItemAttack };
  readonly bareHand: ItemAttack;
  /** The bot's melee reach (`MELEE_RANGE`, src/survival/weapons/equipment.ts). */
  readonly meleeReach: number;
  readonly contacts: readonly {
    readonly id: number;
    readonly species: string;
    readonly distance: number;
    readonly inContact: boolean;
    readonly data: MobCombatData | null;
    /** Its `health` metadata, null when unread. */
    readonly health: number | null;
    readonly heldItemAttack: ItemAttack | null;
    /** Health one of its hits cost this bot (armour and difficulty already applied), null when unobserved. */
    readonly observedHitDamage: number | null;
    readonly unknownMelee?: boolean;
    readonly observedIntervalTicks: number | null;
    readonly fuseRemainingTicks: number | null;
  }[];
  readonly source: { readonly version: string; readonly measured: boolean };
}

type ContactInput = AssessmentInput["contacts"][number];

/**
 * Damage after the difficulty rule of the damage type's scaling (jar `damage_type` json, T1a) —
 * decompiled 1.21.4 `Difficulty` handling in `LivingEntity.hurtServer`, unmeasured; P4-06a T6 compares one hit with the server.
 * Scaling `never` has no rule; `always`, `when_caused_by_living_non_player` and an unknown type (null) follow it.
 */
export function scaleForDifficulty(damage: number, difficulty: Difficulty, scaling: DamageScaling | null): number {
  if (scaling === "never") return damage;
  if (difficulty === "peaceful") return 0;
  if (difficulty === "easy") return Math.min(damage / 2 + 1, damage);
  if (difficulty === "hard") return damage * 1.5;
  return damage;
}

/** Damage after armour and toughness — decompiled 1.21.4 `CombatRules.getDamageAfterAbsorb`, unmeasured; checked by T6. */
export function damageAfterArmor(damage: number, armor: number, toughness: number): number {
  const reduction = Math.min(Math.max(armor - damage / (2 + toughness / 4), armor / 5), 20);
  return damage * (1 - reduction / 25);
}

/**
 * Blast damage at distance `distance` from an explosion of radius `radius`, full exposure — decompiled 1.21.4
 * `Explosion.explode`, unmeasured; checked by T6. 0 past twice the radius.
 */
export function explosionDamage(distance: number, radius: number): number {
  const impact = 1 - distance / (2 * radius);
  if (impact <= 0) return 0;
  return ((impact * impact + impact) / 2) * 7 * 2 * radius + 1;
}

/** A weapon that cannot hurt or never swings falls back to the bare hand, so no tick count is infinite. */
function usableAttack(attack: ItemAttack, bareHand: ItemAttack): ItemAttack {
  return attack.attackDamage > 0 && attack.attackSpeed > 0 ? attack : bareHand;
}

/** Ticks between the bot's swings: the attack speed, but never inside the target's hurt window. */
function swingIntervalTicks(attack: ItemAttack): number {
  return Math.max(TICKS_PER_SECOND / attack.attackSpeed, HURT_IMMUNITY_TICKS);
}

/** An observation can only shorten the interval: a mob that caught up after an evade must not look slow. */
function hitIntervalTicks(contact: ContactInput): number {
  const observed = contact.observedIntervalTicks;
  if (observed === null || !(observed > 0)) return MOB_MELEE_INTERVAL_TICKS;
  return Math.min(observed, MOB_MELEE_INTERVAL_TICKS);
}

/** Metadata health, else the measured maximum, else the vanilla default; a NaN read counts as unread. */
function contactHealth(contact: ContactInput): number {
  const candidates = [contact.health, contact.data?.maxHealth];
  return candidates.find((value): value is number => typeof value === "number" && Number.isFinite(value)) ?? UNKNOWN_MOB_HEALTH;
}

/** Attribute damage plus the held item's bonus over the bare hand, scaled by difficulty, then reduced by armour. */
function attributeHitDamage(contact: ContactInput, data: MobCombatData, input: AssessmentInput): number | null {
  if (data.attackDamage === null) return null;
  const heldBonus = contact.heldItemAttack === null ? 0 : Math.max(0, contact.heldItemAttack.attackDamage - input.bareHand.attackDamage);
  const scaled = scaleForDifficulty(data.attackDamage + heldBonus, input.difficulty, input.mobAttackScaling);
  return damageAfterArmor(scaled, input.bot.armor, input.bot.toughness);
}

function hitDamage(contact: ContactInput, input: AssessmentInput): Pick<ContactAssessment, "damagePerHit" | "damageSource"> {
  // The recorder never keeps a 0 (a shield, the hurt window); a 0 that arrives anyway must not make a mob look harmless.
  if (contact.observedHitDamage !== null && contact.observedHitDamage > 0) return { damagePerHit: contact.observedHitDamage, damageSource: "observed" };
  const attribute = contact.data === null ? null : attributeHitDamage(contact, contact.data, input);
  return attribute === null ? { damagePerHit: null, damageSource: "none" } : { damagePerHit: attribute, damageSource: "attribute" };
}

function explosionOf(contact: ContactInput, input: AssessmentInput): ContactAssessment["explosion"] {
  const explosion = contact.data?.explosion;
  if (!explosion) return null;
  const blast = scaleForDifficulty(explosionDamage(input.meleeReach, explosion.radius), input.difficulty, input.explosionScaling);
  return {
    radius: explosion.radius,
    fuseTicks: explosion.fuseTicks,
    fuseRemainingTicks: contact.fuseRemainingTicks,
    damageAtReach: damageAfterArmor(blast, input.bot.armor, input.bot.toughness),
  };
}

function assessContact(contact: ContactInput, input: AssessmentInput, ourAttack: ItemAttack, effectiveHealth: number): ContactAssessment {
  const explosion = explosionOf(contact, input);
  const { damagePerHit, damageSource } = explosion === null ? hitDamage(contact, input) : { damagePerHit: null, damageSource: "none" as const };
  const health = contactHealth(contact);
  const ourHit = damageAfterArmor(ourAttack.attackDamage, contact.data?.armor ?? 0, contact.data?.armorToughness ?? 0);
  const hitsToKill = Math.ceil(health / ourHit);
  return {
    id: contact.id,
    species: contact.species,
    damagePerHit,
    damageSource,
    unknownMelee: contact.unknownMelee === true && damageSource !== "observed",
    hitIntervalTicks: hitIntervalTicks(contact),
    health,
    hitsToKill,
    ticksToKill: hitsToKill * swingIntervalTicks(ourAttack),
    hitsToKillBot: damagePerHit ? Math.ceil(effectiveHealth / damagePerHit) : null,
    explosion,
    inContact: contact.inContact,
  };
}

/**
 * Health per tick the bot loses to `fighters`: each hits every interval, but the bot's hurt window lets through at
 * most the strongest hit per `HURT_IMMUNITY_TICKS`.
 */
function damageRate(fighters: readonly ContactAssessment[]): number {
  let summed = 0;
  let strongest = 0;
  for (const fighter of fighters) {
    summed += fighter.damagePerHit! / fighter.hitIntervalTicks;
    strongest = Math.max(strongest, fighter.damagePerHit!);
  }
  return Math.min(summed, strongest / HURT_IMMUNITY_TICKS);
}

/** The contacts that melee the bot now, nearest first (ties by id): the order a fight usually kills them in. */
function killOrder(assessed: readonly ContactAssessment[], inputs: readonly ContactInput[]): ContactAssessment[] {
  const distanceOf = new Map(inputs.map((contact) => [contact.id, contact.distance]));
  return assessed
    .filter((contact) => contact.inContact && contact.damagePerHit !== null && contact.damagePerHit > 0)
    .sort((a, b) => distanceOf.get(a.id)! - distanceOf.get(b.id)! || a.id - b.id);
}

/**
 * Weighs the bot against the mobs touching it: pure, built from the measured combat data (T1) and the live facts.
 * Contacts that deal no melee damage (explosives, unknown species, peaceful) stay out of the totals.
 */
export function assessThreats(input: AssessmentInput): ThreatAssessment {
  const ourAttack = usableAttack(input.weapon.attack, input.bareHand);
  const effectiveHealth = input.bot.health + input.bot.absorption;
  const assessed = input.contacts.map((contact) => assessContact(contact, input, ourAttack, effectiveHealth));
  const fighters = killOrder(assessed, input.contacts);

  let healthLostToClear = 0;
  let ticksToClear = 0;
  fighters.forEach((killed, index) => {
    healthLostToClear += damageRate(fighters.slice(index)) * killed.ticksToKill;
    ticksToClear += killed.ticksToKill;
  });
  const rate = fighters.length === 0 ? 0 : damageRate(fighters);

  return {
    bot: { effectiveHealth, armor: input.bot.armor, toughness: input.bot.toughness },
    // The bare-hand fallback reports the bare hand, so the item label and the numbers agree.
    weapon: { item: ourAttack === input.weapon.attack ? input.weapon.item : null, damage: ourAttack.attackDamage, intervalTicks: swingIntervalTicks(ourAttack) },
    contacts: assessed,
    ticksToDie: rate > 0 ? effectiveHealth / rate : null,
    ticksToClear,
    healthLostToClear,
    margin: healthLostToClear > 0 ? effectiveHealth / healthLostToClear : null,
    source: input.source,
  };
}
