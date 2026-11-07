/** Combat numbers measured on the server (P4-06a T1a); T1b adds the loader functions next to these types. */

/** One species' measured combat attributes; a field is null when it differed between two summoned copies or is not read. */
export interface MobCombatData {
  readonly maxHealth: number | null;
  readonly attackDamage: number | null;
  readonly armor: number;
  readonly armorToughness: number;
  readonly movementSpeed: number | null;
  readonly followRange: number | null;
  /** Self-explosion (a creeper's radius and fuse); null when the species has none. */
  readonly explosion: { readonly radius: number; readonly fuseTicks: number } | null;
  readonly rangedExplosionPower: number | null;
}

/** A held item's measured main-hand attribute modifiers (the bare hand when nothing is held). */
export interface ItemAttack {
  readonly attackDamage: number;
  readonly attackSpeed: number;
}

/** How a damage type scales with the server difficulty (the jar's `damage_type` json `scaling`). */
export type DamageScaling = "never" | "always" | "when_caused_by_living_non_player";
