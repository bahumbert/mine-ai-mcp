import { setTimeout as sleep } from "node:timers/promises";
import { describeStep } from "./actions.ts";
import { Body, HUMAN_TYPING, type TypingPace } from "./body.ts";
import type { ChatLine, KnownPlace, Mind, Objective, StepRecord, WorkDecision } from "./mind.ts";
import type { Persona } from "./persona.ts";
import type { BotRuntime, BotSnapshot, PlayerMessage } from "./runtime-client.ts";
import { runStep, type SkillResult } from "./skills.ts";

/** How often the agent checks for new chat. */
const DEFAULT_POLL_MS = 500;
/** Chat lines kept as conversational context. */
const HISTORY_LINES = 12;
/** Known places shown to the models; the oldest is forgotten first. */
const KNOWN_PLACES = 8;
/** Steps kept per objective for the work tier. */
const STEP_MEMORY = 20;
/** Outcomes of its own objectives remembered for the goal tier. */
const OWN_MEMORY = 5;
/** Unusable model replies in a row before an objective is dropped. */
const MAX_BAD_REPLIES = 2;

export interface AgentOptions {
  readonly persona: Persona;
  readonly runtime: BotRuntime;
  readonly mind: Mind;
  /**
   * Usernames of the other agents. Never answered in Phase 1, so two bots cannot talk each other into an endless
   * loop; real bot-to-bot conversation (with explicit start/end) is Phase 4.
   */
  readonly otherAgents: readonly string[];
  readonly log: (line: string) => void;
  readonly pollMs?: number;
  /** Chat typing pace; tests use instant typing. */
  readonly typing?: TypingPace;
}

/** One objective on the stack and what was done for it. */
interface Work {
  readonly objective: Objective;
  readonly steps: StepRecord[];
  taken: number;
  badReplies: number;
  /** Aborts the step running now: the objective is set aside or stopped, the agent goes on. */
  step: AbortController | null;
}

/**
 * One character (ADR-008, ADR-011). Every message it hears goes to the chat tier, which answers in character and
 * decides whether to take something on. What it takes on goes on top of a stack of objectives (an order sets aside
 * what was below, which resumes afterwards); a work loop asks the model for one step at a time towards the top
 * objective and runs it. With nothing on the stack, the character picks objectives towards its own goal, at most
 * `settings.goalCallsPerMinute` model calls a minute. Code decides nothing else (Rule #0): it runs skills.
 */
export class Agent {
  private readonly body: Body;
  private readonly history: ChatLine[] = [];
  private readonly places: KnownPlace[] = [];
  private readonly stack: Work[] = [];
  private readonly lately: string[] = [];
  private restUntil = 0;
  private nextGoalCall = 0;
  private wake: (() => void) | null = null;
  private runSignal: AbortSignal = new AbortController().signal;

  constructor(private readonly options: AgentOptions) {
    this.body = new Body(options.runtime, options.log, options.typing ?? HUMAN_TYPING);
  }

  get activity(): string {
    const top = this.stack.at(-1);
    if (top === undefined) return "idle";
    const whose = top.objective.requester === null ? "your own goal" : `for ${top.objective.requester}`;
    const paused = this.stack.slice(0, -1).map((work) => JSON.stringify(work.objective.text));
    return `${JSON.stringify(top.objective.text)} (${whose})${paused.length === 0 ? "" : `; set aside: ${paused.join(", ")}`}`;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.runSignal = signal;
    signal.addEventListener("abort", () => this.wake?.(), { once: true });
    // The runtime keeps chat from before this brain started; answering it now would be confusing.
    await this.options.runtime.readMessages();
    await this.keepSettings(await this.options.runtime.status());
    this.options.log(`listening as ${this.options.persona.username} (${this.options.persona.stance})`);
    const working = this.workLoop(signal);
    try {
      while (!signal.aborted) {
        for (const message of await this.options.runtime.readMessages()) {
          await this.handle(message).catch((error: unknown) => this.options.log(`could not handle "${message.message}": ${String(error)}`));
        }
        await sleep(this.options.pollMs ?? DEFAULT_POLL_MS, undefined, { signal }).catch(() => undefined);
      }
    } finally {
      this.stopAll();
      await working;
    }
  }

