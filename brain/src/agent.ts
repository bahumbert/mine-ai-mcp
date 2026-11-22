import { sleepMs } from "./wall-timers.ts";
import type { Step } from "./actions.ts";
import { Body, HUMAN_TYPING } from "./body.ts";
import { BodyDown, bodyDownState, bodyDownWait } from "./body-down.ts";
import { ModelUnavailable } from "./chat-model.ts";
import { ConversationController } from "./conversation/controller.ts";
import type { Conversation } from "./conversation/state.ts";
import { TillFacts } from "./farming/site.ts";
import { Inbox, burstLimitsOf, type Heard } from "./inbox.ts";
import { MAX_ERROR_WAIT_MS, modelRetryDelay } from "./model-wait.ts";
import { monotonicNow } from "./monotonic-clock.ts";
import type { ChatLine, Objective } from "./mind.ts";
import { AgentRelations } from "./relations/agent-relations.ts";
import { itemsYieldedBy } from "./relations/chat-trade.ts";
import { describeHandoff, isGiveTo, type Handoff } from "./relations/handoff.ts";
import { OwnWork } from "./relations/own-work.ts";
import { TradeAsks } from "./relations/trading.ts";
import type { BotSnapshot, PlayerMessage } from "./runtime-client.ts";
import { loopVerdict } from "./step-loop-rules.ts";
import { WhoWasNamed } from "./who-was-named.ts";
import { AgentMemory } from "./agent/agent-memory.ts";
import type { AgentOptions } from "./agent/agent-options.ts";
import { handleLine, type HandleHost } from "./agent/chat-orders.ts";
import { takeMessage, type TalkState } from "./agent/chat-routing.ts";
import { ConversationLook } from "./agent/conversation-look.ts";
import { FailedSteps } from "./agent/failed-steps.ts";
import { GameFacts } from "./agent/game-facts.ts";
import { opportunitiesFor } from "./agent/house-opportunities.ts";
import { AgentNarration } from "./agent/narration.ts";
import { SituationDecisions } from "./agent/situation-host.ts";
import { neededWork, stopAll, stopWorkOf, topWork } from "./agent/stack.ts";
import { StepGuards } from "./agent/step-guards.ts";
import { StepRunner } from "./agent/step-runner.ts";
import { createRelations, createTalks, type TalkSetupHost } from "./agent/talk-setup.ts";
import { drawGoal, handoffStep, partners, socialiseStep, tickRelations, tradeStep, type TradeWorkHost } from "./agent/trade-work.ts";
import { decideStep, type DecideStepHost } from "./agent/decide-step.ts";
import { newWork, type Work } from "./agent/work.ts";

/** How often the agent checks for new chat. */
const DEFAULT_POLL_MS = 500;
const STARTUP_RETRY_MS = 10_000;
/** Chat lines kept as conversational context. */
const HISTORY_LINES = 12;
/** Chances of the likeliest activities kept in the brain log with each own objective. */
const TOP_CHANCES = 5;

export type { AgentOptions };

/**
 * One character (ADR-008, ADR-011). Every message it hears goes to the chat tier, which answers in character and
 * decides whether to take something on. What it takes on goes on top of a stack of objectives (an order sets aside
 * what was below, which resumes afterwards); a work loop asks the model for one step at a time towards the top
 * objective and runs it. With nothing on the stack, the character picks objectives towards its own goal, at most
 * `settings.goalCallsPerMinute` model calls a minute. Code decides nothing else (Rule #0): it runs skills.
 */
