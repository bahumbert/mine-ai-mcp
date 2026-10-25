// Deposit and withdraw by variant: the clicks of a transfer, told apart by components instead of Mineflayer's `nbt` (null on 1.21.4).
// Mineflayer's `transfer` takes any variant as its source and any partial stack of the item as its destination (`inventory.js:314,334-335`),
// so a plain deposit lands on a renamed stack, the server swaps the two (contract check `variant-transfer-clicks`) and the cursor keeps a stack.
import type { Bot } from "mineflayer";
import { isPlainItem, itemVariantKey } from "../../world/item-variant.js";
import { type ClickAnswerWatch, type ClickWaitTiming, ClickAnswerTimeout, watchClickAnswer } from "./window-answer.js";

type ContainerWindow = Awaited<ReturnType<Bot["openContainer"]>>;
type WindowStack = NonNullable<ContainerWindow["slots"][number]>;
type Operation = "deposit" | "withdraw";

/**
 * Longest a `transferByVariant` call goes on the monotonic wall clock without a source stack settling: the bound renews at each
 * answer, so a 27-stack transfer on a slow server (each stack waits 40 ticks) goes on while the stacks keep settling, and a
 * stall inside one stack's wait is bounded by the click's own `CLICK_STALL_MS` and `CLICK_WALL_MS`. It is a guard against a hang
 * (clicks that take long to write, rounds of recovery), not the transfer's total time: the caller's abort ends a transfer sooner.
 */
const TRANSFER_WALL_MS = 90_000;
/** Times a stack the server left in hand after its answer is put back before the transfer gives up on it. */
const CURSOR_RECOVERY_ROUNDS = 3;

export interface VariantTransferOptions {
  /** Checked before every click: a hunger reflex must not wait for a whole stack. The stack in hand goes back first, then the call rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /** The clock of the waits for the server's answers (a test passes the fake clock's); the monotonic wall clock by default. */
  readonly timing?: ClickWaitTiming;
  readonly wallMs?: number;
}

/** What the cursor holds, as the transfer knows it: the client's own copy of a stack in hand may have lost its components (Prismarine rebuilds a split half without them), so the variant comes from the stack it was taken from. */
interface Held {
  readonly key: string;
  readonly name: string;
  readonly stackSize: number;
  count: number;
}

/** How the stack in hand goes onto a destination stack that holds `destCount`: one left click, the half-pickup path, or single right clicks. */
export type Placement =
  | { readonly kind: "whole"; readonly moved: number }
  | { readonly kind: "half"; readonly moved: number; readonly afterLeftClick: number; readonly rights: number }
  | { readonly kind: "singles"; readonly moved: number };

/**
 * Mineflayer's choice (`inventory.js:357-367`): a left click moves what fits when that is no more than wanted; else the half-pickup path
 * (left-click everything onto the destination, right-click it with an empty hand to take the larger half back, then right-click single
 * items for the difference) when it costs fewer clicks than one right click per item.
 */
export function planPlacement(held: number, stackSize: number, destCount: number, wanted: number): Placement {
  const fits = Math.min(stackSize - destCount, held);
  if (fits <= wanted) return { kind: "whole", moved: fits };
  const target = destCount + wanted;
  const half = Math.floor(Math.min(destCount + held, stackSize) / 2);
  if (half <= target && 3 + target - half < wanted) return { kind: "half", moved: wanted, afterLeftClick: held - fits, rights: target - half };
  return { kind: "singles", moved: wanted };
}

class VariantTransfer {
  private readonly now: () => number;
  /** The wall time after which the next click is refused; pushed on by every settled answer. */
  private deadline: number;
  private readonly wallMs: number;
  private held: Held | null = null;
  private readonly sourceStart: number;
  private readonly sourceEnd: number;
  private readonly destStart: number;
  private readonly destEnd: number;

