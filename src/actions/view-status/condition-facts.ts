/**
 * The condition facts of `view_status` (plan 2026-11-07-p4-03-condition-line task 2): what the runtime reads in the game for the brain's one-line
 * condition (armour worn and carried, armour points, light, the fight reflex's gear, the respawn point). Facts only, no advice, no item names typed here:
 * armour families come from `tool-tiers.ts`, the slot of a piece from `inferEquipmentDestination`, bow and arrow from the item families.
 */
import type { Bot } from "mineflayer";
import { respawnPoint, wornArmour } from "../../runtime/respawn-point.js";
import { combatReadout } from "../../survival/weapons/equipment.js";
import { armourPoints } from "../../world/armour-points.js";
import { familyIndexOf } from "../../world/item-families.js";
import { lightAt } from "../../world/light.js";
import { ARMOUR_CLASSES, equipmentClass } from "../../world/tool-tiers.js";
import { inferEquipmentDestination } from "../equip/contract.js";
import type { LiveSituation } from "./contract.js";

/** Sky light under an open sky: the cell from which no block shades the sun. */
const FULL_SKY_LIGHT = 15;
const ARMOUR_SLOTS = ["head", "torso", "legs", "feet"] as const;
type ArmourSlot = (typeof ARMOUR_SLOTS)[number];

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

export type ConditionFacts = Pick<LiveSituation, "armourWorn" | "armourCarried" | "light" | "combat" | "respawn"> & {
  readonly vitals: Pick<LiveSituation["vitals"], "armour" | "armourToughness">;
};

export function observeConditionFacts(bot: Bot): ConditionFacts {
  const points = armourPoints(bot);
  const worn = wornArmour(bot);
  const wornBySlot: Record<ArmourSlot, string | null> = { head: worn.head, torso: worn.chest, legs: worn.legs, feet: worn.feet };
  const spawn = respawnPoint(bot);
  return {
    vitals: { armour: points?.armor ?? null, armourToughness: points?.toughness ?? null },
    armourWorn: ARMOUR_SLOTS.map((slot) => ({ slot, item: wornBySlot[slot] })),
    armourCarried: carriedArmour(bot),
    light: observeLight(bot),
    combat: combatReadout(bot),
    respawn: spawn && {
      kind: spawn.kind,
      position: { x: round(spawn.x, 2), y: round(spawn.y, 2), z: round(spawn.z, 2) },
      distance: spawn.distance === null ? null : round(spawn.distance, 1),
    },
  };
}

/** Armour pieces in the main inventory and hotbar, summed per item in slot order, each with the slot it is for. */
function carriedArmour(bot: Bot): ConditionFacts["armourCarried"] {
  const index = familyIndexOf(bot);
  const pieces = new Map<string, { item: string; count: number; slot: ArmourSlot }>();
  for (const stack of bot.inventory.items()) {
    const kind = equipmentClass(index, stack.name);
    const slot = inferEquipmentDestination(stack.name, index);
    if (kind === null || !(ARMOUR_CLASSES as readonly string[]).includes(kind) || !(ARMOUR_SLOTS as readonly string[]).includes(slot)) continue;
    const seen = pieces.get(stack.name);
    if (seen) seen.count += stack.count;
    else pieces.set(stack.name, { item: stack.name, count: stack.count, slot: slot as ArmourSlot });
  }
  return [...pieces.values()];
}

/**
 * The light at the feet cell and, when it is under full sky light, how far up the first cell of full sky light is: counted over the cells above, from the
 * chunk data; null when a cell on the way has no light data (an unloaded column, a section the server sent none for) or none is found below the dimension's top.
 */
function observeLight(bot: Bot): ConditionFacts["light"] {
  const feet = bot.entity.position.floored();
  const here = lightAt(bot, feet);
  const light: ConditionFacts["light"] = { sky: here.sky, block: here.block, openSkyAbove: null };
  if (here.sky === null || here.sky >= FULL_SKY_LIGHT) return light;
  const dimension = bot.game as typeof bot.game & { minY: number; height: number }; // the game plugin supplies the bounds; Mineflayer's type omits them
  const top = dimension.minY + dimension.height - 1;
  for (let y = feet.y + 1; y <= top; y += 1) {
    const sky = lightAt(bot, feet.offset(0, y - feet.y, 0)).sky;
    if (sky === null) return light;
    if (sky >= FULL_SKY_LIGHT) return { ...light, openSkyAbove: y - feet.y };
  }
  return light;
}

/** The one text line of the facts, a missing fact left out; null when there is nothing to say. */
export function conditionFactsLine(situation: LiveSituation): string | null {
  const { vitals, armourWorn, armourCarried, light, combat, respawn } = situation;
  const wornPieces = armourWorn.flatMap((piece) => (piece.item === null ? [] : [`${piece.slot} ${piece.item}`]));
  const carriedPieces = armourCarried.map((piece) => (piece.count > 1 ? `${piece.item} x${piece.count}` : piece.item));
  const lightParts = [light.sky === null ? null : `sky ${light.sky}`, light.block === null ? null : `block ${light.block}`].filter((part) => part !== null);
  const combatParts = [combat.melee, combat.bow === null ? null : `${combat.bow} (${combat.arrows} arrows)`, combat.shield].filter((part) => part !== null);
  const parts = [
    vitals.armour === null ? null : `armour ${vitals.armour}${vitals.armourToughness ? `, toughness ${vitals.armourToughness}` : ""}`,
    wornPieces.length > 0 ? `worn ${wornPieces.join(", ")}` : null,
    carriedPieces.length > 0 ? `carried armour ${carriedPieces.join(", ")}` : null,
    lightParts.length > 0 ? `light ${lightParts.join(" ")}${light.openSkyAbove === null ? "" : `; open sky ${light.openSkyAbove} blocks above`}` : null,
    combatParts.length > 0 ? `combat ${combatParts.join(", ")}` : null,
    respawn === null ? null : `respawn ${respawn.kind === "bed" ? "bed" : respawn.kind === "last_wake" ? "where it last woke" : "world spawn"} ${respawn.distance === null ? "in another dimension" : `${Math.round(respawn.distance)} blocks away`}`,
  ].filter((part) => part !== null);
  return parts.length > 0 ? `Condition facts: ${parts.join("; ")}.` : null;
}
