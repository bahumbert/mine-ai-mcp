// The relationship record's rules: facts counted from ended trades, the model's feeling, what a partner said, the note form.
import { z } from "zod";
import { sideText } from "./items.ts";
import { isOpen } from "./trade.ts";
import { type ItemCount, type Judged, MINUTE_MS, type Relation, type RelationFacts, type SaidItem, type Trade } from "./types.ts";

const KEPT_ENDED_TRADES = 3;
const MAX_WORD = 20;
const MAX_WHY = 200;

const NO_FACTS: RelationFacts = { tradesDone: 0, promisesKept: 0, keptLate: 0, promisesBroken: 0, iFailedToPay: 0, giftsGiven: 0, giftsReceived: 0 };

export function newRelation(partner: string, now: number): Relation {
  return { partner, feeling: 0, word: "", why: "", facts: NO_FACTS, trades: [], saidHas: [], saidNeeds: [], lastDealt: now };
}

/** Open trades plus the last few ended ones (by end time); the facts already count the rest. */
function keepRecentTrades(r: Relation): Relation {
  const ended = r.trades.filter((t) => !isOpen(t)).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  const kept = new Set(ended.slice(-KEPT_ENDED_TRADES).map((t) => t.id));
  return { ...r, trades: r.trades.filter((t) => isOpen(t) || kept.has(t.id)) };
}

function replaceTrade(r: Relation, trade: Trade): Relation {
  const known = r.trades.some((t) => t.id === trade.id);
  const trades = known ? r.trades.map((t) => (t.id === trade.id ? trade : t)) : [...r.trades, trade];
  return keepRecentTrades({ ...r, trades, lastDealt: Math.max(r.lastDealt, trade.endedAt ?? trade.agreedAt ?? trade.createdAt) });
}

