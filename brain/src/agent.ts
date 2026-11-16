import { sleepMs } from "./wall-timers.ts";
import { parseActivity } from "./activities.ts";
import { activityChances, availableActivities, drawTwo } from "./activity-draw.ts";
import { Body, HUMAN_TYPING, type TypingPace } from "./body.ts";
import { ModelUnavailable } from "./chat-model.ts";
import { Inbox, type Heard } from "./inbox.ts";
import type { BrainEvent } from "./brain-log.ts";
import { MAX_ERROR_WAIT_MS, modelRetryDelay } from "./model-wait.ts";
import { monotonicNow } from "./monotonic-clock.ts";
import { sameWords, type ChatLine, type Mind, type Objective, type WorkDecision } from "./mind.ts";
import { personaSkills, type Persona } from "./persona.ts";
import type { BotRuntime, BotSnapshot, PlayerMessage } from "./runtime-client.ts";
import { TillFacts } from "./farming/site.ts";
import { loopVerdict } from "./step-loop-rules.ts";
import { lastOfPlay, minutesByActivity, minutesByPurpose } from "./time-spent.ts";
import { WhoWasNamed } from "./who-was-named.ts";
import { AgentMemory } from "./agent/agent-memory.ts";
import { decideChat, listensTo, type ChatRoutingHost } from "./agent/chat-routing.ts";
import { FailedSteps } from "./agent/failed-steps.ts";
import { GameFacts } from "./agent/game-facts.ts";
import { opportunitiesFor } from "./agent/house-opportunities.ts";
import { StepGuards } from "./agent/step-guards.ts";
import { StepRunner } from "./agent/step-runner.ts";
import { stopAll, stopWorkOf } from "./agent/stack.ts";
import { newWork, type Work } from "./agent/work.ts";

/** How often the agent checks for new chat. */
const DEFAULT_POLL_MS = 500;
const STARTUP_RETRY_MS = 10_000;
/** Chat lines kept as conversational context. */
const HISTORY_LINES = 12;
/** Chances of the likeliest activities kept in the brain log with each own objective. */
const TOP_CHANCES = 5;
/** Unusable model replies in a row before an objective is dropped. */
const MAX_BAD_REPLIES = 2;
/** Decisions in a row that a content check kept sending back (not a format failure: those are bad replies). */
const MAX_SENT_BACKS = 4;

export interface AgentOptions {
  readonly persona: Persona;
  readonly runtime: BotRuntime;
  readonly mind: Mind;
  /**
   * Usernames of the other agents. Never answered in Phase 1, so two bots cannot talk each other into an endless
   * loop; real bot-to-bot conversation (with explicit start/end) is Phase 5. `OtherAgents` (fixed names, and the
   * launcher's file when there is one) is asked on every line: a bot started from game chat joins the list while this
   * one runs.
   */
  readonly otherAgents: { names(): readonly string[] };
  readonly log: (line: string) => void;
  /** The block names a till failed on, shared by the agents of one process (each agent has its own when none is given). */
  readonly soil?: TillFacts;
  readonly pollMs?: number;
  /** Chat typing pace; tests use instant typing. */
  readonly typing?: TypingPace;
  /** Told what the character takes on, does and reports (the brain log, read by the monitor). */
  readonly journal?: (event: BrainEvent) => void;
  /** Where the activity draw gets its chance, a number in [0, 1); tests inject a seeded one. Default `Math.random`. */
  readonly random?: () => number;
  /** People talked to who are not players here (e.g. the controller): a message opening with their name, then a comma, calls them. Default none. */
  readonly knownNames?: readonly string[];
  /** Minutes without any target item gained before a step is stopped, and how often the inventory is looked at; tests shorten them. */
  readonly noGain?: { readonly minutes: number; readonly sampleMs: number };
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
  /** What the chat routing reads from this agent. */
  private readonly chatHost: ChatRoutingHost;
  /** Runs the step the model chose and keeps what it did. */
  private readonly runner: StepRunner;
  /** The goal tier's pace. */
  private readonly guards: StepGuards;
  private restUntil = 0;
  private wake: (() => void) | null = null;
  private runSignal: AbortSignal = new AbortController().signal;
  /** Calls of any tier in a row that found the model server away (reset by any answer): sets how long the next wait is. */
  private modelFailures = 0;
  /** Wakes the chat loop when a line arrives (it sleeps until the burst window of the last one ends). */
  private wakeChat: (() => void) | null = null;

