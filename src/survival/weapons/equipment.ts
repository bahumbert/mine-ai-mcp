export const BOW_DRAW_TICKS = 20;
/** Combat equipment rules shared by the hostile policy and the engagement loop. */
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import type { Position3 } from "../../utils/index.js";
import { familyIndexOf, hasItemFamily, type FamilyIndex, type ItemFamily } from "../../world/item-families.js";
import type { CombatPolicy } from "../policy/combat/contract.js";
import { permittedCombatItems } from "../policy/combat/permissions.js";

export type CombatLoadout =
  | { readonly kind: "bow"; readonly weapon: Item; readonly shield: Item | null }
  | {
      readonly kind: "melee";
      /** Null means deliberately empty-handed. */
      readonly weapon: Item | null;
      readonly shield: Item | null;
      readonly cooldownTicks: number;
    };

type BowLoadout = Extract<CombatLoadout, { kind: "bow" }>;
type MeleeLoadout = Extract<CombatLoadout, { kind: "melee" }>;

/** The window slot of the off-hand. */
export const OFF_HAND_SLOT = 45;
/** An empty hand's attack speed is four attacks per second. */
const EMPTY_HAND_COOLDOWN_TICKS = 5;
/**
 * A full bow draw takes twenty ticks, in which a walking zombie covers about
 * 4.6 blocks. Inside six blocks it reaches melee range before the arrow leaves.
 */
const BOW_MINIMUM_RANGE = 6;
/** Maximum eye-to-body melee reach, shared by ordinary and knockback attacks. */
export const MELEE_RANGE = 3;
/** Prefer weapon families in this order, with their conservative full-strength cooldowns. */
const MELEE_FAMILIES: readonly { readonly family: ItemFamily; readonly cooldownTicks: number }[] = [
  { family: "sword", cooldownTicks: 13 },
  { family: "axe", cooldownTicks: 25 },
  { family: "pickaxe", cooldownTicks: 17 },
  { family: "shovel", cooldownTicks: 20 },
  { family: "hoe", cooldownTicks: 20 },
];

/** Both hands first, then inventory. Selection reads this list without changing equipment. */
export function readCombatItems(bot: Pick<Bot, "heldItem" | "inventory">): readonly Item[] {
  return [bot.heldItem, bot.inventory.slots[OFF_HAND_SLOT], ...bot.inventory.items()].filter(
    (item): item is Item => !!item,
  );
}

/** The first carried item of `family` with the best rank (an earlier one wins a tie), or null. */
function bestOfFamily(index: FamilyIndex, carried: readonly Item[], family: ItemFamily): Item | null {
  let best: Item | null = null;
  for (const item of carried) {
    if (!index.itemFamilies(item.name).includes(family)) continue;
    if (best === null || index.compareRank(item, best, family) < 0) best = item;
  }
  return best;
}

/** Choose the best ranked item within the first carried weapon family. */
function selectMeleeWeapon(
  index: FamilyIndex,
  carried: readonly Item[],
): { readonly item: Item; readonly cooldownTicks: number } | null {
  for (const { family, cooldownTicks } of MELEE_FAMILIES) {
    const item = bestOfFamily(index, carried, family);
    if (item) return { item, cooldownTicks };
  }
  return null;
}

/** A bow is usable only when at least one arrow (family `arrow`: arrows, tipped, spectral) is carried. */
function usableBow(index: FamilyIndex, carried: readonly Item[]): Item | null {
  const arrows = carried.some((item) => index.itemFamilies(item.name).includes("arrow"));
  return arrows ? bestOfFamily(index, carried, "bow") : null;
}

/** Whether `item` is a shield (family `shield`); null and undefined are not. */
export function isShield(bot: Bot, item: { readonly name: string } | null | undefined): boolean {
  return item != null && hasItemFamily(bot, item.name, "shield");
}

/** Whether the off-hand already holds a shield. */
export function shieldInOffHand(bot: Bot): boolean {
  return isShield(bot, bot.inventory.slots[OFF_HAND_SLOT]);
}