/** Replaces the trade with the same id, or adds it. */
export function withTrade(r: Relation, trade: Trade): Relation {
  return replaceTrade(r, trade);
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
export function withEndedTrade(r: Relation, trade: Trade): Relation {
  const before = r.trades.find((t) => t.id === trade.id);
  const counted = before !== undefined && before.state === trade.state && before.brokenBy === trade.brokenBy;
  const facts = counted ? r.facts : factsOfEnd(r.facts, trade, before);
  return replaceTrade({ ...r, facts }, trade);
}

/** Stores the model's judgment: feeling rounded and clamped to -3..3, word and why trimmed. */
export function withFeeling(r: Relation, judged: Judged): Relation {
  const feeling = Number.isFinite(judged.feeling) ? Math.max(-3, Math.min(3, Math.round(judged.feeling))) + 0 : r.feeling;
  return { ...r, feeling: Object.is(feeling, -0) ? 0 : feeling, word: judged.word.trim().slice(0, MAX_WORD), why: judged.why.trim().slice(0, MAX_WHY) };
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

/** What changed hands in an agreed trade: nothing, or the part payment that arrived before my give. */
function agreedHandOver(t: Trade, partner: string): string {
  const give = sideText(t.give) || "nothing";
  if (t.received.length === 0) return `nothing handed over yet: you have not given your ${give} and have not received their ${sideText(t.get) || "nothing"}`;
  return `you have not given your ${give} yet; ${partner} handed over ${sideText(t.received)} and still owes ${owedText(t)}`;
}

function describeTrade(t: Trade, partner: string, now: number): string {
  const ago = minutesAgo(t.gaveAt ?? t.agreedAt ?? t.createdAt, now);
  if (t.state === "proposed") return `you proposed giving ${sideText(t.give) || "nothing"} for ${sideText(t.get) || "nothing"} ${ago} min ago, no answer yet`;
  if (t.state === "agreed") return `agreed ${ago} min ago: you give ${sideText(t.give) || "nothing"}, ${partner} gives ${sideText(t.get) || "nothing"}, ${t.first === "me" ? "you" : partner} first; ${agreedHandOver(t, partner)}`;
  if (t.state === "i_gave") return `you gave ${sideText(t.give)} ${ago} min ago, ${partner} owes ${owedText(t)}`;
  if (t.state === "they_gave") return `${partner} gave ${sideText(t.get)}; you have not given your ${sideText(t.give)} yet (it is handed over for you)`;
  return `${partner} did not pay in time (${t.note}), still owes ${owedText(t)}`;
}

function describeSaid(partner: string, has: readonly SaidItem[], needs: readonly SaidItem[], now: number): string[] {
  const out: string[] = [];
  const list = (items: readonly SaidItem[]) => items.map((s) => (s.count === null ? s.item : `${s.item} x${s.count}`)).join(", ");
  const newest = (items: readonly SaidItem[]) => Math.max(...items.map((s) => s.at));
  if (has.length > 0) out.push(`${partner} said ${minutesAgo(newest(has), now)} min ago they have ${list(has)}.`);
  if (needs.length > 0) out.push(`${partner} said ${minutesAgo(newest(needs), now)} min ago they need ${list(needs)}.`);
  return out;
}

/** The text block the prompts use for one partner; a partner with no record reads as a stranger. */
export function describeRelation(r: Relation | null, partner: string, now: number): string {
  if (r === null) return `You have not dealt with ${partner} before.`;
  const feel = `${r.feeling > 0 ? "+" : ""}${r.feeling}`;
  const head = `You and ${partner}: ${r.word === "" ? "no opinion yet" : r.word} (${feel})${r.why === "" ? "" : `, ${r.why}`}.`;
  const f = r.facts;
  const counts = `${f.tradesDone} trades done, ${f.keptLate} kept late, ${f.promisesBroken} broken` +
    `${f.iFailedToPay > 0 ? `, you failed to pay ${f.iFailedToPay}` : ""}${f.giftsGiven + f.giftsReceived > 0 ? `, gifts: ${f.giftsGiven} given, ${f.giftsReceived} received` : ""}.`;
  const pending = r.trades.filter((t) => isOpen(t) || (t.state === "broken" && t.brokenBy === "them" && owedText(t) !== ""));
  const open = pending.length > 0 ? [`Open: ${pending.map((t) => describeTrade(t, partner, now)).join("; ")}.`] : [];
  return [head, counts, ...open, ...describeSaid(partner, r.saidHas, r.saidNeeds, now)].join(" ");
}

const itemCount = z.object({ item: z.string(), count: z.number() });
const tradeSchema = z.object({
  id: z.string(), partner: z.string(), give: z.array(itemCount), get: z.array(itemCount), first: z.enum(["me", "them"]),
  state: z.enum(["proposed", "agreed", "i_gave", "they_gave", "done", "broken", "cancelled"]),
  createdAt: z.number(), agreedAt: z.number().nullable(), receivedAt: z.number().nullable().default(null), gaveAt: z.number().nullable(), received: z.array(itemCount),
  endedAt: z.number().nullable(), brokenBy: z.enum(["me", "them"]).nullable(), late: z.boolean(), note: z.string(),
});
const said = z.object({ item: z.string(), count: z.number().nullable(), at: z.number() });
export const relationSchema = z.object({
  partner: z.string().min(1), feeling: z.number(), word: z.string(), why: z.string(),
  facts: z.object({
    tradesDone: z.number(), promisesKept: z.number(), keptLate: z.number(), promisesBroken: z.number(),
    iFailedToPay: z.number(), giftsGiven: z.number(), giftsReceived: z.number(),
  }),
  trades: z.array(tradeSchema), saidHas: z.array(said), saidNeeds: z.array(said), lastDealt: z.number(),
});

/** One runtime note per partner: the record as JSON, context `relation:<partner>`. */
export function relationNote(r: Relation): { note: string; context: string } {
  return { note: JSON.stringify(r), context: `relation:${r.partner}` };
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
