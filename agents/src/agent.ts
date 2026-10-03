import { setTimeout as sleep } from "node:timers/promises";
import { describeStep } from "./actions.ts";
import { Body, HUMAN_TYPING, type TypingPace } from "./body.ts";
import type { BrainEvent } from "./brain-log.ts";
import type { ChatLine, KnownPlace, Mind, Objective, StepRecord, WorkDecision } from "./mind.ts";
import { memoryNote, recall, recallQuery, type KnownFarm, type Memory } from "./memory.ts";
import type { Persona } from "./persona.ts";
import type { BotRuntime, BotSnapshot, PlayerMessage, ProtectedArea } from "./runtime-client.ts";
import { RESUME_RANGE, runStep, type SkillResult, type UnfinishedHouse } from "./skills.ts";

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
/** Farms it remembers and every tier sees. */
const KNOWN_FARMS = 4;
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
  /** Told what the character takes on, does and reports (the brain log, read by the monitor). */
  readonly journal?: (event: BrainEvent) => void;
}

/** One objective on the stack and what was done for it. */
interface Work {
  readonly objective: Objective;
  readonly steps: StepRecord[];
  taken: number;
  badReplies: number;
  /** Aborts the step running now: the objective is set aside or stopped, the agent goes on. */
  step: AbortController | null;
  /** The last thing a skill said it started doing, and when a line about it was last asked for (an order's progress). */
  lastFact: string;
  spokenAt: number;
}