export class Agent {
  private readonly body: Body;
  /** What it hears, before the chat tier reads it: quick lines of one player are one message. */
  private readonly inbox: Inbox;
  private readonly history: ChatLine[] = [];
  /** Whom each player's lines named last: a line naming nobody is read as following the one that did. */
  private readonly whoWasNamed: WhoWasNamed;
  private readonly soil: TillFacts;
  /** What it knows and keeps across restarts: places, farms, protected areas, its own outcomes, activity time, the unfinished house. */
  private readonly memory: AgentMemory;
  /** When each player (lower case) last said anything: a follow they asked for ends after a long silence. */
  private readonly lastHeard = new Map<string, number>();
  /** Game facts learnt from the runtime, kept for the session: block tags by name, foods seen, how items are got. */
  private readonly facts: GameFacts;
  private readonly stack: Work[] = [];
  /** Its last own objective, when it failed (the goal tier sends it back once if chosen again as it was). */
  private lastFailed: { readonly objective: string; readonly reason: string } | null = null;
  private readonly failedSteps = new FailedSteps();
  /** What the chat routing and the handling of a line read from this agent. */
  private readonly chatHost: HandleHost;
  /** What the talking and trading work reads from this agent. */
  private readonly tradeHost: TradeWorkHost;
  /** What the work tier's decision reads from this agent. */
  private readonly decideHost: DecideStepHost;
  /** Runs the step the model chose and keeps what it did. */
  private readonly runner: StepRunner;
  /** The goal tier's pace. */
  private readonly guards: StepGuards;
  private readonly narration: AgentNarration;
  private readonly situations: SituationDecisions;
  private restUntil = 0;
  private wake: (() => void) | null = null;
  private runSignal: AbortSignal = new AbortController().signal;
  /** Calls of any tier in a row that found the model server away (reset by any answer): sets how long the next wait is. */
  private modelFailures = 0;
  /** The work loop showed "my body is down…" and no call has gone through since (see {@link workLoop}). */
  private bodyDownShown = false;
  /** Wakes the chat loop when a line arrives (it sleeps until the burst window of the last one ends). */
  private wakeChat: (() => void) | null = null;

  /** Its conversations; null when the brain runs without them. */
  private readonly talks: ConversationController | null;
  /** Its relations and trades (spec 2026-10-19-relations-trading-design); null when `settings.relations.enabled` is false. */
  private readonly relations: AgentRelations | null;
  /** What the steps and hand-offs explain in the bag: their yields and own-work flag, for the relations tick and one more (relations/own-work.ts). */
  private readonly own = new OwnWork();
  /** What an own objective could not get and who refused to trade it, for ten minutes (relations/trading.ts). */
  private readonly asks = new TradeAsks();
  /** When this agent started (wall clock): the window of trading's share of the time begins here, so a restart starts it again. */
  private readonly startedAt = Date.now();
  /** Who is online, where players stood at the last look, who was a member before their line. */
  private readonly state: TalkState = { onlineNames: [], lastLook: null, noPositionSince: new Map(), memberBeforeLine: new Map() };
  /** The background look that keeps conversations going. */
  private readonly conversationLook: ConversationLook;