  constructor(private readonly options: AgentOptions) {
    this.soil = options.soil ?? new TillFacts();
    this.body = new Body(options.runtime, options.log, options.typing ?? HUMAN_TYPING);
    this.facts = new GameFacts(options.runtime, options.log);
    this.memory = new AgentMemory(options, this.body);
    this.guards = new StepGuards({
      options,
      pollMs: options.pollMs ?? DEFAULT_POLL_MS,
      runSignal: () => this.runSignal,
      top: () => this.stack.at(-1),
      idle: (ms) => this.idle(ms),
    });
    this.inbox = new Inbox(options.persona.settings.chatBurstMs);
    this.whoWasNamed = new WhoWasNamed(options.persona.username, () => options.otherAgents.names());
    this.chatHost = {
      options,
      history: this.history,
      inbox: this.inbox,
      areas: this.memory.areas,
      activity: () => this.activity,
      knownPlaces: () => this.memory.knownPlaces(),
      orderOnTop: () => (this.stack.at(-1)?.objective.requester ?? null) !== null,
      modelFailed: (error) => this.modelFailed(error),
      resetModelFailures: () => { this.modelFailures = 0; },
      runSignal: () => this.runSignal,
    };
    this.runner = new StepRunner({
      options,
      body: this.body,
      memory: this.memory,
      facts: this.facts,
      failedSteps: this.failedSteps,
      soil: this.soil,
      lastHeard: this.lastHeard,
      progress: (work, fact) => this.progress(work, fact),
      journalState: (step) => this.journalState(step),
      runSignal: () => this.runSignal,
    });
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
    const { persona } = this.options;
    this.options.journal?.({ kind: "persona", name: persona.displayName, stance: persona.stance, goal: persona.goal ?? null, preferences: persona.preferences ?? null });
    // The runtime keeps chat from before this brain started; answering it now would be confusing.
    await this.options.runtime.readMessages();
    await this.memory.recallMemory();
    await this.memory.rotateActivityNotes();
    await this.memory.recallAreas();
    // One failed read must not end the brain (live 2026-10-05: an unreadable modded item on the ground failed
    // view_status, and the brain stopped before its first step).
    for (;;) {
      try {
        await this.keepSettings(await this.options.runtime.status());
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
      for (const message of await this.options.runtime.readMessages()) {
        this.lastHeard.set(message.username.toLowerCase(), monotonicNow());
        this.inbox.push(message);
        this.wakeChat?.();
      }
      return false;
    } catch (error) {
      if (!unreadable) this.options.log(`chat unreadable, retrying at the next poll (not logged again until a read works): ${String(error)}`);
      return true;
    }
  }

  /** The chat loop: one message at a time to the chat tier, once its speaker has paused for the burst window. */
  private async chatLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const heard = this.inbox.next();
      if (heard === null) {
        const wait = Math.min(this.options.pollMs ?? DEFAULT_POLL_MS, this.inbox.readyIn() ?? Number.POSITIVE_INFINITY);
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
    const heardAt = monotonicNow();
    this.lastHeard.set(message.username.toLowerCase(), heardAt);
    const { persona, log } = this.options;
    const line = this.remember(message.username, message.message);
    const talkedTo = this.whoWasNamed.note(message, heardAt);
    if (!listensTo(this.chatHost, message.username)) return;
    const decision = await decideChat(this.chatHost, message, heard, heardAt, talkedTo);
    if (decision === null) return;
    const { route } = decision;
    const request = route === "act" || route === "later" ? ` ${JSON.stringify(decision.request)}` : "";
    log(`${message.username}: ${JSON.stringify(message.message)} -> ${route}${request}, say ${JSON.stringify(decision.say)}`);
    // Whom it read the line as spoken to stays with the line: a follow-up is read in that light (live 2026-10-04:
    // "fix it now" after "Opus, Vex is going through the ocean" was taken by Vex).
    if (decision.to !== undefined) this.annotate(line, decision.to);
    // Its speaker went on while the model thought: this reply answers a state that is gone. The newest lines are read
    // next, with this one in the history (spec 2026-10-09-chat-handling, A).
    const superseded = heard !== undefined && this.inbox.superseded(message.username, heard.seq);
    this.options.journal?.({ kind: "chat", speaker: message.username, text: message.message, channel: message.channel, lines: heard?.lines ?? 1, route, say: decision.say, superseded, ...(decision.to !== undefined && { to: decision.to }), ...(decision.place !== undefined && { place: decision.place }), ...(decision.startsNow !== undefined && { startsNow: decision.startsNow }) });
    if (superseded) {
      // The line answers a state that is gone and is dropped, but a stop is not: it was meant, and the newer line
      // (read next) does not take it back.
      if (route === "stop") {
        log("  superseded: its speaker said something since; the line is dropped but the stop is kept");
        this.stopAndRest(message.username);
      } else {
        log("  superseded: its speaker said something since, the reply is dropped");
      }
      return;
    }
    // A line naming nobody, soon after its speaker named another character, is that character's unless the model read
    // it as spoken to her or to everyone (owner, 2026-10-11, L6: Ayla answered "thanks, no rush" meant for Vex although
    // the fact was in her input).
    if (talkedTo !== undefined && (decision.to ?? []).every((name) => name.toLowerCase() !== persona.username.toLowerCase() && name.toLowerCase() !== "everyone")) {
      log(`  ignored: ${message.username} was talking to ${talkedTo.name} ${talkedTo.secondsAgo} s ago, the line names nobody and is not read as spoken to ${persona.username} or everyone`);
      return;
    }
    // A "stop" that carries a request stops what runs (if anything), then the request is the order (live 2026-10-11, L7:
    // "release that area" routed stop while idle, and the area stayed; a busy agent dropped it the same way).
    const carriesRequest = decision.route === "stop" && decision.request.trim() !== "";
    const routed = carriesRequest ? "act" : decision.route;
    if (routed === "ignore") return;
    // A whisper is answered by whisper (and so is the order it gives), anything else in public chat.
    const whisperTo = message.channel === "whisper" ? message.username : null;
    this.speak(decision.say, heardAt, [message.username], whisperTo);
    // A stop ends the speaker's work and the character's own goals only, the other players' queued orders stay, with or
    // without a request (owner, 2026-10-16, review R18, SF4: "a stop ends only the speaker's work").
    if (routed === "stop" || (carriesRequest && this.stack.length > 0)) this.stopAndRest(message.username);
    // A request already on her stack is not taken again (live 2026-10-04: "thanks, no rush" while she fetched for
    // Opus's house came back as "later" with the same request, and a second house order was queued under the first).
    // The speaker is the requester: their authority is the order's.
    const asked = { text: decision.request, requester: message.username, purpose: parseActivity(decision.work), ...(decision.place !== undefined && { place: decision.place }) };
    if ((routed === "act" || routed === "later") && this.stack.some(({ objective }) => objective.requester === asked.requester && sameWords(objective.text, asked.text))) {
      log(`already on "${asked.text}" for ${asked.requester}`);
      return;
    }
    if (routed === "act") this.take(asked, whisperTo);
    if (routed === "later") {
      // Owner rule (2026-10-01): a player's request always comes before the character's own goal. The prompt says so,
      // but qwen3 still answered "later" to a plain request while on its own goal, so the stack enforces it: "later"
      // only waits behind work done for someone.
      const top = this.stack.at(-1);
      const objective = asked;
      if (top === undefined || top.objective.requester === null) this.take(objective, whisperTo);
      else this.queue(objective, whisperTo);
    }
  }

  /** Puts something the character took on above what it was doing, which is set aside (its step stopped) and resumes later. */
  private take(objective: Objective, whisperTo: string | null = null): void {
    const current = this.stack.at(-1);
    current?.step?.abort();
    this.stack.push(newWork(objective, whisperTo));
    this.journalObjective("taken", objective);
    this.wake?.();
  }

  /** Takes something on for when the current objective ends: it goes just below it on the stack. */
  private queue(objective: Objective, whisperTo: string | null = null): void {
    const work = newWork(objective, whisperTo);
    if (this.stack.length === 0) this.stack.push(work);
    else this.stack.splice(this.stack.length - 1, 0, work);
    this.journalObjective("queued", objective);
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
        if (work !== undefined) await this.advance(work);
        else if (!(await this.pickOwnObjective())) await this.idle(this.options.pollMs ?? DEFAULT_POLL_MS);
        repeated = { error: "", count: 0 };
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
        await this.idle(Math.min(poll * 2 ** (repeated.count - 1), Math.max(poll, MAX_ERROR_WAIT_MS)));
      }
    }
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
    const { persona, mind, runtime, log } = this.options;
    if (persona.goal === undefined || monotonicNow() < this.restUntil) return false;
    if (!(await this.guards.waitForGoalBudget())) return true;
    const snapshot = await runtime.status();
    this.memory.notePosition(snapshot.position, snapshot.dimension, monotonicNow());
    const hour = lastOfPlay(this.memory.times);
    const time = minutesByActivity(hour);
    // What it feels like doing now (spec 2026-10-09-activity-draw): two activities drawn by their chances, which count
    // the hour's time spent *for* each, not the kind of work the body did.
    const spent = new Map(minutesByPurpose(hour).map(({ activity, minutes }) => [activity, minutes]));
    const chances = activityChances(availableActivities(personaSkills(persona), snapshot), persona.preferences, persona.settings.feelingMultipliers, (activity) => spent.get(activity) ?? 0);
    const drawn = drawTwo(chances, this.options.random ?? Math.random);
    const opportunities = await opportunitiesFor({ memory: this.memory, facts: this.facts, runtime, style: persona.style, log }, snapshot, drawn);
    const { text, purpose } = await mind.chooseObjective({ persona, snapshot, places: this.memory.knownPlaces(), areas: [...this.memory.areas], lately: [...this.memory.lately], lastFailed: this.lastFailed, opportunities, time, drawn, chances }, this.runSignal);
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
    const { persona, runtime } = this.options;
    if (work.objective.requester === null && !(await this.guards.waitForGoalBudget())) return;
    if (this.stack.at(-1) !== work) return;
    const snapshot = await runtime.status();
    this.memory.notePosition(snapshot.position, snapshot.dimension, monotonicNow());
    await this.keepSettings(snapshot);
    // A planned step (a situation's, decided when it was raised) runs without a model call, once.
    const decision = work.planned ?? (await this.decideStep(work, snapshot));
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

