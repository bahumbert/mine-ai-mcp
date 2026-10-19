import { randomUUID } from "node:crypto";
import { outranksReflex } from "../survival/control/priority.js";
import { BodyAbort, type BodyAbortCause, type Continuation } from "./abort.js";
import type { RequestEvidence, RequestSnapshot, RequestState } from "./request.js";
import { RequestProgress, reflexStateKey, type CombatResourceObservation, type ProgressPosition, type ReflexActivityObservation, type ReflexStateIdentity } from "./progress.js";
import type { ToolSnapshot } from "../world/tool-tiers.js";
import { MONOTONIC_CLOCK, type StallClock } from "../actions/stall-watch.js";
import type { RouteOutcomes } from "../navigation/index.js";
import type { PinnedEscape, PinnedWatch } from "./pinned-watch.js";
/**
 * What is true between actions: one owner of the bot's body at a time, with an
 * explicitly separate control path that can cancel it.
 *
 * The single lock is the complete concurrency model. Control actions are
 * deliberately outside it so they can stop or observe its owner. Action results
 * are not retained by this runner; protocol evidence persistence lives outside
 * it. Minecraft resources live outside this action runner.
 *
 * Two things can own the body, and only one of them is an action. `run` admits
 * a model-requested action into the foreground. `claim` hands the body to
 * reflex code that no model asked for and no model can call - it preempts a
 * running action, or takes an idle body, and while it holds the claim `run`
 * refuses like any other busy session. Combat policy lives outside the runner. A reflex
 * must be able to fire when the bot is doing nothing at all, which is exactly
 * the case an action-shaped takeover cannot express.
 *
 * A claim can hand the body back with a verdict on the action it preempted.
 * When the reflex says the threat is gone and the bot is fit, and the action
 * supplied a resumable request executor, `run` re-enters that executor and
 * answers the original caller with the resumed result and a record of every
 * interruption. A long mining trip then survives its zombies without a round
 * trip to the agent for each one.
 *
 * `run` never throws for a request or executor failure. A refusal is an outcome
 * like any other, nested separately from action-owned physical evidence.
 */
import { runWithHighlighter, type BlockHighlighter } from "@aibengineering/minecraft-block-highlighter";
import type { RequestExecution, ActionExecution, MovementUse } from "../actions/action.js";
import {
  type Action,
  type ActionOutput,
  type ActionResult,
  type RuntimeFailure,
} from "../actions/index.js";

export interface ActionRunnerOptions {
  /** Publishes an action's highlights, and decides whether any are built. */
  readonly highlighter?: BlockHighlighter;
  readonly position?: () => ProgressPosition | null;
  /** Whether the bot is in water now: bobbing there is not travel. */
  readonly inWater?: () => boolean;
  readonly tools?: () => ToolSnapshot;
  /**
   * How long an action that owns the body may go without a physics tick before it fails `RUNTIME_PHYSICS_STALLED` and
   * releases the body (ticks come 20 times a second whether the bot moves or waits). Unset: no watch.
   */
  readonly physicsStallMs?: number;
  /** How long a cancelled action may go on without a tick before it is given up on (default 5 s). */
  readonly cancelGraceMs?: number;
  /** False while the bot is a passenger: Mineflayer turns physics off for the ride, so no tick is owed. */
  readonly physicsExpected?: () => boolean;
  /**
   * Called once when an action fails `RUNTIME_PHYSICS_STALLED`, after its signal is aborted: the runtime records it and
   * turns physics back on where the bot is, so the stopped action can settle before the body is released.
   */
  readonly onPhysicsStall?: (action: string) => void;
  /** The stall watch's clock (default monotonic); tests step it by hand. */
  readonly clock?: StallClock;
  /** Counts the failures of movement actions against a bot that does not move; unset: no watch. */
  readonly pinned?: PinnedWatch;
  /** What a pinned bot's next movement action starts with; without it a pinned bot is only watched. */
  readonly pinnedEscape?: PinnedEscape;
  /** How this bot's routes ended: a movement action's failure counts toward `pinned` only when its route failed; unset: none does. */
  readonly routes?: RouteOutcomes;
}

// ── Reported outcomes ────────────────────────────────────────────────────────

