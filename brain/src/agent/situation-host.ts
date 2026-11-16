// Serial situation decisions beside the work loop, with captured work and detached late answers.
import { describeStep, SKILL_TRAITS } from "../actions.ts";
import type { AgentOptions } from "../agent.ts";
import type { BrainEvent } from "../brain-log.ts";
import { ModelUnavailable } from "../chat-model.ts";
import type { KnownPlace, WorkDecision, WorkInput } from "../mind.ts";
import { modelRetryDelay } from "../model-wait.ts";
import { monotonicNow } from "../monotonic-clock.ts";
import { personaSkills } from "../persona.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";
import { underCover } from "../shelter/spot.ts";
import { sleepMs } from "../wall-timers.ts";
import { situationView } from "./situation-options.ts";
import { SituationWatch, type SituationHost, type SituationInfo, type SituationKind } from "./situations.ts";
import { pushSituation, topWork } from "./stack.ts";
import type { Work } from "./work.ts";

export interface DecisionsHost {
  readonly options: AgentOptions;
  readonly stack: Work[];
  places(): readonly KnownPlace[];
  runSignal(): AbortSignal;
  wake(): void;
  journal(event: BrainEvent): void;
  narrate(order: Work, line: string): void;
}

interface PendingDecision {
  readonly generation: number;
  readonly info: SituationInfo;
  readonly running: Work | undefined;
  readonly runningStep: Work["running"];
  readonly ordinary: Work | undefined;
  readonly order: Work | null;
  readonly input: WorkInput;
  readonly controller: AbortController;
}

/** The event objective tells the model what it is deciding, without choosing its response. */
function objectiveText(info: SituationInfo): string {
  if (info.kind === "night") return "night has fallen: decide what to do until day";
  if (info.kind === "respawn") return "you died and respawned: decide what to do now";
  return `your health is low (${info.health}/20): decide what to do now`;
}

