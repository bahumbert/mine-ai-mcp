// The requests I make of a partner: opened when my line asks, answered by their next lines, ignored when nobody answers in time.
import { withScoreEvent } from "./score.ts";
import { MINUTE_MS, type OpenRequest, type Relation, type Scoring } from "./types.ts";

const MAX_OPEN_REQUESTS = 3;
/** An agreed request nobody reports done is forgotten after this long, with no score. */
const AGREED_FORGET_MS = 30 * MINUTE_MS;
const MAX_WHAT = 200;

export type RequestAnswer = "agreed" | "refused" | "done";

export interface ExpireOptions {
  /** The brain just started: requests older than the answer time were not watched, so they are dropped, never ignored. */
  readonly atLoad?: boolean;
  /** A line from this partner is heard and not yet decided: nothing expires. */
  readonly waiting?: boolean;
  /** The partner is no longer in the game: what is due is dropped, never ignored. */
  readonly offline?: boolean;
}

/** A new request to the partner; the oldest goes when three are open. */
export function openRequest(r: Relation, what: string, at: number, inRange: boolean): Relation {
  const request: OpenRequest = { what: what.trim().slice(0, MAX_WHAT), at, inRange, agreed: false, heard: false };
  return { ...r, requests: [...r.requests, request].slice(-MAX_OPEN_REQUESTS) };
}

/** The partner's line answered open request `n` (1-based, in `requestLines` order); a refusal or a done closes it and scores, an agreement keeps it open. No request `n`: unchanged. */
export function answerRequest(r: Relation, n: number, answer: RequestAnswer, now: number, s: Scoring): Relation {
  const request = r.requests[n - 1];
  if (request === undefined) return r;
  if (answer === "agreed") return request.agreed ? r : { ...r, requests: r.requests.map((q) => (q === request ? { ...q, agreed: true } : q)) };
  const closed = { ...r, requests: r.requests.filter((q) => q !== request) };
  return answer === "refused"
    ? withScoreEvent(closed, { kind: "request_refused", why: `refused your request for ${request.what}` }, now, s)
    : withScoreEvent(closed, { kind: "request_helped", why: `helped with your request for ${request.what}` }, now, s);
}

/** A line from the partner was heard at `at`: each request asked before it is answered (its silence is never scored). The same record when none changes, so nothing is written. */
export function heardFrom(r: Relation, at: number): Relation {
  if (!r.requests.some((q) => !q.heard && q.at < at)) return r;
  return { ...r, requests: r.requests.map((q) => (!q.heard && q.at < at ? { ...q, heard: true } : q)) };
}

export interface ExpiredRequests {
  readonly relation: Relation;
  /** In earshot, never answered by any line: these score. */
  readonly ignored: readonly OpenRequest[];
  /** Not agreed but the partner spoke after the ask: dropped with no score. */
  readonly heardDropped: readonly OpenRequest[];
}

/** The requests that ran out: `ignored` are those in earshot nobody answered in time with any line; the rest are dropped without a score. */
export function expireRequests(r: Relation, now: number, answerMinutes: number, o: ExpireOptions = {}): ExpiredRequests {
  if (o.waiting === true || r.requests.length === 0) return { relation: r, ignored: [], heardDropped: [] };
  const kept: OpenRequest[] = [];
  const ignored: OpenRequest[] = [];
  const heardDropped: OpenRequest[] = [];
  for (const q of r.requests) {
    const age = now - q.at;
    if (q.agreed ? age <= AGREED_FORGET_MS : age < answerMinutes * MINUTE_MS) kept.push(q);
    else if (q.agreed) continue;
    else if (q.heard) heardDropped.push(q);
    else if (q.inRange && o.atLoad !== true && o.offline !== true) ignored.push(q);
  }
  return kept.length === r.requests.length ? { relation: r, ignored, heardDropped } : { relation: { ...r, requests: kept }, ignored, heardDropped };
}

/** The requests that ran out are closed and each ignored one scores, as one change. */
export function withExpiredRequests(r: Relation, now: number, s: Scoring, o: ExpireOptions = {}): Relation {
  const { relation, ignored } = expireRequests(r, now, s.score.requestAnswerMinutes, o);
  return ignored.reduce((acc, q) => withScoreEvent(acc, { kind: "request_ignored", why: `did not answer when you asked for ${q.what}` }, now, s), relation);
}

/** "1. You asked Theo for 5 oak_log 1 min ago." for each open request, numbered as `answerRequest` counts. */
export function requestLines(r: Relation, partner: string, now: number): string[] {
  return r.requests.map((q, i) => `${i + 1}. You asked ${partner} for ${q.what} ${Math.max(0, Math.floor((now - q.at) / MINUTE_MS))} min ago${q.agreed ? "; they agreed" : ""}.`);
}
