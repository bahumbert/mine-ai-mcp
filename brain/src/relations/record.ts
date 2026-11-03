// The relationship record's rules: facts counted from ended trades, what a partner said, the note form and its migration.
import { z } from "zod";
import { sideText } from "./items.ts";
import { band, drifted } from "./score.ts";
import { type HeldWindow, heldPayment, isOpen } from "./trade.ts";
import { type Band, type GiveProgress, type ItemCount, MINUTE_MS, type Relation, type RelationFacts, type SaidItem, SCORE_KINDS, type ScoreEvent, type Scoring, type Trade } from "./types.ts";

const KEPT_ENDED_TRADES = 3;

const NO_FACTS: RelationFacts = { tradesDone: 0, promisesKept: 0, keptLate: 0, promisesBroken: 0, iFailedToPay: 0, giftsGiven: 0, giftsReceived: 0 };

/** Someone new: the score starts at the character's first impression. */
export function newRelation(partner: string, now: number, firstImpression: number): Relation {
  return { partner, score: firstImpression, scoredAt: now, ledger: [], requests: [], lastHurt: null, facts: NO_FACTS, trades: [], saidHas: [], saidNeeds: [], lastDealt: now };
}

/** The window a payment held for an ended trade counts in, at `now`. */
export const heldWindow = (now: number, s: Scoring): HeldWindow => ({ now, ms: s.heldMinutes * MINUTE_MS });

/** Open trades, those still holding a payment inside `held`'s window, plus the last few other ended ones (by end time); the facts already count the rest. */
function keepRecentTrades(r: Relation, held?: HeldWindow): Relation {
  const holding = (t: Trade) => held !== undefined && heldPayment(t, held).length > 0;
  const ended = r.trades.filter((t) => !isOpen(t) && !holding(t)).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  const kept = new Set(ended.slice(-KEPT_ENDED_TRADES).map((t) => t.id));
  return { ...r, trades: r.trades.filter((t) => isOpen(t) || holding(t) || kept.has(t.id)) };
}

function replaceTrade(r: Relation, trade: Trade, held?: HeldWindow): Relation {
  const known = r.trades.some((t) => t.id === trade.id);
  const trades = known ? r.trades.map((t) => (t.id === trade.id ? trade : t)) : [...r.trades, trade];
  return keepRecentTrades({ ...r, trades, lastDealt: Math.max(r.lastDealt, trade.endedAt ?? trade.agreedAt ?? trade.createdAt) }, held);
}

/** Replaces the trade with the same id, or adds it. `held`: a trade still holding a payment inside the window is kept as an open one is. */
export function withTrade(r: Relation, trade: Trade, held?: HeldWindow): Relation {
  return replaceTrade(r, trade, held);
}

/** The facts an end state adds, given the entry the record already held for the trade (a late payment takes a broken promise back). */
function factsOfEnd(facts: RelationFacts, trade: Trade, before: Trade | undefined): RelationFacts {
  if (trade.state === "done") {
    if (trade.get.length === 0) return { ...facts, giftsGiven: facts.giftsGiven + 1 };
    if (trade.give.length === 0) return { ...facts, giftsReceived: facts.giftsReceived + 1 };
    const done = { ...facts, tradesDone: facts.tradesDone + 1 };
    if (trade.late) {
      const wasBroken = before?.state === "broken" && before.brokenBy === "them";
      return { ...done, keptLate: done.keptLate + 1, promisesBroken: Math.max(0, done.promisesBroken - (wasBroken ? 1 : 0)) };
    }
    return trade.first === "me" ? { ...done, promisesKept: done.promisesKept + 1 } : done;
  }
  if (trade.state === "broken") {
    return trade.brokenBy === "me" ? { ...facts, iFailedToPay: facts.iFailedToPay + 1 } : { ...facts, promisesBroken: facts.promisesBroken + 1 };
  }
  return facts;
}

/** Records an ended trade in the history and counts it into the facts by end state; an already counted end counts once. */
export function withEndedTrade(r: Relation, trade: Trade, held?: HeldWindow): Relation {
  const before = r.trades.find((t) => t.id === trade.id);
  const counted = before !== undefined && before.state === trade.state && before.brokenBy === trade.brokenBy;
  const facts = counted ? r.facts : factsOfEnd(r.facts, trade, before);
  return replaceTrade({ ...r, facts }, trade, held);
}