/** Choose a weapon and its mechanics from one observation; equipping is a separate effect. */
export function selectCombatLoadout(index: FamilyIndex, carried: readonly Item[], targetOffset: Position3): CombatLoadout {
  const shield = bestOfFamily(index, carried, "shield");
  const bow = usableBow(index, carried);
  const distance = Math.hypot(targetOffset.x, targetOffset.y, targetOffset.z);
  // Walking closer on this level cannot put an elevated target inside melee
  // range. A carried bow remains usable even inside the ground-melee cutoff.
  if (bow && (distance > BOW_MINIMUM_RANGE || targetOffset.y > MELEE_RANGE))
    return { kind: "bow", weapon: bow, shield };
  return selectMeleeLoadout(index, carried);
}

/** A stationary firing position may use a bow inside the open-ground approach cutoff. */
export function selectRangedLoadout(index: FamilyIndex, carried: readonly Item[]): BowLoadout | null {
  const weapon = usableBow(index, carried);
  return weapon ? { kind: "bow", weapon, shield: bestOfFamily(index, carried, "shield") } : null;
}

/** Melee only, including for strikes made during a retreat that cannot stop to draw a bow. */
export function selectMeleeLoadout(index: FamilyIndex, carried: readonly Item[]): MeleeLoadout {
  const melee = selectMeleeWeapon(index, carried);
  return {
    kind: "melee",
    weapon: melee?.item ?? null,
    shield: bestOfFamily(index, carried, "shield"),
    cooldownTicks: melee?.cooldownTicks ?? EMPTY_HAND_COOLDOWN_TICKS,
  };
}

/** The melee loadout of the carried `items` the combat policy permits (no bow or shield the policy forbids). */
export function permittedMeleeLoadout(bot: Bot, items: readonly Item[], combat: Readonly<CombatPolicy>): MeleeLoadout {
  const index = familyIndexOf(bot);
  return selectMeleeLoadout(index, permittedCombatItems(index, items, combat));
}

/** The bow loadout of the carried `items` the combat policy permits, or null without a permitted bow and arrow. */
export function permittedRangedLoadout(bot: Bot, items: readonly Item[], combat: Readonly<CombatPolicy>): BowLoadout | null {
  const index = familyIndexOf(bot);
  return selectRangedLoadout(index, permittedCombatItems(index, items, combat));
}

/** Whether the bot carries a melee tool or a bow with arrows. Empty-handed fighting is not a weapon. */
export function carriesCombatWeapon(bot: Bot): boolean {
  const index = familyIndexOf(bot);
  const carried = readCombatItems(bot);
  return selectMeleeWeapon(index, carried) !== null || usableBow(index, carried) !== null;
}

/**
 * What the fight reflex has to work with, for the model's condition line: the melee weapon it picks (null: bare hands), the best bow
 * whether or not arrows are carried, the arrows carried (a slot counted once, the off-hand included) and the best shield.
 */
export function combatReadout(bot: Bot): { melee: string | null; bow: string | null; arrows: number; shield: string | null } {
  const index = familyIndexOf(bot);
  const carried = readCombatItems(bot);
  // `readCombatItems` lists the held stack again among the inventory's: count by window slot.
  const arrowSlots = new Map<number, number>();
  for (const stack of [...bot.inventory.items(), bot.inventory.slots[OFF_HAND_SLOT]]) {
    if (stack && index.itemFamilies(stack.name).includes("arrow")) arrowSlots.set(stack.slot, stack.count);
  }
  return {
    melee: selectMeleeLoadout(index, carried).weapon?.name ?? null,
    bow: bestOfFamily(index, carried, "bow")?.name ?? null,
    arrows: [...arrowSlots.values()].reduce((total, count) => total + count, 0),
    shield: bestOfFamily(index, carried, "shield")?.name ?? null,
  };
}

/** Whether the bot can deal damage from beyond a creeper's fuse. */
export function carriesRangedWeapon(bot: Bot): boolean {
  return usableBow(familyIndexOf(bot), readCombatItems(bot)) !== null;
}

/** Equip the shield first, then the selected weapon; null deliberately empties the hand. */
export async function equipCombatLoadout(bot: Bot, loadout: CombatLoadout): Promise<void> {
  if (loadout.shield && !shieldInOffHand(bot)) {
    await bot.equip(loadout.shield, "off-hand");
  }
  if (loadout.weapon) {
    if (bot.heldItem?.name !== loadout.weapon.name) await bot.equip(loadout.weapon, "hand");
  } else if (bot.heldItem) {
    await bot.unequip("hand");
  }
}
