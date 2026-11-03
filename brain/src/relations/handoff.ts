// The hand-off routines of a trade, as code (no work-tier call): give my side with `give_item`, or collect theirs from the ground.
import type { Clock } from "../conversation/socialise.ts";
import { manhattan } from "../conversation/state.ts";
import type { Position } from "../runtime-client.ts";
import { findPlayer, giveTo, runStep, type SkillContext, type SkillResult } from "../skills.ts";
import { carriedOf, sideText, spareFor } from "./items.ts";
import { type ItemCount, MINUTE_MS } from "./types.ts";

/** How far around itself a collect looks for the partner's items. */
export const COLLECT_RADIUS = 6;
/**
 * How far (3-D, from the toss spot, as `pick_up_items` filters) around the spot it tossed from a giver looks for the items
 * the partner left. Centred on the giver itself, 6 missed them (Mine Labs hand-over-walks-off: it walks off). Measured
 * 2026-11-01 (Mine Labs barter/toss-rest-distance*.yaml, 5 runs each, receiver with a full inventory): flat grass
 * 0.74-0.99 (up to 1.57 from the 2-block reach), a 2-block stair slope 0.51-0.71, still water 3.16-3.49 (tossed from inside the pool: the giver wades in), ice 3.96-4.40
 * (4.95-5.53 tossed from the full 2-block reach); the largest, 5.53, plus 2 is under 8, so 8 stays. Flowing water carries a
 * toss with no bound: not measured, and the radius cannot cover it.
 */
export const PICK_BACK_RADIUS = 8;
/** How often a wait for the partner's payment looks at whether it came. */
const AWAIT_POLL_MS = 1_000;
/** A waiting partner who stands this far (Manhattan) from the spot of my last walk to them has moved: the wait walks to them again. */
const REWALK_MOVED = 3;
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
  readonly outcome: "done" | "items_gone" | "not_taken" | "busy" | "failed" | "dropped";
  readonly detail: string;
}

/** The controller's reading of a hand-off's result: stopped is dropped (the trade stays due), items gone, not taken and a busy recipient are told apart by the result's reason. */
export function handoffOutcome(result: SkillResult): HandoffEnd {
  if (result.status === "stopped") return { outcome: "dropped", detail: "stopped" };
  if (result.status === "done") return { outcome: "done", detail: result.detail };
  if (result.reason === "items_gone" || result.reason === "not_taken") return { outcome: result.reason, detail: result.detail };
  if (result.reason === "recipient_busy") return { outcome: "busy", detail: result.detail };
  return { outcome: "failed", detail: result.detail };
}

/** Tells the caller how many of an item the partner took, so a retake gives only what is left. */
export type TakenCredit = (credit: ItemCount) => void;

/** What a get-back leaves of the trade's clock for the walk, the toss and the pick-back that follow (`settleTrade` ends the trade at the pay-back time whatever the give is doing). */
export const GIVE_ALLOWANCE_MS = MINUTE_MS;

/** What bounds the one get-back of an owed item that is short before a give. */
export interface GetBack {
  /** The pay-back time left on the trade's clock: the get-back is cut after this long on the wall clock. */
  readonly getBackMs: number;
  /** Whether the trade is still open (read after the get-back: a trade that ended meanwhile gets nothing tossed). */
  readonly stillDue: () => boolean;
}

/** An item of my side the bag cannot give: `count` as agreed, `lacking` more to get (the count beyond what is spare for the partner: the bag minus what other agreed trades owe). */
type Short = ItemCount & { readonly lacking: number };

async function shortOf(context: SkillContext, partner: string, items: readonly ItemCount[]): Promise<Short[]> {
  const { inventory } = await context.runtime.status();
  const owed = context.owed?.() ?? [];
  return items.flatMap(({ item, count }) => {
    const lacking = count - spareFor(carriedOf(inventory, item), owed, item, partner);
    return lacking > 0 ? [{ item, count, lacking }] : [];
  });
}

/**
 * Runs `get_items` once for what is short (crafts or gathers it, as any fetch), bounded by the pay-back time left
 * on the wall clock; null when nothing was short afterwards, else the line that says what is still lacking and what the fetch said.
 */
async function getBackShort(context: SkillContext, partner: string, short: readonly Short[], getBackMs: number): Promise<string | null> {
  const timeout = AbortSignal.timeout(getBackMs);
  const fetched = await runStep({ skill: "get_items", items: short.map(({ item, lacking }) => ({ item, count: lacking })) }, { ...context, signal: AbortSignal.any([context.signal, timeout]) });
  const still = await shortOf(context, partner, short);
  if (still.length === 0) return null;
  const said = timeout.aborted ? `the trade's clock ran out after ${Math.round(getBackMs / 1000)} s` : fetched.status === "done" ? "what it fetched is owed to another agreed trade" : "detail" in fetched ? fetched.detail : fetched.status;
  return `I no longer carry ${sideText(still)}; getting it back failed: ${said}`;
}

