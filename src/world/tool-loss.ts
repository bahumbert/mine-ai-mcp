import type { Bot } from "mineflayer";
import { familyIndexOf, type ItemFamily } from "./item-families.js";
import { equipmentClass, rankedItem, snapshotTools, type EquipmentClass, type ToolSnapshotEntry } from "./tool-tiers.js";

/** The families whose loss stops a call: the tools a break or a fight selects. */
const LOSS_FAMILIES = ["pickaxe", "shovel", "axe", "hoe", "sword"] as const satisfies readonly ItemFamily[];
type LossFamily = typeof LOSS_FAMILIES[number];
const isLossFamily = (kind: EquipmentClass): kind is LossFamily => (LOSS_FAMILIES as readonly string[]).includes(kind);

export interface ToolTierLoss {
  readonly class: LossFamily;
  readonly before: ToolSnapshotEntry;
  readonly now: ToolSnapshotEntry;
  readonly reason: string;
}

/**
 * Stop at the navigator/process safe boundary when a tool family actually selected for a break ranks lower than it did
 * (`FamilyIndex.compareRank`: harvest capability, then maximum durability, then mining speed) or its last carried item
 * is gone. Families merely carried by the bot are irrelevant. The failure names the family (`family: pickaxe`) so the
 * brain reads it without parsing an item name.
 */
export function observeToolTierLoss(bot: Bot): {
  signal: AbortSignal;
  loss: () => ToolTierLoss | null;
  select: (itemType: number | null) => void;
  close: () => void;
} {
  const controller = new AbortController();
  const initial = new Map(snapshotTools(bot).tools.map((entry) => [entry.class, entry]));
  const relevant = new Set<LossFamily>();
  let loss: ToolTierLoss | null = null;
  let inspectionScheduled = false;
  let closed = false;
  const inspect = () => {
    if (closed || loss) return;
    const current = new Map(snapshotTools(bot).tools.map((entry) => [entry.class, entry]));
    const index = familyIndexOf(bot);
    for (const kind of relevant) {
      const before = initial.get(kind)!;
      const now = current.get(kind)!;
      if (!before.item) continue;
      if (now.item && index.compareRank(rankedItem(now), rankedItem(before), kind) <= 0) continue;
      const position = bot.entity?.position?.floored?.() ?? bot.entity?.position ?? { x: 0, y: 0, z: 0 };
      const remaining = now.item ? `${now.item} remains` : `no ${kind} remains`;
      const reason = `[TOOL_TIER_LOST] ${before.item} was lost at ${position.x},${position.y},${position.z}; family: ${kind}; ${remaining}.`;
      loss = { class: kind, before, now, reason };
      controller.abort(reason);
      return;
    }
  };
  const scheduleInspect = () => {
    if (inspectionScheduled) return;
    inspectionScheduled = true;
    queueMicrotask(() => {
      inspectionScheduled = false;
      inspect();
    });
  };
  const select = (itemType: number | null) => {
    if (itemType === null) return;
    // The snapshot's own classifier: an item in two families is watched under the class the snapshot files it in.
    const kind = equipmentClass(familyIndexOf(bot), bot.registry.items[itemType]?.name ?? "");
    if (kind && isLossFamily(kind)) relevant.add(kind);
  };
  bot.inventory.on?.("updateSlot", scheduleInspect);
  bot.on?.("heldItemChanged", scheduleInspect);
  return {
    signal: controller.signal,
    loss: () => loss,
    select,
    close: () => {
      closed = true;
      bot.inventory.off?.("updateSlot", scheduleInspect);
      bot.off?.("heldItemChanged", scheduleInspect);
    },
  };
}
