// The hand-off routines of a trade, as code (no work-tier call): give my side with `give_item`, or collect theirs from the ground.
import type { Clock } from "../conversation/socialise.ts";
import { manhattan } from "../conversation/state.ts";
import type { Position } from "../runtime-client.ts";
import { findPlayer, giveTo, runStep, type SkillContext, type SkillResult } from "../skills.ts";
import { carriedOf, sideText } from "./items.ts";
import { type ItemCount, MINUTE_MS } from "./types.ts";

/** How far around itself a collect looks for the partner's items. */
export const COLLECT_RADIUS = 6;
/**
 * How far around the spot it tossed from a giver looks for the items the partner left: the partner within reach plus a
 * level toss's ~4.3 block slide. Centred on the giver itself, 6 missed them (Mine Labs hand-over-walks-off: it walks off).
 */
export const PICK_BACK_RADIUS = 8;
/** How often a wait for the partner's payment looks at whether it came. */
const AWAIT_POLL_MS = 1_000;
export type Handoff =
  | { readonly kind: "give"; readonly tradeId: string; readonly partner: string; readonly items: readonly ItemCount[] }
  | { readonly kind: "collect"; readonly tradeId: string; readonly items: readonly ItemCount[] }
  | { readonly kind: "await"; readonly tradeId: string; readonly partner: string };

/** What the agent's stack and the controller call a hand-off by: the trade id, except a wait, which shares its trade with the give or the collect on top of it. */
export const handoffKey = (h: Handoff): string => (h.kind === "await" ? awaitKey(h.tradeId) : h.tradeId);
export const awaitKey = (tradeId: string): string => `await:${tradeId}`;

/** The objective text of a hand-off, as the monitor and the logs show it. */
export function describeHandoff(h: Handoff): string {
  if (h.kind === "await") return `wait for ${h.partner} to give their side (trade)`;
  return h.kind === "give" ? `hand over ${sideText(h.items)} to ${h.partner} (trade)` : `pick up ${sideText(h.items)} the partner of my trade gave me (trade)`;
}

export interface HandoffEnd {
  readonly outcome: "done" | "items_gone" | "not_taken" | "failed" | "dropped";
  readonly detail: string;
}

/** The controller's reading of a hand-off's result: stopped is dropped (the trade stays due), items gone and not taken are told apart by the result's reason. */
export function handoffOutcome(result: SkillResult): HandoffEnd {
  if (result.status === "stopped") return { outcome: "dropped", detail: "stopped" };
  if (result.status === "done") return { outcome: "done", detail: result.detail };
  if (result.reason === "items_gone" || result.reason === "not_taken") return { outcome: result.reason, detail: result.detail };
  return { outcome: "failed", detail: result.detail };
}

/** Tells the caller how many of an item the partner took, so a retake gives only what is left. */
export type TakenCredit = (credit: ItemCount) => void;

async function giveMySide(context: SkillContext, partner: string, items: readonly ItemCount[], credit?: TakenCredit): Promise<SkillResult> {
  const { inventory } = await context.runtime.status();
  const short = items.filter((i) => carriedOf(inventory, i.item) < i.count);
  if (short.length > 0) return { status: "failed", detail: `I no longer carry ${sideText(short)}`, reason: "items_gone" };
  const unconfirmed: ItemCount[] = [];
  let sure = true;
  for (const { item, count } of items) {
    const { result, taken, settled, droppedAt } = await giveTo(context, partner, item, count);
    if (result.status !== "done") return result;
    if (Math.min(count, taken ?? count) >= count) {
      credit?.({ item, count });
      continue;
    }
    // The server sends no packet for every pickup (a partial one into a nearly full inventory): the count seen is no proof of what is left, the pick-back is.
    const pickBack = await pickBackCount(context, partner, item, count, droppedAt);
    if (context.signal.aborted || "interrupted" in pickBack) return { status: "stopped" };
    // A pick-back that did not look properly says nothing about what the partner took: no credit, the give stays due.
    if ("unknown" in pickBack) return { status: "failed", detail: `could not pick back the ${item} ${partner} may not have taken (${pickBack.unknown})` };
    const { back } = pickBack;
    if (count - back > 0) credit?.({ item, count: count - back });
    if (back > 0) return notTaken(partner, { item, count: back });
    unconfirmed.push({ item, count });
    sure &&= settled;
  }
  const doubt = sure ? "none of it came back" : "the server had not said whether they took it";
  return { status: "done", detail: `gave ${sideText(items)} to ${partner}${unconfirmed.length > 0 ? ` (${sideText(unconfirmed)} not confirmed taken: ${doubt})` : ""}` };
}

type PickBack = { readonly back: number } | { readonly unknown: string } | { readonly interrupted: true };

