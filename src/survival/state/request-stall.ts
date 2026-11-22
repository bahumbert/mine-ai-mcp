// A request that keeps being answered by hostile fights and evades without getting closer to its objective is handed back to the model.
import type { RequestEvidence, RequestSnapshot } from "../../session/request.js";
import { serverPacedWallMs } from "../../world/world-age.js";

/**
 * Evades of one request, with no objective progress between them, after which the request is returned: twice the most
 * stall evades a succeeded request needed (5, fortress-withdrawal t00990, 660 ticks).
 */
export const STALL_EVADES = 10;
/** World ticks without objective progress, with at least two completed fight or evade responses, after which the request is returned. */
export const STALL_TICKS = 1680;
export const STALLED_CODE = "[HOSTILE_STALLED]";

export interface StallFacts {
  readonly requestId: string;
  readonly action: string;
  /** Completed fight and evade responses since the last progress (an evade counts in both numbers). */
  readonly responses: number;
  readonly evades: number;
  /** World ticks since the last progress; null until a world age was heard. */
  readonly ticks: number | null;
  readonly threats: readonly { readonly id: number; readonly name: string }[];
  readonly best: number | null;
  readonly current: number | null;
  /** The limit reached: the evade count, the world ticks, or the real-time backstop of a stopped server. */
  readonly limit: "evades" | "ticks" | "wall" | null;
}

interface Tracker {
  readonly requestId: string;
  readonly action: string;
  best: number | null;
  current: number | null;
  responses: number;
  evades: number;
  progressAge: number | null;
  progressMs: number;
  readonly threats: Map<number, string>;
}

/**
 * The stall of one request at a time, kept by (request id, generation) across resumes and holds. The newest generation
 * heard is kept whether or not a request is tracked, so a late call of an older life is refused after any later reading.
 */
export class RequestStalls {
  #tracker: Tracker | null = null;
  #generation = 0;

  /** Read the request's evidence: first reading, progress, or nothing. */
  observe(request: RequestSnapshot | null, generation: number, age: number | null, nowMs: number): void {
    this.#read(request, generation, age, nowMs);
  }

  /** Count one completed fight or evade of the request; the facts carry `limit` when the request must be returned. */
  recordResponse(
    request: RequestSnapshot | null,
    generation: number,
    response: "fight" | "evade",
    threats: readonly { id: number; name: string }[],
    age: number | null,
    nowMs: number,
  ): StallFacts | null {
    const tracker = this.#read(request, generation, age, nowMs);
    if (!tracker) return null;
    tracker.responses++;
    if (response === "evade") tracker.evades++;
    for (const threat of threats) tracker.threats.set(threat.id, threat.name);
    return factsOf(tracker, age, nowMs);
  }

  /** The limit as it stands, counting no response (the held release decides with it). */
  check(request: RequestSnapshot | null, generation: number, age: number | null, nowMs: number): StallFacts | null {
    const tracker = this.#read(request, generation, age, nowMs);
    return tracker ? factsOf(tracker, age, nowMs) : null;
  }

  /**
   * The limit the running fight would reach if it ended now, read without moving `best` or the count: only the
   * response start, its finalize and the held release record progress. Null for another life, another request, a request
   * with no objective, evidence that would count as progress, and fewer than two responses counting the running one.
   */
  limitIfCounted(request: RequestSnapshot | null, generation: number, age: number | null, nowMs: number): StallFacts["limit"] {
    const tracker = this.#tracker;
    if (!tracker || generation !== this.#generation || request?.id !== tracker.requestId) return null;
    if (request.evidence !== null && (request.evidence.objective === undefined || progressed(tracker, request.evidence))) return null;
    return factsOf({ ...tracker, responses: tracker.responses + 1 }, age, nowMs).limit;
  }

  /** Forget the count; the newest generation heard stays, so a late finalize of the life that ended is still refused. */
  clear(): void {
    this.#tracker = null;
  }

  /**
   * The tracker of this request after its reading; null for an old life, for no request, and for a request that
   * publishes no objective (which also drops what was counted before: it keeps no state).
   */
  #read(request: RequestSnapshot | null, generation: number, age: number | null, nowMs: number): Tracker | null {
    if (generation < this.#generation) return null;
    if (generation > this.#generation) {
      this.#generation = generation;
      this.#tracker = null;
    }
    const known = this.#tracker;
    const sameRequest = request !== null && known !== null && known.requestId === request.id;
    if (sameRequest && request.evidence === null) {
      // An observer that failed this once reads nothing new: the count stays and the age is still heard.
      known.progressAge ??= age;
      return known;
    }
    if (!request || request.evidence === null || request.evidence.objective === undefined) {
      this.#tracker = null;
      return null;
    }
    const tracker = sameRequest
      ? known
      : (this.#tracker = { requestId: request.id, action: request.action, best: null, current: null,
        responses: 0, evades: 0, progressAge: age, progressMs: nowMs, threats: new Map() });
    tracker.progressAge ??= age;
    const { objective } = request.evidence;
    tracker.current = objective?.remaining ?? null;
    // The first reading sets `best` and is no progress; every later one is judged against it.
    const first = objective && tracker.best === null;
    const moved = progressed(tracker, request.evidence);
    if (first) tracker.best = objective.remaining;
    if (!moved) return tracker;
    if (objective) tracker.best = objective.remaining;
    tracker.responses = 0;
    tracker.evades = 0;
    tracker.progressAge = age;
    tracker.progressMs = nowMs;
    return tracker;
  }
}

/** A reading is progress when its completion is observed, or its remaining distance is a full tolerance under the best so far; the first reading, with no best yet, is none. */
function progressed(tracker: Tracker, evidence: RequestEvidence): boolean {
  const { objective, completion } = evidence;
  return completion.observed
    || (objective !== undefined && objective !== null && tracker.best !== null && objective.remaining <= tracker.best - objective.tolerance);
}

function factsOf(tracker: Tracker, age: number | null, nowMs: number): StallFacts {
  const ticks = age !== null && tracker.progressAge !== null ? age - tracker.progressAge : null;
  const chained = tracker.responses >= 2;
  const limit = tracker.evades >= STALL_EVADES ? "evades"
    : chained && ticks !== null && ticks >= STALL_TICKS ? "ticks"
    : chained && nowMs - tracker.progressMs >= serverPacedWallMs(STALL_TICKS) ? "wall"
    : null;
  return {
    requestId: tracker.requestId, action: tracker.action, responses: tracker.responses, evades: tracker.evades, ticks,
    threats: [...tracker.threats].map(([id, name]) => ({ id, name })),
    best: tracker.best, current: tracker.current, limit,
  };
}

const blocks = (distance: number | null): string => (distance === null ? "unknown" : distance.toFixed(1));

/** What the model reads when the request is returned instead of resumed (explicit MCP wording, spec D5). */
export function stallReason(stall: StallFacts): string {
  const who = stall.threats.map((threat) => `${threat.name}#${threat.id}`).join(", ");
  const over = stall.ticks === null ? "an unknown number of" : String(stall.ticks);
  return `${STALLED_CODE} ${stall.responses} hostile responses (${stall.evades} evades) from ${who} over ${over} server ticks without progress on ${stall.action} `
    + `(best remaining ${blocks(stall.best)}, now ${blocks(stall.current)}); `
    + "the reflex still protects the body; choose the next action.";
}
