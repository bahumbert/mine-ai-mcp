import { isDeepStrictEqual } from "node:util";
import { monotonicNow } from "../../utils/monotonic-clock.js";
import { MS_PER_ON_TIME_TICK, type ServerTickDeadline, serverPacedWallMs, serverTickDeadline } from "../../world/world-age.js";

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

/**
 * A premise that expires `ticks` world ticks after the failure is remembered (the server's own age, so a 10 tps server
 * gives the same game time as a 20 tps one); the monotonic clock is only its wider backstop.
 */
export interface TemporalPremise {
  readonly premise: string;
  readonly ticks: number;
  readonly why: string;
}

interface RetainedAnswer {
  readonly entry: AnsweredEntry;
  readonly read: AnsweredScope;
  /**
   * The temporal premise's end, private (the entry's public `expiresAt` is a record): a world-age deadline created in
   * `remember`, so a late `find` cannot move its origin.
   */
  readonly deadline: ServerTickDeadline | null;
}

/**
 * One runtime's failed scopes. Cancellation and policy refusals are not failures. Two readings per entry: a deadline on
 * the world age `age` with `now` (monotonic) as its wall backstop, and the public `since` / `temporal.expiresAt` on
 * `wallNow` (a record shown in the status; `expiresAt` is a 20 tps estimate, `ticks * MS_PER_ON_TIME_TICK` after
 * `since`). With no age to read (`age` null, a test, a bot that heard no time packet) a pause is `ticks * 50` ms on `now`.
 */
export class Answered {
  readonly #entries = new Map<number, RetainedAnswer>();
  #nextId = 1;

  constructor(
    private readonly now: () => number = monotonicNow,
    private readonly wallNow: () => number = Date.now,
    private readonly age: () => number | null = () => null,
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
      temporal: temporal && { premise: temporal.premise, expiresAt: since + temporal.ticks * MS_PER_ON_TIME_TICK, why: temporal.why },
    };
    this.#entries.set(entry.id, { entry, read: scope, deadline: temporal && this.#deadlineOf(temporal.ticks) });
    return entry;
  }

  /** Read the age once, here: `find` and `snapshot` run late, and a deadline that read its origin then would restart. */
  #deadlineOf(ticks: number): ServerTickDeadline {
    return serverTickDeadline(this.age, ticks, this.now(), { origin: "packet", wallMs: serverPacedWallMs(ticks), stoppedMs: null });
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
      (deadline === null || !deadline.passed(this.now())) &&
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