  constructor(
    private readonly bot: Bot,
    private readonly window: ContainerWindow,
    private readonly operation: Operation,
    private readonly options: VariantTransferOptions,
  ) {
    this.now = options.timing?.now ?? (() => performance.now());
    this.wallMs = options.wallMs ?? TRANSFER_WALL_MS;
    this.deadline = this.now() + this.wallMs;
    const { inventoryStart, inventoryEnd } = window;
    [this.sourceStart, this.sourceEnd, this.destStart, this.destEnd] = operation === "deposit" ? [inventoryStart, inventoryEnd, 0, inventoryStart] : [0, inventoryStart, inventoryStart, inventoryEnd];
  }

  async run(itemType: number, count: number): Promise<void> {
    // Mineflayer threw this before any click (`inventory.js:385-386`): a full inventory takes nothing.
    if (this.operation === "withdraw" && this.bot.inventory.emptySlotCount() === 0) {
      throw new Error("Unable to withdraw, Bot inventory is full. Drop or store something, then withdraw again.");
    }
    let remaining = count;
    while (remaining > 0) {
      const stop = this.stopReason();
      if (stop) throw stop;
      const source = this.nextSource(itemType);
      if (source === null) throw new Error(this.missingSourceMessage(itemType, count - remaining));
      remaining -= await this.moveFromSource(source, remaining).catch((cause: unknown) => {
        if (!(cause instanceof ClickAnswerTimeout)) throw cause;
        throw new ClickAnswerTimeout(cause.slot, cause.waited, cause.age, count - remaining, count, { cause });
      });
    }
  }

  /** Wait for the server's answer to the clicks sent since the watch began; the transfer's deadline starts over once it came. */
  private async settleAnswer(answer: ClickAnswerWatch, slot: number): Promise<void> {
    await answer.settle(slot, this.options.signal);
    this.deadline = this.now() + this.wallMs;
  }

  /** Why the next click must not be sent, if it must not: the window is no longer the open one, an abort, or the call's wall bound (a rescue click ignores the last two). */
  private stopReason(rescue = false): Error | null {
    if (this.bot.currentWindow !== this.window) {
      return new Error("The container window closed under the transfer: reopen the container and read what it holds before moving more.");
    }
    if (rescue) return null;
    if (this.options.signal?.aborted) return abortReason(this.options.signal);
    if (this.now() <= this.deadline) return null;
    return new Error(`The transfer took longer than ${this.wallMs} ms: the server is lagging or stopped. Reopen the container and read what it holds before moving more.`);
  }

  private async click(slot: number, mouseButton: number, rescue = false): Promise<void> {
    const stop = this.stopReason(rescue);
    if (stop) throw stop;
    await this.bot.clickWindow(slot, mouseButton, 0);
  }

  /** The next stack of the item in the source range: plain ones first (a request by name means the plain item), then by slot. */
  private nextSource(itemType: number): WindowStack | null {
    const stacks: WindowStack[] = [];
    for (let slot = this.sourceStart; slot < this.sourceEnd; slot += 1) {
      const item = this.window.slots[slot];
      if (item?.type === itemType) stacks.push(item);
    }
    stacks.sort((left, right) => Number(!isPlainItem(left)) - Number(!isPlainItem(right)) || left.slot - right.slot);
    return stacks[0] ?? null;
  }

  private missingSourceMessage(itemType: number, moved: number): string {
    const name = this.bot.registry.items[itemType]?.name ?? String(itemType);
    const where = this.operation === "deposit" ? "the inventory" : "the container";
    return `Can't find ${name} in ${where} (slots ${this.sourceStart} - ${this.sourceEnd}, item id ${itemType})${moved > 0 ? ` after moving ${moved}` : ""}: read what it holds before asking for more.`;
  }

