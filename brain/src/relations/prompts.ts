// What the model is told about relations and trades, and how its answers are read; the code states facts, the model decides.
import { z } from "zod";
import { personaPrompt } from "../llm-mind.ts";
import type { GistPartner, TradeDecision } from "../mind.ts";
import type { Persona } from "../persona.ts";
import { describeRelation } from "./record.ts";
import type { ItemCount, Judged, Relation, Trade } from "./types.ts";

const MAX_SIDE_ENTRIES = 4;
const MAX_COUNT = 64;

/** The chat system prompt's trade paragraph: the field and its mechanics, no rule on whom to trust or what to accept. */
export function tradeInstructions(): string {
  return `- "trade": optional, after "route": only when your line proposes, accepts, declines or cancels a swap of items with someone: {"action": "propose" | "accept" | "decline" | "cancel", "give": [{"item": "oak_log", "count": 5}], "get": [{"item": "bread", "count": 3}], "first": "me" | "them"}.
  "give" is what you hand over and "get" what you receive: item ids (as in "Inventory") with counts of 1 to 64, at most ${MAX_SIDE_ENTRIES} entries each. "first" says who hands over first, you or them. A gift is "get": []. Say your offer in "say", in your own words: a trade exists only once both of you agreed in talk. If you agree to an offer you heard in someone's line, answer "accept" with the terms from your side: "give" is what they ask of you and "get" is what they offer you. "propose" is only for an offer of your own, or a counter-offer with different terms.
  You may refuse, ask for something else back, or ask them to give first; that is your choice, from what you know of them ("You and <name>" tells what you have been through together). Trade what you can spare: what your current objective lacks is listed, and you cannot hand over what you do not carry. Items are handed over by the one who gives; the other's side is seen arriving in their inventory. What was agreed and not paid is a broken promise you will remember.
  Leave "trade" out when your line is no part of a swap.`;
}

/** The record text of the speaker and the other members, and what the current objective lacks. */
export function relationsBlock(summaries: readonly string[], lacks: readonly string[]): string {
  if (summaries.length === 0 && lacks.length === 0) return "";
  const lacking = lacks.length === 0 ? [] : [`Your current objective lacks: ${lacks.join(", ")}.`];
  return [...(summaries.length === 0 ? [] : ["Your relations:", ...summaries]), ...lacking].join("\n");
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

/** Reads the gist's `partners`: each good entry kept (its judgment only when its feeling is a number), bad ones dropped. */
export function parseGistPartners(raw: unknown): GistPartner[] {
  if (!Array.isArray(raw)) return [];
  const out: GistPartner[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    const name = text(e.name, 64);
    if (name === "") continue;
    const judged: Judged | null = typeof e.feeling === "number" && Number.isFinite(e.feeling) ? { feeling: e.feeling, word: text(e.word, 200), why: text(e.why, 1_000) } : null;
    out.push({ name, judged, has: words(e.has), needs: words(e.needs) });
  }
  return out;
}

const side$ = (items: readonly ItemCount[]): string => (items.length === 0 ? "nothing" : items.map((i) => `${i.count} ${i.item}`).join(", "));

/** The judge call's system prompt: one judgment of a partner after a trade ended outside a conversation. */
export function judgeSystemPrompt(persona: Persona): string {
  return `${personaPrompt(persona)}

A trade with someone has ended. Judge how you feel about them now, in character: what you know of them and what happened.
Reply with only a JSON object {"feeling": 0, "word": "...", "why": "..."}.
- "feeling": a whole number from -3 (dislike, distrust) to +3 (fondness, trust); 0 is neutral. How far it moves from what you felt is your own, from your traits: a forgiving character moves less (a little, or not at all), a resentful or grudge-holding one more (several steps).
- "word": one word for how you see them. "why": one sentence, in your own words.`;
}

/** The judge call's request: the record with the partner, then the trade that just ended and how it ended. */
export function describeJudge(input: { readonly persona: Persona; readonly partner: string; readonly block: string; readonly trade: Trade }): string {
  const t = input.trade;
  const how = t.state === "done" ? "completed" : t.state === "broken" ? `broken${t.brokenBy === "me" ? " by you" : ` by ${input.partner}`}` : t.state;
  return `${input.block}\n\nThe trade with ${input.partner} just ended, ${how}${t.late ? " (paid late)" : ""}: you give ${side$(t.give)}, ${input.partner} gives ${side$(t.get)}, ${t.first === "me" ? "you" : input.partner} first.${t.note === "" ? "" : ` ${t.note}.`}`;
}

const judgedSchema = z.object({ feeling: z.number(), word: z.string().default(""), why: z.string().default("") });

/** Reads the judge's reply; unusable is null (the feeling stays as it is). */
export function parseJudged(raw: unknown): Judged | null {
  const parsed = judgedSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** One line per nearby partner for the opening request: their record, and what they said they have that the objective lacks. */
export function openingRelationLines(entries: readonly { readonly partner: string; readonly relation: Relation | null }[], lacks: readonly string[], now: number): string[] {
  return entries.map(({ partner, relation }) => {
    const wanted = relation === null ? [] : relation.saidHas.map((s) => s.item).filter((item) => lacks.some((lack) => lack.includes(item)));
    return `${describeRelation(relation, partner, now)}${wanted.length === 0 ? "" : ` You lack ${wanted.join(", ")}.`}`;
  });
}
