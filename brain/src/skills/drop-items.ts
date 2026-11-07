// Making room in the inventory and giving items up: drop_item, with its chest deposit and the room made for crafts.
import { dropEntries, type Step } from "../actions.ts";
import { bestTool, junkHint, junkStacks, KEPT_KINDS, kindOf } from "../inventory-room.ts";
import type { BotSnapshot, CarriedStack } from "../runtime-client.ts";
import type { SkillContext, SkillResult } from "../skills.ts";

/** The player inventory's main slots (hotbar included). */
const INVENTORY_SLOTS = 36;

/**
 * Frees a slot for a craft or a smelt from the carried items neither its own work nor the objective needs (the same
 * sparing as {@link dropItems}): one stack at a time, the kind with most stacks first (`junkStacks`' order), until a slot is free. `inputs` are what the
 * craft or the smelt consumes: never dropped, whatever the objective says (run 13: a full inventory of cobblestone lost
 * all of it to a stone shovel craft). False for an order (no `needed`), when everything carried is needed, or when no
 * slot came free: the failure then names what to drop.
 */
export async function makeRoom(context: SkillContext, inputs: ReadonlySet<string>): Promise<boolean> {
  if (context.needed === undefined) return false;
  for (let attempt = 0; attempt < INVENTORY_SLOTS; attempt++) {
    const before = await context.runtime.status();
    // The kind junkStacks lists first (most stacks: a lone bucket or pair of shears is never first), and a count drops
    // the kind's stacks in inventory order: the first stack's count frees exactly the first stack.
    const [kind] = junkStacks(before, new Set([...context.needed(before), ...inputs]));
    if (kind === undefined) return false;
    const dropped = await dropItems(context, { skill: "drop_item", items: [{ item: kind.name, count: kind.stacks[0]! }] }, "Make room in the inventory for what I am crafting.");
    if (dropped.status !== "done") return false;
    if ((await context.runtime.status()).inventory.length < INVENTORY_SLOTS) return true;
  }
  return false;
}

/** What the action says it really dropped (its `drop.dropped` counts); null when the result carries none. */
function reallyDropped(result: Readonly<Record<string, unknown>> | undefined): { item: string; count: number }[] | null {
  const dropped = (result?.drop as { dropped?: unknown } | undefined)?.dropped;
  if (!Array.isArray(dropped)) return null;
  return dropped
    .map((entry: { item?: unknown; dropped?: unknown }) => ({ item: String(entry.item), count: Number(entry.dropped) }))
    .filter((entry) => entry.count > 0);
}

/**
 * The last tool of a class, the last bed and the last boat stay in the inventory: one is kept, the best carried (`bestTool`)
 * (live 2026-10-10 run 8: Ayla dropped her stone pickaxe, axe, shovel, boat and bed; Yuki her axe while crafting one).
 */
function keepLastOfKind(entries: readonly { item: string; count?: number }[], inventory: readonly CarriedStack[]): { entries: { item: string; count?: number }[]; kept: string[] } {
  const carried = (item: string) => inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
  const result = entries.map((entry) => ({ ...entry }));
  const kept: string[] = [];
  for (const kind of KEPT_KINDS) {
    const owned = [...new Set(inventory.filter((stack) => kindOf(stack) === kind).map((stack) => stack.name))];
    if (owned.length === 0) continue;
    const dropping = (item: string) => { const entry = result.find((candidate) => candidate.item === item); return entry === undefined ? 0 : Math.min(entry.count ?? carried(item), carried(item)); };
    if (owned.some((item) => carried(item) - dropping(item) > 0)) continue;
    const keep = bestTool(inventory.filter((stack) => kindOf(stack) === kind))!.name;
    const entry = result.find((candidate) => candidate.item === keep);
    if (entry === undefined) continue;
    entry.count = Math.max(0, dropping(keep) - 1);
    kept.push(`kept 1 ${keep}: your only ${kind}`);
  }
  return { entries: result.filter((entry) => entry.count !== 0), kept };
}

/** How far a remembered own chest may be for a drop to walk to it instead of burying. */
const CHEST_REACH = 32;

/**
 * Deposits what a drop gives up into the nearest own chest (one she placed, or one in her own protected region) in the
 * dimension she is in, within {@link CHEST_REACH} blocks, that has a slot free or was never opened (`use_container`: it
 * walks there itself). Null when there is none or the deposit did not succeed: the items are then buried as ever (run 15
 * N5: 378 cobblestone buried while a chest stood by the house; review 2026-10-19 #8: a village chest, the Nether).
 */