function mergeSaid(old: readonly SaidItem[], said: readonly (ItemCount | string)[], now: number): SaidItem[] {
  const fresh = said.map((s): SaidItem => (typeof s === "string" ? { item: s, count: null, at: now } : { item: s.item, count: s.count, at: now }));
  const names = new Set(fresh.map((s) => s.item));
  return [...old.filter((s) => !names.has(s.item)), ...fresh];
}

/** Merges what the partner said it has and needs by item, newest first-hand word wins. */
export function withSaid(r: Relation, has: readonly (ItemCount | string)[], needs: readonly (ItemCount | string)[], now: number): Relation {
  return { ...r, saidHas: mergeSaid(r.saidHas, has, now), saidNeeds: mergeSaid(r.saidNeeds, needs, now), lastDealt: Math.max(r.lastDealt, now) };
}

/** Drops what the partner said more than `minutes` ago. */
export function forgetOldSaid(r: Relation, now: number, minutes: number): Relation {
  const recent = (s: SaidItem) => now - s.at <= minutes * MINUTE_MS;
  return { ...r, saidHas: r.saidHas.filter(recent), saidNeeds: r.saidNeeds.filter(recent) };
}

const minutesAgo = (at: number, now: number) => Math.max(0, Math.floor((now - at) / MINUTE_MS));

function owedText(t: Trade): string {
  return t.get.map((w) => ({ item: w.item, left: w.count - (t.received.find((r) => r.item === w.item)?.count ?? 0) }))
    .filter((w) => w.left > 0).map((w) => `${w.left} ${w.item}`).join(", ");
}

/** What of my side is given (part of it, when `progress` says so) and what is left: "you gave 3 bread of your 5 bread, 2 bread still to give", else null. */
function partGiven(t: Trade, progress: GiveProgress | undefined): string | null {
  const given = (progress?.given ?? []).filter((g) => g.count > 0);
  if (given.length === 0) return null;
  const left = t.give.map((g) => ({ item: g.item, count: g.count - (given.find((x) => x.item === g.item)?.count ?? 0) })).filter((g) => g.count > 0);
  return `you gave ${sideText(given)} of your ${sideText(t.give)}, ${sideText(left) || "nothing"} still to give`;
}

/** What changed hands in an agreed trade: nothing, part of my side, or the part payment that arrived before my give. */
function agreedHandOver(t: Trade, partner: string, progress: GiveProgress | undefined): string {
  const give = sideText(t.give) || "nothing";
  const part = partGiven(t, progress);
  if (t.received.length === 0) return part === null ? `nothing handed over yet: you have not given your ${give} and have not received their ${sideText(t.get) || "nothing"}` : `${part}; you have not received their ${sideText(t.get) || "nothing"}`;
  return `${part ?? `you have not given your ${give} yet`}; ${partner} handed over ${sideText(t.received)} and still owes ${owedText(t)}`;
}

/** Why my due give waits, in brackets; "it is handed over for you" when nothing holds it back. */
function giveWait(partner: string, progress: GiveProgress | undefined): string {
  if (progress?.waits === "retake") return " (the hand-over was interrupted; it is tried again shortly)";
  if (progress?.waits === "partner_away") return ` (the hand-over failed; it is tried again when ${partner} is within ${progress.nearWithin} blocks)`;
  return " (it is handed over for you)";
}

function describeTrade(t: Trade, partner: string, now: number, progress?: (tradeId: string) => GiveProgress | undefined): string {
  const ago = minutesAgo(t.gaveAt ?? t.agreedAt ?? t.createdAt, now);
  const mine = progress?.(t.id);
  if (t.state === "proposed") return `you proposed giving ${sideText(t.give) || "nothing"} for ${sideText(t.get) || "nothing"} ${ago} min ago, no answer yet`;
  if (t.state === "agreed") return `agreed ${ago} min ago: you give ${sideText(t.give) || "nothing"}, ${partner} gives ${sideText(t.get) || "nothing"}, ${t.first === "me" ? "you" : partner} first; ${agreedHandOver(t, partner, mine)}`;
  if (t.state === "i_gave") return `you gave ${sideText(t.give)} ${ago} min ago, ${partner} owes ${owedText(t)}`;
  if (t.state === "they_gave") return `${partner} gave ${sideText(t.get)}; ${partGiven(t, mine) ?? `you have not given your ${sideText(t.give)} yet`}${giveWait(partner, mine)}`;
  return `the trade with ${partner} ended (${t.note}); ${partner} still owes ${owedText(t)}`;
}

