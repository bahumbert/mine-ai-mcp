/**
 * What the fake server does with an item the hand uses (contract checks `bow-draw-and-release`, `shield-raised`,
 * `consume-food`, `unequip-hand`, Mine Labs 1.21.4, 2026-10-23): the use sets the hand-in-use bit of the bot's living-entity
 * flags (bit 0, bit 1 for the off hand), the release (`block_dig` status 5) clears bit 0, a bow released after 3 or more
 * ticks shoots an arrow from the eye (0.1 below it) and spends one, and food bitten for 32 ticks is eaten: the stack loses
 * one, the effects come, `entity_status` 9 ends the use and `update_health` follows when the food changed. Bread at food 20
 * is not taken. Also `unequip`, as `simple_inventory.js:43-79` has it.
 * Not modelled: a crossbow, a trident, potions, the other foods' eating times and effects, the bow's power and the arrow's
 * flight, the item's damage, a creative bot keeps its stacks (modelled) but is never refused food (vanilla: it is not refused).
 */
import type { Item } from "prismarine-item";
import type { FakeBot } from "./fake-bot.js";
import type { ServerEntities } from "./fake-bot-entities.js";
import { eyeOnServer } from "./fake-bot-entity-reach.js";
import { EQUIPMENT_SLOTS, type FakeInventory, itemOf } from "./fake-inventory.js";
import type { FakeServer } from "./fake-server.js";

/** The hotbar's first window slot (`simple_inventory.js:6`). */
const HOTBAR_START = 36;
const USING_HAND = 1;
const OFF_HAND_BIT = 2;
const OFF_HAND = 1;
/** A bow drawn fewer ticks than this shoots nothing (2 ticks: none, 4 ticks: an arrow). */
const MIN_DRAW_TICKS = 3;
/** The arrow starts 0.1 below the eye (y -58.48 for an eye at -58.38). */
const ARROW_BELOW_EYE = 0.1;
/** The bite of any food (1.6 s: 1558 to 1576 ms measured for a golden apple). */
const EATING_TICKS = 32;
const FOOD_FULL = 20;
/** Eaten at any food level (measured for the golden apple only). */
const ALWAYS_EDIBLE = new Set(["golden_apple", "enchanted_golden_apple"]);
/** What eating gives besides food, by the effect's name in the registry: measured for the names only, not the strength or length. */
const FOOD_EFFECTS: Readonly<Record<string, readonly { readonly effect: string; readonly amplifier: number; readonly duration: number }[]>> = {
  golden_apple: [
    { effect: "Regeneration", amplifier: 1, duration: 100 },
    { effect: "Absorption", amplifier: 0, duration: 2_400 },
  ],
};
/** `entity_status` that ends a bite (`inventory.js:55-62`). */
const FINISHED_EATING = 9;
/** Hotbar before main, the order an arrow is looked for after the off hand (`Inventory.findProjectile`: unmeasured). */
const ARROW_SLOT_ORDER = [EQUIPMENT_SLOTS["off-hand"], ...Array.from({ length: 9 }, (_, index) => HOTBAR_START + index), ...Array.from({ length: 27 }, (_, index) => 9 + index)];

/** What the held-use answers need of the fight around them. */
export interface HeldUseParts {
  readonly server: FakeServer;
  readonly inventory: FakeInventory;
  readonly entities: ServerEntities;
  /** Server ticks since the start. */
  ticks(): number;
  /** Run `run` after `ticks` server ticks (never while the server is stopped). */
  afterTicks(ticks: number, run: () => void): void;
  /** The server sends the packet; the client's handler (Mineflayer's own, or its effect copied by the caller) runs. */
  hear(name: string, data: unknown): void;
  /** `update_health` with these values, filed as `health.js` does. */
  sendHealth(health: number, food: number): void;
}

/** A use under way: the hand, the item, and when it began. */
interface Use {
  readonly offHand: boolean;
  readonly item: Item;
  readonly startedTick: number;
}

/** The slot of the first arrow stack the server would shoot from, or null. */
function arrowSlot(bot: FakeBot): number | null {
  const arrow = bot.registry.itemsByName.arrow!.id;
  return ARROW_SLOT_ORDER.find((slot) => bot.inventory.slots[slot]?.type === arrow) ?? null;
}

/** `count` minus one in the slot, outside creative. */
function spendOne(bot: FakeBot, parts: HeldUseParts, slot: number): void {
  if (bot.game.gameMode === "creative") return;
  const held = bot.inventory.slots[slot]!;
  parts.inventory.updateSlot(slot, held.count > 1 ? itemOf(bot.registry, held.name, held.count - 1) : (null as never));
}