async function storeInChest(context: SkillContext, entries: readonly { item: string; count?: number }[], before: BotSnapshot, why: string): Promise<SkillResult | null> {
  if (context.self === undefined) return null;
  const chest = (await context.runtime.knownContainers(context.self, before.position, CHEST_REACH, before.dimension).catch(() => [])).find((known) => known.slotCount === null || known.usedSlots < known.slotCount);
  if (chest === undefined) return null;
  const carried = (item: string) => before.inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
  const items = entries.map((entry) => ({ item_name: entry.item, count: Math.min(entry.count ?? carried(entry.item), carried(entry.item)) })).filter((entry) => entry.count > 0);
  if (items.length === 0) return null;
  const outcome = await context.body.act("use_container", { operation: "deposit", x: chest.x, y: chest.y, z: chest.z, items }, why, { signal: context.signal });
  if (context.signal.aborted) return { status: "stopped" };
  if (outcome.status !== "succeeded") return null;
  const free = Math.max(0, INVENTORY_SLOTS - (await context.runtime.status()).inventory.length);
  return { status: "done", detail: `stored ${items.map((entry) => `${entry.count} ${entry.item_name}`).join(", ")} in your chest at ${chest.x} ${chest.y} ${chest.z}; ${free === 0 ? "the inventory is still full" : `the inventory has room again: ${free} of ${INVENTORY_SLOTS} slots free`}` };
}

/**
 * Buries the items in a pit; only a place with no pit within reach (water all around, bedrock) puts them on the ground,
 * and the action itself walks off from them. The step says what was really dropped, never what was asked (live 2026-10-10 run 7: 26
 * identical drops each "done" while the action dropped 0), and whether the inventory has room again.
 */
export async function dropItems(context: SkillContext, step: Extract<Step, { skill: "drop_item" }>, why: string): Promise<SkillResult> {
  const before = await context.runtime.status();
  const own = keepLastOfKind(dropEntries(step), before.inventory);
  // The work's items are spared only while something else could go: with everything needed, keeping them all made
  // a full inventory a dead end (run 11, 2026-10-14: Mira, "nothing dropped; kept all 100 cobblestone" 16 times).
  const workNeeds = context.needed?.(before) ?? new Set<string>();
  const needed = before.inventory.some((stack) => !workNeeds.has(stack.name)) ? workNeeds : new Set<string>();
  const kept = [...own.kept];
  const entries = own.entries.filter((entry) => {
    // A tool, bed or boat asked to go is a copy: the last of the class was kept above.
    if (!needed.has(entry.item) || before.inventory.some((stack) => stack.name === entry.item && kindOf(stack) !== null)) return true;
    const all = before.inventory.filter((stack) => stack.name === entry.item).reduce((sum, stack) => sum + stack.count, 0);
    kept.push(`kept all ${Math.min(entry.count ?? all, all)} ${entry.item}: your current work needs them`);
    return false;
  });
  // What may go instead is said with the refusal, or the same drop came back (run 11: up to 7 times in a row).
  if (entries.length === 0) return { status: "failed", detail: `nothing dropped; ${kept.join("; ")}${needed.size === 0 ? "" : `; ${junkHint(before, needed)}`}` };
  const stored = await storeInChest(context, entries, before, why);
  if (stored !== null) return stored;
  const items = entries.map((entry) => ({ item_name: entry.item, ...(entry.count !== undefined && { count: entry.count }) }));
  const act = (input: Record<string, unknown>) => context.body.act("drop_item", { items, allow_equipped: true, ...input }, why, { signal: context.signal });
  // Buried, not tossed at her feet: a toss lands within a block or two, and she picked most of it up again
  // (owner, live 2026-10-07).
  let outcome = await act({ in_a_hole: true });
  if (context.signal.aborted) return { status: "stopped" };
  let onGround = false;
  if (outcome.status !== "succeeded" && (outcome.error ?? "").includes("[DROP_HOLE_UNAVAILABLE]")) {
    outcome = await act({});
    if (context.signal.aborted) return { status: "stopped" };
    onGround = true;
  }
  const dropped = reallyDropped(outcome.result);
  const total = dropped === null ? (outcome.status === "succeeded" ? 1 : 0) : dropped.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) return { status: "failed", detail: `${outcome.error ?? `drop_item ${outcome.status}`}${kept.length > 0 ? `; ${kept.join("; ")}` : ""}` };
  const what = dropped === null ? entries.map((entry) => `${entry.count ?? "all the"} ${entry.item}`).join(", ") : dropped.map((entry) => `${entry.count} ${entry.item}`).join(", ");
  // How much room it made is what a drop is for (live 2026-10-02: 30 of 36 panes dropped freed no slot); say so, or the
  // model does not see the problem solved (owner, live 2026-10-10).
  const free = Math.max(0, INVENTORY_SLOTS - (await context.runtime.status()).inventory.length);
  const room = free === 0 ? "the inventory is still full" : `the inventory has room again: ${free} of ${INVENTORY_SLOTS} slots free`;
  const failedPart = outcome.status === "partial" && outcome.error !== null ? ` (${outcome.error})` : "";
  const keptNote = kept.length > 0 ? `; ${kept.join("; ")}` : "";
  return { status: "done", detail: `${onGround ? "dropped" : "buried"} ${what}${onGround ? " on the ground" : ""}${failedPart}${keptNote}; ${room}` };
}
