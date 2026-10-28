// What the model is told about relations and trades, and how its answers are read; the code states facts, the model decides.
import { z } from "zod";
import type { GistPartner, TradeDecision } from "../mind.ts";
import { describeRelation } from "./record.ts";
import type { Relation, Scoring } from "./types.ts";

const MAX_SIDE_ENTRIES = 4;
const MAX_COUNT = 64;

/** The chat system prompt's trade paragraph: the field and its mechanics, no rule on whom to trust or what to accept. */
export function tradeInstructions(): string {
  return `- "trade": optional, after "route": only when your line proposes, accepts, declines or cancels a swap of items with someone: {"action": "propose" | "accept" | "decline" | "cancel", "give": [{"item": "oak_log", "count": 5}], "get": [{"item": "bread", "count": 3}], "first": "me" | "them"}.
  "give" is what you hand over and "get" what you receive: item ids (as in "Inventory") with counts of 1 to 64, at most ${MAX_SIDE_ENTRIES} entries each. "first" says who hands over first, you or them. A gift is "get": []. Say your offer in "say", in your own words: a trade exists only once both of you agreed in talk. If you agree to an offer you heard in someone's line, answer "accept" with the terms from your side: "give" is what they ask of you and "get" is what they offer you. "propose" is only for an offer of your own, or a counter-offer with different terms.
  You may refuse, ask for something else back, or ask them to give first; that is your choice, from what you know of them ("You and <name>" tells what you have been through together). Trade what you can spare: what your current objective lacks is listed, and you cannot hand over what you do not carry. Items are handed over by the one who gives; the other's side is seen arriving in their inventory. What was agreed and not paid is a broken promise you will remember. Your line is said before anything is handed over: never say you gave, dropped or handed over items unless your "Open:" line says you gave them; say what happens next instead.
  Leave "trade" out when your line is no part of a swap.`;
}

/** What the model is told about a score: it shows in talk and in deeds, how much is the character's own. No threshold, no rule. */
export const FEELING_SHOWS = "How you feel about someone shows in how you talk to them and in what you do for them; how much is yours, from your traits.";

/** The record text of the speaker and the other members, and what the current objective lacks. */
export function relationsBlock(summaries: readonly string[], lacks: readonly string[]): string {
  if (summaries.length === 0 && lacks.length === 0) return "";
  const lacking = lacks.length === 0 ? [] : [`Your current objective lacks: ${lacks.join(", ")}.`];
  return [...(summaries.length === 0 ? [] : ["Your relations:", FEELING_SHOWS, ...summaries]), ...lacking].join("\n");
}

/** The chat input's line for a speaker who is another agent out of trading reach: the model must not offer to walk to them. */
export function tooFarLine(speaker: string, away: number | null): string {
  return `${speaker} is too far away to trade with (${away === null ? "out of sight" : `${away} blocks away`}): do not offer to go to them; they can come to you.`;
}

const entry = z.object({ item: z.string().min(1), count: z.number().int().min(1).max(MAX_COUNT) });
const side = z.array(entry).max(MAX_SIDE_ENTRIES);
const tradeSchema = z.object({
  action: z.enum(["propose", "accept", "decline", "cancel"]),
  give: side.default([]),
  get: side.default([]),
  first: z.enum(["me", "them"]).optional(),
});

/** Reads the `trade` field of a chat reply; absent or malformed is no trade (the reply's line still stands). */
export function parseTrade(raw: unknown): TradeDecision | null {
  if (raw === undefined || raw === null) return null;
  const parsed = tradeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { action, give, get, first } = parsed.data;
  const swaps = action === "propose" || action === "accept";
  if (swaps && (first === undefined || (give.length === 0 && get.length === 0))) return null;
  return { action, give, get, first: first ?? "me" };
}

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");
const words = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : []);

/** Reads the gist's `partners`: each good entry kept (its nudge only when it is a number), bad ones dropped. */
export function parseGistPartners(raw: unknown): GistPartner[] {
  if (!Array.isArray(raw)) return [];
  const out: GistPartner[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    const name = text(e.name, 64);
    if (name === "") continue;
    const nudge = typeof e.nudge === "number" && Number.isFinite(e.nudge) ? { value: e.nudge, why: text(e.why, 200) || "the conversation" } : null;
    out.push({ name, nudge, has: words(e.has), needs: words(e.needs) });
  }
  return out;
}

const MAX_ASKED = 5;
const ANSWERS = ["agreed", "refused", "done"] as const;

/** The reply fields that open a request: whom my own line asks for items or help, and for what. */
export function askFieldsInstructions(): string {
  return `- "asks_of": the names your own line asks for items or for help (a request, an order; not a question); [] when it asks for nothing. "asks_what": what you ask, in a few words.`;
}

/** The numbered requests I made of the speaker, and the field that says which one their new line answers. */
export function requestsBlock(speaker: string, lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return `Your requests to ${speaker}:\n${lines.join("\n")}\n- "my_request": only when the new message answers one of them: {"n": <its number>, "answer": "agreed" | "refused" | "done"} ("done": they say it is done or hand it over); leave it out otherwise.`;
}

/** Reads "asks_of" and "asks_what": the names that are strings (at most a few), and what; anything else asks nothing. */
export function parseAsks(askOf: unknown, askWhat: unknown): { asksOf?: string[]; asksWhat?: string } {
  const names = [...new Set(words(askOf).map((name) => name.slice(0, 64)))].slice(0, MAX_ASKED);
  if (names.length === 0) return {};
  return { asksOf: names, asksWhat: text(askWhat, 200) || "something" };
}

/** Reads "my_request": a whole number n >= 1 and one of the three answers; anything else answers nothing. */
export function parseMyRequest(raw: unknown): { n: number; answer: (typeof ANSWERS)[number] } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { n, answer } = raw as Record<string, unknown>;
  const known = ANSWERS.find((a) => a === answer);
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && known !== undefined ? { n, answer: known } : undefined;
}

/** One line per nearby partner for the opening request: their record, and what they said they have that the objective lacks. */
export function openingRelationLines(entries: readonly { readonly partner: string; readonly relation: Relation | null }[], lacks: readonly string[], now: number, scoring: Scoring): string[] {
  return entries.map(({ partner, relation }) => {
    const wanted = relation === null ? [] : relation.saidHas.map((s) => s.item).filter((item) => lacks.some((lack) => lack.includes(item)));
    return `${describeRelation(relation, partner, now, scoring)}${wanted.length === 0 ? "" : ` You lack ${wanted.join(", ")}.`}`;
  });
}
