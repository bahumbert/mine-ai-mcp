import { equipCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { isDeepStrictEqual } from "node:util";
import { defineAction, type ActionContext, type RequestExecution } from "../action.js";
import type { ObserveRequest } from "../../session/request.js";
import {
  equipAnnotations,
  equipOutcomes,
  parseEquipRequest,
  EQUIP,
  EQUIP_DESCRIPTION,
  equipInputSchema,
  equipResultSchema,
  type EquipEvidence,
  type EquipmentDestination,
  type EquipmentSlots,
  type EquipRequest,
  type EquipResult,
} from "./contract.js";

function equippedItem(bot: Bot, destination: EquipmentDestination) {
  return destination === "hand" ? bot.heldItem : bot.inventory.slots[bot.getEquipmentDestSlot(destination)];
}

function slot(bot: Bot, destination: EquipmentDestination): string | null {
  return equippedItem(bot, destination)?.name ?? null;
}

/** Inventory slots and counts can change during equip; the selected item's properties must match. */
function itemProperties(item: NonNullable<ReturnType<typeof equippedItem>>) {
  return structuredClone({
    name: item.name, type: item.type, metadata: item.metadata,
    durabilityUsed: item.durabilityUsed ?? null, nbt: item.nbt,
    // Prismarine exposes 1.20.5+ components at runtime but omits them from Item's declarations.
    components: Reflect.get(item, "components") as unknown,
  });
}

/**
 * Number-key swaps address slots without item merging. Prismarine Item.equal
 * currently ignores modern components, so its ordinary pickup clicks mistake
 * a fresh shield for the worn destination shield and leave the latter in place.
 * Remove this workaround when component-aware pickup clicks pass the native fixture.
 */
async function equipFromSlot(bot: Bot, sourceSlot: number, destination: EquipmentDestination): Promise<void> {
  if (bot.currentWindow) throw new Error("Close the container before selecting a player inventory slot.");
  if (bot.inventory.selectedItem) throw new Error("The inventory cursor must be empty before equipping.");
  const destinationSlot = bot.getEquipmentDestSlot(destination);
  if (sourceSlot === destinationSlot) return;
  if (sourceSlot >= 36 && sourceSlot <= 44) {
    if (destination === "hand") bot.setQuickBarSlot(sourceSlot - 36);
    else await bot.clickWindow(destinationSlot, sourceSlot - 36, 2);
    return;
  }
  const hotbarButton = bot.quickBarSlot;
  await bot.clickWindow(sourceSlot, hotbarButton, 2);
  if (destination === "hand") return;
  // Restore the temporary hand slot and preserve both failures if cleanup also fails.
  await using restoreHand = new AsyncDisposableStack();
  restoreHand.defer(() => bot.clickWindow(sourceSlot, hotbarButton, 2));
  await bot.clickWindow(destinationSlot, hotbarButton, 2);
}

/** What every equipment slot holds right now, by item name. */
export function equipmentSlots(bot: Bot): EquipmentSlots {
  return {
    hand: bot.heldItem?.name ?? null,
    offHand: slot(bot, "off-hand"),
    head: slot(bot, "head"),
    torso: slot(bot, "torso"),
    legs: slot(bot, "legs"),
    feet: slot(bot, "feet"),
  };
}

type EquipEntry = EquipEvidence["equipped"][number];
type RequestedEquip = EquipRequest["items"][number];

/** What an equip request keeps across the attempts a reflex splits it into. */
interface EquipProgress {
  /** Source-slot items a finished swap put in their destination, by request index: their source slot now holds another item. */
  readonly swapped: Map<number, EquipEntry>;
  /** A source-slot item's properties, kept before its swap so a swap cut short is recognised in the destination. */
  readonly selected: Map<number, ReturnType<typeof itemProperties>>;
  /** The entries of the attempt running (or last run), read by the progress observer. */
  attempt: EquipEntry[];
}

/** Equip one requested item (or find it already done) and say how it went. */
async function equipRequested(
  bot: Bot,
  requested: RequestedEquip,
  index: number,
  progress: EquipProgress,
  signal: AbortSignal | undefined,
): Promise<EquipEntry> {
  const { itemName, destination, sourceSlot } = requested;
  const done = progress.swapped.get(index);
  if (done) return done;
  if (sourceSlot === undefined && slot(bot, destination) === itemName) return { item: itemName, destination, equipped: true };
  const kept = progress.selected.get(index);
  const worn = equippedItem(bot, destination);
  if (kept && worn && worn.name === itemName && isDeepStrictEqual(itemProperties(worn), kept)) {
    const entry = { item: itemName, destination, sourceSlot: sourceSlot!, durabilityUsed: worn.durabilityUsed ?? null, equipped: true };
    progress.swapped.set(index, entry);
    return entry;
  }
  const item = sourceSlot === undefined
    ? bot.inventory.items().find((candidate) => candidate.name === itemName)
    : bot.inventory.slots[sourceSlot];
  if (sourceSlot !== undefined && item?.name !== itemName) {
    return { item: itemName, destination, sourceSlot, equipped: false,
      error: equipOutcomes.sourceMismatch(itemName, sourceSlot, item?.name ?? null) };
  }
  if (!item) return { item: itemName, destination, equipped: false, error: equipOutcomes.notCarried(itemName) };
  const selectedProperties = itemProperties(item);
  const selection = sourceSlot === undefined ? {} : { sourceSlot, durabilityUsed: item.durabilityUsed ?? null };
  if (sourceSlot !== undefined) progress.selected.set(index, selectedProperties);
  try {
    if (sourceSlot === undefined) await bot.equip(item, destination);
    else await equipFromSlot(bot, sourceSlot, destination);
  } catch (cause) {
    signal?.throwIfAborted();
    return { item: itemName, destination, ...selection, equipped: false, error: equipOutcomes.rejected(itemName, cause) };
  }
  const held = equippedItem(bot, destination);
  if (!held || held.name !== itemName || (sourceSlot !== undefined && !isDeepStrictEqual(itemProperties(held), selectedProperties))) {
    return { item: itemName, destination, ...selection, equipped: false, error: equipOutcomes.notObserved(itemName, destination) };
  }
  const entry = { item: itemName, destination, ...selection, equipped: true };
  if (sourceSlot !== undefined) progress.swapped.set(index, entry);
  return entry;
}

/**
 * One request's executor: a source-slot swap that finished in an earlier attempt stays done (its source slot holds
 * another item now), and every other item is looked at again, so the attempt after a reflex does what is left.
 */
export function beginEquip(bot: Bot, request: EquipRequest, observe: ObserveRequest): RequestExecution<EquipResult> {
  const progress: EquipProgress = { swapped: new Map(), selected: new Map(), attempt: [] };
  observe(() => ({
    baseline: null,
    checkpoint: { phase: "equipping", completed: progress.attempt.filter((entry) => entry.equipped).length,
      requested: request.items.length, equipment: { ...equipmentSlots(bot) } },
    completion: { kind: "current", observed: progress.attempt.length === request.items.length && progress.attempt.every((entry) => entry.equipped),
      owes: "Every requested equipment operation confirmed in its destination slot." },
  }));
  return async (context) => {
    const equipped: EquipEntry[] = [];
    progress.attempt = equipped;
    for (const [index, requested] of request.items.entries()) {
      context.signal?.throwIfAborted();
      equipped.push(await equipRequested(bot, requested, index, progress, context.signal));
    }
    const evidence: EquipEvidence = { equipped, equipment: equipmentSlots(bot) };
    const failed = equipped.filter((entry) => !entry.equipped).length;
    if (failed === 0) return { status: "succeeded", equip: evidence };
    return {
      status: failed === equipped.length ? "failed" : "partial",
      error: equipOutcomes.incomplete(failed, equipped.length),
      equip: evidence,
    };
  };
}

/** Equip each requested item in turn and report what every slot holds afterwards. */
export function equip(bot: Bot, request: EquipRequest, context: ActionContext): Promise<EquipResult> {
  return beginEquip(bot, request, context.observeProgress ?? (() => {}))(context);
}

export function formatEquipResult(result: EquipResult): string {
  const { equip } = result;
  const lines = equip.equipped.map((entry) =>
    entry.equipped
      ? `- Equipped **${entry.item}** in ${entry.destination}${entry.sourceSlot === undefined ? "" : ` from slot ${entry.sourceSlot}${entry.durabilityUsed == null ? "" : ` (${entry.durabilityUsed} durability used)`}`}.`
      : `- Could not equip **${entry.item}** in ${entry.destination}: ${entry.error ?? "unknown"}`,
  );
  const slots = equip.equipment;
  lines.push(
    "",
    `Now holding \`${slots.hand ?? "nothing"}\`; off-hand \`${slots.offHand ?? "nothing"}\`; wearing head \`${slots.head ?? "-"}\`, torso \`${slots.torso ?? "-"}\`, legs \`${slots.legs ?? "-"}\`, feet \`${slots.feet ?? "-"}\`.`,
  );
  if (result.status !== "succeeded") lines.push("", `**Observed stop:** ${result.error}`);
  return lines.join("\n");
}

export function createEquipAction(bot: Bot) {
  return defineAction({
    checkpointSchema: equipCheckpointSchema,
    name: EQUIP,
    description: EQUIP_DESCRIPTION,
    inputSchema: equipInputSchema,
    resultSchema: equipResultSchema,
    formatResult: formatEquipResult,
    execution: { kind: "resumable_task" },
    annotations: equipAnnotations,
    parse: parseEquipRequest,
    begin: (request, _lifetime, observe) => beginEquip(bot, request, observe),
  });
}
