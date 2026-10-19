// The hand-off routines of a trade, as code (no work-tier call): give my side with `give_item`, or collect theirs from the ground.
import { runStep, type SkillContext, type SkillResult } from "../skills.ts";
import type { ItemCount } from "./types.ts";

/** How far around itself a collect looks for the partner's items. */
export const COLLECT_RADIUS = 6;
/** Starts a failed give's detail when what I meant to give is no longer carried. */
const ITEMS_GONE = "[ITEMS_GONE]";

export type Handoff =
  | { readonly kind: "give"; readonly tradeId: string; readonly partner: string; readonly items: readonly ItemCount[] }
  | { readonly kind: "collect"; readonly tradeId: string; readonly items: readonly ItemCount[] };

const side = (items: readonly ItemCount[]): string => items.map((i) => `${i.count} ${i.item}`).join(", ");

/** The objective text of a hand-off, as the monitor and the logs show it. */
export function describeHandoff(h: Handoff): string {
  return h.kind === "give" ? `hand over ${side(h.items)} to ${h.partner} (trade)` : `pick up ${side(h.items)} the partner of my trade gave me (trade)`;
}

export interface HandoffEnd {
  readonly outcome: "done" | "items_gone" | "failed" | "dropped";
  readonly detail: string;
}

/** The controller's reading of a hand-off's result: stopped is dropped (the trade stays due), items gone is told apart. */
export function handoffOutcome(result: SkillResult): HandoffEnd {
  if (result.status === "stopped") return { outcome: "dropped", detail: "stopped" };
  if (result.status === "done") return { outcome: "done", detail: result.detail };
  return result.detail.startsWith(ITEMS_GONE)
    ? { outcome: "items_gone", detail: result.detail.slice(ITEMS_GONE.length).trim() }
    : { outcome: "failed", detail: result.detail };
}

async function giveMySide(context: SkillContext, partner: string, items: readonly ItemCount[]): Promise<SkillResult> {
  const { inventory } = await context.runtime.status();
  const short = items.filter((i) => inventory.filter((s) => s.name === i.item).reduce((sum, s) => sum + s.count, 0) < i.count);
  if (short.length > 0) return { status: "failed", detail: `${ITEMS_GONE} I no longer carry ${side(short)}` };
  for (const { item, count } of items) {
    const given = await runStep({ skill: "give_item", player: partner, item, count }, context);
    if (given.status !== "done") return given;
  }
  return { status: "done", detail: `gave ${side(items)} to ${partner}` };
}

async function collectTheirSide(context: SkillContext, items: readonly ItemCount[]): Promise<SkillResult> {
  const failures: string[] = [];
  let picked = 0;
  for (const { item } of items) {
    const outcome = await context.body.act("pick_up_items", { item, radius: COLLECT_RADIUS }, `Pick up the ${item} the partner of my trade gave me.`, { signal: context.signal });
    if (context.signal.aborted) return { status: "stopped" };
    if (outcome.status === "succeeded") picked += 1;
    else failures.push(outcome.error ?? `pick_up_items ${outcome.status}`);
  }
  return picked > 0 || failures.length === 0 ? { status: "done", detail: `picked up ${side(items)} around me` } : { status: "failed", detail: failures.join("; ") };
}

/** Runs one hand-off: `give_item` for each entry of my side, or `pick_up_items` around me for each entry of theirs. */
export function runHandoff(context: SkillContext, h: Handoff): Promise<SkillResult> {
  return h.kind === "give" ? giveMySide(context, h.partner, h.items) : collectTheirSide(context, h.items);
}