const outcomes = {
  actionBusy: (activeAction: { action: string; startedAt: string }) =>
    `[ACTION_BUSY] ${activeAction.action} has been running since ${activeAction.startedAt}; no new action started.`,
  invalidArguments: (cause: unknown) => `[INVALID_ARGUMENTS] ${message(cause)}`,
  executionError: message,
  physicsStalled: (action: string, stalledMs: number) =>
    `[RUNTIME_PHYSICS_STALLED] ${action} owned the body for ${Math.round(stalledMs / 1000)} s with no physics tick; it was stopped, physics restarted where it stands, and the body released.`,
  cancelledWithoutTicks: (action: string, reason: string) =>
    `${reason} (${action} did not stop: no physics tick since the cancel; the body was released and the next action may start)`,
} as const;

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface ActionRunnerStatus {
  busy: boolean;
  activeAction: { action: string; startedAt: string } | null;
  owner: "idle" | "foreground" | "yielding" | "takeover";
}

export type ForegroundCancellation =
  | {
      readonly kind: "cancellation_requested";
      readonly action: string;
      readonly startedAt: string;
      readonly reason: string;
    }
  | { readonly kind: "idle"; readonly reason: string };

/** What a reflex reports when it releases the body. */
export interface ClaimSettlement<Value> {
  readonly value: Value;
  readonly continuation: Continuation;
}

interface Preemption {
  readonly reason: string;
  readonly cause: BodyAbortCause;
  /** Resolves once the physical claim settles: resume or return its observed stop. */
  readonly verdict: Promise<Continuation>;
}

interface ActiveAction {
  readonly metadata: NonNullable<ActionRunnerStatus["activeAction"]>;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  settle(): void;
  /** The next owner's verdict, for a foreground action or an interrupted reflex. */
  preemption: Preemption | null;
  predecessor: ActiveAction | null;
  released: boolean;
}

type PhysicalSessionState =
  | { readonly kind: "idle" }
  | { readonly kind: "foreground"; readonly action: ActiveAction }
  | {
      readonly kind: "yielding";
      readonly interrupted: ActiveAction;
      readonly takeover: ActiveAction;
      readonly cause: BodyAbortCause;
    }
  | { readonly kind: "takeover"; readonly action: ActiveAction };

interface AdmittedRequest {
  readonly id: string;
  readonly requestId: number | null;
  readonly action: string;
  readonly admittedAt: number;
  readonly lifetime: AbortController;
  objective: unknown;
  state: RequestState;
  evidence: (() => RequestEvidence) | null;
  readonly progress: RequestProgress;
  /** The bot was pinned when this movement action was admitted: it runs as an escape. */
  escaping: boolean;
  /** `RouteOutcomes.mark()` when the action was admitted: its routes are the ones settled after it. */
  routeMark: number;
}

export interface BodyOwnership {
  readonly current: string | null;
  readonly reserved: string | null;
  readonly transfer: { readonly from: string; readonly to: string; readonly cause: BodyAbortCause } | null;
  readonly connected: boolean;
}

/** What a reflex was handed, or why the body was not available to it. */
export type BodyClaim<Value> =
  | { readonly kind: "closed"; readonly cause: BodyAbortCause }
  | { readonly kind: "busy"; readonly activeAction: NonNullable<ActionRunnerStatus["activeAction"]> }
  | {
      readonly kind: "claimed";
      /** The action this claim preempted, or null when the body was already idle. */
      readonly interrupted: ActionRunnerStatus["activeAction"];
      readonly outcome: Promise<Value>;
    };

function activeAction(action: string): ActiveAction {
  const controller = new AbortController();
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    metadata: { action, startedAt: new Date().toISOString() },
    controller,
    settled,
    settle,
    preemption: null,
    predecessor: null,
    released: false,
  };
}

/** A request that never reached the bot: nothing ran, so nothing was spent. */
function refusal<Name extends string, Result extends ActionResult>(
  action: Name,
  error: string,
): ActionOutput<Name, Result> {
  const result: RuntimeFailure = { kind: "runtime_failure", status: "failed", error };
  return { action, durationMs: 0, result };
}

function measured<Name extends string, Result extends ActionResult>(
  action: Name,
  startedAtMs: number,
  result: Result | RuntimeFailure,
  interruptions: readonly string[] = [],
): ActionOutput<Name, Result> {
  // The wall clock can step back (WSL resyncing its clock, live 2026-10-07): a negative duration failed the output
  // schema and every view_status call with it.
  const output: ActionOutput<Name, Result> = { action, durationMs: Math.max(0, Date.now() - startedAtMs), result };
  return interruptions.length > 0 ? { ...output, interruptions: [...interruptions] } : output;
}

