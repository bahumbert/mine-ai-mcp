// A suspended request's hold between reflex decisions.
import type { Continuation } from "./abort.js";
import { monotonicNow } from "../utils/index.js";
import { AGE_PACKET_TICKS, MS_PER_ON_TIME_TICK, serverPacedWallMs, serverTickDeadline } from "../world/world-age.js";

export interface HeldRequestOptions {
  readonly request: string;
  readonly owner: string;
  readonly reason: string;
  readonly backstopTicks: number;
  readonly worldAge: () => number | null;
  readonly onTransition?: (transition: HoldTransition) => void;
}

export interface HoldTransition {
  readonly request: string;
  readonly owner: string;
  readonly outcome: "held" | "attached" | "released" | "backstop";
  readonly generation: number;
  readonly worldAge: number | null;
  readonly resumed: boolean;
}

export interface HoldEnd {
  readonly kind: "resume" | "return" | "abort";
  readonly reason: string | null;
}

/** One request's first-wins handshake across successive reflex decisions. */
export class HeldRequest {
  readonly request: string;
  readonly owner: string;
  generation = 1;
  state: "waiting" | "attached" | "released" | "aborted" | "backstop" = "waiting";
  readonly reasons: string[];
  /** Terminal annotation is separate so a receipt already in the cancelled error is not repeated. */
  suffix: string | null = null;
  readonly startedAge: number | null;
  readonly done: Promise<HoldEnd>;
  readonly #options: HeldRequestOptions;
  #resolve!: (end: HoldEnd) => void;
  #ended = false;
  #resumed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(options: HeldRequestOptions) {
    this.#options = options;
    this.request = options.request;
    this.owner = options.owner;
    this.startedAge = options.worldAge();
    this.reasons = [options.reason];
    this.done = new Promise((resolve) => { this.#resolve = resolve; });
    this.#wait();
  }

  attach(name: string, contact: string): boolean {
    if (this.#ended || this.state !== "waiting" || name !== this.owner) return false;
    this.#clearTimer();
    this.state = "attached";
    this.reasons.push(contact);
    this.#options.onTransition?.(this.snapshot());
    return true;
  }

  verdict(continuation: Continuation, by: string): boolean {
    if (this.#ended) return false;
    // An unrelated claim on the idle body cannot decide to resume this objective (P4-29 a6 G02).
    if (this.state === "waiting" && by !== this.owner && continuation.kind === "resume") return true;
    if (continuation.kind !== "cancel" && continuation.reason) this.reasons.push(continuation.reason);
    if (continuation.kind === "hold" || continuation.kind === "resume" && by !== this.owner) {
      this.generation++;
      this.state = "waiting";
      this.#wait();
      this.#options.onTransition?.(this.snapshot());
      return true;
    }
    return this.#finish("released", {
      kind: continuation.kind === "cancel" ? "abort" : continuation.kind,
      reason: continuation.kind === "cancel" ? null : continuation.reason ?? null,
    });
  }

  release(decision: string, ended: string | null = null): boolean {
    if (this.state !== "waiting") return false;
    const suffix = ended === null ? `; ${this.owner} chose no further response (${decision}).`
      : `; ${this.owner} saw the threat end (${ended}): the walk resumes.`;
    return this.#finish("released", { kind: ended === null ? "return" : "resume", reason: `${this.reasons.join(" ")}${suffix}` }, suffix);
  }

  abort(cause: unknown): boolean {
    return this.#finish("aborted", { kind: "abort", reason: cause instanceof Error ? cause.message : String(cause) });
  }

  backstop(): boolean {
    if (this.state !== "waiting") return false;
    const suffix = `; no decision from ${this.owner} within ${this.#options.backstopTicks} world ticks.`;
    return this.#finish("backstop", { kind: "return", reason: `${this.reasons.join(" ")}${suffix}` }, suffix);
  }

  /** The actual first-wins state, stamped with the latest packet age for phase receipts. */
  snapshot(): HoldTransition {
    return { request: this.request, owner: this.owner, generation: this.generation, worldAge: this.#options.worldAge(),
      outcome: this.state === "waiting" ? "held" : this.state === "attached" ? "attached"
        : this.state === "backstop" ? "backstop" : "released", resumed: this.#resumed };
  }

  /** A generation owns one polled packet-origin deadline, retired before attachment or any exit. */
  #wait(): void {
    this.#clearTimer();
    const deadline = serverTickDeadline(this.#options.worldAge, this.#options.backstopTicks, monotonicNow(), {
      origin: "packet", wallMs: serverPacedWallMs(this.#options.backstopTicks),
    });
    const poll = () => {
      if (deadline.passed(monotonicNow())) this.backstop();
      else this.#timer = setTimeout(poll, AGE_PACKET_TICKS * MS_PER_ON_TIME_TICK);
    };
    this.#timer = setTimeout(poll, AGE_PACKET_TICKS * MS_PER_ON_TIME_TICK);
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #finish(state: HeldRequest["state"], end: HoldEnd, suffix: string | null = null): boolean {
    if (this.#ended) return false;
    this.#ended = true;
    this.state = state;
    this.suffix = suffix;
    this.#resumed = state === "released" && end.kind === "resume" && suffix !== null;
    this.#clearTimer();
    this.#resolve(end);
    this.#options.onTransition?.(this.snapshot());
    return true;
  }
}

/** Await a held decision, ending the objective immediately on either request cancellation source. */
export async function awaitHeldRequest(record: HeldRequest, signals: readonly AbortSignal[]): Promise<HoldEnd> {
  const onAbort = () => record.abort(signals.find((signal) => signal.aborted)?.reason);
  for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
  if (signals.some((signal) => signal.aborted)) onAbort();
  try { return await record.done; }
  finally { for (const signal of signals) signal.removeEventListener("abort", onAbort); }
}

/** Keep the release annotation on the last receipt for both returned and resumed requests. */
export function heldInterruptions(reasons: readonly string[], suffix: string | null): string[] {
  return reasons.map((reason, index) => index === reasons.length - 1 ? `${reason}${suffix ?? ""}` : reason);
}

/** Append every new receipt to a cancelled result without altering an executor's other outcomes. */
export function appendHeldReasons<Result extends { readonly status: string; readonly error?: string }>(result: Result, reasons: readonly string[], suffix: string | null = null): Result {
  if (result.status !== "cancelled") return result;
  let error = result.error ?? "";
  let covered = reasons.length;
  while (covered > 0 && !error.endsWith(reasons.slice(0, covered).join(" "))) covered--;
  for (const reason of reasons.slice(covered)) error = `${error} ${reason}`;
  if (suffix && !error.endsWith(suffix)) error += suffix;
  return { ...result, error };
}
