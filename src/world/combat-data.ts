/**
 * The combat numbers the server keeps, shipped per measured version (`data/combat-data/`): what each mob species has (health,
 * attack, armour, a self-explosion), what each item adds to the bot's hit, and how the difficulty scales each damage type.
 * Measured on the real server by the Mine Labs checks `combat-data-mobs` and `combat-data-items-*` and written by
 * `combat-data-write.ts`; the runtime never reads a jar. Nothing here is a list of names: a species or item the data lacks
 * answers null or the bare hand, never a guess.
 */
import type { CombatDataFile, MeasuredItemAttack } from "./combat-data-file.js";
import data_1_21_4 from "./data/combat-data/1.21.4.json" with { type: "json" };
import { compareVersions, nearestShipped } from "./shipped-data.js";

/** Shipped data files. Add one with `combat-data-write.ts`, then list it here. */
const SHIPPED: readonly CombatDataFile[] = [data_1_21_4];

/**
 * What the server keeps of one mob species. A field is null when the species has no such attribute (a ghast has no `attack_damage`: it
 * does not melee) or when it varies between individuals (a slime's size, a hoglin's age): `variesFields` tells the two apart.
 */
export interface MobCombatData {
  readonly maxHealth: number | null;
  readonly attackDamage: number | null;
  /** 0 when the data holds none: the species has no armour attribute, or its armour varies (`variesFields`). */
  readonly armor: number;
  readonly armorToughness: number;
  readonly movementSpeed: number | null;
  readonly followRange: number | null;
  readonly explosion: { readonly radius: number; readonly fuseTicks: number } | null;
  readonly rangedExplosionPower: number | null;
}
export type ItemAttack = MeasuredItemAttack;
export type DamageScaling = "never" | "always" | "when_caused_by_living_non_player";
const DAMAGE_SCALINGS: readonly string[] = ["never", "always", "when_caused_by_living_non_player"] satisfies readonly DamageScaling[];

/**
 * The file for `version`: its own, else the nearest older shipped one, else the oldest newer one (such data rarely changes between
 * versions, and a server with no combat data at all would leave every fight unweighed).
 */
export function nearestCombatData(version: string, files: readonly CombatDataFile[]): CombatDataFile {
  const chosen = nearestShipped(version, files) ?? [...files].sort((a, b) => compareVersions(a.version, b.version))[0];
  if (chosen === undefined) throw new Error("no combat data is shipped");
  return chosen;
}

const forVersion = (version: string): CombatDataFile => nearestCombatData(version, SHIPPED);

/** The version whose numbers `version` reads, and whether they were measured on that very version. */
export function combatDataSource(version: string): { readonly version: string; readonly measured: boolean } {
  const file = forVersion(version);
  return { version: file.version, measured: file.version === version };
}

/** A species' numbers, or null when the data does not know it (a modded mob, a species added after the measured version). */
export function mobCombatData(species: string, version: string): MobCombatData | null {
  const mob = forVersion(version).mobs[species];
  if (mob === undefined) return null;
  return { ...mob, armor: mob.armor ?? 0, armorToughness: mob.armorToughness ?? 0 };
}

/** The fields of a species that differ between individuals (null in `mobCombatData`: a melee mob with a varying `attackDamage` still melees); none for a species the data lacks. */
export function variesFields(species: string, version: string): readonly string[] {
  return forVersion(version).varies[species] ?? [];
}

/** Whether the species explodes by itself (a creeper's fuse): the data gives it an explosion. */
export function hasSelfExplosion(species: string | undefined, version: string): boolean {
  return species !== undefined && mobCombatData(species, version)?.explosion != null;
}

/** The bare hand's attack. */
export function bareHand(version: string): ItemAttack {
  return forVersion(version).bareHand;
}

/** What the player's attack becomes with `item` in the main hand; null or an item that changes nothing: the bare hand. */
export function itemAttack(item: string | null, version: string): ItemAttack {
  const file = forVersion(version);
  return (item === null ? undefined : file.items[item]) ?? file.bareHand;
}

/** How the difficulty scales a hit of this damage type (`mob_attack`, `explosion`), or null when the data does not know the type. */
export function damageScaling(type: string, version: string): DamageScaling | null {
  const scaling = forVersion(version).damageTypes[type]?.scaling;
  return scaling !== undefined && DAMAGE_SCALINGS.includes(scaling) ? (scaling as DamageScaling) : null;
}