/** One trade that ended with their payment in my bag: what they handed over, how it ended, how much of my side went, and that nothing went back. */
function describeHeld(t: Trade, held: readonly ItemCount[], partner: string, now: number): string {
  const end = t.brokenBy === "me" ? `your give failed: ${t.note}` : `cancelled: ${t.note}`;
  const gave = t.gaveSome.length === 0 ? "none" : sideText(t.gaveSome);
  return `${partner} handed over ${sideText(held)} for a trade that ended ${agoText(t.endedAt ?? now, now)} (${end}); you handed over ${gave} of your ${sideText(t.give)}, and you have not given their ${sideText(held)} back.`;
}

function describeSaid(partner: string, has: readonly SaidItem[], needs: readonly SaidItem[], now: number): string[] {
  const out: string[] = [];
  const list = (items: readonly SaidItem[]) => items.map((s) => (s.count === null ? s.item : `${s.item} x${s.count}`)).join(", ");
  const newest = (items: readonly SaidItem[]) => Math.max(...items.map((s) => s.at));
  if (has.length > 0) out.push(`${partner} said ${minutesAgo(newest(has), now)} min ago they have ${list(has)}.`);
  if (needs.length > 0) out.push(`${partner} said ${minutesAgo(newest(needs), now)} min ago they need ${list(needs)}.`);
  return out;
}

const LATELY_SHOWN = 3;

/** What a band means for the prompt: the model reads it, no code decides by it. */
function bandWords(b: Band, partner: string): string {
  switch (b) {
    case "enemy": return `you count ${partner} an enemy`;
    case "dislike": return `you dislike ${partner}`;
    case "neutral": return `you have no strong feeling about ${partner}`;
    case "like": return `you like ${partner}`;
    case "friend": return `you count ${partner} a friend`;
  }
}