export class ActionRunner {
  readonly #highlighter: BlockHighlighter | undefined;
  readonly #position: () => ProgressPosition | null;
  readonly #inWater: () => boolean;
  readonly #tools: () => ToolSnapshot;
  readonly #physicsStallMs: number | undefined;
  readonly #cancelGraceMs: number;
  readonly #physicsExpected: () => boolean;
  readonly #onPhysicsStall: (action: string) => void;
  readonly #clock: StallClock;
  readonly #pinned: PinnedWatch | undefined;
  readonly #pinnedEscape: PinnedEscape | undefined;
  readonly #routes: RouteOutcomes | undefined;
  #lastPhysicsTickAt: number;
  readonly #connection = new AbortController();
  #state: PhysicalSessionState = { kind: "idle" };
  #admittedRequest: AdmittedRequest | null = null;
  #precedingRequest: { requestId: number; completedAtMs: number } | null = null;
  readonly #ownershipListeners = new Set<() => void>();
  #baseline: { readonly name: string; readonly release: () => void } | null = null;

  constructor(options: ActionRunnerOptions = {}) {
    this.#highlighter = options.highlighter;
    this.#position = options.position ?? (() => null);
    this.#inWater = options.inWater ?? (() => false);
    this.#tools = options.tools ?? (() => ({ tools: [], armour: [] }));
    this.#physicsStallMs = options.physicsStallMs;
    this.#cancelGraceMs = options.cancelGraceMs ?? 5_000;
    this.#physicsExpected = options.physicsExpected ?? (() => true);
    this.#onPhysicsStall = options.onPhysicsStall ?? (() => {});
    this.#clock = options.clock ?? MONOTONIC_CLOCK;
    this.#pinned = options.pinned;
    this.#pinnedEscape = options.pinnedEscape;
    this.#routes = options.routes;
    this.#lastPhysicsTickAt = this.#clock.now();
  }

  /** A physics tick happened now: the clock the stall watch reads. */
  observePhysicsTick(): void {
    this.#lastPhysicsTickAt = this.#clock.now();
  }

  /**
   * Settles with `run`, or earlier when the action owns the body and no physics tick comes: a cancelled action is given
   * up on after the grace, any action after the stall limit (live run 14: twelve bots left mounted at sea never ticked
   * again, their navigate never returned and ignored its cancel). A stalled action is stopped (its controller aborted)
   * and physics is restarted through `onPhysicsStall`; it then has the cancel grace to settle on the returning ticks
   * before the body is released (run 14b: left running, the old navigate held the navigation for good). Clock only,
   * monotonic: every limit that waits for a tick is blind in exactly this case.
   */
  #watchPhysics<Value>(action: string, signal: AbortSignal, controller: AbortController, run: Promise<Value | RuntimeFailure>): Promise<Value | RuntimeFailure> {
    const stallMs = this.#physicsStallMs;
    if (stallMs === undefined) return run;
    const clock = this.#clock;
    const startedAt = clock.now();
    let cancelledAt: number | null = null;
    let stalled: { readonly failure: RuntimeFailure; readonly at: number } | null = null;
    return new Promise((resolve, reject) => {
      const settle = (value: Value | RuntimeFailure) => {
        stop();
        resolve(value);
      };
      const stop = clock.every(() => {
        const now = clock.now();
        if (stalled !== null) {
          if (now - stalled.at >= this.#cancelGraceMs) settle(stalled.failure);
          return;
        }
        if (signal.aborted && cancelledAt === null) cancelledAt = now;
        const lastTick = Math.max(this.#lastPhysicsTickAt, startedAt);
        if (cancelledAt !== null && now - Math.max(lastTick, cancelledAt) >= this.#cancelGraceMs) {
          const reason = signal.reason instanceof Error ? signal.reason.message : "cancelled";
          settle({ kind: "runtime_failure", status: "cancelled", error: outcomes.cancelledWithoutTicks(action, reason) });
        } else if (now - lastTick >= stallMs && this.#physicsExpected()) {
          const error = outcomes.physicsStalled(action, now - lastTick);
          stalled = { failure: { kind: "runtime_failure", status: "failed", error }, at: now };
          controller.abort(new BodyAbort({ kind: "cancelled", by: "runtime" }, error));
          this.#onPhysicsStall(action);
        }
      }, Math.max(10, Math.min(250, Math.floor(stallMs / 4))));
      run.then(
        (value) => settle(stalled?.failure ?? value),
        (cause: unknown) => {
          if (stalled !== null) settle(stalled.failure);
          else {
            stop();
            reject(cause);
          }
        },
      );
    });
  }

  #currentAction(): ActiveAction | null {
    switch (this.#state.kind) {
      case "idle":
        return null;
      case "foreground":
      case "takeover":
        return this.#state.action;
      case "yielding":
        return this.#state.takeover;
    }
  }