  /** Reacts to one incoming message. Returns once the reply is queued, not spoken, so "stop" is never stuck behind work. */
  async handle(message: PlayerMessage): Promise<void> {
    const heardAt = Date.now();
    const { persona, mind, log } = this.options;
    this.remember(message.username, message.message);
    if (!this.listensTo(message.username)) return;
    let decision;
    try {
      const snapshot = await this.options.runtime.status();
      decision = await mind.chat({ persona, message, history: this.history.slice(0, -1), snapshot, activity: this.activity, places: [...this.places] }, this.runSignal);
    } catch (error) {
      log(`chat tier failed on "${message.message}": ${String(error)}`);
      return;
    }
    const { route } = decision;
    const request = route === "act" ? ` ${JSON.stringify(decision.request)}` : "";
    log(`${message.username}: ${JSON.stringify(message.message)} -> ${route}${request}, say ${JSON.stringify(decision.say)}`);
    if (route === "ignore") return;
    this.speak(decision.say, heardAt);
    if (route === "stop") {
      this.stopAll();
      this.restUntil = Date.now() + persona.settings.restAfterStopSeconds * 1_000;
    }
    if (route === "act") this.take({ text: decision.request, requester: message.username });
  }

  /**
   * Who the agent hears at all; whether a message is meant for it is the chat tier's call (no name needed).
   * Other agents are never answered (see {@link AgentOptions.otherAgents}).
   */
  private listensTo(username: string): boolean {
    const { persona, otherAgents } = this.options;
    const speaker = username.toLowerCase();
    if (otherAgents.some((name) => name.toLowerCase() === speaker)) return false;
    return persona.listensTo.length === 0 || persona.listensTo.some((name) => name.toLowerCase() === speaker);
  }

  /** Puts something the character took on above what it was doing, which is set aside (its step stopped) and resumes later. */
  private take(objective: Objective): void {
    const current = this.stack.at(-1);
    current?.step?.abort();
    this.stack.push({ objective, steps: [], taken: 0, badReplies: 0, step: null });
    this.wake?.();
  }

