// One reflex's sensor, decision and claim lifecycle, as the driver ticks it.
import { isDeepStrictEqual } from "node:util";
import { BodyAbort } from "../../session/abort.js";
import type { ActionRunner } from "../../session/action-runner.js";
import type { Answered, AnsweredEntry, Facts } from "../state/answered.js";
import type { DangerObservation, ReflexDefinition, ReflexName, ReflexSnapshot, SurvivalTransition } from "./contract.js";

/** What a registered reflex needs from its driver: the shared runner, answers, clock and the driver's world revision. */
export interface RegistrationHost {
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
  tick(): void;
  stop(reason: BodyAbort): void;
  close(): Promise<void>;
  settled(): Promise<void>;
  snapshot(): ReflexSnapshot;
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
    const world = host.world();
    let signal: AbortSignal | null = null;
    const active: ActiveClaim = { name: responseName, startedAt: Date.now(), controller, signal: null };
    this.#active = active;
    const claim = host.runner.claim(
      definition.name,
      reason,
      async (bodySignal) => {
        signal = AbortSignal.any([bodySignal, controller.signal, this.#lifetime.signal]);
        if (this.#active) this.#active.signal = signal;
        signal.throwIfAborted();
        const outcome = await definition.act(response, signal);
        const continuation = definition.continuation(outcome);
        return {
          value: outcome,
          continuation: signal.aborted
            ? {
                kind: "cancel" as const,
                cause:
                  signal.reason instanceof BodyAbort
                    ? signal.reason.detail
                    : { kind: "cancelled" as const, by: "runtime" as const },
              }
            : continuation,
        };
      },
      definition.releaseAfterAdmission,
    );
    if (claim.kind !== "claimed") {
      this.#active = null;
      return;
    }
    host.publish({
      kind: "claim",
      reflex: definition.name,
      evidence: { response: responseName, interrupted: claim.interrupted ? { ...claim.interrupted } : null },
    });
    const wasCancelled = () => signal?.aborted || this.#lifetime.signal.aborted || world !== host.world();
    this.#pending = claim.outcome
      .then((outcome) => this.#settleClaimOutcome(response, responseName, outcome, claim.interrupted, wasCancelled))
      .catch((cause: unknown) => this.#settleClaimFailure(response, responseName, cause, signal, world, wasCancelled))
      .finally(() => {
        this.#pending = null;
        this.#active = null;
      });
  }

  #settleClaimOutcome(
    response: Response,
    responseName: string,
    outcome: Outcome,
    interrupted: { action: string; startedAt: string } | null,
    wasCancelled: () => boolean | undefined,
  ): void {
    const { definition, host } = this;
    const cancelled = wasCancelled();
    const failure = cancelled ? null : definition.failure(outcome);
    // Movement or construction can change the attempted arrangement.
    // Remember the settled scope, including its identity, so an evade
    // cannot buy another full attempt just by moving before it fails.
    if (failure)
      host.answered.remember(
        definition.facts(response),
        failure,
        definition.temporal?.(outcome) ?? this.#retryTemporal(failure.why),
      );
    definition.settled?.(response, outcome, interrupted);
    host.publish({
      kind: "outcome",
      reflex: definition.name,
      evidence: {
        response: responseName,
        cancelled: Boolean(cancelled),
        outcome: definition.describe(outcome),
        interrupted: interrupted ? { ...interrupted } : null,
      },
    });
  }

  #settleClaimFailure(
    response: Response,
    responseName: string,
    cause: unknown,
    signal: AbortSignal | null,
    world: number,
    wasCancelled: () => boolean | undefined,
  ): void {
    const { definition, host } = this;
    // An exception is evidence of an execution failure, never proof that geometry is impossible.
    const why = cause instanceof Error ? cause.message : String(cause);
    if (!wasCancelled())
      host.answered.remember(definition.facts(response), { kind: "execution_failed", why }, this.#retryTemporal(why));
    host.publish({
      kind: "outcome",
      reflex: definition.name,
      evidence: {
        response: responseName,
        kind: signal?.aborted || world !== host.world() ? "cancelled" : "execution_failed",
        why,
      },
    });
  }
}
