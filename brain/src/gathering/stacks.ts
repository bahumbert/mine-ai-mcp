// The shape of an inventory's stacks and how many of an item are carried.

export type Stacks = readonly { readonly name: string; readonly count: number; readonly families?: readonly string[] }[];

export function carried(inventory: Stacks, item: string): number {
  return inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
}