function newWork(objective: Objective): Work {
  return { objective, steps: [], taken: 0, badReplies: 0, step: null, lastFact: "", spokenAt: Date.now() };
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
  /** Its farms, oldest first, each as it was at its last tend. */
  private readonly farms: KnownFarm[] = [];

  /**
   * The places shown to the models: the known ones, and the unfinished house with where to stand to resume it (live
   * 2026-10-02: asked to "go back and finish the house you started", she began a new one where she stood).
   */
  private knownPlaces(): KnownPlace[] {
    // Her farms, as they were at their last tend: the models only know what the situation says (when to come back is
    // their choice).
    const farms = this.farms.map((farm): KnownPlace => ({
      name: `your ${farm.crop} farm`,
      detail: `${farm.size}x${farm.size} around ${farm.centre.x} ${farm.centre.y} ${farm.centre.z}; ${farm.state.planted} planted, ${farm.state.ripe} ripe, ${farm.state.empty} empty when you last tended it, ${minutesAgo(farm.tendedAt)}; farming it again harvests what is ripe and replants it`,
    }));
    const house = this.building.unfinished;
    if (house === null) return [...this.places, ...farms];
    const { x, y, z } = house.site.door;
    return [...this.places, ...farms, { name: `your unfinished ${house.kind}`, detail: `door ${x} ${y} ${z}; go within ${RESUME_RANGE} blocks of the door, then build it again to finish it` }];
  }
  /** The areas it never digs or places blocks in (ADR-012), kept in step with the skills that change them. */
  private readonly areas: ProtectedArea[] = [];
  private readonly building: { unfinished: UnfinishedHouse | null } = { unfinished: null };
  /** The unfinished house as last saved to memory, to save it again only when it changed. */
  private savedUnfinished = "null";
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
    await this.recallMemory();
    await this.recallAreas();
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
      decision = await mind.chat({ persona, message, history: this.history.slice(0, -1), snapshot, activity: this.activity, places: this.knownPlaces(), areas: [...this.areas], canWait: (this.stack.at(-1)?.objective.requester ?? null) !== null }, this.runSignal);
    } catch (error) {
      log(`chat tier failed on "${message.message}": ${String(error)}`);
      return;
    }
    const { route } = decision;
    const request = route === "act" || route === "later" ? ` ${JSON.stringify(decision.request)}` : "";
    log(`${message.username}: ${JSON.stringify(message.message)} -> ${route}${request}, say ${JSON.stringify(decision.say)}`);
    if (route === "ignore") return;
    this.speak(decision.say, heardAt);
    if (route === "stop") {
      this.stopAll();
      this.restUntil = Date.now() + persona.settings.restAfterStopSeconds * 1_000;
    }
    if (route === "act") this.take({ text: decision.request, requester: message.username });
    if (route === "later") {
      // Owner rule (2026-10-01): a player's request always comes before the character's own goal. The prompt says so,
      // but qwen3 still answered "later" to a plain request while on its own goal, so the stack enforces it: "later"
      // only waits behind work done for someone.
      const top = this.stack.at(-1);
      const objective = { text: decision.request, requester: message.username };
      if (top === undefined || top.objective.requester === null) this.take(objective);
      else this.queue(objective);
    }
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
    this.stack.push(newWork(objective));
    this.journalObjective("taken", objective);
    this.wake?.();
  }

  /** Takes something on for when the current objective ends: it goes just below it on the stack. */
  private queue(objective: Objective): void {
    const work = newWork(objective);
    if (this.stack.length === 0) this.stack.push(work);
    else this.stack.splice(this.stack.length - 1, 0, work);
    this.journalObjective("queued", objective);
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
    const text = await mind.chooseObjective({ persona, snapshot: await runtime.status(), places: this.knownPlaces(), areas: [...this.areas], lately: [...this.lately] }, this.runSignal);
    // An order that arrived while it was thinking comes first; its own idea is dropped, it will think again.
    if (this.stack.length > 0 || Date.now() < this.restUntil) return true;
    log(`own objective: ${JSON.stringify(text)}`);
    this.stack.push(newWork({ text, requester: null }));
    this.journalObjective("own", { text, requester: null });
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
      decision = await mind.next({ persona, objective: work.objective, snapshot, places: this.knownPlaces(), areas: [...this.areas], steps: [...work.steps], paused }, this.runSignal);
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
    this.journalState(label);
    const started = Date.now();
    let result: SkillResult;
    try {
      result = await runStep(decision.step, {
        runtime,
        body: this.body,
        signal: AbortSignal.any([controller.signal, this.runSignal]),
        requester: work.objective.requester ?? undefined,
        self: persona.username,
        style: persona.style,
        remember: (place) => this.learnPlace(place),
        farms: this.farms,
        rememberFarm: (farm) => this.learnFarm(farm),
        building: this.building,
        areas: this.areas,
        // Only an order is narrated (owner, 2026-10-02); its own goals show in the monitor.
        ...(work.objective.requester !== null && { progress: (fact: string) => this.progress(work, fact) }),
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
    this.options.journal?.({ kind: "step", objective: work.objective.text, requester: work.objective.requester, step: label, input: decision.step, thought: decision.thought, outcome: record.outcome, detail: record.detail, ms: Date.now() - started });
    this.journalState(null);
    if (work.steps.length > STEP_MEMORY) work.steps.splice(0, work.steps.length - STEP_MEMORY);
    log(`  -> ${record.outcome}: ${record.detail}`);
    const unfinished = JSON.stringify(this.building.unfinished);
    if (unfinished !== this.savedUnfinished) {
      this.savedUnfinished = unfinished;
      this.memorize({ kind: "unfinished_house", house: this.building.unfinished });
    }
    // A model that keeps choosing a step that ends the same way is stuck; the loop must not spin until the step cap.
    const same = persona.settings.maxSameStepInARow;
    const last = work.steps.slice(-same);
    if (record.outcome !== "interrupted" && last.length === same && last.every((step) => step.step === record.step && step.outcome === record.outcome && step.detail === record.detail)) {
      this.finish(work, "failed", `${record.step} ${record.outcome === "done" ? "changed nothing" : "failed the same way"} ${same} times in a row: ${record.detail}`);
    }
  }

  /** Ends an objective: an order is reported in character; its own objectives are remembered for the goal tier. */
  private finish(work: Work, outcome: "done" | "failed", detail: string): void {
    const index = this.stack.indexOf(work);
    if (index >= 0) this.stack.splice(index, 1);
    const { objective } = work;
    this.options.log(`objective ${JSON.stringify(objective.text)} (${objective.requester ?? "own goal"}): ${outcome} (${detail})`);
    this.options.journal?.({ kind: "objective", event: "finished", text: objective.text, requester: objective.requester, outcome, detail });
    this.journalState(null);
    if (objective.requester === null) {
      const outcomeLine = `${objective.text}: ${outcome} (${detail})`;
      this.lately.push(outcomeLine);
      if (this.lately.length > OWN_MEMORY) this.lately.splice(0, this.lately.length - OWN_MEMORY);
      this.memorize({ kind: "own_objective", outcome: outcomeLine });
      return;
    }
    void this.narrate(objective.text, outcome, detail);
  }

  /**
   * Paces own-goal thinking (ADR-011): waits until the next call is allowed. False when an order to do now arrived
   * meanwhile (orders and chat are never held back; an order taken on for later waits its turn).
   */
  private async waitForGoalBudget(): Promise<boolean> {
    const interval = 60_000 / this.options.persona.settings.goalCallsPerMinute;
    const orderOnTop = () => (this.stack.at(-1)?.objective.requester ?? null) !== null;
    while (Date.now() < this.nextGoalCall) {
      if (this.runSignal.aborted || orderOnTop()) return false;
      await this.idle(Math.min(this.nextGoalCall - Date.now(), this.options.pollMs ?? DEFAULT_POLL_MS));
    }
    if (orderOnTop()) return false;
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
    this.memorize({ kind: "place", place });
  }

  private learnFarm(farm: KnownFarm): void {
    this.options.log(`farm: ${farm.crop} ${farm.size}x${farm.size} around ${farm.centre.x} ${farm.centre.y} ${farm.centre.z} (${farm.state.planted} planted)`);
    const index = this.farms.findIndex((known) => known.centre.x === farm.centre.x && known.centre.y === farm.centre.y && known.centre.z === farm.centre.z);
    if (index >= 0) this.farms.splice(index, 1);
    this.farms.push(farm);
    if (this.farms.length > KNOWN_FARMS) this.farms.splice(0, this.farms.length - KNOWN_FARMS);
    this.memorize({ kind: "farm", farm });
  }

  /** The areas protected in this world's bot data, so the models know them from the first prompt. */
  private async recallAreas(): Promise<void> {
    try {
      this.areas.push(...await this.options.runtime.protectedRegions());
      this.options.log(`knows ${this.areas.length} protected area(s)`);
    } catch (error) {
      this.options.log(`could not read its protected areas: ${String(error)}`);
    }
  }

  /** What it knew before this brain started: the memories saved as notes in this world's bot data. */
  private async recallMemory(): Promise<void> {
    const limits = { places: KNOWN_PLACES, lately: OWN_MEMORY, farms: KNOWN_FARMS };
    try {
      const rows = await this.options.runtime.queryBotData(recallQuery(this.options.persona.username, limits));
      const recalled = recall(rows.map((row) => String(row[1] ?? "")), limits);
      this.places.push(...recalled.places);
      this.lately.push(...recalled.lately);
      this.farms.push(...recalled.farms);
      this.building.unfinished = recalled.unfinished;
      this.savedUnfinished = JSON.stringify(recalled.unfinished);
      const house = recalled.unfinished === null ? "" : `, an unfinished ${recalled.unfinished.kind}`;
      this.options.log(`remembers ${recalled.places.length} place(s), ${recalled.farms.length} farm(s), ${recalled.lately.length} own objective(s)${house}`);
    } catch (error) {
      this.options.log(`could not recall its memory: ${String(error)}`);
    }
  }

  /** Saves one memory as a note; it takes the body between steps (the runtime runs `note_save` as a task). */
  private memorize(memory: Memory): void {
    this.body.act("note_save", memoryNote(memory), "Remember this across restarts.")
      .then((outcome) => {
        if (outcome.status !== "succeeded") this.options.log(`could not save a memory (${outcome.status}): ${outcome.error ?? ""}`);
      })
      .catch((error: unknown) => this.options.log(`could not save a memory: ${String(error)}`));
  }

  /**
   * A skill started something new for an order: the chat tier may say it, at most once per
   * `settings.narrateEverySeconds` (counted from the reply that took the order on) and never twice for the same thing.
   */
  private progress(work: Work, fact: string): void {
    if (fact === work.lastFact) return;
    work.lastFact = fact;
    this.options.log(`  now: ${fact}`);
    const asked = Date.now() - work.spokenAt >= this.options.persona.settings.narrateEverySeconds * 1_000;
    this.options.journal?.({ kind: "progress", objective: work.objective.text, fact, asked });
    if (!asked) return;
    work.spokenAt = Date.now();
    void this.narrate(work.objective.text, "progress", fact);
  }

  /** Has the chat tier tell the players about an order: how it ended, or what it does now. */
  private async narrate(objective: string, outcome: "done" | "failed" | "progress", detail: string): Promise<void> {
    if (this.runSignal.aborted) return;
    try {
      const line = await this.options.mind.narrate({ persona: this.options.persona, objective, outcome, detail, history: this.history }, this.runSignal);
      this.speak(line);
    } catch (error) {
      this.options.log(`narration failed: ${String(error)}`);
    }
  }

  private journalObjective(event: "taken" | "queued" | "own", objective: Objective): void {
    this.options.journal?.({ kind: "objective", event, text: objective.text, requester: objective.requester });
    this.journalState(null);
  }

  /** The stack as it is now (top last) and the step running, for the monitor. */
  private journalState(step: string | null): void {
    this.options.journal?.({ kind: "state", stack: this.stack.map(({ objective }) => ({ text: objective.text, requester: objective.requester })), step });
  }

  /** "stop": everything on the stack ends, its own goal included. */
  private stopAll(): void {
    for (const work of this.stack) work.step?.abort();
    this.stack.length = 0;
    this.journalState(null);
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

/** `14 min ago` (or `just now`) from an ISO time, for the situation the models read. */
function minutesAgo(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "some time ago";
  return minutes < 1 ? "just now" : minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}
