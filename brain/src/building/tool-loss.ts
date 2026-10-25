import { errorCode, type ItemCount } from "../runtime-client.ts";

/** Cobblestone a stone tool of each class takes: with that much spare, the tool is made in stone, else in wood. */
export const TOOL_COBBLESTONE: Readonly<Record<string, number>> = { pickaxe: 3, axe: 3, shovel: 1, hoe: 2 };

/** Losses of one tool class that end a step: the one before it was remade, this one is not. */
export const MAX_TOOL_LOSSES = 3;

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
  /** Told the class of each tool lost, whatever came of it (the objective remembers it: N7). */
  readonly onLost?: (toolClass: string) => void;
  /** Whether work that needs a tool of the class is still to do (leveling: only for the digging left); unset: always. */
  readonly stillNeeded?: (toolClass: string) => boolean;
}

export type ToolLossOutcome =
  | { readonly status: "none" }
  /** Lost, but no work is left that needs it: not made again, the part goes on. */
  | { readonly status: "unneeded" }
  | { readonly status: "stopped" }
  | { readonly status: "remade"; readonly item: string }
  /** Lost again after being made again in this step, or the making failed: `note` is added to the failure's detail. */
  | { readonly status: "refused" | "failed"; readonly note: string };

/** How many losses one step makes good: per tool class and in all (default: one per class, as a building part does). */
export interface ToolLossCaps {
  readonly perClass: number;
  readonly total: number;
}

/**
 * The tools a player replaces when they wear out in the middle of a job, as the `get_items` skill does: a few times per
 * tool class in one step (one instance per step), so a tool that keeps dying ends the step instead of looping.
 */
export class ToolLosses {
  private readonly remade = new Map<string, string>();
  private readonly lossCount = new Map<string, number>();

  constructor(private readonly caps: ToolLossCaps = { perClass: 1, total: Number.POSITIVE_INFINITY }) {}

  /** Handles a failed action's `error`: makes the lost tool again (`remade`: do the part again) or says why not. */
  async handle(error: string | null | undefined, deps: ToolLossDeps): Promise<ToolLossOutcome> {
    const toolClass = lostToolClass(error);
    if (toolClass === null) return { status: "none" };
    deps.onLost?.(toolClass);
    const losses = (this.lossCount.get(toolClass) ?? 0) + 1;
    this.lossCount.set(toolClass, losses);
    const before = this.remade.get(toolClass);
    if (losses > this.caps.perClass || [...this.lossCount.values()].reduce((sum, count) => sum + count, 0) > this.caps.total) {
      return { status: "refused", note: before === undefined ? `the ${toolClass} was lost ${losses} times in this step` : `${before} was remade earlier in this step and lost again (the ${toolClass} was lost ${losses} times in this step)` };
    }
    if (deps.stillNeeded?.(toolClass) === false) return { status: "unneeded" };
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