  constructor(private readonly options: AgentOptions) {
    this.soil = options.soil ?? new TillFacts();
    this.body = new Body(options.runtime, options.log, options.typing ?? HUMAN_TYPING);
    this.facts = new GameFacts(options.runtime, options.log);
    this.memory = new AgentMemory(options, this.body);
    this.narration = new AgentNarration({ options, stack: this.stack, history: this.history, runSignal: () => this.runSignal, speak: (line, whisperTo) => void this.speak(line, undefined, undefined, whisperTo) });
    this.situations = new SituationDecisions({ options, stack: this.stack, places: () => this.memory.knownPlaces(), runSignal: () => this.runSignal, wake: () => this.wake?.(), journal: (event) => options.journal?.(event), narrate: (work, line) => { void this.narration.narrate(work.objective.text, "event", line, work.whisperTo); } });
    this.guards = new StepGuards({
      options,
      pollMs: options.pollMs ?? DEFAULT_POLL_MS,
      runSignal: () => this.runSignal,
      top: () => topWork(this.stack),
      idle: (ms) => this.idle(ms),
      interrupted: () => this.stack.at(-1)?.situation != null,
    });
    this.inbox = new Inbox(options.persona.settings.chatBurstMs, burstLimitsOf(options.persona.settings.chat));
    const setup: TalkSetupHost = { options, body: this.body, inbox: this.inbox, history: this.history, stack: this.stack, state: this.state, takeHandoff: (h) => this.takeHandoff(h), speak: (text, since, to, whisperTo, shout) => this.speak(text, since, to, whisperTo, shout), memorize: (memory) => this.memory.memorize(memory) };
    this.relations = createRelations(setup);
    this.talks = createTalks(setup, this.relations);
    this.whoWasNamed = new WhoWasNamed(options.persona.username, () => options.otherAgents.names());
    this.conversationLook = new ConversationLook({ options, talks: this.talks, state: this.state, memory: this.memory, stack: this.stack, lastFailed: () => this.lastFailed, activity: () => this.activity, runSignal: () => this.runSignal });
    this.chatHost = {
      options,
      history: this.history,
      inbox: this.inbox,
      areas: this.memory.areas,
      talks: this.talks,
      relations: this.relations,
      state: this.state,
      whoWasNamed: this.whoWasNamed,
      lastHeard: this.lastHeard,
      stack: this.stack,
      asks: this.asks,
      activity: () => this.activity,
      knownPlaces: () => this.memory.knownPlaces(),
      orderOnTop: () => (topWork(this.stack)?.objective.requester ?? null) !== null,
      openOrdersOf: (name) => this.openOrdersOf(name),
      stopAndRest: (speaker) => this.stopAndRest(speaker),
      modelFailed: (error) => this.modelFailed(error),
      resetModelFailures: () => { this.modelFailures = 0; },
      runSignal: () => this.runSignal,
      remember: (speaker, text) => this.remember(speaker, text),
      annotate: (line, to) => this.annotate(line, to),
      speak: (text, since, to, whisperTo, shout) => this.speak(text, since, to, whisperTo, shout),
      take: (objective, whisperTo, duringTrade) => this.take(objective, whisperTo, duringTrade),
      queue: (objective, whisperTo, duringTrade) => this.queue(objective, whisperTo, duringTrade),
    };
    this.tradeHost = {
      options, body: this.body, memory: this.memory, stack: this.stack, talks: this.talks, relations: this.relations, own: this.own, asks: this.asks,
      startedAt: () => this.startedAt, lastHeard: this.lastHeard, state: this.state,
      lastFailed: () => this.lastFailed,
      activity: () => this.activity,
      runSignal: () => this.runSignal,
      journalState: (step) => this.journalState(step),
      finish: (work, outcome, detail) => this.finish(work, outcome, detail),
    };
    this.decideHost = { options, stack: this.stack, memory: this.memory, failedSteps: this.failedSteps, settled: () => this.situations.settled(), laterInput: (work, snapshot) => this.situations.laterInput(work, snapshot), runSignal: () => this.runSignal, resetModelFailures: () => { this.modelFailures = 0; }, finish: (work, outcome, detail) => this.finish(work, outcome, detail) };
    this.runner = new StepRunner({
      options,
      body: this.body,
      memory: this.memory,
      facts: this.facts,
      failedSteps: this.failedSteps,
      soil: this.soil,
      lastHeard: this.lastHeard,
      relations: this.relations,
      progress: (work, fact) => this.narration.progress(work, fact),
      journalState: (step) => this.journalState(step),
      runSignal: () => this.runSignal,
      neededWork: (work) => neededWork(this.stack, work),
      observe: (snapshot) => this.situations.observe(snapshot),
      startStep: (work, controller, step) => this.startStep(work, controller, step),
      endStep: (work, controller) => this.endStep(work, controller),
    });
  }

  /** The conversation it is in now, if any. */
  get conversation(): Conversation | null {
    return this.talks?.current ?? null;
  }

  get activity(): string {
    const top = this.stack.at(-1);
    if (top === undefined) return "idle";
    const whose = top.situation !== null ? "an event" : top.objective.requester === null ? "your own goal" : `for ${top.objective.requester}`;
    const paused = this.stack.slice(0, -1).map((work) => JSON.stringify(work.objective.text));
    return `${JSON.stringify(top.objective.text)} (${whose})${paused.length === 0 ? "" : `; set aside: ${paused.join(", ")}`}`;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.runSignal = signal;
    signal.addEventListener("abort", () => { this.situations.stopFor(null); this.wake?.(); }, { once: true });
    const { persona } = this.options;
    this.options.journal?.({ kind: "persona", name: persona.displayName, stance: persona.stance, goal: persona.goal ?? null, preferences: persona.preferences ?? null });
    // The runtime keeps chat and hits from before this brain started; answering or scoring them now would be confusing.
    await this.options.runtime.readEvents();
    const recalled = await this.memory.recallMemory();
    if (recalled !== null) {
      this.talks?.recalled(recalled.conversations);
      this.relations?.load(recalled);
    }
    await this.memory.rotateActivityNotes();
    await this.memory.recallAreas();
    // One failed read must not end the brain (live 2026-10-05: an unreadable modded item on the ground failed
    // view_status, and the brain stopped before its first step).
    for (;;) {
      try {
        const snapshot = await this.options.runtime.status();
        this.situations.observe(snapshot);
        await this.keepSettings(snapshot);
        break;
      } catch (error) {
        if (signal.aborted) return;
        this.options.log(`status unreadable, retrying: ${String(error)}`);
        await sleepMs(STARTUP_RETRY_MS, signal).catch(() => undefined);
      }
    }
    this.options.log(`listening as ${this.options.persona.username} (${this.options.persona.stance})`);
    const working = this.workLoop(signal);
    const chatting = this.chatLoop(signal);
    // Logged once while the runtime stays down, and again only after a read worked (review R17).
    let unreadable = false;
    try {
      while (!signal.aborted) {
        unreadable = await this.readChat(unreadable);
        this.conversationLook.lookAtConversations();
        tickRelations(this.tradeHost, signal);
        void this.situations.poll().catch(() => undefined);
        await sleepMs(this.options.pollMs ?? DEFAULT_POLL_MS, signal).catch(() => undefined);
      }
    } finally {
      this.stopAll();
      this.wakeChat?.();
      await working;
      await chatting;
    }
  }

