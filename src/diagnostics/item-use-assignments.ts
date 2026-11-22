// Trace item-use assignments without changing Mineflayer's property semantics.
import type { Bot } from "mineflayer";

/** Retain the assigning stack before event listeners can obscure who changed the held-item flag. */
export function observeItemUseAssignments(bot: Bot, record: (direction: "incoming", packet: string, fields: unknown) => unknown): Disposable {
  const descriptor = Object.getOwnPropertyDescriptor(bot, "usingHeldItem");
  let using = bot.usingHeldItem;
  let active = true;
  const getUsing = () => using;
  const setUsing = (value: boolean) => {
    const before = using;
    using = value;
    if (active && before !== value) record("incoming", "item_use_transition", {
      before, after: value, origin: "local_assignment",
      stack: new Error().stack?.split("\n").slice(2, 9),
      mainHand: bot.heldItem?.name ?? null, offHand: bot.inventory?.slots?.[45]?.name ?? null,
    });
  };
  if (descriptor?.configurable && "value" in descriptor && descriptor.writable)
    Object.defineProperty(bot, "usingHeldItem", { configurable: true, enumerable: descriptor.enumerable, get: getUsing, set: setUsing });
  const heldChanged = () => { record("incoming", "held_item_changed", {
    mainHand: bot.heldItem?.name ?? null, count: bot.heldItem?.count ?? null,
    offHand: bot.inventory?.slots?.[45]?.name ?? null, usingHeldItem: bot.usingHeldItem,
  }); };
  bot.on("heldItemChanged", heldChanged);
  return {
    [Symbol.dispose]() {
      active = false;
      if (Object.getOwnPropertyDescriptor(bot, "usingHeldItem")?.get === getUsing)
        Object.defineProperty(bot, "usingHeldItem", { ...descriptor, value: using });
      bot.off("heldItemChanged", heldChanged);
    },
  };
}
