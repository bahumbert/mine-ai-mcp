/**
 * What the fake server does with an item the hand uses (contract checks `bow-draw-and-release`, `shield-raised`,
 * `consume-food`, `unequip-hand`, Mine Labs 1.21.4, 2026-10-23): the use sets the hand-in-use bit of the bot's living-entity
 * flags (bit 0, bit 1 for the off hand), the release (`block_dig` status 5) clears bit 0, a bow released after 3 or more
 * ticks shoots an arrow from the eye (0.1 below it) and spends one, and food bitten for 32 ticks is eaten: `entity_status` 9
 * ends the use first, then (`AFTER_BITE_TICKS` later) the stack loses one, the effects come and `update_health` follows when
 * the food changed (`AFTER_BITE_TICKS` says what is measured). Bread at food 20 is not taken. Also `unequip`, as `simple_inventory.js:43-79` has it.
 * Not modelled: a crossbow, a trident, potions, the other foods' eating times and effects, the arrow's
 * flight, the item's damage, a creative bot keeps its stacks (modelled) but is never refused food (vanilla: it is not refused).
 */
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import type { FakeBot } from "./fake-bot.js";
import { notchVelocity } from "./fake-bot-combat-rules.js";
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
/** Full draw and launch power measured by contract check `bow-draw-and-release` (2026-11-17). */
const FULL_DRAW_TICKS = 20;
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
/**
 * Server ticks between `entity_status` 9 and the stack, the effects and the health. Measured (contract check `consume-food`,
 * Mine Labs 1.21.4, 2026-10-23, the comment "The stack, the bit and the effects come after the resolution", the `consume`
 * promise resolving on the status): the stack and the effects are seen after the status. Not measured: the one-tick gap, the
 * order of the stack, the effects and the health among themselves, and the bit (the fake clears it with the status).
 */
const AFTER_BITE_TICKS = 1;
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

/** Spawn a bow's measured launch and spend its projectile. */
function shoot(bot: FakeBot, parts: HeldUseParts, use: Use): void {
  const slot = arrowSlot(bot);
  const drawTicks = parts.ticks() - use.startedTick;
  if (drawTicks < MIN_DRAW_TICKS || (slot === null && bot.game.gameMode !== "creative")) return;
  const pull = Math.min(1, drawTicks / FULL_DRAW_TICKS);
  const speed = pull * pull + 2 * pull;
  const { yaw, pitch } = bot.entity;
  const velocity = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).scaled(speed);
  const arrow = parts.entities.spawn({ name: "arrow", position: eyeOnServer(bot, parts.server).offset(0, -ARROW_BELOW_EYE, 0), velocity });
  parts.afterTicks(1, () => parts.hear("entity_velocity", { entityId: arrow.id, velocity: notchVelocity(velocity) }));
  if (slot !== null) spendOne(bot, parts, slot);
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
    stopUsing();
    parts.hear("entity_status", { entityId: bot.entity.id, entityStatus: FINISHED_EATING });
    bot.usingHeldItem = false;
    parts.afterTicks(AFTER_BITE_TICKS, () => {
      const slot = use.offHand ? EQUIPMENT_SLOTS["off-hand"] : use.item.slot;
      if (bot.inventory.slots[slot]?.type === use.item.type) spendOne(bot, parts, slot);
      for (const { effect, amplifier, duration } of FOOD_EFFECTS[use.item.name] ?? []) {
        const id = Object.values(bot.registry.effects).find(({ name }) => name === effect)!.id;
        parts.hear("entity_effect", { entityId: bot.entity.id, effectId: id, amplifier, duration });
        bot.entity.effects[id] = { id, amplifier, duration };
        bot.emit("entityEffect", bot.entity, bot.entity.effects[id]);
      }
      const nextFood = Math.min(FOOD_FULL, bot.food + food.foodPoints);
      if (nextFood !== bot.food) parts.sendHealth(bot.health, nextFood);
    });
  };

  /** Whether the server lets the hand begin using `item`: a bow with an arrow behind it, a shield, food that is wanted. */
  const takesUse = (item: Item): boolean => {
    if (item.name === "bow") return arrowSlot(bot) !== null || bot.game.gameMode === "creative";
    if (item.name === "shield") return true;
    return bot.registry.foodsByName[item.name] !== undefined && (bot.food < FOOD_FULL || ALWAYS_EDIBLE.has(item.name));
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
      if (use.item.name === "bow") shoot(bot, parts, use);
      stopUsing();
    });
  });
  // The server ends a use of the main hand when the hand's item changes (`LivingEntity.updatingUsingItem`, vanilla source), which it learns when it reads the client's packet, as for a hit: a late server ends it a lag after the change, in order with the use and the release (contract check `attack-cooldown-damage` swing, `fake-bot-swing.ts`: 3.7 at the client's change against 1.89 read).
  parts.inventory.onHeldItemChanged((held) => {
    parts.server.answer(() => {
      if (using !== null && !using.offHand && held?.type !== using.item.type) stopUsing();
    });
  });

  bot.unequip = (destination) => unequip(bot, destination);
}
