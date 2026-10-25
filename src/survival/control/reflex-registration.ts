// One reflex's sensor, decision and claim lifecycle, as the driver ticks it.
import type { Bot } from "mineflayer";
import { isDeepStrictEqual } from "node:util";
import { BodyAbort, type BodyAbortCause, type Continuation } from "../../session/abort.js";
import type { ActionRunner } from "../../session/action-runner.js";
import type { Answered, AnsweredEntry, Facts } from "../state/answered.js";
import type {
  DangerObservation,
  ReflexDefinition,
  ReflexLimits,
  ReflexName,
  ReflexSnapshot,
  SurvivalTransition,
} from "./contract.js";
import { observeBodyProgress, ReflexProgress } from "./reflex-progress.js";

/** What a registered reflex needs from its driver: the shared runner, answers, clock and the driver's world revision. */
export interface RegistrationHost {
  readonly bot: Bot;
  readonly runner: ActionRunner;
  readonly answered: Answered;
  publish(transition: SurvivalTransition): void;
  /** Bumped by the driver on death and dimension change: a claim started in an older world was cancelled. */
  world(): number;
  /** The wall clock the retry delay is counted on (the answered scopes' clock). */
  now(): number;
}

/** What the driver does with a registration, whatever the types of its danger, response and outcome. */
export interface RegisteredReflex {
  readonly name: ReflexName;
  /** Whether this reflex still senses while the bot is a passenger (the body's physics is off). */
  readonly seated: boolean;
  tick(): void;
  stop(reason: BodyAbort): void;
  close(): Promise<void>;
  settled(): Promise<void>;
  snapshot(): ReflexSnapshot;
}

/** One claim in flight: what its settlement needs to tell a cancel, a limit and a failure apart. */
interface ClaimRun<Response> {
  readonly response: Response;
  readonly name: string;
  readonly world: number;
  readonly limits: ReflexLimits;
  readonly progress: ReflexProgress;
  interrupted: { action: string; startedAt: string } | null;
  signal: AbortSignal | null;
}

type ReflexLimitCause = Extract<BodyAbortCause, { kind: "reflex_limit" }>;

/** The limit a claim ran into, when this abort reason or rejection is the runner's `reflex_limit`. */
function reflexLimitOf(cause: unknown): ReflexLimitCause | null {
  return cause instanceof BodyAbort && cause.detail.kind === "reflex_limit" ? cause.detail : null;
}

interface ActiveClaim {
  readonly name: string;
  readonly startedAt: number;
  readonly controller: AbortController;
  signal: AbortSignal | null;
}

/** One reflex's sensor, decision and claim lifecycle, ticked by the driver's single physics listener. */
export class ReflexRegistration<Danger, Response, Outcome> implements RegisteredReflex {
  readonly #lifetime = new AbortController();
  #pending: Promise<void> | null = null;
  #active: ActiveClaim | null = null;
  #danger: Facts = null;
  #missing: string | null = null;
  #decision: Facts = null;
  #observedDanger: Facts = null;
  #observedAt: number | null = null;
  #observedWorld = -1;
  #ticks = 0;

  constructor(
    private readonly definition: ReflexDefinition<Danger, Response, Outcome>,
    private readonly host: RegistrationHost,
  ) {}

  get name(): ReflexName {
    return this.definition.name;
  }

  get seated(): boolean {
    return this.definition.seated === true;
  }

  snapshot(): ReflexSnapshot {
    const active = this.#active;
    return {
      name: this.definition.name,
      danger: this.#danger,
      missing: this.#missing,
      decision: this.#decision,
      observedAt: this.#observedAt,
      stale: this.#observedWorld !== this.host.world(),
      response: active
        ? {
            name: active.name,
            startedAt: active.startedAt,
            releasing: active.controller.signal.aborted || active.signal?.aborted === true,
          }
        : null,
    };
  }

  stop(reason: BodyAbort): void {
    this.#active?.controller.abort(reason);
  }

  settled(): Promise<void> {
    return this.#pending ?? Promise.resolve();
  }

  async close(): Promise<void> {
    this.#lifetime.abort(new BodyAbort({ kind: "cancelled", by: "runtime" }, `${this.definition.name} closed.`));
    await this.#pending;
  }

