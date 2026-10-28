// The score of a partner: drift back to the first impression, events scaled by temperament, and the words of a band.
import type { Persona } from "../persona.ts";
import type { Band, Relation, ScoreEvent, ScoreInput, RelationEvent, ScoreKind, ScoreSettings, Scoring, Temperament } from "./types.ts";

const HOUR_MS = 3_600_000;
const MIN_SCORE = -100;
const MAX_SCORE = 100;

/** The setting that holds the base amount of each kind a code event scores (a nudge and an old note's "earlier" have none). */
const AMOUNT_OF: Record<Exclude<ScoreKind, "nudge" | "earlier">, keyof ScoreSettings["amounts"]> = {
  trade_done: "tradeDone", kept_late: "keptLate", promise_broken: "promiseBroken", gift_received: "giftReceived",
  request_helped: "requestHelped", request_refused: "requestRefused", request_ignored: "requestIgnored", hurt: "hurt",
};

/** The score amounts and temperament of a character, from its relations settings. */
export function scoringOf(settings: Persona["settings"]["relations"]): Scoring {
  return { score: settings.score, temperament: settings.temperament };
}

/** No negative zero in a stored or shown number. */
const plain = (n: number) => (n === 0 ? 0 : n);

/** The score moved towards the first impression by `forgiveness` points per hour since `scoredAt`, never past it; fractions kept. */
export function drifted(r: Relation, now: number, t: Temperament): Relation {
  if (now < r.scoredAt) return r;
  const gap = t.firstImpression - r.score;
  const step = (t.forgiveness * (now - r.scoredAt)) / HOUR_MS;
  const score = Math.abs(gap) <= step ? t.firstImpression : r.score + Math.sign(gap) * step;
  return { ...r, score, scoredAt: now };
}

/** What a late payment takes back of the same trade's broken promise: what it applied less what forgiveness has faded since. */
function takenBack(r: Relation, tradeId: string | undefined, now: number, forgiveness: number): number {
  const broken = [...r.ledger].reverse().find((e) => e.kind === "promise_broken" && e.tradeId === tradeId && tradeId !== undefined);
  if (broken === undefined) return 0;
  return plain(Math.round(Math.max(0, Math.abs(broken.delta) - (forgiveness * Math.max(0, now - broken.at)) / HOUR_MS)));
}

/** The delta an input asks for before clamping to the score range; null when it cannot be scored. */
function wantedDelta(e: ScoreInput, drift: Relation, now: number, s: Scoring): number | null {
  const { sensitivity, forgiveness } = s.temperament;
  if (e.kind === "earlier") return null;
  if (e.kind === "nudge") {
    if (e.nudge === undefined || !Number.isFinite(e.nudge)) return null;
    const max = s.score.nudgeMax;
    return plain(Math.round(Math.max(-max, Math.min(max, Math.round(e.nudge))) * sensitivity));
  }
  const base = Math.round(s.score.amounts[AMOUNT_OF[e.kind]] * sensitivity);
  return e.kind === "kept_late" ? base + takenBack(drift, e.tradeId, now, forgiveness) : base;
}

/** Drifts the score to `now`, then applies one event: scaled by sensitivity, clamped to -100..100, the applied delta kept in the ledger. */
export function withScoreEvent(r: Relation, e: ScoreInput, now: number, s: Scoring): Relation {
  const drift = drifted(r, now, s.temperament);
  const wanted = wantedDelta(e, drift, now, s);
  if (wanted === null) return r;
  const score = plain(Math.max(MIN_SCORE, Math.min(MAX_SCORE, drift.score + wanted)));
  const event: ScoreEvent = { kind: e.kind, delta: plain(Math.round(score - drift.score)), why: e.why, at: now, ...(e.tradeId !== undefined && { tradeId: e.tradeId }) };
  return { ...drift, score, ledger: [...drift.ledger, event].slice(-s.score.ledgerSize) };
}

/** A hit from this partner: one `hurt` event per `hurtDebounceSeconds`, none inside that window (so a fight is one event). `lastHurt` moves with it. */
export function withHurt(r: Relation, direct: string | null, now: number, s: Scoring): Relation {
  if (r.lastHurt !== null && now - r.lastHurt < s.score.hurtDebounceSeconds * 1000) return r;
  return { ...withScoreEvent(r, { kind: "hurt", why: direct === "arrow" ? "shot you" : "hit you" }, now, s), lastHurt: now };
}

/** The word of a score for prompts only; thresholds from the settings. */
export function band(score: number, bands: ScoreSettings["bands"]): Band {
  if (score <= bands.enemy) return "enemy";
  if (score <= bands.dislike) return "dislike";
  if (score < bands.like) return "neutral";
  if (score < bands.friend) return "like";
  return "friend";
}

/** The journal row for an event of the ledger (the last by default; null when there is none), with the score as the record holds it. */
export function scoredRow(r: Relation, event: ScoreEvent | undefined = r.ledger.at(-1)): RelationEvent | null {
  if (event === undefined) return null;
  return { kind: "relation", event: "scored", partner: r.partner, scoreKind: event.kind, delta: event.delta, score: Math.round(r.score), why: event.why };
}

/** One journal row for each event `next` holds that `prev` did not (a change may score several). */
export function newScoredRows(prev: Relation | null, next: Relation): RelationEvent[] {
  const known = new Set(prev?.ledger ?? []);
  return next.ledger.filter((e) => !known.has(e)).flatMap((e) => scoredRow(next, e) ?? []);
}
