/**
 * The bot's own armour attributes on the fake server, as contract check `armour-points-worn` measured them on the real 1.21.4 server (2026-11-07, plan
 * 2026-11-07-p4-03-condition-line task 1): Mineflayer files them on `bot.entity.attributes` under `generic.armor` and `generic.armor_toughness`, each
 * `{ value: 0, modifiers }`; a worn chestplate adds one modifier `{ uuid: "minecraft:armor.chestplate", amount, operation: 0 }` (iron: armor 6; diamond:
 * armor 8 and toughness 2), an unequip removes it and the key stays. The server tells it after reading the equip, so the update comes through `server.answer`.
 * Unmeasured, so not modelled: any other item (no modifier), any other slot than the torso (no modifier), the toughness modifier's uuid (the armour one's is
 * used), the attributes before the first armour change, and the two updates a respawn sent (the points followed the kept gear).
 */
import type { Bot } from "mineflayer";
import type { FakeBot } from "./fake-bot.js";
import { EQUIPMENT_SLOTS, type FakeInventory } from "./fake-inventory.js";
import type { FakeServer } from "./fake-server.js";

const ARMOUR_KEY = "generic.armor";
const TOUGHNESS_KEY = "generic.armor_toughness";
const ADD_VALUE = 0;
const CHESTPLATE_MODIFIER = "minecraft:armor.chestplate";

/** The chestplates the contract check measured, with the points each gave. */
const MEASURED_CHESTPLATES: Readonly<Record<string, { readonly armor: number; readonly toughness: number }>> = {
  iron_chestplate: { armor: 6, toughness: 0 },
  diamond_chestplate: { armor: 8, toughness: 2 },
};

type Modifier = { readonly uuid: string; readonly amount: number; readonly operation: number };

/** The modifiers the worn torso piece puts on each attribute: none for a piece or a slot nobody measured. */
function wornModifiers(inventory: FakeInventory): { readonly armor: Modifier[]; readonly toughness: Modifier[] } {
  const points = MEASURED_CHESTPLATES[inventory.slots[EQUIPMENT_SLOTS.torso]?.name ?? ""];
  const modifier = (amount: number): Modifier[] => (points && amount > 0 ? [{ uuid: CHESTPLATE_MODIFIER, amount, operation: ADD_VALUE }] : []);
  return { armor: modifier(points?.armor ?? 0), toughness: modifier(points?.toughness ?? 0) };
}

/** Keep `bot.entity.attributes` armour entries in step with the worn slots, told by the server after each change of an armour slot. */
export function attachFakeArmour(bot: FakeBot, parts: { readonly server: FakeServer; readonly inventory: FakeInventory }): void {
  const armourSlots: number[] = [EQUIPMENT_SLOTS.head, EQUIPMENT_SLOTS.torso, EQUIPMENT_SLOTS.legs, EQUIPMENT_SLOTS.feet];
  parts.inventory.on("updateSlot", (slot: number) => {
    if (!armourSlots.includes(slot)) return;
    parts.server.answer(() => {
      const { armor, toughness } = wornModifiers(parts.inventory);
      const entity = bot.entity as Bot["entity"] & { attributes: Record<string, { value: number; modifiers: Modifier[] }> };
      entity.attributes = { ...entity.attributes, [ARMOUR_KEY]: { value: 0, modifiers: armor }, [TOUGHNESS_KEY]: { value: 0, modifiers: toughness } };
      bot.emit("entityAttributes", entity);
    });
  });
}