  /** Take one source stack in hand, place up to `wanted` of it, put the rest back, and wait once for the server's answer to all of it. Returns what the destination gained. */
  private async moveFromSource(source: WindowStack, wanted: number): Promise<number> {
    const sourceSlot = source.slot;
    const key = itemVariantKey(source);
    const destinationBefore = this.destinationCount(key);
    const answer = watchClickAnswer(this.bot, this.window, this.options.timing);
    try {
      this.held = { key, name: source.name, stackSize: source.stackSize, count: 0 };
      await this.click(sourceSlot, 0);
      this.held.count = source.count;
      await this.placeAndReturn(sourceSlot, wanted);
      await this.settleAnswer(answer, sourceSlot);
    } finally {
      answer.stop();
    }
    await this.settleCursor(sourceSlot);
    const moved = this.destinationCount(key) - destinationBefore;
    if (moved <= 0) {
      throw new Error(`The server took none of the ${source.name} taken from slot ${sourceSlot}: its answer left the destination as it was. Reopen the container and read what it holds.`);
    }
    return moved;
  }

  /** Place `wanted` of the stack in hand, then put what is left back; whatever stops the placing (an abort, a full destination, a close) still puts the stack back first. */
  private async placeAndReturn(sourceSlot: number, wanted: number): Promise<void> {
    try {
      let left = Math.min(wanted, this.held!.count);
      while (left > 0) left -= await this.placeOnDestination(sourceSlot, left);
    } catch (cause) {
      await this.putBackBestEffort(sourceSlot);
      throw cause;
    }
    await this.putBack(sourceSlot, false);
  }

  /** One destination stack gets items: a partial stack of the variant (fullest first), else the first empty slot. Returns how many it took. */
  private async placeOnDestination(sourceSlot: number, wanted: number): Promise<number> {
    const held = this.held!;
    const destination = this.destinationSlot(held);
    if (destination === null) {
      const next = this.operation === "deposit" ? "Free a slot in the container or use another container" : "Drop or store something";
      throw new Error(`destination full: the ${this.operation === "deposit" ? "container" : "inventory"} has no free slot or partial ${held.name} stack left. ${next}, then ${this.operation} again.`);
    }
    const placement = planPlacement(held.count, held.stackSize, this.window.slots[destination]?.count ?? 0, wanted);
    if (placement.kind === "whole") {
      await this.click(destination, 0);
      held.count -= placement.moved;
    } else if (placement.kind === "half") {
      await this.placeByHalfPickup(destination, sourceSlot, placement);
    } else {
      for (let placed = 0; placed < placement.moved; placed += 1) {
        await this.click(destination, 1);
        held.count -= 1;
      }
    }
    return placement.moved;
  }

  /**
   * Left-click everything onto the destination, put what did not fit back, take the larger half with an empty hand, then single items for the difference.
   * Once the whole stack lies on the destination, the put-back and the take-back are rescue clicks (an abort, the wall bound or a lagging answer must not leave more there than was asked).
   */
  private async placeByHalfPickup(destination: number, sourceSlot: number, placement: Extract<Placement, { kind: "half" }>): Promise<void> {
    const held = this.held!;
    const together = Math.min((this.window.slots[destination]?.count ?? 0) + held.count, held.stackSize);
    await this.click(destination, 0);
    held.count = placement.afterLeftClick;
    if (held.count > 0) await this.putBack(sourceSlot, true);
    await this.click(destination, 1, true);
    held.count = Math.ceil(together / 2);
    for (let single = 0; single < placement.rights; single += 1) {
      await this.click(destination, 1);
      held.count -= 1;
    }
  }

  private destinationSlot(held: Held): number | null {
    return this.fullestPartialOf(held, this.destStart, this.destEnd) ?? this.window.firstEmptySlotRange(this.destStart, this.destEnd);
  }

  /** The slot of the range holding the fullest stack of the variant that has room, or null. */
  private fullestPartialOf(held: Held, start: number, end: number): number | null {
    let best: number | null = null;
    let bestCount = -1;
    for (let slot = start; slot < end; slot += 1) {
      const item = this.window.slots[slot];
      if (item && item.count < item.stackSize && item.count > bestCount && itemVariantKey(item) === held.key) [best, bestCount] = [slot, item.count];
    }
    return best;
  }