  /** The work loop: one model decision and one step at a time for the top objective; own goal when idle. */
  private async workLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const work = this.stack.at(-1);
      try {
        if (work !== undefined) await this.advance(work);
        else if (!(await this.pickOwnObjective())) await this.idle(this.options.pollMs ?? DEFAULT_POLL_MS);
      } catch (error) {
        if (signal.aborted) break;
        this.options.log(`work loop error: ${String(error)}`);
        await this.idle(this.options.pollMs ?? DEFAULT_POLL_MS);
      }
    }
  }

  /** Asks the goal tier for the next objective of the character's own goal; false when there is none to pick now. */
  private async pickOwnObjective(): Promise<boolean> {
    const { persona, mind, runtime, log } = this.options;
    if (persona.goal === undefined || Date.now() < this.restUntil) return false;
    if (!(await this.waitForGoalBudget())) return true;
    const text = await mind.chooseObjective({ persona, snapshot: await runtime.status(), places: [...this.places], lately: [...this.lately] }, this.runSignal);
    // An order that arrived while it was thinking comes first; its own idea is dropped, it will think again.
    if (this.stack.length > 0 || Date.now() < this.restUntil) return true;
    log(`own objective: ${JSON.stringify(text)}`);
    this.stack.push({ objective: { text, requester: null }, steps: [], taken: 0, badReplies: 0, step: null });
    return true;
  }

  /** Takes one step towards `work`: one model call, then the chosen skill. */
  private async advance(work: Work): Promise<void> {
    const { persona, mind, runtime, log } = this.options;
    if (work.objective.requester === null && !(await this.waitForGoalBudget())) return;
    if (this.stack.at(-1) !== work) return;
    const snapshot = await runtime.status();
    await this.keepSettings(snapshot);
    let decision: WorkDecision;
    try {
      const paused = this.stack.slice(0, -1).map((below) => below.objective);
      decision = await mind.next({ persona, objective: work.objective, snapshot, places: [...this.places], steps: [...work.steps], paused }, this.runSignal);
      work.badReplies = 0;
    } catch (error) {
      if (this.runSignal.aborted) return;
      work.badReplies += 1;
      log(`work tier failed on ${JSON.stringify(work.objective.text)}: ${String(error)}`);
      if (work.badReplies >= MAX_BAD_REPLIES) this.finish(work, "failed", "could not work out what to do next");
      return;
    }
    // Set aside or stopped while it was thinking: it thinks again once the objective is back on top.
    if (this.stack.at(-1) !== work) return;
    if (decision.kind === "done") return this.finish(work, "done", decision.summary);
    if (decision.kind === "give_up") return this.finish(work, "failed", decision.reason);
    if (work.taken >= persona.settings.maxStepsPerObjective) return this.finish(work, "failed", `still not done after ${work.taken} steps`);
    work.taken += 1;
    const label = describeStep(decision.step);
    log(`step ${work.taken} for ${JSON.stringify(work.objective.text)}: ${label}${decision.thought === "" ? "" : ` (${decision.thought})`}`);
    const controller = new AbortController();
    work.step = controller;
    let result: SkillResult;
    try {
      result = await runStep(decision.step, {
        runtime,
        body: this.body,
        signal: AbortSignal.any([controller.signal, this.runSignal]),
        requester: work.objective.requester ?? undefined,
        style: persona.style,
        remember: (place) => this.learnPlace(place),
      });
    } catch (error) {
      result = { status: "failed", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      work.step = null;
    }
    const record: StepRecord = result.status === "stopped"
      ? { step: label, outcome: "interrupted", detail: "set aside for something more urgent, or stopped" }
      : { step: label, outcome: result.status, detail: result.detail };
    work.steps.push(record);
    if (work.steps.length > STEP_MEMORY) work.steps.splice(0, work.steps.length - STEP_MEMORY);
    log(`  -> ${record.outcome}: ${record.detail}`);
  }

  /** Ends an objective: an order is reported in character; its own objectives are remembered for the goal tier. */
  private finish(work: Work, outcome: "done" | "failed", detail: string): void {
    const index = this.stack.indexOf(work);
    if (index >= 0) this.stack.splice(index, 1);
    const { objective } = work;
    this.options.log(`objective ${JSON.stringify(objective.text)} (${objective.requester ?? "own goal"}): ${outcome} (${detail})`);
    if (objective.requester === null) {
      this.lately.push(`${objective.text}: ${outcome} (${detail})`);
      if (this.lately.length > OWN_MEMORY) this.lately.splice(0, this.lately.length - OWN_MEMORY);
      return;
    }
    void this.narrate(objective.text, outcome, detail);
  }

  /**
   * Paces own-goal thinking (ADR-011): waits until the next call is allowed. False when an order arrived meanwhile
   * (orders and chat are never held back).
   */
  private async waitForGoalBudget(): Promise<boolean> {
    const interval = 60_000 / this.options.persona.settings.goalCallsPerMinute;
    while (Date.now() < this.nextGoalCall) {
      if (this.runSignal.aborted || this.stack.some((work) => work.objective.requester !== null)) return false;
      await this.idle(Math.min(this.nextGoalCall - Date.now(), this.options.pollMs ?? DEFAULT_POLL_MS));
    }
    if (this.stack.some((work) => work.objective.requester !== null)) return false;
    this.nextGoalCall = Date.now() + interval;
    return true;
  }

  /** Sleeps until `ms` pass, something is taken on, or the agent stops. */
  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
      if (this.runSignal.aborted) done();
    });
  }

  /**
   * Settings the runtime keeps (ADR-011: preferences are settings, not code paths). Checked from each snapshot because
   * the runtime resets its survival policy on death and dimension change.
   */
  private async keepSettings(snapshot: BotSnapshot): Promise<void> {
    const wanted = this.options.persona.settings.digStraightDown;
    if (snapshot.policy === null || snapshot.policy.digStraightDown === wanted) return;
    const applied = await this.options.runtime.setDigStraightDown(wanted, snapshot.policy.revision).catch(() => false);
    this.options.log(`${wanted ? "may" : "never"} dig straight down: ${applied ? "set" : "not set yet"}`);
  }

  private learnPlace(place: KnownPlace): void {
    this.options.log(`known place: ${place.name} (${place.detail})`);
    this.places.push(place);
    if (this.places.length > KNOWN_PLACES) this.places.splice(0, this.places.length - KNOWN_PLACES);
  }

  /** Has the chat tier tell the players how an order ended. */
  private async narrate(objective: string, outcome: "done" | "failed", detail: string): Promise<void> {
    if (this.runSignal.aborted) return;
    try {
      const line = await this.options.mind.narrate({ persona: this.options.persona, objective, outcome, detail, history: this.history }, this.runSignal);
      this.speak(line);
    } catch (error) {
      this.options.log(`narration failed: ${String(error)}`);
    }
  }

  /** "stop": everything on the stack ends, its own goal included. */
  private stopAll(): void {
    for (const work of this.stack) work.step?.abort();
    this.stack.length = 0;
    this.wake?.();
  }

  /** `since`: when the message being answered was heard (thinking time counts as typing time). */
  private speak(text: string, since = Date.now()): void {
    if (text.trim() === "") return;
    this.remember(this.options.persona.username, text);
    this.body.say(text, since).catch((error: unknown) => this.options.log(`say failed: ${String(error)}`));
  }

  private remember(speaker: string, text: string): void {
    this.history.push({ speaker, text });
    if (this.history.length > HISTORY_LINES) this.history.splice(0, this.history.length - HISTORY_LINES);
  }
}