export class SituationDecisions implements SituationHost {
  readonly watch: SituationWatch;
  private readonly queue: PendingDecision[] = [];
  private active: PendingDecision | null = null;
  private generation = 0;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly host: DecisionsHost) { this.watch = new SituationWatch(this); }
  get persona() { return this.host.options.persona; }
  get random() { return this.host.options.random ?? Math.random; }
  status(): Promise<BotSnapshot> { return this.host.options.runtime.status(); }
  underCover(at: Position): Promise<boolean> { return underCover(this.host.options.runtime, at); }

  /** Observations never hold up the caller's work or chat handling. */
  observe(snapshot: BotSnapshot): void {
    if (this.host.runSignal().aborted) return;
    void this.watch.observe(snapshot).catch((error: unknown) => this.host.options.log(`situation observation failed: ${String(error)}`));
  }
  poll(): Promise<void> { return this.host.runSignal().aborted ? Promise.resolve() : this.watch.poll(); }

  busy(): readonly SituationKind[] {
    return [...new Set([
      ...this.queue.map(({ info }) => info.kind),
      ...(this.active === null ? [] : [this.active.info.kind]),
      ...this.host.stack.flatMap((work) => work.situation === null ? [] : [work.situation.info.kind]),
    ])];
  }

  answeringNight(): "night" | "for now" | null {
    const step = this.host.stack.at(-1)?.running?.step;
    if (step === undefined || SKILL_TRAITS[step.skill].answersNight !== true) return null;
    return step.skill === "dig_shelter" && step.minutes !== undefined ? "for now" : "night";
  }

  /** Waiters belong to decisions, never to the lifetime of a detached model request. */
  settled(): Promise<void> {
    if (this.active === null && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.add(resolve));
  }

  raise(info: SituationInfo, snapshot: BotSnapshot): void {
    if (this.host.runSignal().aborted || this.busy().includes(info.kind)) return;
    const running = this.host.stack.at(-1);
    const runningStep = running?.running ?? null;
    const ordinary = topWork(this.host.stack);
    const order = ordinary?.objective.requester != null ? ordinary : null;
    const view = this.view(info, snapshot, running, ordinary, false);
    const label = runningStep === null ? null : describeStep(runningStep.step);
    const input: WorkInput = {
      persona: this.persona, objective: { text: objectiveText(info), requester: null, purpose: null }, snapshot,
      places: this.host.places(), areas: [], steps: [], paused: this.host.stack.map((work) => work.objective),
      situation: { info, view, objective: running?.objective ?? null, running: label, deciding: true },
    };
    this.queue.push({ generation: ++this.generation, info, running, runningStep, ordinary, order, input, controller: new AbortController() });
    this.host.journal({ kind: "situation", event: "raised", situation: info.kind, text: info.cause, options: view.options.map(({ label }) => label), weigh: view.weigh, running: label, setAside: running === undefined ? null : { text: running.objective.text, requester: running.objective.requester } });
    this.startNext();
  }

  /** One request at a time; a detached request's completion cannot release a newer request's waiters. */
  private startNext(): void {
    if (this.active !== null) return;
    const pending = this.queue.shift();
    if (pending === undefined) {
      for (const resolve of this.waiters) resolve();
      this.waiters.clear();
      return;
    }
    this.active = pending;
    void this.decide(pending).catch((error: unknown) => this.host.options.log(`situation decision failed: ${String(error)}`)).finally(() => {
      if (!this.isCurrent(pending)) return;
      this.active = null;
      this.startNext();
    });
  }

  private isCurrent(pending: PendingDecision): boolean { return this.active?.generation === pending.generation; }

  /** Unavailability preserves the event; two unusable decisions leave the running work alone. */
  private async decide(pending: PendingDecision): Promise<void> {
    const signal = AbortSignal.any([pending.controller.signal, this.host.runSignal()]);
    let failures = 0;
    let unusable = 0;
    while (this.isCurrent(pending) && !signal.aborted) {
      try {
        const answer = await this.host.options.mind.next(pending.input, signal);
        if (this.isCurrent(pending) && !signal.aborted) this.apply(pending, answer);
        return;
      } catch (error) {
        if (!this.isCurrent(pending) || signal.aborted) return;
        if (error instanceof ModelUnavailable) {
          const delay = modelRetryDelay(++failures, this.host.options.pollMs ?? 500, this.random);
          this.host.options.log(`situation model unavailable (${failures} times): ${error.message}`);
          await sleepMs(delay, signal).catch(() => undefined);
        } else if (++unusable >= 2) {
          this.decided(pending, "no usable answer");
          return;
        }
      }
    }
  }

  private apply(pending: PendingDecision, answer: WorkDecision): void {
    if (answer.kind !== "step") { this.decided(pending, "carried on"); return; }
    if (topWork(this.host.stack) !== pending.ordinary) {
      this.ended(pending.info, "the work changed");
      return;
    }
    pushSituation(this.host.stack, { info: pending.info, order: pending.order, told: false }, pending.input.objective.text, answer);
    this.decided(pending, describeStep(answer.step));
    pending.runningStep?.controller.abort();
    this.host.wake();
  }

  private decided(pending: PendingDecision, answer: string): void {
    this.host.journal({ kind: "situation", event: "decided", situation: pending.info.kind, text: pending.info.cause, answer, latencyMs: Math.round(monotonicNow() - pending.info.raisedAt) });
  }
  private ended(info: SituationInfo, detail: string): void {
    this.host.journal({ kind: "situation", event: "ended", situation: info.kind, text: info.cause, detail });
  }

  /** Watch endings detach queued and active decisions without waiting for their transport. */
  end(kind: SituationKind, detail: string, _snapshot: BotSnapshot): void {
    this.dropDecisions((pending) => pending.info.kind === kind, detail);
  }

  private dropDecisions(ends: (pending: PendingDecision) => boolean, detail: string): void {
    const dropped = this.queue.filter(ends);
    for (const pending of dropped) this.queue.splice(this.queue.indexOf(pending), 1);
    if (this.active !== null && ends(this.active)) { dropped.push(this.active); this.active = null; }
    for (const pending of dropped) { pending.controller.abort(); this.ended(pending.info, detail); }
    this.startNext();
  }

  /** A stop also invalidates held cover and status reads, before they can raise another event. */
  stopFor(_speaker: string | null): void {
    this.watch.invalidate();
    this.dropDecisions(() => true, "stopped");
  }

  /** The lifecycle owner calls this when a pushed event leaves the stack. */
  closed(work: Work, detail: string): void {
    if (work.situation !== null) this.ended(work.situation.info, detail);
  }

  laterInput(work: Work, snapshot: BotSnapshot): WorkInput["situation"] {
    if (work.situation === null) return undefined;
    const below = this.host.stack.slice(0, this.host.stack.indexOf(work));
    const running = below.at(-1);
    return { info: work.situation.info, view: this.view(work.situation.info, snapshot, running, topWork(below), true), objective: running?.objective ?? null, running: work.running === null ? null : describeStep(work.running.step), deciding: false };
  }

  private view(info: SituationInfo, snapshot: BotSnapshot, running: Work | undefined, ordinary: Work | undefined, pushed: boolean) {
    return situationView({ info, snapshot, places: this.host.places(), objective: running?.objective ?? null, ordinary: ordinary?.objective ?? null, boldness: this.persona.boldness, skills: personaSkills(this.persona), pushed, deaths: this.watch.deaths(), night: this.watch.nightActive(), timeOfDay: this.watch.timeOfDay() });
  }
}