  /**
   * The model's decision for the next step of `work`. Null when the call gave none: an unusable reply is counted
   * against the objective (two in a row, or too many send-backs, end it), or the agent is stopping.
   */
  private async decideStep(work: Work, snapshot: BotSnapshot): Promise<WorkDecision | null> {
    const { persona, mind, log } = this.options;
    try {
      const paused = this.stack.slice(0, -1).map((below) => below.objective);
      const decision = await mind.next({ persona, objective: work.objective, snapshot, places: this.memory.knownPlaces(), areas: [...this.memory.areas], steps: [...work.steps], paused, earlierFailures: this.failedSteps.earlier(snapshot), ownsTemporaryHouse: this.memory.temporaryHouse() !== null, refused: work.refused }, this.runSignal);
      work.badReplies = 0;
      work.sentBacks = 0;
      this.modelFailures = 0;
      return decision;
    } catch (error) {
      // Stopped while it thought (an order stopped or the agent shutting down): nothing it did is counted or told.
      if (this.runSignal.aborted || !this.stack.includes(work)) return null;
      // The model server is away: no reply was given, so none is bad. The work loop waits and asks again.
      if (error instanceof ModelUnavailable) throw error;
      const sentBack = String(error).includes("[LLM_SENT_BACK]");
      if (sentBack) work.sentBacks += 1;
      else work.badReplies += 1;
      log(`work tier failed on ${JSON.stringify(work.objective.text)}: ${String(error)}`);
      if (work.badReplies >= MAX_BAD_REPLIES || work.sentBacks >= MAX_SENT_BACKS) {
        // What the last step ran into is the cause the players hear; without it the narration made one up (live
        // 2026-10-03: "how do I build a house exactly around you without stepping on your feet?" when the logs she
        // needed were all inside her own protected houses).
        const last = work.steps.at(-1);
        this.finish(work, "failed", last === undefined || last.outcome === "done"
          ? "could not work out what to do next"
          : `could not work out what to do next after this: ${last.step} ${last.outcome}: ${last.detail}`);
      }
      return null;
    }
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
    if (objective.requester === null) {
      const outcomeLine = `${objective.text}: ${outcome} (${detail})`;
      this.lastFailed = outcome === "failed" ? { objective: objective.text, reason: detail } : null;
      this.memory.rememberOwnOutcome(outcomeLine);
      this.memory.memorize({ kind: "own_objective", outcome: outcomeLine });
      return;
    }
    void this.narrate(objective.text, outcome, detail, work.whisperTo);
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

  /**
   * A skill started something new for an order: the chat tier may say it, at most once per
   * `settings.narrateEverySeconds` (counted from the reply that took the order on) and never twice for the same thing.
   */
  private progress(work: Work, fact: string): void {
    // A step that outlives its stop may still report (BRN-08): the order was stopped, nothing is told about it.
    if (!this.stack.includes(work) || fact === work.lastFact) return;
    work.lastFact = fact;
    this.options.log(`  now: ${fact}`);
    const asked = monotonicNow() - work.spokenAt >= this.options.persona.settings.narrateEverySeconds * 1_000;
    this.options.journal?.({ kind: "progress", objective: work.objective.text, fact, asked });
    if (!asked) return;
    work.spokenAt = monotonicNow();
    void this.narrate(work.objective.text, "progress", fact, work.whisperTo, () => this.stack.includes(work));
  }

  /**
   * Has the chat tier tell the players about an order: how it ended, or what it does now. `stillOn`: asked when the
   * line comes back, a line about an order stopped meanwhile is dropped (flavour text, never retried: BRN-11).
   */
  private async narrate(objective: string, outcome: "done" | "failed" | "progress", detail: string, whisperTo: string | null, stillOn: () => boolean = () => true): Promise<void> {
    if (this.runSignal.aborted) return;
    try {
      const line = await this.options.mind.narrate({ persona: this.options.persona, objective, outcome, detail, history: this.history }, this.runSignal);
      if (stillOn()) this.speak(line, undefined, undefined, whisperTo);
    } catch (error) {
      this.options.log(`narration failed: ${String(error)}`);
    }
  }

  private journalObjective(event: "taken" | "queued" | "own", objective: Objective): void {
    this.options.journal?.({ kind: "objective", event, text: objective.text, requester: objective.requester, purpose: objective.purpose });
    this.journalState(null);
  }

  /** The stack as it is now (top last) and the step running, for the monitor. */
  private journalState(step: string | null): void {
    this.options.journal?.({ kind: "state", stack: this.stack.map(({ objective }) => ({ text: objective.text, requester: objective.requester })), step });
  }

  /** "stop": everything on the stack ends, its own goal included. */
  private stopAll(): void {
    stopAll(this.stack);
    this.journalState(null);
    this.wake?.();
  }

  /** "stop" from a player: only that player's share of the stack ends (see `stopWorkOf`). */
  private stopWorkOf(speaker: string): void {
    stopWorkOf(this.stack, speaker);
    this.journalState(null);
    this.wake?.();
  }

  /**
   * A player's "stop": everything ends (only `speaker`'s work and the character's own goals when given), and no goal
   * of its own starts for the persona's rest time.
   */
  private stopAndRest(speaker?: string): void {
    if (speaker === undefined) this.stopAll();
    else this.stopWorkOf(speaker);
    this.restUntil = monotonicNow() + this.options.persona.settings.restAfterStopSeconds * 1_000;
  }

  /** `since`: when the message being answered was heard (thinking time counts as typing time). */
  private speak(text: string, since = monotonicNow(), to?: readonly string[], whisperTo: string | null = null): void {
    if (text.trim() === "") return;
    const said = this.remember(this.options.persona.username, text);
    if (to !== undefined) this.annotate(said, to);
    this.body.say(text, since, whisperTo ?? undefined).catch((error: unknown) => this.options.log(`say failed: ${String(error)}`));
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
