/** A carried stack; `durability` only for items that wear out (tools, armour), as the runtime reports it. */
export interface CarriedStack {
  readonly name: string;
  readonly count: number;
  readonly durability?: { readonly remaining: number; readonly maximum: number } | null;
  /** The item's families (`sword`, `food`...) as the runtime reports them; `status()` always sets it, `[]` when the item has none or the runtime is older. Optional so hand-built stacks need not list it. */
  readonly families?: readonly string[];
}
