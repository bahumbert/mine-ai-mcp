/**
 * The shape of `src/world/data/combat-data/<version>.json`: what the Mine Labs combat-data checks measured on the real
 * server (`tests/minecraft/contract/checks/combat-data-*.ts`) plus the jar's damage types, written by
 * `combat-data-write.ts` and served by `combat-data.ts`.
 */

/** One mob species as the server reports it; a field is null when the server has no such attribute or the value differs between two copies (listed in `varies`). */
export interface MeasuredMob {
  readonly maxHealth: number | null;
  readonly attackDamage: number | null;
  readonly armor: number | null;
  readonly armorToughness: number | null;
  readonly movementSpeed: number | null;
  readonly followRange: number | null;
  /** The self-explosion data (`ExplosionRadius`, `Fuse`); null when the species has none. */
  readonly explosion: { readonly radius: number; readonly fuseTicks: number } | null;
  /** The ranged explosion strength (`ExplosionPower`); null when the species has none. */
  readonly rangedExplosionPower: number | null;
}

export interface MeasuredItemAttack {
  readonly attackDamage: number;
  readonly attackSpeed: number;
}

/** What one combat-data check logs on its `MEASURED` line: the mob check gives the first three fields, the item check the last two. */
export interface MeasuredPart {
  readonly mobs?: Readonly<Record<string, MeasuredMob>>;
  readonly varies?: Readonly<Record<string, readonly string[]>>;
  readonly skipped?: readonly string[];
  readonly bareHand?: MeasuredItemAttack;
  readonly items?: Readonly<Record<string, MeasuredItemAttack>>;
}

export interface CombatDataFile {
  /** The version of the server that was measured. */
  readonly version: string;
  readonly bareHand: MeasuredItemAttack;
  readonly mobs: Readonly<Record<string, MeasuredMob>>;
  /** Only the items whose attack differs from the bare hand. */
  readonly items: Readonly<Record<string, MeasuredItemAttack>>;
  readonly damageTypes: Readonly<Record<string, { readonly scaling: string }>>;
  /** Species with a field that differed between two summoned copies (random size, genes): the field is null in `mobs`. */
  readonly varies: Readonly<Record<string, readonly string[]>>;
  /** Registry entities the measurement could not read (not living, or a boss the box could not hold). */
  readonly skipped: readonly string[];
}