  readonly run = async <Name extends string, Request, Result extends ActionResult>(
    definition: Action<Name, Request, Result>,
    input: unknown,
    signal?: AbortSignal,
    requestId?: number,
    actionId?: string,
  ): Promise<ActionOutput<Name, Result>> => {
    const startedAt = Date.now();
    const invocation: AdmittedRequest = {
      id: actionId ?? randomUUID(),
      requestId: requestId ?? null,
      action: definition.name,
      admittedAt: startedAt,
      lifetime: new AbortController(),
      objective: null,
      state: { kind: "admitted" },
      evidence: null,
      progress: new RequestProgress(this.#position(), this.#tools),
      escaping: false,
      routeMark: 0,
    };
    try {
      const output = await this.#whileConnected(() => this.#run(definition, input, invocation, signal));
      this.#countMovement(definition, invocation, output.result);
      return invocation.state.kind === "admitted"
        ? output
        : this.#finishedOutput(output, invocation);
    } catch (cause) {
      const output = measured<Name, Result>(definition.name, startedAt, {
        kind: "runtime_failure",
        status: "failed",
        error: message(cause),
      });
      this.#countMovement(definition, invocation, output.result);
      return invocation.state.kind === "admitted"
        ? output
        : this.#finishedOutput(output, invocation);
    } finally {
      invocation.state = { kind: "returned" };
      invocation.lifetime.abort("Admitted request settled.");
      // A takeover settles an attempt, not the admitted call. Finish its
      // incident context here, including when disconnect outlives executor cleanup.
      if (this.#admittedRequest === invocation) {
        this.#admittedRequest = null;
        if (invocation.requestId !== null) {
          this.#precedingRequest = { requestId: invocation.requestId, completedAtMs: Date.now() };
        }
      }
    }
  };

  async #run<Name extends string, Request, Result extends ActionResult>(
    definition: Action<Name, Request, Result>,
    input: unknown,
    invocation: AdmittedRequest,
    signal?: AbortSignal,
  ): Promise<ActionOutput<Name, Result>> {
    if (this.#connection.signal.aborted) return refusal(definition.name, message(this.#connection.signal.reason));
    // Parse before taking the lock: bad arguments are not a busy bot, and a
    // rejected request must not stop the action that is legitimately running.
    let request: Request;
    try {
      request = definition.parse(input);
    } catch (cause) {
      return refusal(definition.name, outcomes.invalidArguments(cause));
    }

    // A control action stops the body's owner, an information action only
    // reads, and a concurrent action (public chat) acts without the body; none
    // needs the body, so none waits for it. The first playthrough was refused
    // eleven status reads while the reflex fought, exactly when the model most
    // needed to see health and threats.
    if (
      definition.execute &&
      (definition.execution.kind === "control" ||
        definition.execution.kind === "information" ||
        definition.execution.kind === "concurrent")
    ) {
      const execute = definition.execute;
      return measured(
        definition.name,
        Date.now(),
        await this.#execute(definition.execution, (context) => execute(request, context), signal),
      );
    }

    signal?.throwIfAborted();
    const active = this.#currentAction();
    if (active) return refusal(definition.name, outcomes.actionBusy(active.metadata));
    if (this.#admittedRequest) return refusal(definition.name, outcomes.actionBusy({
      action: this.#admittedRequest.action, startedAt: new Date(this.#admittedRequest.admittedAt).toISOString(),
    }));
    const pinnedRefusal = definition.movement === "travel" ? this.#pinned?.refusal() : null;
    if (pinnedRefusal) return refusal(definition.name, pinnedRefusal);
    invocation.escaping = definition.movement !== undefined && this.#pinned?.isPinned() === true;
    invocation.routeMark = this.#routes?.mark() ?? 0;
    this.#releaseBaseline();
    invocation.objective = request;
    invocation.evidence = () => ({ baseline: null, checkpoint: { phase: "executing" },
      completion: { kind: "event", observed: false, owes: `The ${definition.name} executor must return its observed outcome.` } });
    const observeProgress = (read: () => RequestEvidence) => {
      invocation.evidence = () => {
        const evidence = read();
        return definition.checkpointSchema
          ? { ...evidence, checkpoint: definition.checkpointSchema.parse(evidence.checkpoint) } : evidence;
      };
    };
    this.#admittedRequest = invocation;
    for (const state of this.#reflexStates.values()) invocation.progress.reflexActivity({ kind: "active", state });
    const startedAtMs = Date.now();
    const resumable = definition.execution.kind === "resumable_task";
    let execute: RequestExecution<Result> | null = null;
    const interruptions: string[] = [];
    let running = activeAction(definition.name);
    this.#state = { kind: "foreground", action: running };
    invocation.state = { kind: "running" };
    this.#ownershipChanged();
    while (true) {
      const actionSignal = signal ? AbortSignal.any([signal, running.controller.signal]) : running.controller.signal;
      let result: Result | RuntimeFailure;
      try {
        result = await this.#watchPhysics(definition.name, actionSignal, running.controller, this.#execute(
          definition.execution,
          (context) => this.#asEscapeWhenPinned(invocation, context.signal ?? this.#connection.signal, () => {
            if (execute === null) {
              if (definition.begin)
                execute = definition.begin(request, invocation.lifetime.signal, observeProgress);
              else {
                const run = definition.execute;
                execute = (attempt) => run(request, attempt);
              }
            }
            return execute({ ...context, observeProgress });
          }),
          actionSignal,
        ));
      } finally {
        if (this.#state.kind === "foreground" && this.#state.action === running) this.#state = { kind: "idle" };
        running.settle();
        running.released = true;
        this.#ownershipChanged();
      }
      const preemption = running.preemption;
      if (!preemption || this.#connection.signal.aborted) {
        return measured(definition.name, startedAtMs, result, interruptions);
      }
      const verdict = await preemption.verdict;
      if (signal?.aborted || invocation.lifetime.signal.aborted) {
        interruptions.push(preemption.reason);
        return measured(definition.name, startedAtMs, result, interruptions);
      }
      if (!resumable) return measured(definition.name, startedAtMs, result, interruptions);
      if (verdict.kind !== "resume") {
        if (verdict.kind === "return" && verdict.reason) interruptions.push(verdict.reason);
        return measured(definition.name, startedAtMs, result, interruptions);
      }
      if (invocation.lifetime.signal.aborted) return measured(definition.name, startedAtMs, result, interruptions);
      interruptions.push(preemption.reason);
      invocation.state = { kind: "resuming" };
      invocation.progress.transition("resuming");
      await this.#awaitIdle();
      if (invocation.lifetime.signal.aborted) return measured(definition.name, startedAtMs, result, interruptions);
      this.#connection.signal.throwIfAborted();
      running = activeAction(definition.name);
      this.#state = { kind: "foreground", action: running };
      invocation.state = { kind: "running" };
      invocation.progress.transition("running");
      this.#ownershipChanged();
    }
  }

  /** A pinned bot's movement action starts by leaving the water or boat, then routes as an escape until it settles. */
  async #asEscapeWhenPinned<Value>(invocation: AdmittedRequest, signal: AbortSignal, run: () => Promise<Value>): Promise<Value> {
    const escape = this.#pinnedEscape;
    if (!invocation.escaping || escape === undefined) return run();
    await escape.leave(signal);
    using _escaping = escape.routesAsEscape();
    // `await`: a `using` hold is released when the function returns, and `return run()` returns the still-pending promise.
    return await run();
  }

  /**
   * What a movement action did to the pinned watch: a success resets it, a failure counts when the route or the movement
   * itself failed (not "none usable near", a lost tool, a full inventory), and a failed escape shuts travel actions out.
   */
  #countMovement(definition: { readonly movement?: MovementUse }, invocation: AdmittedRequest, result: ActionResult | RuntimeFailure): void {
    const watch = this.#pinned;
    // Still "admitted": the request was refused before it ran (busy, bad arguments, [PINNED]), so it says nothing of the bot.
    if (!definition.movement || !watch || invocation.state.kind === "admitted") return;
    if (result.status === "succeeded") watch.recordSuccess();
    else if (result.status === "failed" && this.#routes?.failedSince(invocation.routeMark)) {
      watch.recordFailure("error" in result ? result.error : "failed");
      if (invocation.escaping) watch.escapeFailed();
    }
  }

  /** Wait for whoever holds the body to let go. Nothing else runs between their release and our claim. */
  async #awaitIdle(): Promise<void> {
    for (let holder = this.#currentAction(); holder; holder = this.#currentAction()) await holder.settled;
  }

  readonly cancelActive = (
    reason: string,
    cause: BodyAbortCause = { kind: "cancelled", by: "model" },
  ): ForegroundCancellation => {
    const abort = new BodyAbort(cause, reason);
    this.#admittedRequest?.lifetime.abort(abort);
    const active = this.#currentAction();
    if (!active) return { kind: "idle", reason };
    const { action, startedAt } = active.metadata;
    active.controller.abort(abort);
    if (this.#state.kind === "yielding") {
      // A control cancellation is final: the interrupted action is not resumed.
      this.#state.interrupted.preemption = null;
      this.#state.interrupted.controller.abort(abort);
    }
    return { kind: "cancellation_requested", action, startedAt, reason };
  };

  /** Stop the objective while allowing a reflex to finish its physical release. */
  cancelRequest(id: string, reason: string): ForegroundCancellation {
    const request = this.#admittedRequest;
    if (!request || request.id !== id) return { kind: "idle", reason };
    const abort = new BodyAbort({ kind: "cancelled", by: "model" }, reason);
    request.lifetime.abort(abort);
    request.progress.transition("stopping");
    if (this.#state.kind === "foreground") this.#state.action.controller.abort(abort);
    if (this.#state.kind === "yielding") this.#state.interrupted.controller.abort(abort);
    return { kind: "cancellation_requested", action: request.action, startedAt: new Date(request.admittedAt).toISOString(), reason };
  }

  samplePosition(discontinuity?: string): void {
    const owner = this.ownership().current;
    this.#admittedRequest?.progress.sample(this.#position(), owner !== null && owner !== this.#admittedRequest.action, discontinuity, this.#inWater());
  }

  /** Attribute a native combat resource observation only to the request active at that instant. */
  recordCombatResource(observation: CombatResourceObservation): void {
    this.#admittedRequest?.progress.combatResource(observation);
  }

  combatResourceScope(): string | null { return this.#admittedRequest?.id ?? null; }

  /** Survival states occupied right now, so a request admitted mid-state still accrues its time. */
  readonly #reflexStates = new Map<string, ReflexStateIdentity>();

  /** Attribute a survival state boundary to the request active at that instant. */
  recordReflexActivity(observation: ReflexActivityObservation): void {
    const key = reflexStateKey(observation.state);
    if (observation.kind === "left") this.#reflexStates.delete(key);
    else this.#reflexStates.set(key, observation.state);
    this.#admittedRequest?.progress.reflexActivity(observation);
  }

  recordScopedCombatResource(scope: string, observation: CombatResourceObservation): void {
    if (this.#admittedRequest?.id === scope) this.#admittedRequest.progress.combatResource(observation);
  }

  progress() { return this.#admittedRequest?.progress.snapshot() ?? null; }

  #finishedOutput<Name extends string, Result extends ActionResult>(output: ActionOutput<Name, Result>, request: AdmittedRequest): ActionOutput<Name, Result> {
    const cancellation = request.lifetime.signal.reason;
    // A runner cancel text already names the reason and what happened to the body (review V5): kept.
    const runnerCancel = cancellation instanceof Error && output.result.status === "cancelled" && "error" in output.result
      && (output.result.error ?? "").startsWith(`${cancellation.message} (`);
    if (cancellation instanceof BodyAbort && cancellation.detail.kind === "cancelled" && "kind" in output.result && output.result.kind === "runtime_failure" && !runnerCancel) {
      output = { ...output, result: { kind: "runtime_failure", status: "cancelled", error: cancellation.message } };
    }
    request.progress.sample(this.#position(), false, undefined, this.#inWater());
    const progress = request.progress.finish();
    const snapshot = this.#requestSnapshot(request, { kind: "returned" });
    // A successful executor result confirms its event contract. Current-state
    // conditions still come from the final observation and may have regressed.
    const evidence = snapshot.evidence;
    return { ...output, durationMs: progress.elapsedMs, progress, request: {
      ...snapshot,
      evidence: output.result.status === "succeeded" && evidence?.completion.kind === "event"
        ? { ...evidence, completion: { ...evidence.completion, observed: true } } : evidence,
    } };
  }

  /** Terminal for this bot: pending Mineflayer promises may never settle after end. */
  disconnect(reason: string): void {
    this.#connection.abort(new BodyAbort({ kind: "connection_lost" }, `[MINECRAFT_DISCONNECTED] ${reason}`));
    this.cancelActive(reason, { kind: "connection_lost" });
    this.#releaseBaseline();
    this.#state = { kind: "idle" };
    this.#ownershipChanged();
  }

  /** Retire old-world reflex work while an expected portal request reconciles arrival. */
  dimensionChanged(from: string, to: string): void {
    this.#releaseBaseline();
    if (this.#state.kind !== "takeover" && this.#state.kind !== "yielding") return;
    const cause = new BodyAbort({ kind: "dimension_changed", from, to }, `Dimension changed from ${from} to ${to}.`);
    let owner = this.#currentAction();
    while (owner && !owner.released) {
      owner.controller.abort(cause);
      owner = owner.predecessor;
    }
    this.#ownershipChanged();
  }

  /**
   * Reserve the body for a reflex, preempting a foreground action or a lower
   * priority reflex. Each successor awaits its predecessor's physical release.
   *
   * An idle body is claimable, which is the whole reason this exists rather
   * than a takeover expressed as an action: a reflex that only fires when
   * something else is already running is not a reflex. `work` owns the body
   * until its promise settles and is responsible for leaving the bot neutral.
   * The interrupted request stays pending until the physical claim settles.
   * Progress reporting cannot release the caller while defence owns its body.
   */

  readonly claim = <Value>(
    name: string,
    reason: string,
    work: (signal: AbortSignal) => Promise<ClaimSettlement<Value>>,
    releaseAfterAdmission?: () => void,
  ): BodyClaim<Value> => {
    if (this.#connection.signal.aborted) return { kind: "closed", cause: { kind: "connection_lost" } };
    const interrupted = this.#currentAction();
    if (
      interrupted &&
      (this.#state.kind === "yielding" || this.#state.kind === "takeover") &&
      !outranksReflex(name, interrupted.metadata.action)
    )
      return { kind: "busy", activeAction: interrupted.metadata };
    const takeover = activeAction(name);
    takeover.predecessor = interrupted;
    const cause: BodyAbortCause = { kind: "preempted", by: name };
    let settleVerdict!: (verdict: Continuation) => void;
    const verdict = new Promise<Continuation>((resolve) => {
      settleVerdict = resolve;
    });
    const settleContinuation = (result: Continuation) => {
      // A higher reflex inherits the original request's continuation. Do not
      // await that verdict here: the higher owner first needs our physical
      // release, which the finally block below settles independently.
      if (takeover.preemption) void takeover.preemption.verdict.then(settleVerdict);
      else settleVerdict(result);
    };
    if (interrupted) {
      interrupted.preemption = { reason, cause, verdict };
      this.#state = { kind: "yielding", interrupted, takeover, cause };
      interrupted.controller.abort(new BodyAbort(cause, reason));
    } else {
      this.#releaseBaseline();
      this.#state = { kind: "takeover", action: takeover };
    }
    if (this.#admittedRequest) {
      this.#admittedRequest.state = { kind: "suspended", by: name, cause };
      this.#admittedRequest.progress.transition("suspended");
    }
    this.#ownershipChanged();

    const outcome = (async () => {
      try {
        // Admission must precede release. This may terminate a navigation
        // cleanup that needs the successor to establish a landing, but cannot steer.
        let releaseFailure: { cause: unknown } | null = null;
        try {
          if (interrupted) releaseAfterAdmission?.();
        } catch (cause) {
          releaseFailure = { cause };
        }
        const settlement = await this.#whileConnected(async () => {
          if (interrupted) await interrupted.settled;
          this.#connection.signal.throwIfAborted();
          // A higher owner may already be reserved while this one releases.
          if (this.#currentAction() === takeover) this.#state = { kind: "takeover", action: takeover };
          this.#ownershipChanged();
          if (releaseFailure) throw releaseFailure.cause;
          return work(AbortSignal.any([takeover.controller.signal, this.#connection.signal]));
        });
        const aborted = takeover.controller.signal.reason;
        settleContinuation(
          aborted instanceof BodyAbort && aborted.detail.kind === "dimension_changed"
            ? { kind: "resume" }
            : settlement.continuation,
        );
        return settlement.value;
      } catch (cause) {
        const aborted = takeover.controller.signal.reason;
        settleContinuation(
          aborted instanceof BodyAbort && aborted.detail.kind === "dimension_changed"
            ? { kind: "resume" }
            : { kind: "return", reason: null },
        );
        throw cause;
      } finally {
        if (this.#state.kind === "takeover" && this.#state.action === takeover) this.#state = { kind: "idle" };
        takeover.settle();
        takeover.released = true;
        this.#ownershipChanged();
      }
    })();

    return { kind: "claimed", interrupted: interrupted?.metadata ?? null, outcome };
  };

  requestContext() {
    return {
      requestId: this.#admittedRequest?.requestId ?? null,
      preceding: this.#admittedRequest ? null : this.#precedingRequest,
    };
  }

  request(): RequestSnapshot | null {
    const request = this.#admittedRequest;
    return request ? this.#requestSnapshot(request, request.state) : null;
  }

  #requestSnapshot(request: AdmittedRequest, state: RequestState): RequestSnapshot {
    const observed = (() => {
      try { return { evidence: request.evidence?.() ?? null }; }
      catch (error) {
        // An observer failure must not erase physical execution results or
        // become an uncaught exception in the periodic persistence callback.
        return { evidence: null, observationError: error instanceof Error ? error.message : String(error) };
      }
    })();
    return {
      id: request.id,
      requestId: request.requestId,
      action: request.action,
      admittedAt: request.admittedAt,
      state,
      objective: request.objective,
      ...observed,
    };
  }

  ownership(): BodyOwnership {
    const state = this.#state;
    let releasing = state.kind === "yielding" ? state.interrupted : null;
    while (releasing?.predecessor && !releasing.predecessor.released) releasing = releasing.predecessor;
    return {
      current:
        state.kind === "idle"
          ? (this.#baseline?.name ?? null)
          : state.kind === "yielding"
            ? releasing!.metadata.action
            : state.action.metadata.action,
      reserved: state.kind === "yielding" ? state.takeover.metadata.action : null,
      transfer:
        state.kind === "yielding"
          ? {
              from: releasing!.metadata.action,
              to: state.takeover.metadata.action,
              cause: state.cause,
            }
          : null,
      connected: !this.#connection.signal.aborted,
    };
  }

  onOwnershipChange(listener: () => void): () => void {
    this.#ownershipListeners.add(listener);
    return () => {
      this.#ownershipListeners.delete(listener);
    };
  }

  /** Idle stabilization is an owner too; admission releases it synchronously. */
  holdBaseline(name: string, release: () => void): boolean {
    if (this.#state.kind !== "idle" || this.#connection.signal.aborted) return false;
    if (this.#baseline?.name === name) return true;
    this.#releaseBaseline();
    this.#baseline = { name, release };
    this.#ownershipChanged();
    return true;
  }

  releaseBaseline(name: string): void {
    if (this.#baseline?.name !== name) return;
    this.#releaseBaseline();
    this.#ownershipChanged();
  }

  #releaseBaseline(): void {
    const baseline = this.#baseline;
    this.#baseline = null;
    baseline?.release();
  }

  #ownershipChanged(): void {
    for (const listener of this.#ownershipListeners) listener();
  }

  status(): ActionRunnerStatus {
    return {
      busy: this.#state.kind !== "idle" || this.#admittedRequest !== null,
      activeAction: this.#currentAction()?.metadata ?? null,
      owner: this.#state.kind,
    };
  }

  async #execute<Result extends ActionResult>(
    execution: ActionExecution,
    run: RequestExecution<Result>,
    signal?: AbortSignal,
  ): Promise<Result | RuntimeFailure> {
    const context = { signal: signal ? AbortSignal.any([signal, this.#connection.signal]) : this.#connection.signal };
    try {
      context.signal?.throwIfAborted();
      const execute = async () => {
        if (execution.kind === "task" || execution.kind === "resumable_task") await execution.prepare?.(context.signal);
        context.signal.throwIfAborted();
        return runWithHighlighter(this.#highlighter?.scope(context.signal) ?? { enabled: false, signal: context.signal }, () =>
          run(context),
        );
      };
      // Ordinary cancellation still waits for physical cleanup. Only a lost
      // connection can settle independently: that bot can never act again.
      return await execute();
    } catch (cause) {
      return {
        kind: "runtime_failure",
        status: this.#connection.signal.aborted ? "failed" : context.signal.aborted ? "cancelled" : "failed",
        error: outcomes.executionError(this.#connection.signal.aborted ? this.#connection.signal.reason : cause),
      };
    }
  }

  /** End every kind of pending work with this connection, including a reflex verdict. */
  async #whileConnected<Value>(work: () => Promise<Value>): Promise<Value> {
    this.#connection.signal.throwIfAborted();
    let rejectDisconnected!: (reason: unknown) => void;
    const disconnected = new Promise<never>((_resolve, reject) => {
      rejectDisconnected = reject;
    });
    const onDisconnect = () => rejectDisconnected(this.#connection.signal.reason);
    this.#connection.signal.addEventListener("abort", onDisconnect, { once: true });
    try {
      return await Promise.race([work(), disconnected]);
    } finally {
      this.#connection.signal.removeEventListener("abort", onDisconnect);
    }
  }
}