  /** A throw in the reflex's sense, decision or facts never leaves the physics listener: it reads as a failed sensor. */
  tick(): void {
    if (this.#lifetime.signal.aborted) return;
    if (++this.#ticks % (this.definition.intervalTicks ?? 1) !== 0) return;
    try {
      this.#observeAndRespond();
    } catch (cause) {
      this.#failSensor(cause);
    }
  }

  #observeAndRespond(): void {
    const sensed = this.#senseDanger();
    if (this.#pending) return;
    if (sensed?.kind !== "observed") {
      this.#changeDecision(null);
      return;
    }
    this.#chooseResponse(sensed.danger);
  }

  #senseDanger(): DangerObservation<Danger> {
    const sensed = this.definition.sense();
    this.#observedAt = Date.now();
    this.#observedWorld = this.host.world();
    this.#danger = sensed?.kind === "observed" ? sensed.evidence : null;
    this.#missing = sensed?.kind === "unknown" ? sensed.missing : null;
    this.#publishDangerChange();
    return sensed;
  }

  /** The danger read is published once per change, so a sensor that fails every tick is one receipt, not twenty a second. */
  #publishDangerChange(): void {
    const nextDanger = { danger: this.#danger, missing: this.#missing };
    if (isDeepStrictEqual(nextDanger, this.#observedDanger)) return;
    this.#observedDanger = structuredClone(nextDanger);
    this.host.publish({ kind: "danger", reflex: this.definition.name, evidence: nextDanger });
  }

  /** No danger is read and no decision is made this tick; a claim begun before the throw is not left half-registered. */
  #failSensor(cause: unknown): void {
    this.#observedAt = Date.now();
    this.#observedWorld = this.host.world();
    this.#danger = null;
    this.#missing = `sensor_failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    this.#publishDangerChange();
    if (this.#pending) return;
    this.#active = null;
    this.#changeDecision(null);
  }

  /** The remembered failure of a reflex that retries: it expires after `retryAfterFailureMs`, the facts may reopen it sooner. */
  #retryTemporal(why: string): AnsweredEntry["temporal"] {
    const { retryAfterFailureMs } = this.definition;
    if (retryAfterFailureMs === undefined) return null;
    return { premise: "retry_after_failure", expiresAt: this.host.now() + retryAfterFailureMs, why };
  }

  /** Decide for an observed danger; claim the body unless the decision is not a response or the scope is answered. */
  #chooseResponse(danger: Danger): void {
    const chosen = this.definition.decide(danger);
    const inputs = () => this.definition.decisionFacts?.(danger) ?? this.#danger;
    if (chosen.kind !== "respond") {
      this.#changeDecision(
        chosen.kind === "handled"
          ? { kind: chosen.kind, by: chosen.by }
          : {
              kind: chosen.kind,
              candidates: chosen.candidates.map(({ response, excluded }) => ({
                response,
                excluded: { ...excluded },
              })),
            },
        inputs,
      );
      return;
    }
    const scope = this.definition.facts(chosen.response);
    const answered = this.host.answered.find(scope.capability, scope.scope);
    if (answered) {
      this.#changeDecision(
        {
          kind: "stand_down",
          candidates: [{ response: chosen.name, excluded: { kind: "answered", entry: answered.id } }],
        },
        inputs,
      );
      return;
    }
    this.#changeDecision({ kind: "respond", response: chosen.name, reason: chosen.reason }, inputs);
    this.#startClaim(chosen.response, chosen.name, chosen.reason);
  }

  #changeDecision(next: Facts, inputs: () => Facts = () => this.#danger): void {
    if (isDeepStrictEqual(next, this.#decision)) return;
    this.#decision = next;
    this.host.publish({
      kind: "decision",
      reflex: this.definition.name,
      evidence: { decision: next, inputs: inputs() },
    });
  }

  #startClaim(response: Response, responseName: string, reason: string): void {
    const { definition, host } = this;
    const controller = new AbortController();
    const active: ActiveClaim = { name: responseName, startedAt: Date.now(), controller, signal: null };
    this.#active = active;
    const limits = definition.limits(response);
    const progress = new ReflexProgress();
    const run: ClaimRun<Response> = {
      response,
      name: responseName,
      world: host.world(),
      limits,
      progress,
      interrupted: null,
      signal: null,
    };
    // Probes listen from before the claim: the work may start inside the call when no action is interrupted.
    const detach = this.#watchProgress(response, progress);
    const claim = host.runner.claim(
      definition.name,
      reason,
      async (bodySignal) => {
        const signal = AbortSignal.any([bodySignal, controller.signal, this.#lifetime.signal]);
        run.signal = signal;
        active.signal = signal;
        signal.throwIfAborted();
        const outcome = await definition.act(response, signal);
        const continuation = definition.continuation(outcome);
        return { value: outcome, continuation: this.#continuationAfter(signal, continuation) };
      },
      definition.releaseAfterAdmission,
      { ceilingMs: limits.ceilingMs, noProgressMs: limits.noProgressMs, progressMarks: () => progress.marks },
    );
    if (claim.kind !== "claimed") {
      detach();
      this.#active = null;
      return;
    }
    run.interrupted = claim.interrupted;
    host.publish({
      kind: "claim",
      reflex: definition.name,
      evidence: { response: responseName, interrupted: claim.interrupted ? { ...claim.interrupted } : null },
    });
    this.#pending = claim.outcome
      .then((outcome) => this.#settleClaimOutcome(run, outcome))
      .catch((cause: unknown) => this.#settleClaimFailure(run, cause))
      .finally(() => {
        detach();
        this.#pending = null;
        this.#active = null;
      });
  }

  /** The base probe and the reflex's own, both off when the claim ends (or never starts). */
  #watchProgress(response: Response, progress: ReflexProgress): () => void {
    const base = observeBodyProgress(this.host.bot, progress.mark);
    let own: (() => void) | undefined;
    try {
      own = this.definition.progress?.(response, progress.mark);
    } catch {
      // A probe that cannot attach must not keep the reflex from answering: the base probe and the limits still hold.
    }
    return () => {
      base();
      own?.();
    };
  }

  /** A claim told to stop returns its request with the limit's text; any other abort cancels it with its cause. */
  #continuationAfter(signal: AbortSignal, continuation: Continuation): Continuation {
    if (!signal.aborted) return continuation;
    if (reflexLimitOf(signal.reason)) return { kind: "return", reason: (signal.reason as BodyAbort).message };
    return {
      kind: "cancel",
      cause: signal.reason instanceof BodyAbort ? signal.reason.detail : { kind: "cancelled", by: "runtime" },
    };
  }

  /** A cancel (policy, death, dimension, close) is no attempt; a limit is, and stands the reflex down in time. */
  #cancelled(run: ClaimRun<Response>): boolean {
    const stoppedByAnother = run.signal?.aborted === true && reflexLimitOf(run.signal.reason) === null;
    return stoppedByAnother || this.#lifetime.signal.aborted || run.world !== this.host.world();
  }

  #settleClaimOutcome(run: ClaimRun<Response>, outcome: Outcome): void {
    const { definition, host } = this;
    const cancelled = this.#cancelled(run);
    const limit = cancelled ? null : reflexLimitOf(run.signal?.reason);
    const failure = cancelled || limit ? null : definition.failure(outcome);
    // Movement or construction can change the attempted arrangement.
    // Remember the settled scope, including its identity, so an evade
    // cannot buy another full attempt just by moving before it fails.
    if (failure)
      host.answered.remember(
        definition.facts(run.response),
        failure,
        definition.temporal?.(outcome) ?? this.#retryTemporal(failure.why),
      );
    if (limit) this.#standDown(run, limit);
    definition.settled?.(run.response, outcome, run.interrupted);
    host.publish({
      kind: "outcome",
      reflex: definition.name,
      evidence: {
        response: run.name,
        cancelled,
        outcome: limit ? this.#limitOutcome(run, limit) : definition.describe(outcome),
        interrupted: run.interrupted ? { ...run.interrupted } : null,
      },
    });
  }

  #settleClaimFailure(run: ClaimRun<Response>, cause: unknown): void {
    const { definition, host } = this;
    const why = cause instanceof Error ? cause.message : String(cause);
    const cancelled = this.#cancelled(run);
    const limit = cancelled ? null : (reflexLimitOf(run.signal?.reason) ?? reflexLimitOf(cause));
    if (limit) {
      // The work ignored the abort (or threw on it) and the runner released the body: the limit, not an exception.
      this.#standDown(run, limit);
      host.publish({
        kind: "outcome",
        reflex: definition.name,
        evidence: {
          response: run.name,
          cancelled: false,
          outcome: this.#limitOutcome(run, limit),
          interrupted: run.interrupted ? { ...run.interrupted } : null,
        },
      });
      return;
    }
    // An exception is evidence of an execution failure, never proof that geometry is impossible.
    if (!cancelled)
      host.answered.remember(definition.facts(run.response), { kind: "execution_failed", why }, this.#retryTemporal(why));
    host.publish({
      kind: "outcome",
      reflex: definition.name,
      evidence: {
        response: run.name,
        kind: run.signal?.aborted || run.world !== host.world() ? "cancelled" : "execution_failed",
        why,
      },
    });
  }

  #limitOutcome(run: ClaimRun<Response>, limit: ReflexLimitCause): Facts {
    return {
      kind: "limit",
      limit: limit.limit,
      elapsedMs: Math.round(limit.elapsedMs),
      lastProgress: run.progress.lastReason,
    };
  }

  /**
   * After a limit the scope is answered for `standDownMs` whatever the facts do: the danger may be growing while the
   * scene stays equal, and a body held for good is worse than a pause. Only the time ends it (permissions still apply).
   */
  #standDown(run: ClaimRun<Response>, limit: ReflexLimitCause): void {
    const { definition, host } = this;
    const seconds = Math.round(limit.elapsedMs / 1000);
    const why = `${definition.name} hit its ${limit.limit} limit after ${seconds} s (last progress: ${run.progress.lastReason ?? "none"}).`;
    host.answered.remember(
      { ...definition.facts(run.response), facts: () => null },
      { kind: "reflex_limit", why },
      { premise: "reflex_limit", expiresAt: host.now() + run.limits.standDownMs, why },
    );
  }
}
