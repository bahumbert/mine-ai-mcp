import { isDeepStrictEqual } from "node:util";
import { monotonicNow } from "../../utils/monotonic-clock.js";

/** Named observations, not an opaque fingerprint or a full policy revision. */
export type Facts = null | boolean | number | string | readonly Facts[] | { readonly [name: string]: Facts };

export interface AnsweredScope {
  readonly capability: string;
  readonly response: string;
  readonly scope: string;
  readonly facts: () => Facts;
  readonly permissions: () => Facts;
  /** Release observation subscriptions when this conclusion expires. */
  readonly dispose?: () => void;
}

export interface AnsweredEntry {
  readonly id: number;
  readonly capability: string;
  readonly response: string;
  readonly scope: string;
  readonly facts: Facts;
  readonly consumed: Facts;
  readonly failure: { readonly kind: string; readonly why: string };
  readonly since: number;
  readonly temporal: { readonly premise: string; readonly expiresAt: number; readonly why: string } | null;
}

/** A premise that expires `durationMs` after the failure is remembered, counted on the monotonic clock. */
export interface TemporalPremise {
  readonly premise: string;
  readonly durationMs: number;
  readonly why: string;
}

interface RetainedAnswer {
  readonly entry: AnsweredEntry;
  readonly read: AnsweredScope;
  /** The temporal premise's end on the monotonic clock, private: the entry's public `expiresAt` is a wall-clock record. */
  readonly deadline: number | null;
}

/**
 * One runtime's failed scopes. Cancellation and policy refusals are not failures. Two readings per entry: a deadline on
 * `now` (monotonic, compared) and the public `since` / `temporal.expiresAt` on `wallNow` (a record shown in the status).
 */
export class Answered {
  readonly #entries = new Map<number, RetainedAnswer>();
  #nextId = 1;

  constructor(
    private readonly now: () => number = monotonicNow,
    private readonly wallNow: () => number = Date.now,
  ) {}

  /** Capture after settlement, so the attempt's own construction cannot rearm itself. */
  remember(scope: AnsweredScope, failure: AnsweredEntry["failure"], temporal: TemporalPremise | null = null): AnsweredEntry {
    this.forget(scope.capability, scope.scope);
    const since = this.wallNow();
    const entry: AnsweredEntry = {
      id: this.#nextId++,
      capability: scope.capability,
      response: scope.response,
      scope: scope.scope,
      facts: structuredClone(scope.facts()),
      consumed: structuredClone(scope.permissions()),
      failure,
      since,
      temporal: temporal && { premise: temporal.premise, expiresAt: since + temporal.durationMs, why: temporal.why },
    };
    this.#entries.set(entry.id, { entry, read: scope, deadline: temporal && this.now() + temporal.durationMs });
    return entry;
  }

  /** Each capability declares the facts that can reopen its conclusion. */
  find(capability: string, scope: string): AnsweredEntry | null {
    for (const [id, answer] of this.#entries) {
      if (answer.entry.capability !== capability || answer.entry.scope !== scope) continue;
      if (this.current(answer)) return answer.entry;
      answer.read.dispose?.();
      this.#entries.delete(id);
    }
    return null;
  }

  private current({ entry, read, deadline }: RetainedAnswer): boolean {
    return (
      (deadline === null || this.now() < deadline) &&
      isDeepStrictEqual(entry.facts, read.facts()) &&
      isDeepStrictEqual(entry.consumed, read.permissions())
    );
  }

  forget(capability: string, scope?: string): void {
    for (const [id, { entry, read }] of this.#entries)
      if (entry.capability === capability && (scope === undefined || entry.scope === scope)) {
        read.dispose?.();
        this.#entries.delete(id);
      }
  }

  clear(): void {
    for (const { read } of this.#entries.values()) read.dispose?.();
    this.#entries.clear();
  }

  snapshot(): AnsweredEntry[] {
    for (const [id, answer] of this.#entries)
      if (!this.current(answer)) {
        answer.read.dispose?.();
        this.#entries.delete(id);
      }
    return [...this.#entries.values()].map(({ entry }) => entry);
  }
}
