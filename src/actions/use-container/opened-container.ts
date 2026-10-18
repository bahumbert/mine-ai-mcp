// An open container window and the stack arithmetic behind a transfer, a compaction and an organizing.
import type { Bot } from "mineflayer";
import type { ContainerContent } from "../../bot-data/index.js";
import { useContainerOutcomes } from "./contract.js";

type ContainerWindow = Awaited<ReturnType<Bot["openContainer"]>>;
export type ContainerBlock = NonNullable<ReturnType<Bot["blockAt"]>>;
type ContainerStack = ReturnType<ContainerWindow["containerItems"]>[number];
export type ContainerOperationAttempt = { readonly kind: "completed" } | { readonly kind: "failed"; readonly cause: unknown };

export type ContainerLayoutAttempt =
  | { readonly kind: "completed"; readonly movedStacks: number }
  | { readonly kind: "failed"; readonly movedStacks: number; readonly cause: unknown };

interface PlannedContainerStack {
  readonly slot: number;
  readonly count: number;
  readonly representative: ContainerStack;
}

interface OrganizationPlan {
  readonly stacks: readonly PlannedContainerStack[];
  readonly contents: readonly ContainerContent[];
}

interface OrganizationSettlement {
  readonly execution: ContainerLayoutAttempt;
  readonly matchedSlots: number;
  readonly contentsPreserved: boolean;
  readonly playerInventoryPreserved: boolean;
  readonly cursorEmpty: boolean;
}

export class UseContainerActionError extends Error {}


export class OpenedContainer implements Disposable {
  static async open(bot: Bot, block: ContainerBlock): Promise<OpenedContainer> {
    try {
      const window = await bot.openContainer(block);
      return new OpenedContainer(window, (slot) => bot.clickWindow(slot, 0, 0));
    } catch (cause) {
      throw new UseContainerActionError(useContainerOutcomes.openFailed(cause), { cause });
    }
  }

  private constructor(
    private readonly window: ContainerWindow,
    private readonly clickSlot: (slot: number) => Promise<void>,
  ) {}

  get slotCount(): number {
    return this.window.inventoryStart;
  }

  contents(): ContainerContent[] {
    return this.containerStacks().map(({ slot, name: item, count }) => ({ slot, item, count }));
  }

  observedItemNames(): string[] {
    return [...new Set(this.containerStacks().map(({ name }) => name))].sort();
  }

  planOrganization(itemOrder: readonly string[]): OrganizationPlan {
    const groups = groupCompatibleStacks(this.containerStacks());
    const stacks: PlannedContainerStack[] = [];

    for (const itemName of itemOrder) {
      for (const group of groups.filter(({ representative }) => representative.name === itemName)) {
        const fullStacks = Math.floor(group.totalCount / group.representative.stackSize);
        for (let index = 0; index < fullStacks; index += 1) {
          stacks.push({
            slot: stacks.length,
            count: group.representative.stackSize,
            representative: group.representative,
          });
        }
        const remainder = group.totalCount % group.representative.stackSize;
        if (remainder > 0) stacks.push({ slot: stacks.length, count: remainder, representative: group.representative });
      }
    }

    return {
      stacks,
      contents: stacks.map(({ slot, count, representative }) => ({ slot, item: representative.name, count })),
    };
  }

  async transfer(
    operation: "deposit" | "withdraw",
    itemType: number,
    count: number,
  ): Promise<ContainerOperationAttempt> {
    try {
      if (operation === "deposit") await this.window.deposit(itemType, null, count);
      else await this.window.withdraw(itemType, null, count);
      return { kind: "completed" };
    } catch (cause) {
      return { kind: "failed", cause };
    }
  }

  async compact(signal?: AbortSignal): Promise<ContainerLayoutAttempt> {
    let movedStacks = 0;
    try {
      for (const group of groupCompatibleStacks(this.containerStacks())) {
        movedStacks += await this.compactGroup(group.representative, signal);
      }
      return { kind: "completed", movedStacks };
    } catch (cause) {
      signal?.throwIfAborted();
      return { kind: "failed", movedStacks, cause };
    }
  }

  async organize(plan: OrganizationPlan, signal?: AbortSignal): Promise<OrganizationSettlement> {
    const containerBefore = stackTotals(this.containerStacks());
    const playerInventoryBefore = stackLayout(this.window.items());
    const execution = await this.executeOrganization(plan, signal);
    const after = this.containerStacks();
    const matchedSlots = plan.stacks.filter((expected) => stackAt(after, expected.slot, expected)).length;

    return {
      execution,
      matchedSlots,
      contentsPreserved: stackTotals(after) === containerBefore,
      playerInventoryPreserved: stackLayout(this.window.items()) === playerInventoryBefore,
      cursorEmpty: this.window.selectedItem === null,
    };
  }