  /** How many of the variant the destination range holds. */
  private destinationCount(key: string): number {
    let total = 0;
    for (let slot = this.destStart; slot < this.destEnd; slot += 1) {
      const item = this.window.slots[slot];
      if (item && itemVariantKey(item) === key) total += item.count;
    }
    return total;
  }

  /**
   * Put the stack in hand back into the source range: a partial stack of its variant (fullest first), else the slot it came from when it
   * is empty, else the first empty slot, else the call fails naming what the cursor holds (the close then gives it to the inventory).
   */
  private async putBack(sourceSlot: number, rescue: boolean): Promise<void> {
    const held = this.held!;
    while (held.count > 0) {
      const slot = this.putBackSlot(held, sourceSlot);
      if (slot === null) {
        throw new Error(`cursor holds ${held.count} ${held.name}: the ${this.operation === "deposit" ? "inventory" : "container"} has no room for it. It goes to your inventory (or falls to the ground when that is full) when this call closes the container: check what you carry and what lies at your feet.`);
      }
      const room = held.stackSize - (this.window.slots[slot]?.count ?? 0);
      await this.click(slot, 0, rescue);
      held.count -= Math.min(room, held.count);
    }
  }

  private putBackSlot(held: Held, sourceSlot: number): number | null {
    const partial = this.fullestPartialOf(held, this.sourceStart, this.sourceEnd);
    if (partial !== null) return partial;
    return this.window.slots[sourceSlot] ? this.window.firstEmptySlotRange(this.sourceStart, this.sourceEnd) : sourceSlot;
  }

  /** Put back a stack an abort, a full destination or a closed window interrupted, without replacing the cause being thrown: a failed put-back leaves the stack in hand for the close to give to the inventory. */
  private async putBackBestEffort(sourceSlot: number): Promise<void> {
    try {
      await this.putBack(sourceSlot, true);
    } catch {
      // The stack stays in hand: the close gives it to the inventory (contract check variant-transfer-clicks), and the window's counts settle what moved.
    }
  }

  /** After the server's answer the hand must be empty; a stack it left in hand (another player changed a slot meanwhile) goes back by what the server says it is, each round waiting for its own answer. */
  private async settleCursor(sourceSlot: number): Promise<void> {
    for (let round = 0; round < CURSOR_RECOVERY_ROUNDS; round += 1) {
      const cursor = this.window.selectedItem;
      if (!cursor) return;
      this.held = { key: itemVariantKey(cursor), name: cursor.name, stackSize: cursor.stackSize, count: cursor.count };
      const answer = watchClickAnswer(this.bot, this.window, this.options.timing);
      try {
        await this.putBack(sourceSlot, true);
        await this.settleAnswer(answer, sourceSlot);
      } finally {
        answer.stop();
      }
    }
    const cursor = this.window.selectedItem;
    if (cursor) {
      throw new Error(`cursor holds ${cursor.count} ${cursor.name}: the server keeps giving the stack back to the hand. It goes to your inventory (or falls to the ground when that is full) when this call closes the container: check what you carry and what lies at your feet.`);
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted"));
}

/**
 * Move up to `count` of `itemType` between the player's slots and the container's by clicks, never onto a stack of another variant: plain
 * stacks are taken first, a partial stack of the same variant or an empty slot is the destination. Rejects with what stopped it (its message
 * is the cause the model reads); the stack in hand is put back first unless the window closed under it.
 */
export async function transferByVariant(
  bot: Bot,
  window: ContainerWindow,
  operation: Operation,
  itemType: number,
  count: number,
  options: VariantTransferOptions = {},
): Promise<void> {
  await new VariantTransfer(bot, window, operation, options).run(itemType, count);
}