async function giveMySide(context: SkillContext, partner: string, items: readonly ItemCount[], credit?: TakenCredit, back?: GetBack): Promise<SkillResult> {
  const short = await shortOf(context, partner, items);
  if (short.length > 0) {
    // Not before the first look: a give that is not short never fetches. Once only, and only while the trade is open.
    const lacking = back === undefined ? `I no longer carry ${sideText(short)}` : await getBackShort(context, partner, short, back.getBackMs);
    if (context.signal.aborted) return { status: "stopped" };
    if (lacking !== null) return { status: "failed", detail: lacking, reason: "items_gone" };
  }
  const unconfirmed: ItemCount[] = [];
  let sure = true;
  for (const { item, count } of items) {
    // The partner may end the trade while an item is on its way: the next item stays in the bag.
    if (back !== undefined && !back.stillDue()) return { status: "failed", detail: `the trade is over: nothing ${items[0]?.item === item ? "" : "more "}given` };
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
    const { back: pickedBack } = pickBack;
    if (count - pickedBack > 0) credit?.({ item, count: count - pickedBack });
    if (pickedBack > 0) return notTaken(partner, { item, count: pickedBack });
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

/**
 * Picks up each item of their side around me. An item counts picked when the pick-up succeeded or the bag holds more of
 * it than before the call (items walked over while a pick-up reported a failure); the others are named in the failure.
 */
async function collectTheirSide(context: SkillContext, items: readonly ItemCount[]): Promise<SkillResult> {
  const picked: ItemCount[] = [];
  const failures: string[] = [];
  for (const wanted of items) {
    const { item } = wanted;
    const before = carriedOf((await context.runtime.status()).inventory, item);
    const outcome = await context.body.act("pick_up_items", { item, radius: COLLECT_RADIUS }, `Pick up the ${item} the partner of my trade gave me.`, { signal: context.signal });
    if (context.signal.aborted) return { status: "stopped" };
    const gained = carriedOf((await context.runtime.status()).inventory, item) - before;
    if (gained > 0) picked.push({ item, count: Math.min(wanted.count, gained) });
    else if (outcome.status === "succeeded") picked.push(wanted);
    else failures.push(`${item}: ${outcome.error ?? `pick_up_items ${outcome.status}`}`);
  }
  if (failures.length === 0) return { status: "done", detail: `picked up ${sideText(picked)} around me` };
  return { status: "failed", detail: `${picked.length > 0 ? `picked up ${sideText(picked)}, but not ` : "picked up nothing: "}${failures.join("; ")}` };
}

export interface AwaitOptions {
  /** Whether the partner's payment is still to come (the trade controller's reading). */
  readonly stillAwaiting: () => boolean;
  /** How the trade ended when the wait is over (`cancelled: Finn cancelled`), null while it stands or once it is paid. */
  readonly endedAs: () => string | null;
  readonly clock: Clock;
  /** The wait ends failed after this long on the clock, whatever else happens. */
  readonly maxMs: number;
  /** Farther than this from the partner at a look, the wait walks up to them. */
  readonly openingDistance: number;
}

/**
 * Waits near a partner who owes their side (they pay first, or I paid first): a look every second until the payment is
 * credited or the bound on the clock. Whenever the partner stands farther than the opening distance at a look, and
 * somewhere new, the wait walks up to them again (a failed walk is no end: the partner may come to hand over).
 */
export async function awaitTheirSide(context: SkillContext, partner: string, o: AwaitOptions): Promise<SkillResult> {
  const stopped: SkillResult = { status: "stopped" };
  const deadline = o.clock.now() + o.maxMs;
  let walkedTo: Position | null | undefined;
  while (o.stillAwaiting()) {
    if (context.signal.aborted) return stopped;
    if (o.clock.now() >= deadline) return { status: "failed", detail: `${partner} did not give within ${Number.isInteger(o.maxMs / MINUTE_MS) ? `${o.maxMs / MINUTE_MS} min` : `${Math.round(o.maxMs / 1000)} s`}` };
    walkedTo = await walkIfFarOrMoved(context, partner, o.openingDistance, walkedTo);
    if (!context.signal.aborted) await o.clock.sleep(AWAIT_POLL_MS, context.signal);
  }
  if (context.signal.aborted) return stopped;
  const over = o.endedAs();
  return over === null ? { status: "done", detail: "they gave" } : { status: "failed", detail: `the trade ended (${over}) before ${partner} gave` };
}

/** Walks to the partner when they are farther than `openingDistance` and stand somewhere other than the spot of the last walk (`undefined`: no walk yet). Returns the spot walked to. */
async function walkIfFarOrMoved(context: SkillContext, partner: string, openingDistance: number, walkedTo: Position | null | undefined): Promise<Position | null | undefined> {
  const snapshot = await context.runtime.status().catch(() => null); // a runtime restarting under a poll: no walk this time, the wait goes on
  if (snapshot === null) return walkedTo;
  const there = findPlayer(snapshot, partner)?.position ?? null;
  if (there !== null && manhattan(snapshot.position, there) <= openingDistance) return walkedTo;
  const sameSpot = walkedTo !== undefined && (there === null ? walkedTo === null : walkedTo !== null && manhattan(walkedTo, there) < REWALK_MOVED);
  if (sameSpot) return walkedTo;
  await runStep({ skill: "go_to_player", player: partner }, context);
  return there;
}

/** Runs one hand-off: a hand-over for each entry of my side (`credit` hears what the partner took), or `pick_up_items` around me for each entry of theirs. */
export function runHandoff(context: SkillContext, h: Exclude<Handoff, { kind: "await" }>, credit?: TakenCredit, back?: GetBack): Promise<SkillResult> {
  return h.kind === "give" ? giveMySide(context, h.partner, h.items, credit, back) : collectTheirSide(context, h.items);
}
