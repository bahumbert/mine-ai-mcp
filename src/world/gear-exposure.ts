/**
 * The bot's gear exposure (spec D3): 1 for no gear, down to 0.15 for the best protection and weapon with a shield. A fight costs more
 * the less exposure the bot has, so the cave weighing (`target-weighing.ts`) reads it. Built from the shipped combat data and the
 * readouts the fight reflex already uses: no item list here. The numbers are the owner's (2026-11-08), tuned on the figures of D3.
 */
import type { Bot } from "mineflayer";
import { damageAfterArmor } from "../survival/perception/combat/threat-assessment.js";
import { combatReadout } from "../survival/weapons/equipment.js";
import { armourPoints } from "./armour-points.js";
import { attackDps, itemAttack } from "./combat-data.js";

/** The damage a hit of the probe measures the armour with (owner 2026-11-08). */
const PROBE_DAMAGE = 5;
/** Protection reaches 1 at this damage reduction (owner 2026-11-08). */
const ARMOUR_CAP = 0.8;
/** The bare hand's dps in the shipped data (1 × 4) (owner 2026-11-08). */
const WEAPON_FLOOR_DPS = 4;
/** The best melee dps in the shipped data (netherite sword, 8 × 1.6) (owner 2026-11-08). */
const WEAPON_CAP_DPS = 12.8;
/** A ready bow's dps: "at the iron-sword level", the 1.21.4 data's 6 × 1.6 (owner 2026-11-08). */
const BOW_DPS = 9.6;
/** Arrows a bow needs to count as ready (owner 2026-11-08). */
const BOW_MIN_ARROWS = 16;
/** The weights of protection, shield and weapon in the exposure, and the exposure's floor (owner 2026-11-08). */
const PROTECTION_WEIGHT = 0.6;
const SHIELD_WEIGHT = 0.1;
const WEAPON_WEIGHT = 0.15;
const EXPOSURE_FLOOR = 0.15;
/** The curve of protection and weapon (owner 2026-11-08). */
const CURVE_POWER = 1.5;

/** What exposure reads from the gear, without the names of the items. */
export interface ExposureFigures {
  readonly exposure: number;
  readonly protection: number;
  readonly weapon: number;
  readonly shield: 0 | 1;
  /** The better of the melee weapon and a counted bow. */
  readonly dps: number;
  /** A ready bow sets the dps (its dps beats the melee weapon's). */
  readonly bowCounted: boolean;
}

/** The figures, plus the melee weapon the fight reflex would take (null: the bare hand). */
export interface GearExposure extends ExposureFigures {
  readonly melee: string | null;
}

export interface ExposureInput {
  readonly armor: number;
  readonly toughness: number;
  readonly meleeDps: number;
  readonly bowReady: boolean;
  readonly shield: boolean;
}

/** Exposure from the numbers alone (spec D3), rounded to two decimals. */
export function exposureOf(input: ExposureInput): ExposureFigures {
  const protection = (1 - damageAfterArmor(PROBE_DAMAGE, input.armor, input.toughness) / PROBE_DAMAGE) / ARMOUR_CAP;
  const bowDps = input.bowReady ? BOW_DPS : 0;
  const dps = Math.max(input.meleeDps, bowDps);
  const weapon = Math.min(1, Math.max(0, (dps - WEAPON_FLOOR_DPS) / (WEAPON_CAP_DPS - WEAPON_FLOOR_DPS)));
  const shield = input.shield ? 1 : 0;
  const lost = PROTECTION_WEIGHT * protection ** CURVE_POWER + SHIELD_WEIGHT * shield + WEAPON_WEIGHT * weapon ** CURVE_POWER;
  return {
    exposure: Math.round(Math.max(EXPOSURE_FLOOR, 1 - lost) * 100) / 100,
    protection,
    weapon,
    shield,
    dps,
    bowCounted: input.bowReady && bowDps > input.meleeDps,
  };
}

/** The bot's exposure now: its worn armour (unknown reads as none), its melee weapon, a ready bow and a carried shield. */
export function gearExposure(bot: Bot): GearExposure {
  const readout = combatReadout(bot);
  const armour = armourPoints(bot) ?? { armor: 0, toughness: 0 };
  const figures = exposureOf({
    armor: armour.armor,
    toughness: armour.toughness,
    meleeDps: attackDps(itemAttack(readout.melee, bot.version)),
    bowReady: readout.bow !== null && readout.arrows >= BOW_MIN_ARROWS,
    shield: readout.shield !== null,
  });
  return { ...figures, melee: readout.melee };
}