function agoText(at: number, now: number): string {
  const minutes = minutesAgo(at, now);
  if (minutes < 60) return `${minutes} min ago`;
  return minutes < 1_440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1_440)} d ago`;
}

function eventText(e: ScoreEvent, now: number): string {
  const delta = e.kind === "earlier" ? "" : `${e.delta > 0 ? "+" : ""}${e.delta} `;
  return `${delta}${e.why} (${agoText(e.at, now)})`;
}

/** The text block the prompts use for one partner; a partner with no record reads as a stranger. */
export function describeRelation(r: Relation | null, partner: string, now: number, scoring: Scoring, progress?: (tradeId: string) => GiveProgress | undefined): string {
  const { bands } = scoring.score;
  if (r === null) return `You have not dealt with ${partner} before; your first impression is that ${bandWords(band(scoring.temperament.firstImpression, bands), partner)}.`;
  const current = drifted(r, now, scoring.temperament);
  const shown = Math.round(current.score);
  const lately = r.ledger.slice(-LATELY_SHOWN).reverse().map((e) => eventText(e, now));
  const head = `You and ${partner}: ${shown}, ${bandWords(band(shown, bands), partner)}.${lately.length === 0 ? "" : ` Lately: ${lately.join("; ")}.`}`;
  const f = r.facts;
  const counts = `${f.tradesDone} trades done, ${f.keptLate} kept late, ${f.promisesBroken} broken` +
    `${f.iFailedToPay > 0 ? `, you failed to pay ${f.iFailedToPay}` : ""}${f.giftsGiven + f.giftsReceived > 0 ? `, gifts: ${f.giftsGiven} given, ${f.giftsReceived} received` : ""}.`;
  const pending = r.trades.filter((t) => isOpen(t) || (t.state === "broken" && t.brokenBy === "them" && owedText(t) !== ""));
  const open = pending.length > 0 ? [`Open: ${pending.map((t) => describeTrade(t, partner, now, progress)).join("; ")}.`] : [];
  const holding = r.trades.flatMap((t) => { const held = heldPayment(t, heldWindow(now, scoring)); return held.length > 0 ? [describeHeld(t, held, partner, now)] : []; });
  return [head, counts, ...open, ...holding, ...describeSaid(partner, r.saidHas, r.saidNeeds, now)].join(" ");
}

const itemCount = z.object({ item: z.string(), count: z.number() });
const tradeSchema = z.object({
  id: z.string(), partner: z.string(), give: z.array(itemCount), get: z.array(itemCount), first: z.enum(["me", "them"]),
  state: z.enum(["proposed", "agreed", "i_gave", "they_gave", "done", "broken", "cancelled"]),
  createdAt: z.number(), agreedAt: z.number().nullable(), receivedAt: z.number().nullable().default(null), gaveAt: z.number().nullable(), received: z.array(itemCount),
  endedAt: z.number().nullable(), brokenBy: z.enum(["me", "them"]).nullable(), late: z.boolean(), note: z.string(),
  handedBack: z.array(itemCount).default([]), gaveSome: z.array(itemCount).default([]),
});
const said = z.object({ item: z.string(), count: z.number().nullable(), at: z.number() });
const scoreEvent = z.object({
  kind: z.enum(SCORE_KINDS),
  delta: z.number(), why: z.string(), at: z.number(), tradeId: z.string().optional(),
});
const openRequest = z.object({ what: z.string(), at: z.number(), inRange: z.boolean(), agreed: z.boolean(), heard: z.boolean().default(false) });
const relationBase = {
  partner: z.string().min(1),
  facts: z.object({
    tradesDone: z.number(), promisesKept: z.number(), keptLate: z.number(), promisesBroken: z.number(),
    iFailedToPay: z.number(), giftsGiven: z.number(), giftsReceived: z.number(),
  }),
  trades: z.array(tradeSchema), saidHas: z.array(said), saidNeeds: z.array(said), lastDealt: z.number(),
};
/** A version 1 note adds the model's feeling (-3..+3), word and why. */
const relationV1 = z.object({ ...relationBase, feeling: z.number(), word: z.string(), why: z.string(), v: z.undefined().optional() });
const MIGRATED_SCORE_PER_FEELING = 30;

/** A version 1 note (the model's feeling -3..+3) becomes a score, its word and why the one "earlier" ledger event. */
function migrate({ feeling, word, why, ...old }: Omit<z.infer<typeof relationV1>, "v">): Relation {
  const score = Math.max(-100, Math.min(100, feeling * MIGRATED_SCORE_PER_FEELING));
  const earlier = word === "" ? [] : [{ kind: "earlier" as const, delta: 0, why: `${word}: ${why}`, at: old.lastDealt }];
  return { ...old, score: score === 0 ? 0 : score, scoredAt: old.lastDealt, ledger: earlier, requests: [], lastHurt: null };
}

const relationV2 = z.object({
  ...relationBase, v: z.literal(2), score: z.number(), scoredAt: z.number(), ledger: z.array(scoreEvent),
  requests: z.array(openRequest).default([]), lastHurt: z.number().nullable().default(null),
}).transform(({ v: _version, ...relation }): Relation => relation);

/** A note of either version; the memory recall reads relation notes through this too. */
export const relationSchema = z.union([relationV2, relationV1.transform(({ v: _version, ...old }) => migrate(old))]);

/** The record as it is written in a note: marked version 2, so it is not read as an old note. */
export function versioned(r: Relation): Relation & { readonly v: 2 } {
  return { v: 2, ...r };
}

/** One runtime note per partner: the record as JSON (version 2), context `relation:<partner>`. */
export function relationNote(r: Relation): { note: string; context: string } {
  return { note: JSON.stringify(versioned(r)), context: `relation:${r.partner}` };
}

/** Reads a relation note; a bad one reads as no record (null), never throws. */
export function parseRelationNote(text: string): Relation | null {
  try {
    const parsed = relationSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