/**
 * How many of the item the pick-up around the toss spot got back after a toss that was not all seen taken (carried
 * after minus carried before). Nothing seen, or every item seen gone before it got there, means taken. Unknown when it
 * could not look (no toss spot, an item it could not reach or had no room for, no evidence); interrupted when the
 * pick-up was refused or cancelled (the body taken by another owner): no give failure.
 */
async function pickBackCount(context: SkillContext, partner: string, item: string, left: number, at: Position | null): Promise<PickBack> {
  if (at === null) return { unknown: "the toss result named no spot" };
  const before = carriedOf((await context.runtime.status()).inventory, item);
  const outcome = await context.body.act("pick_up_items", { item, x: at.x, y: at.y, z: at.z, radius: PICK_BACK_RADIUS }, `Pick up the ${item} ${partner} did not take.`, { signal: context.signal });
  if (context.signal.aborted) return { back: 0 };
  if (outcome.preempted || outcome.status === "refused" || outcome.status === "cancelled") return { interrupted: true };
  const back = Math.min(left, Math.max(0, carriedOf((await context.runtime.status()).inventory, item) - before));
  if (back > 0 || outcome.status === "succeeded") return { back };
  const fates = sightingOutcomes(outcome.result);
  const why = outcome.error ?? `pick_up_items ${outcome.status}`;
  if (fates === null) return { unknown: why };
  const stuck = fates.find((fate) => fate !== "collected" && fate !== "gone_unconfirmed");
  return stuck === undefined ? { back } : { unknown: `${stuck}: ${why}` };
}

/** What became of each item the pick-up saw (`pickup.sightings[].outcome`); null when the result names no sightings. */
function sightingOutcomes(result: Readonly<Record<string, unknown>> | undefined): string[] | null {
  const sightings = (result?.pickup as { sightings?: unknown } | undefined)?.sightings;
  return Array.isArray(sightings) ? sightings.map((s) => String((s as { outcome?: unknown }).outcome)) : null;
}

const notTaken = (partner: string, left: ItemCount): SkillResult =>
  ({ status: "failed", detail: `${partner} did not take ${sideText([left])}`, reason: "not_taken" });

async function collectTheirSide(context: SkillContext, items: readonly ItemCount[]): Promise<SkillResult> {
  const failures: string[] = [];
  let picked = 0;
  for (const { item } of items) {
    const outcome = await context.body.act("pick_up_items", { item, radius: COLLECT_RADIUS }, `Pick up the ${item} the partner of my trade gave me.`, { signal: context.signal });
    if (context.signal.aborted) return { status: "stopped" };
    if (outcome.status === "succeeded") picked += 1;
    else failures.push(outcome.error ?? `pick_up_items ${outcome.status}`);
  }
  return picked > 0 || failures.length === 0 ? { status: "done", detail: `picked up ${sideText(items)} around me` } : { status: "failed", detail: failures.join("; ") };
}

export interface AwaitOptions {
  /** Whether the partner's payment is still to come (the trade controller's reading). */
  readonly stillAwaiting: () => boolean;
  readonly clock: Clock;
  /** The wait ends failed after this long on the clock, whatever else happens. */
  readonly maxMs: number;
  /** Farther than this from the partner, the wait first walks up to them. */
  readonly openingDistance: number;
}

/**
 * Waits near a partner who is to pay first: one walk up to them when they are not near (a failed walk is no end: the
 * partner may come to hand over), then a look every second until the payment is credited or the bound on the clock.
 */
export async function awaitTheirSide(context: SkillContext, partner: string, o: AwaitOptions): Promise<SkillResult> {
  const stopped: SkillResult = { status: "stopped" };
  const deadline = o.clock.now() + o.maxMs;
  if (o.stillAwaiting()) {
    const snapshot = await context.runtime.status();
    const there = findPlayer(snapshot, partner)?.position ?? null;
    const away = there === null ? Infinity : manhattan(snapshot.position, there);
    if (away > o.openingDistance) await runStep({ skill: "go_to_player", player: partner }, context);
  }
  while (o.stillAwaiting()) {
    if (context.signal.aborted) return stopped;
    if (o.clock.now() >= deadline) return { status: "failed", detail: `${partner} did not give within ${o.maxMs / MINUTE_MS} min` };
    await o.clock.sleep(AWAIT_POLL_MS, context.signal);
  }
  return context.signal.aborted ? stopped : { status: "done", detail: "they gave" };
}

/** Runs one hand-off: a hand-over for each entry of my side (`credit` hears what the partner took), or `pick_up_items` around me for each entry of theirs. */
export function runHandoff(context: SkillContext, h: Exclude<Handoff, { kind: "await" }>, credit?: TakenCredit): Promise<SkillResult> {
  return h.kind === "give" ? giveMySide(context, h.partner, h.items, credit) : collectTheirSide(context, h.items);
}