  /**
   * One poll of the chat. Reading never waits for the chat tier: lines that come while it thinks are heard at once (and
   * may supersede its reply), so a "stop" is not stuck behind a queue of calls. A runtime restarting under a poll fails
   * the read: the next poll tries again (review B5). `unreadable`: the last poll failed; returns whether this one did.
   */
  private async readChat(unreadable: boolean): Promise<boolean> {
    try {
      const { messages, hurts } = await this.options.runtime.readEvents();
      for (const hurt of hurts) this.relations?.hurt(hurt);
      for (const message of messages) if (takeMessage(this.chatHost, message)) this.wakeChat?.();
      return false;
    } catch (error) {
      if (!unreadable) this.options.log(`chat unreadable, retrying at the next poll (not logged again until a read works): ${String(error)}`);
      return true;
    }
  }

  /** The chat loop: one message at a time to the chat tier, once its speaker has paused for the burst window. */
  private async chatLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const { speakerBudget } = this.options;
      const heard = this.inbox.next((speaker) => speakerBudget?.tryTake(speaker) ?? true);
      if (heard === null) {
        const wait = Math.min(this.options.pollMs ?? DEFAULT_POLL_MS, this.inbox.readyIn((speaker) => speakerBudget?.waitMs(speaker) ?? 0) ?? Number.POSITIVE_INFINITY);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, wait);
          function done() {
            clearTimeout(timer);
            resolve();
          }
          this.wakeChat = done;
        });
        this.wakeChat = null;
        continue;
      }
      await this.handle(heard.message, heard).catch((error: unknown) => this.options.log(`could not handle "${heard.message.message}": ${String(error)}`));
    }
  }

  /**
   * Reacts to one incoming message. Returns once the reply is queued, not spoken, so "stop" is never stuck behind work.
   * `heard`: the message as the inbox gave it; when its speaker has said something since, the reply is dropped unspoken
   * (a "stop" still stops: only its line is dropped).
   */
  async handle(message: PlayerMessage, heard?: Heard): Promise<void> {
    return handleLine(this.chatHost, message, heard);
  }

  /** The requests on the stack asked by `name` (any case); hand-offs and the character's own goals have no requester and never count. */
  private openOrdersOf(name: string): number {
    return this.stack.filter(({ objective }) => objective.requester?.toLowerCase() === name.toLowerCase()).length;
  }

  /** Puts something the character took on above what it was doing, which is set aside (its step stopped) and resumes later. */
  private take(objective: Objective, whisperTo: string | null = null, duringTrade?: string): void {
    // A member's request is worked on while the conversation goes on, as a chance conversation does; anything else takes the body.
    if (objective.requester === null || this.state.memberBeforeLine.get(objective.requester.toLowerCase()) !== true) this.talks?.end("taken_over", this.runSignal);
    const current = this.stack.at(-1);
    current?.step?.abort();
    this.stack.push(newWork(objective, whisperTo));
    this.journalObjective("taken", objective, duringTrade);
    this.wake?.();
  }

  /** A trade's hand-off goes on top of what it does, like an order that takes the body; its own decision, so no authority is asked. A player's running order is not interrupted: the hand-off waits just below it, except the give for that player's own trade, which goes on top of the order it let through (the order's step is set aside and resumes). */
  private takeHandoff(h: Handoff): void {
    const objective = { text: describeHandoff(h), requester: null, purpose: null, handoff: h };
    const running = topWork(this.stack)?.objective.requester ?? null;
    if (running !== null && !isGiveTo(h, running)) return this.queue(objective);
    this.stack.at(-1)?.step?.abort();
    this.stack.push(newWork(objective));
    this.journalObjective("taken", objective);
    this.wake?.();
  }

  /** The step of a hand-off objective: the routine in relations/handoff.ts; a stop or a shelter drops it and the trade stays due. */
  private handoffStep(work: Work, h: Handoff): Promise<void> {
    return handoffStep(this.tradeHost, work, h);
  }

  /** The step runs: its controller stops it, and the items it is out to get are its own work, never a partner's payment. */
  private startStep(work: Work, controller: AbortController, step: Step): void {
    work.step = controller;
    this.own.startStep(itemsYieldedBy(step));
  }

  /** The step's yields wait for the ticks that see the inventory after the step (and one more); cleared only while the step is still this one's. */
  private endStep(work: Work, controller?: AbortController): void {
    if (controller === undefined || work.step === controller) work.step = null;
    this.own.endStep();
  }

  /** Takes something on for when the current objective ends: it goes just below it on the stack. */
  private queue(objective: Objective, whisperTo: string | null = null, duringTrade?: string): void {
    const work = newWork(objective, whisperTo);
    const top = topWork(this.stack);
    if (top === undefined) this.stack.push(work);
    else this.stack.splice(this.stack.indexOf(top), 0, work);
    this.journalObjective("queued", objective, duringTrade);
    this.wake?.();
  }

  /** The work loop: one model decision and one step at a time for the top objective; own goal when idle. */
  private async workLoop(signal: AbortSignal): Promise<void> {
    // The same error again and again (live 2026-10-09: a runtime that exited gave 1090 lines in 10 minutes) waits
    // longer each time, up to a minute, and is logged at its 1st, 10th, 100th... occurrence.
    let repeated = { error: "", count: 0 };
    while (!signal.aborted) {
      const work = this.stack.at(-1);
      try {
        if (work !== undefined) await (work.objective.handoff === undefined ? this.advance(work) : this.handoffStep(work, work.objective.handoff));
        else if (!(await this.pickOwnObjective())) await this.idle(this.options.pollMs ?? DEFAULT_POLL_MS);
        repeated = { error: "", count: 0 };
        this.clearBodyDown();
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof ModelUnavailable) {
          await this.waitForModel(error);
          continue;
        }
        const text = String(error);
        repeated = text === repeated.error ? { error: text, count: repeated.count + 1 } : { error: text, count: 1 };
        if (Number.isInteger(Math.log10(repeated.count))) this.options.log(`work loop error${repeated.count > 1 ? ` (${repeated.count} times)` : ""}: ${text}`);
        const poll = this.options.pollMs ?? DEFAULT_POLL_MS;
        const usual = Math.min(poll * 2 ** (repeated.count - 1), Math.max(poll, MAX_ERROR_WAIT_MS));
        // Only a call that went through ends "my body is down": a 503 while it starts leaves the state.
        if (error instanceof BodyDown) {
          this.showBodyDown(error);
          await this.idle(bodyDownWait(usual, error.restart, poll, Date.now()));
          continue;
        }
        if (text.includes("[BODY_RESTARTED]")) this.clearBodyDown();
        await this.idle(usual);
      }
    }
  }

  /** The supervisor keeps the body down: the monitor shows when it starts again. */
  private showBodyDown(error: BodyDown): void {
    this.bodyDownShown = true;
    this.journalState(bodyDownState(error.restart, Date.now()));
  }

  /** A call went through, or the body restarted under it: "my body is down…" is no longer true. */
  private clearBodyDown(): void {
    if (!this.bodyDownShown) return;
    this.bodyDownShown = false;
    this.journalState(null);
    this.memory.unfinishedSaver.request(); // a house recorded while the body was down could not be saved
  }

  /**
   * The model server did not answer the work or goal tier: waits (an order taken meanwhile ends the wait) and lets the
   * work loop ask again. The objective stays where it is however long the server is away; nothing is counted against it.
   */
  private async waitForModel(error: ModelUnavailable): Promise<void> {
    const delay = this.modelFailed(error);
    this.journalState("waiting for the model");
    await this.idle(delay);
    this.journalState(null);
  }

  /** Counts one more failure of the model server in a row (any tier), logs it at the 1st, 10th, 100th, and returns how long to wait before asking again. */
  private modelFailed(error: ModelUnavailable): number {
    this.modelFailures += 1;
    if (Number.isInteger(Math.log10(this.modelFailures))) this.options.log(`model unavailable (${this.modelFailures} times): ${error.message}`);
    return modelRetryDelay(this.modelFailures, this.options.pollMs ?? DEFAULT_POLL_MS, this.options.random ?? Math.random);
  }

  /** Asks the goal tier for the next objective of the character's own goal; false when there is none to pick now. */
  private async pickOwnObjective(): Promise<boolean> {
    await this.situations.settled();
    if (this.runSignal.aborted || this.stack.length > 0) return true;
    const { persona, mind, runtime, log } = this.options;
    if (persona.goal === undefined || monotonicNow() < this.restUntil) return false;
    if (!(await this.guards.waitForGoalBudget())) return true;
    const snapshot = await runtime.status();
    this.situations.observe(snapshot);
    this.memory.notePosition(snapshot.position, snapshot.dimension, monotonicNow());
    const { chances, drawn, time, trading } = drawGoal(this.tradeHost, snapshot);
    const opportunities = await opportunitiesFor({ memory: this.memory, facts: this.facts, runtime, style: persona.style, log }, snapshot, drawn, trading);
    let chosen;
    try {
      chosen = await mind.chooseObjective({ persona, snapshot, places: this.memory.knownPlaces(), areas: [...this.memory.areas], lately: [...this.memory.lately], lastFailed: this.lastFailed, opportunities, time, drawn, chances, ...(this.relations !== null && { relations: this.relations.lines(partners(this.tradeHost)) }) }, this.runSignal);
    } catch (error) {
      await this.situations.settled();
      if (this.runSignal.aborted || this.stack.length > 0) return true;
      throw error;
    }
    await this.situations.settled();
    if (this.runSignal.aborted || this.stack.length > 0) return true;
    const { text, purpose } = chosen;
    this.modelFailures = 0;
    // An order that arrived while it was thinking comes first; its own idea is dropped, it will think again.
    if (this.stack.length > 0 || monotonicNow() < this.restUntil) return true;
    log(`own objective: ${JSON.stringify(text)}${purpose === null ? " (no kind of work named for it)" : ` (for ${purpose})`}`);
    this.stack.push(newWork({ text, requester: null, purpose }));
    this.options.journal?.({ kind: "objective", event: "own", text, requester: null, opportunities, time, purpose, drawn, chances: chances.slice(0, TOP_CHANCES) });
    this.journalState(null);
    return true;
  }

  /** Takes one step towards `work`: one model call, then the chosen skill. */
  private async advance(work: Work): Promise<void> {
    await this.situations.settled();
    if (this.runSignal.aborted || this.stack.at(-1) !== work) return;
    const { persona, runtime } = this.options;
    if (work.situation === null && work.objective.requester === null && !(await this.guards.waitForGoalBudget())) return;
    if (this.stack.at(-1) !== work) return;
    if (work.situation === null && work.objective.requester === null && work.objective.purpose === "socialising") return socialiseStep(this.tradeHost, work);
    if (work.situation === null && work.objective.requester === null && work.objective.purpose === "trading") return tradeStep(this.tradeHost, work);
    const snapshot = await runtime.status();
    this.situations.observe(snapshot);
    if (this.stack.at(-1) !== work) return;
    this.memory.notePosition(snapshot.position, snapshot.dimension, monotonicNow());
    await this.keepSettings(snapshot);
    // A planned step (a situation's, decided when it was raised) runs without a model call, once.
    const decision = work.planned ?? (await decideStep(this.decideHost, work, snapshot));
    await this.situations.settled();
    // Set aside or stopped while it was thinking: it thinks again once the objective is back on top.
    if (decision === null || this.stack.at(-1) !== work) return;
    work.planned = null;
    if (decision.kind === "done") return this.finish(work, "done", decision.summary);
    if (decision.kind === "give_up") return this.finish(work, "failed", decision.reason);
    if (work.taken >= persona.settings.maxStepsPerObjective) return this.finish(work, "failed", `still not done after ${work.taken} steps`);
    work.taken += 1;
    const run = await this.runner.runChosenStep(work, decision, snapshot);
    const record = await this.runner.recordStep(work, decision, run, snapshot);
    if (record === null) return;
    const verdict = loopVerdict(work, record, decision.step.skill, persona.settings);
    if (verdict !== null) this.finish(work, "failed", verdict);
  }

  /** Ends an objective: an order is reported in character; its own objectives are remembered for the goal tier. */
  private finish(work: Work, outcome: "done" | "failed", detail: string): void {
    // An objective no longer on the stack was stopped: a late result of its step or its model call says nothing (BRN-08).
    const index = this.stack.indexOf(work);
    if (index < 0) return;
    this.stack.splice(index, 1);
    const { objective } = work;
    this.options.log(`objective ${JSON.stringify(objective.text)} (${objective.requester ?? "own goal"}): ${outcome} (${detail})`);
    this.options.journal?.({ kind: "objective", event: "finished", text: objective.text, requester: objective.requester, outcome, detail });
    this.journalState(null);
    if (work.situation !== null) { this.situations.closed(work, detail); return; }
    if (objective.requester === null) {
      const outcomeLine = `${objective.text}: ${outcome} (${detail})`;
      this.lastFailed = outcome === "failed" ? { objective: objective.text, reason: detail } : null;
      // A trading objective's own failure is not a new need: the ask would never time out.
      if (outcome === "failed" && objective.purpose !== "trading") this.asks.failed(work.wanted, this.state.lastLook?.inventory ?? [], monotonicNow());
      this.memory.rememberOwnOutcome(outcomeLine);
      this.memory.memorize({ kind: "own_objective", outcome: outcomeLine });
      return;
    }
    void this.narration.narrate(objective.text, outcome, detail, work.whisperTo);
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

  private journalObjective(event: "taken" | "queued" | "own", objective: Objective, duringTrade?: string): void {
    this.options.journal?.({ kind: "objective", event, text: objective.text, requester: objective.requester, purpose: objective.purpose, ...(duringTrade !== undefined && { duringTrade }) });
    this.journalState(null);
  }

  /** The stack as it is now (top last) and the step running, for the monitor. */
  private journalState(step: string | null): void {
    this.options.journal?.({ kind: "state", stack: this.stack.map(({ objective }) => ({ text: objective.text, requester: objective.requester })), step });
  }

  /** "stop": everything on the stack ends, its own goal included. */
  private stopAll(): void {
    this.situations.stopFor(null);
    const removed = [...this.stack];
    stopAll(this.stack);
    for (const work of removed) this.situations.closed(work, "stopped");
    this.journalState(null);
    this.wake?.();
  }

  /** "stop" from a player: only that player's share of the stack ends (see `stopWorkOf`). */
  private stopWorkOf(speaker: string): void {
    this.situations.stopFor(speaker);
    const before = [...this.stack];
    stopWorkOf(this.stack, speaker);
    for (const work of before) if (!this.stack.includes(work)) this.situations.closed(work, `stopped by ${speaker}`);
    this.journalState(null);
    this.wake?.();
  }

  /**
   * A player's "stop": everything ends (only `speaker`'s work and the character's own goals when given), and no goal
   * of its own starts for the persona's rest time.
   */
  private stopAndRest(speaker?: string): void {
    this.talks?.end("taken_over", this.runSignal);
    if (speaker === undefined) this.stopAll();
    else this.stopWorkOf(speaker);
    this.restUntil = monotonicNow() + this.options.persona.settings.restAfterStopSeconds * 1_000;
  }

  /** `since`: when the message being answered was heard (thinking time counts as typing time). Resolves once the line is sent; rejects (after logging) when the runtime threw. A refusal the runtime reports without throwing still resolves (`Body.say` only logs it). */
  private speak(text: string, since = monotonicNow(), to?: readonly string[], whisperTo: string | null = null, shout = false): Promise<void> {
    if (text.trim() === "") return Promise.resolve();
    const said = this.remember(this.options.persona.username, text);
    if (to !== undefined) this.annotate(said, to);
    const sent = this.body.say(text, since, whisperTo ?? undefined, shout);
    sent.catch((error: unknown) => this.options.log(`say failed: ${String(error)}`));
    return sent;
  }

  private remember(speaker: string, text: string): ChatLine {
    const line = { speaker, text, at: Date.now() };
    this.history.push(line);
    if (this.history.length > HISTORY_LINES) this.history.splice(0, this.history.length - HISTORY_LINES);
    return line;
  }

  private annotate(line: ChatLine, to: readonly string[]): void {
    const index = this.history.indexOf(line);
    if (index !== -1) this.history[index] = { ...line, to };
  }
}