  private async executeOrganization(plan: OrganizationPlan, signal?: AbortSignal): Promise<ContainerLayoutAttempt> {
    const settledSlots = new Set<number>();
    const compaction = await this.compact(signal);
    if (compaction.kind === "failed") return compaction;
    let movedStacks = compaction.movedStacks;

    try {
      for (const desired of plan.stacks) {
        signal?.throwIfAborted();
        const current = this.containerStacks();
        if (stackAt(current, desired.slot, desired)) {
          settledSlots.add(desired.slot);
          continue;
        }

        const source = current.find(
          (candidate) =>
            !settledSlots.has(candidate.slot) &&
            sameItemKind(candidate, desired.representative) &&
            candidate.count === desired.count,
        );
        if (!source) {
          throw new Error(`No source stack remained for planned slot ${desired.slot}.`);
        }

        await this.moveStack(source, desired.slot, current);
        movedStacks += 1;
        settledSlots.add(desired.slot);
      }
      return { kind: "completed", movedStacks };
    } catch (cause) {
      signal?.throwIfAborted();
      return { kind: "failed", movedStacks, cause };
    }
  }

  private async compactGroup(representative: ContainerStack, signal?: AbortSignal): Promise<number> {
    let mergedStacks = 0;

    while (true) {
      signal?.throwIfAborted();
      const partials = this.containerStacks()
        .filter((stack) => sameItemKind(stack, representative) && stack.count < stack.stackSize)
        .sort((left, right) => right.count - left.count);
      if (partials.length < 2) return mergedStacks;

      const destination = partials[0]!;
      const source = partials.at(-1)!;
      await this.clickSlot(source.slot);
      await this.clickSlot(destination.slot);
      if (this.window.selectedItem) await this.clickSlot(source.slot);
      if (this.window.selectedItem) throw new Error("A compacted container stack remained held by the cursor.");
      mergedStacks += 1;
    }
  }

  private async moveStack(
    source: ContainerStack,
    destinationSlot: number,
    current: readonly ContainerStack[],
  ): Promise<void> {
    const destination = current.find(({ slot }) => slot === destinationSlot);
    if (!destination || !sameItemKind(destination, source)) {
      await this.moveOrSwapStack(source.slot, destinationSlot);
      return;
    }

    // Left-clicking two stacks of the same item merges them, so use one empty slot as a swap buffer.
    const bufferSlot = this.window.firstEmptyContainerSlot();
    if (bufferSlot === null) {
      throw new Error("No empty container slot was available to swap matching item stacks.");
    }
    await this.moveOrSwapStack(destinationSlot, bufferSlot);
    await this.moveOrSwapStack(source.slot, destinationSlot);
    await this.moveOrSwapStack(bufferSlot, source.slot);
  }

  private async moveOrSwapStack(sourceSlot: number, destinationSlot: number): Promise<void> {
    await this.clickSlot(sourceSlot);
    await this.clickSlot(destinationSlot);
    if (this.window.selectedItem) await this.clickSlot(sourceSlot);
    if (this.window.selectedItem) throw new Error("A container stack remained held by the cursor after its slot move.");
  }

  private containerStacks(): ContainerStack[] {
    return this.window.containerItems().sort((left, right) => left.slot - right.slot);
  }

  [Symbol.dispose](): void {
    this.window.close();
  }
}

interface CompatibleStackGroup {
  readonly representative: ContainerStack;
  totalCount: number;
}

function groupCompatibleStacks(stacks: readonly ContainerStack[]): CompatibleStackGroup[] {
  const groups: CompatibleStackGroup[] = [];
  for (const stack of stacks) {
    const existing = groups.find(({ representative }) => sameItemKind(representative, stack));
    if (existing) existing.totalCount += stack.count;
    else groups.push({ representative: stack, totalCount: stack.count });
  }
  return groups;
}

function sameItemKind(left: ContainerStack, right: ContainerStack): boolean {
  return (
    left.type === right.type &&
    left.metadata === right.metadata &&
    JSON.stringify(left.nbt) === JSON.stringify(right.nbt)
  );
}

function stackAt(stacks: readonly ContainerStack[], slot: number, expected: PlannedContainerStack): boolean {
  const actual = stacks.find((stack) => stack.slot === slot);
  return actual !== undefined && sameItemKind(actual, expected.representative) && actual.count === expected.count;
}

function stackIdentity(stack: ContainerStack): string {
  return `${stack.type}\u0000${stack.metadata}\u0000${JSON.stringify(stack.nbt)}`;
}

function stackTotals(stacks: readonly ContainerStack[]): string {
  const totals = new Map<string, number>();
  for (const stack of stacks) {
    const identity = stackIdentity(stack);
    totals.set(identity, (totals.get(identity) ?? 0) + stack.count);
  }
  return JSON.stringify([...totals].sort(([left], [right]) => left.localeCompare(right)));
}

function stackLayout(stacks: readonly ContainerStack[]): string {
  return JSON.stringify(
    stacks
      .map((stack) => ({ slot: stack.slot, identity: stackIdentity(stack), count: stack.count }))
      .sort((left, right) => left.slot - right.slot),
  );
}