/** `unequip` as `simple_inventory.js:43-79` has it: the hand to a free hotbar slot, else its stack clicked into the first free main slot, else tossed; another place is put away. */
async function unequip(bot: FakeBot, destination: Parameters<FakeBot["unequip"]>[0]): Promise<void> {
  if (destination !== "hand") return bot.putAway(bot.getEquipmentDestSlot(destination ?? "hand"));
  const freeHotbar = Array.from({ length: 9 }, (_, index) => index).find((index) => !bot.inventory.slots[HOTBAR_START + index]);
  if (freeHotbar !== undefined) return bot.setQuickBarSlot(freeHotbar);
  const free = bot.inventory.firstEmptyInventorySlot();
  if (free === null || free === undefined) return bot.tossStack(bot.heldItem!);
  await bot.clickWindow(HOTBAR_START + bot.quickBarSlot, 0, 0);
  await bot.clickWindow(free, 0, 0);
  if (bot.inventory.selectedItem) await bot.clickWindow(-999, 0, 0);
}

/** Give `bot` its use of items, `unequip`, and the server's answers to `use_item` and the release. */
export function attachFakeHeldUse(bot: FakeBot, parts: HeldUseParts): void {
  const flagsKey = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("living_entity_flags");
  let using: Use | null = null;
  const setFlags = (flags: number) => {
    Reflect.set(bot.entity.metadata, flagsKey, flags);
    bot.emit("entityUpdate", bot.entity);
  };
  const currentFlags = () => Number(Reflect.get(bot.entity.metadata, flagsKey) ?? 0);
  const stopUsing = () => {
    if (using === null) return;
    using = null;
    setFlags(currentFlags() & ~USING_HAND);
  };

  const eaten = (use: Use) => {
    if (using !== use) return;
    const food = bot.registry.foodsByName[use.item.name]!;
    spendOne(bot, parts, use.offHand ? EQUIPMENT_SLOTS["off-hand"] : use.item.slot);
    for (const { effect, amplifier, duration } of FOOD_EFFECTS[use.item.name] ?? []) {
      const id = Object.values(bot.registry.effects).find(({ name }) => name === effect)!.id;
      parts.hear("entity_effect", { entityId: bot.entity.id, effectId: id, amplifier, duration });
      bot.entity.effects[id] = { id, amplifier, duration };
      bot.emit("entityEffect", bot.entity, bot.entity.effects[id]);
    }
    stopUsing();
    parts.hear("entity_status", { entityId: bot.entity.id, entityStatus: FINISHED_EATING });
    bot.usingHeldItem = false;
    const nextFood = Math.min(FOOD_FULL, bot.food + food.foodPoints);
    if (nextFood !== bot.food) parts.sendHealth(bot.health, nextFood);
  };

  /** Whether the server lets the hand begin using `item`: a bow with an arrow behind it, a shield, food that is wanted. */
  const takesUse = (item: Item): boolean => {
    if (item.name === "bow") return arrowSlot(bot) !== null || bot.game.gameMode === "creative";
    if (item.name === "shield") return true;
    return bot.registry.foodsByName[item.name] !== undefined && (bot.food < FOOD_FULL || ALWAYS_EDIBLE.has(item.name));
  };

  const shoot = (use: Use) => {
    const slot = arrowSlot(bot);
    if (parts.ticks() - use.startedTick < MIN_DRAW_TICKS || (slot === null && bot.game.gameMode !== "creative")) return;
    parts.entities.spawn({ name: "arrow", position: eyeOnServer(bot, parts.server).offset(0, -ARROW_BELOW_EYE, 0) });
    if (slot !== null) spendOne(bot, parts, slot);
  };

  parts.server.onPacket("use_item", (data) => {
    const { hand } = data as { hand: number };
    parts.server.answer(() => {
      const offHand = hand === OFF_HAND;
      const item = offHand ? bot.inventory.slots[EQUIPMENT_SLOTS["off-hand"]] : parts.inventory.heldItem;
      if (using !== null || item == null || !takesUse(item)) return;
      const use: Use = { offHand, item, startedTick: parts.ticks() };
      using = use;
      setFlags(currentFlags() | USING_HAND | (offHand ? OFF_HAND_BIT : 0));
      if (bot.registry.foodsByName[item.name] !== undefined) parts.afterTicks(EATING_TICKS, () => eaten(use));
    });
  });
  parts.server.onPacket("block_dig", (data) => {
    if ((data as { status: number }).status !== 5) return;
    parts.server.answer(() => {
      const use = using;
      if (use === null) return;
      if (use.item.name === "bow") shoot(use);
      stopUsing();
    });
  });
  // The server ends a use of the main hand when the hand's item changes.
  parts.inventory.onHeldItemChanged((held) => {
    if (using !== null && !using.offHand && held?.type !== using.item.type) stopUsing();
  });

  bot.unequip = (destination) => unequip(bot, destination);
}
