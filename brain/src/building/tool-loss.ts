import { errorCode, type ItemCount } from "../runtime-client.ts";

/** Cobblestone a stone tool of each class takes: with that much spare, the tool is made in stone, else in wood. */
export const TOOL_COBBLESTONE: Readonly<Record<string, number>> = { pickaxe: 3, axe: 3, shovel: 1, hoe: 2 };

/** The class (`pickaxe`, `shovel`...) of the tool a `[TOOL_TIER_LOST] stone_pickaxe was lost ...` error names; null for any other error. */
export function lostToolClass(error: string | null | undefined): string | null {
  if (errorCode(error) !== "TOOL_TIER_LOST") return null;
  const name = /^\[TOOL_TIER_LOST\] ([a-z_]+) was lost/u.exec(error ?? "")?.[1];
  return name?.split("_").at(-1) ?? null;
}

/** The best tier of a tool class the spare materials allow: stone with the cobblestone for it, else wood. */
export function toolToMake(toolClass: string, spare: (item: string) => number): string {
  return spare("cobblestone") >= (TOOL_COBBLESTONE[toolClass] ?? 3) ? `stone_${toolClass}` : `wooden_${toolClass}`;
}

/** What {@link ToolLosses} needs from the skill it serves. */
export interface ToolLossDeps {
  /** Materials that are not spare (the bill of what is being built): never spent on a tool. */
  readonly reserved: readonly ItemCount[];
  readonly inventory: () => Promise<readonly { readonly name: string; readonly count: number }[]>;
  /** The `get_items` skill: fetches and crafts what is missing. */
  readonly getItems: (items: readonly ItemCount[], purpose: string) => Promise<{ readonly status: "done" | "failed" | "stopped"; readonly detail?: string }>;
}

export type ToolLossOutcome =
  | { readonly status: "none" }
  | { readonly status: "stopped" }
  | { readonly status: "remade"; readonly item: string }
  /** Lost again after being made again in this step, or the making failed: `note` is added to the failure's detail. */
  | { readonly status: "refused" | "failed"; readonly note: string };

/**
 * The tools a player replaces when they wear out in the middle of a job, as the `get_items` skill does: once per tool
 * class in one step (one instance per step), so a tool that keeps dying ends the step instead of looping.
 */
export class ToolLosses {
  private readonly remade = new Map<string, string>();

  /** Handles a failed action's `error`: makes the lost tool again (`remade`: do the part again) or says why not. */
  async handle(error: string | null | undefined, deps: ToolLossDeps): Promise<ToolLossOutcome> {
    const toolClass = lostToolClass(error);
    if (toolClass === null) return { status: "none" };
    const before = this.remade.get(toolClass);
    if (before !== undefined) return { status: "refused", note: `${before} was remade earlier in this step and lost again` };
    const inventory = await deps.inventory();
    const carried = (item: string) => inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
    const spare = (item: string) => carried(item) - (deps.reserved.find((entry) => entry.item === item)?.count ?? 0);
    const have = inventory.find((stack) => stack.name.endsWith(`_${toolClass}`));
    const item = have?.name ?? toolToMake(toolClass, spare);
    if (have === undefined) {
      const got = await deps.getItems([{ item, count: 1 }], `a new ${toolClass} to go on (one wore out)`);
      if (got.status === "stopped") return { status: "stopped" };
      if (got.status === "failed") return { status: "failed", note: `making a new ${item} failed: ${got.detail ?? "failed"}` };
    }
    this.remade.set(toolClass, item);
    return { status: "remade", item };
  }

  /** What was made again so far, for a failure's detail: "" when nothing. */
  describe(): string {
    return this.remade.size === 0 ? "" : `remade ${[...this.remade.values()].join(", ")}`;
  }
}
