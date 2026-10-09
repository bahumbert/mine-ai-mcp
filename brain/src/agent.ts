import { setTimeout as sleep } from "node:timers/promises";
import { describeStep, SKILL_NAMES, type Step } from "./actions.ts";
import { activityOf, activityTimes, gatheringActivity, parseActivity, type Activity, type ActionTime, type ActivityPhase, type ActivitySpan } from "./activities.ts";
import { activityChances, availableActivities, drawTwo } from "./activity-draw.ts";
import { Body, HUMAN_TYPING, type TypingPace } from "./body.ts";
import { shortfall } from "./building/blueprint.ts";
import { chooseSite, planHouse, styleOrDefault } from "./building/plan.ts";
import { Inbox, type Heard } from "./inbox.ts";
import { obtainedBy } from "./gathering.ts";
import type { BrainEvent } from "./brain-log.ts";
import { sameWords, type ChatLine, type KnownPlace, type Mind, type Objective, type StepRecord, type WorkDecision } from "./mind.ts";
import { activityNotesQuery, memoryNote, recall, recallQuery, staleActivityNotes, type KnownFarm, type Memory } from "./memory.ts";
import { findOpportunities, type Opportunity, type Shortfall } from "./opportunities.ts";
import { shelterForNight, underCover } from "./night-shelter.ts";
import type { Persona } from "./persona.ts";
import type { BotRuntime, BotSnapshot, PlayerMessage, ProtectedArea } from "./runtime-client.ts";
import { RESUME_RANGE, runStep, type SkillResult, type UnfinishedHouse } from "./skills.ts";
import { lastOfPlay, minutesByActivity, minutesByPurpose, RECENT_MINUTES, type ActivityTime } from "./time-spent.ts";

/** How often the agent checks for new chat. */
const DEFAULT_POLL_MS = 500;
const STARTUP_RETRY_MS = 10_000;
/** Chat lines kept as conversational context. */
const HISTORY_LINES = 12;
/** Known places shown to the models; the oldest is forgotten first. */
const KNOWN_PLACES = 8;
/** Steps kept per objective for the work tier. */
const STEP_MEMORY = 20;
/** Outcomes of its own objectives remembered for the goal tier. */
const OWN_MEMORY = 5;
/** How often a step of its own is checked for nightfall (TEMPORARY night shelter). */
const NIGHT_CHECK_MS = 20_000;
/** After a night shelter could not be made, how long before it is tried again. */
const SHELTER_RETRY_MS = 5 * 60_000;
/** Farms it remembers and every tier sees. */
const KNOWN_FARMS = 4;
/** Chances of the likeliest activities kept in the brain log with each own objective. */
const TOP_CHANCES = 5;
/** Unusable model replies in a row before an objective is dropped. */
const MAX_BAD_REPLIES = 2;
/** Activity records read back at start: more than an hour of steps. */
const ACTIVITY_MEMORY = 200;
/** A step shorter than this is not worth a memory note (it still counts until the brain stops). */
const MIN_RECORDED_MS = 5_000;
/** How often activity-time notes older than the last hour of play are deleted (the hour rotates). */
const ROTATE_EVERY_MS = 10 * 60_000;
/** At most this many notes deleted in one `note_delete`. */
const DELETE_BATCH = 500;

export interface AgentOptions {
  readonly persona: Persona;
  readonly runtime: BotRuntime;
  readonly mind: Mind;
  /**
   * Usernames of the other agents. Never answered in Phase 1, so two bots cannot talk each other into an endless
   * loop; real bot-to-bot conversation (with explicit start/end) is Phase 5.
   */
  readonly otherAgents: readonly string[];
  readonly log: (line: string) => void;
  readonly pollMs?: number;
  /** Chat typing pace; tests use instant typing. */
  readonly typing?: TypingPace;
  /** Told what the character takes on, does and reports (the brain log, read by the monitor). */
  readonly journal?: (event: BrainEvent) => void;
  /** Where the activity draw gets its chance, a number in [0, 1); tests inject a seeded one. Default `Math.random`. */
  readonly random?: () => number;
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
  /** The skill whose steps failed last, and how many times in a row. */
  failing: { skill: string; count: number };
  /** Who the order came from by whisper: its progress and its end are whispered back to them (spec 2026-10-09, C). */
  whisperTo: string | null;
}

function newWork(objective: Objective, whisperTo: string | null = null): Work {
  return { objective, steps: [], taken: 0, badReplies: 0, step: null, lastFact: "", spokenAt: Date.now(), failing: { skill: "", count: 0 }, whisperTo };
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
  /** Each finished step's activity and time over the last hour of play, oldest first. */
  private readonly times: ActivityTime[] = [];
  /** When old activity notes were last deleted. */
  private rotatedAt = 0;
  /** When each player (lower case) last said anything: a follow they asked for ends after a long silence. */
  private readonly lastHeard = new Map<string, number>();
  /** Game facts learnt from the runtime, kept for the session: block tags by name, foods seen, how items are got. */
  private readonly blockTags = new Map<string, readonly string[]>();
  private readonly foods = new Set<string>();
  private readonly itemActivities = new Map<string, Activity | null>();
  private readonly building: { unfinished: UnfinishedHouse | null } = { unfinished: null };
  /** The unfinished house as last saved to memory, to save it again only when it changed. */
  private savedUnfinished = "null";
  private readonly stack: Work[] = [];
  private readonly lately: string[] = [];
  /** Its last own objective, when it failed (the goal tier sends it back once if chosen again as it was). */
  private lastFailed: { readonly objective: string; readonly reason: string } | null = null;
  private restUntil = 0;
  private nextGoalCall = 0;
  private wake: (() => void) | null = null;
  private runSignal: AbortSignal = new AbortController().signal;
  /** The night shelter running now (see {@link shelterIfNight}); an order stops it. */
  private sheltering: AbortController | null = null;
  /** No shelter tried before then: the last one could not be dug here. */
  private shelterRetryAt = 0;
  /** When the sky was last looked at for nightfall during a step of its own. */
  private nightCheckedAt = 0;
  /** Wakes the chat loop when a line arrives (it sleeps until the burst window of the last one ends). */
  private wakeChat: (() => void) | null = null;

  constructor(private readonly options: AgentOptions) {
    this.body = new Body(options.runtime, options.log, options.typing ?? HUMAN_TYPING);
    this.inbox = new Inbox(options.persona.settings.chatBurstMs);
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
    await this.recallMemory();
    await this.rotateActivityNotes();
    await this.recallAreas();
    // One failed read must not end the brain (live 2026-10-05: an unreadable modded item on the ground failed
    // view_status, and the brain stopped before its first step).
    for (;;) {
      try {
        await this.keepSettings(await this.options.runtime.status());
        break;
      } catch (error) {
        if (signal.aborted) return;
        this.options.log(`status unreadable, retrying: ${String(error)}`);
        await sleep(STARTUP_RETRY_MS, undefined, { signal }).catch(() => undefined);
      }
    }
    this.options.log(`listening as ${this.options.persona.username} (${this.options.persona.stance})`);
    const working = this.workLoop(signal);
    const chatting = this.chatLoop(signal);
    try {
      while (!signal.aborted) {
        // Reading never waits for the chat tier: lines that come while it thinks are heard at once (and may supersede
        // its reply), so a "stop" is not stuck behind a queue of calls.
        for (const message of await this.options.runtime.readMessages()) {
          this.lastHeard.set(message.username.toLowerCase(), Date.now());
          this.inbox.push(message);
          this.wakeChat?.();
        }
        await this.stopOwnStepAtNightfall().catch(() => undefined);
        await sleep(this.options.pollMs ?? DEFAULT_POLL_MS, undefined, { signal }).catch(() => undefined);
      }
    } finally {
      this.stopAll();
      this.wakeChat?.();
      await working;
      await chatting;
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
    const heardAt = Date.now();
    this.lastHeard.set(message.username.toLowerCase(), heardAt);
    const { persona, mind, log } = this.options;
    const line = this.remember(message.username, message.message);
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
        this.stopAndRest();
      } else {
        log("  superseded: its speaker said something since, the reply is dropped");
      }
      return;
    }
    if (route === "ignore") return;
    // A whisper is answered by whisper (and so is the order it gives), anything else in public chat.
    const whisperTo = message.channel === "whisper" ? message.username : null;
    this.speak(decision.say, heardAt, [message.username], whisperTo);
    if (route === "stop") this.stopAndRest();
    // A request already on her stack is not taken again (live 2026-10-04: "thanks, no rush" while she fetched for
    // Opus's house came back as "later" with the same request, and a second house order was queued under the first).
    // The speaker is the requester: their authority is the order's.
    const asked = { text: decision.request, requester: message.username, purpose: parseActivity(decision.work) };
    if ((route === "act" || route === "later") && this.stack.some(({ objective }) => objective.requester === asked.requester && sameWords(objective.text, asked.text))) {
      log(`already on "${asked.text}" for ${asked.requester}`);
      return;
    }
    if (route === "act") this.take(asked, whisperTo);
    if (route === "later") {
      // Owner rule (2026-10-01): a player's request always comes before the character's own goal. The prompt says so,
      // but qwen3 still answered "later" to a plain request while on its own goal, so the stack enforces it: "later"
      // only waits behind work done for someone.
      const top = this.stack.at(-1);
      const objective = asked;
      if (top === undefined || top.objective.requester === null) this.take(objective, whisperTo);
      else this.queue(objective, whisperTo);
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
  private take(objective: Objective, whisperTo: string | null = null): void {
    const current = this.stack.at(-1);
    current?.step?.abort();
    this.sheltering?.abort();
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
    while (!signal.aborted) {
      const work = this.stack.at(-1);
      try {
        if (await this.shelterIfNight(work)) continue;
        if (work !== undefined) await this.advance(work);
        else if (!(await this.pickOwnObjective())) await this.idle(this.options.pollMs ?? DEFAULT_POLL_MS);
      } catch (error) {
        if (signal.aborted) break;
        this.options.log(`work loop error: ${String(error)}`);
        await this.idle(this.options.pollMs ?? DEFAULT_POLL_MS);
      }
    }
  }

  /**
   * TEMPORARY night measure (see night-shelter.ts): at nightfall, a step of its own goal is set aside (the objective
   * stays on the stack and resumes in the morning). Looked at every {@link NIGHT_CHECK_MS}.
   */
  private async stopOwnStepAtNightfall(): Promise<void> {
    if (!this.options.persona.settings.shelterAtNight || Date.now() - this.nightCheckedAt < NIGHT_CHECK_MS) return;
    const top = this.stack.at(-1);
    if (top?.step == null || top.objective.requester !== null || Date.now() < this.shelterRetryAt) return;
    this.nightCheckedAt = Date.now();
    if (!(await this.outInTheNight())) return;
    this.options.log("night fell: setting the step aside to dig in");
    top.step.abort();
  }

  /** Night in the overworld, and nothing over its head (underground or under a roof the night is no worse). */
  private async outInTheNight(): Promise<boolean> {
    const { runtime } = this.options;
    const snapshot = await runtime.status();
    return snapshot.clock?.phase === "night" && !(await underCover(runtime, snapshot.position));
  }

  /**
   * TEMPORARY night measure (see night-shelter.ts): at night, unless working on an order, it digs in and waits for the
   * day. True when it took the turn (sheltered, or tried to); a shelter that could not be made is not tried again for
   * {@link SHELTER_RETRY_MS}, so it goes on with its work meanwhile.
   */
  private async shelterIfNight(work: Work | undefined): Promise<boolean> {
    const { persona, runtime, log } = this.options;
    if (!persona.settings.shelterAtNight || Date.now() < this.shelterRetryAt) return false;
    if (work !== undefined && work.objective.requester !== null) return false;
    if (!(await this.outInTheNight())) return false;
    const controller = new AbortController();
    this.sheltering = controller;
    const objective = work?.objective.text ?? "(own goal)";
    const label = "shelter for the night";
    log(`night: ${label}`);
    this.journalState(label);
    const started = Date.now();
    let result: SkillResult;
    try {
      result = await shelterForNight({
        runtime,
        body: this.body,
        signal: AbortSignal.any([controller.signal, this.runSignal]),
        areas: this.areas,
        dayCame: async () => (await runtime.status()).clock?.phase !== "night",
      });
    } catch (error) {
      result = { status: "failed", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      this.sheltering = null;
    }
    if (result.status === "failed") this.shelterRetryAt = Date.now() + SHELTER_RETRY_MS;
    const outcome = result.status === "stopped" ? "interrupted" : result.status;
    const detail = result.status === "stopped" ? "left for an order, or stopped" : result.detail;
    log(`  -> ${label}: ${outcome}: ${detail}`);
    this.options.journal?.({ kind: "step", objective, requester: null, step: label, input: { skill: "shelter_for_night" }, thought: "", outcome, detail, ms: Date.now() - started, activity: null });
    this.journalState(null);
    if (result.status === "done") {
      this.lately.push(`${label}: ${detail}`);
      if (this.lately.length > OWN_MEMORY) this.lately.splice(0, this.lately.length - OWN_MEMORY);
    }
    return true;
  }

  /** Asks the goal tier for the next objective of the character's own goal; false when there is none to pick now. */
  private async pickOwnObjective(): Promise<boolean> {
    const { persona, mind, runtime, log } = this.options;
    if (persona.goal === undefined || Date.now() < this.restUntil) return false;
    if (!(await this.waitForGoalBudget())) return true;
    const snapshot = await runtime.status();
    const opportunities = await this.opportunities(snapshot);
    const hour = lastOfPlay(this.times);
    const time = minutesByActivity(hour);
    // What it feels like doing now (spec 2026-10-09-activity-draw): two activities drawn by their chances, which count
    // the hour's time spent *for* each, not the kind of work the body did.
    const spent = new Map(minutesByPurpose(hour).map(({ activity, minutes }) => [activity, minutes]));
    const chances = activityChances(availableActivities(persona.skills ?? SKILL_NAMES, snapshot), persona.preferences, persona.settings.feelingMultipliers, (activity) => spent.get(activity) ?? 0);
    const drawn = drawTwo(chances, this.options.random ?? Math.random);
    const { text, purpose } = await mind.chooseObjective({ persona, snapshot, places: this.knownPlaces(), areas: [...this.areas], lately: [...this.lately], lastFailed: this.lastFailed, opportunities, time, drawn, chances }, this.runSignal);
    // An order that arrived while it was thinking comes first; its own idea is dropped, it will think again.
    if (this.stack.length > 0 || Date.now() < this.restUntil) return true;
    log(`own objective: ${JSON.stringify(text)}${purpose === null ? " (no kind of work named for it)" : ` (for ${purpose})`}`);
    this.stack.push(newWork({ text, requester: null, purpose }));
    this.options.journal?.({ kind: "objective", event: "own", text, requester: null, opportunities, time, purpose, drawn, chances: chances.slice(0, TOP_CHANCES) });
    this.journalState(null);
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
      if (work.badReplies >= MAX_BAD_REPLIES) {
        // What the last step ran into is the cause the players hear; without it the narration made one up (live
        // 2026-10-03: "how do I build a house exactly around you without stepping on your feet?" when the logs she
        // needed were all inside her own protected houses).
        const last = work.steps.at(-1);
        this.finish(work, "failed", last === undefined || last.outcome === "done"
          ? "could not work out what to do next"
          : `could not work out what to do next after this: ${last.step} ${last.outcome}: ${last.detail}`);
      }
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
    // The runtime actions the step runs, timed: what a get_items step mostly did is its activity, and its walking is
    // travelling; a skill's phases (the house's site preparation) change the activity from then on.
    const actions: ActionTime[] = [];
    this.body.onAction = (tool, input, ms) => {
      if (tool !== "note_save" && tool !== "note_delete") actions.push({ tool, input, ms, ended: Date.now() });
    };
    const phases: ActivityPhase[] = [];
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
        phase: (activity) => phases.push({ activity, at: Date.now() }),
        ...(work.objective.requester !== null && { heardFrom: () => this.lastHeard.get(work.objective.requester!.toLowerCase()) ?? started }),
        // Only an order is narrated (owner, 2026-10-02); its own goals show in the monitor.
        ...(work.objective.requester !== null && { progress: (fact: string) => this.progress(work, fact) }),
      });
    } catch (error) {
      result = { status: "failed", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      work.step = null;
      this.body.onAction = null;
    }
    const ended = Date.now();
    const ms = ended - started;
    const { activity, spans } = await this.activityOf(decision.step, actions, snapshot, started, ended, phases);
    const { purpose } = work.objective;
    for (const span of spans) this.spent({ activity: span.activity, ...(purpose !== null && { purpose }), ended: new Date(ended).toISOString(), minutes: span.ms / 60_000 }, span.ms >= MIN_RECORDED_MS);
    if (Date.now() - this.rotatedAt >= ROTATE_EVERY_MS) await this.rotateActivityNotes();
    const record: StepRecord = result.status === "stopped"
      ? { step: label, outcome: "interrupted", detail: "set aside for something more urgent, or stopped" }
      : { step: label, outcome: result.status, detail: result.detail };
    work.steps.push(record);
    this.options.journal?.({ kind: "step", objective: work.objective.text, requester: work.objective.requester, step: label, input: decision.step, thought: decision.thought, outcome: record.outcome, detail: record.detail, ms, activity, times: spans, purpose });
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
      return;
    }
    if (record.outcome === "interrupted") return;
    work.failing = record.outcome === "failed"
      ? { skill: decision.step.skill, count: work.failing.skill === decision.step.skill ? work.failing.count + 1 : 1 }
      : { skill: "", count: 0 };
    if (work.failing.count >= persona.settings.maxSkillFailuresInARow) {
      this.finish(work, "failed", `${decision.step.skill.replaceAll("_", " ")} failed ${work.failing.count} times in a row, whichever way it was tried; the last: ${record.detail}`);
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
      this.lastFailed = outcome === "failed" ? { objective: objective.text, reason: detail } : null;
      this.lately.push(outcomeLine);
      if (this.lately.length > OWN_MEMORY) this.lately.splice(0, this.lately.length - OWN_MEMORY);
      this.memorize({ kind: "own_objective", outcome: outcomeLine });
      return;
    }
    void this.narrate(objective.text, outcome, detail, work.whisperTo);
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

  /**
   * The kind of work a finished step was, from game facts the runtime gives (block tags, hostile species, foods),
   * learnt once per name. Null for errands, or when the facts cannot be read (the step still happened).
   */
  private async activityOf(step: Step, actions: readonly ActionTime[], before: BotSnapshot, started: number, ended: number, phases: readonly ActivityPhase[]): Promise<{ readonly activity: Activity | null; readonly spans: readonly ActivitySpan[] }> {
    try {
      const after = await this.options.runtime.status();
      for (const food of [...before.foods, ...after.foods]) this.foods.add(food.name);
      const hostile = new Set([...before.mobs, ...after.mobs].filter((mob) => mob.hostile).map((mob) => mob.name));
      const blocks = actions.flatMap((action) => action.tool === "collect_block" && typeof action.input.block_name === "string" ? [action.input.block_name] : []);
      if (step.skill === "collect_block") blocks.push(step.block);
      const facts = { tags: await this.tagsOf(blocks), hostile, foods: this.foods };
      return { activity: activityOf(step, actions, facts), spans: activityTimes(step, actions, facts, started, ended, phases) };
    } catch (error) {
      this.options.log(`could not tell what kind of work that was: ${String(error)}`);
      return { activity: null, spans: [] };
    }
  }

  /** The game's block tags of these blocks, asked of the runtime once per name. */
  private async tagsOf(blocks: readonly string[]): Promise<Readonly<Record<string, readonly string[]>>> {
    const unknown = [...new Set(blocks)].filter((block) => !this.blockTags.has(block));
    if (unknown.length > 0) {
      const kinds = await this.options.runtime.blockKinds(unknown);
      for (const block of unknown) this.blockTags.set(block, kinds[block]?.tags ?? []);
    }
    return Object.fromEntries(blocks.map((block) => [block, this.blockTags.get(block) ?? []]));
  }

  /** Counts a step's time towards its activity; a long enough one is remembered across restarts. */
  private spent(time: ActivityTime, remember: boolean): void {
    this.times.push(time);
    this.times.splice(0, this.times.length, ...lastOfPlay(this.times));
    if (remember) this.memorize({ kind: "activity_time", time });
  }

  /** Things that could use doing now (the tasks a character looks for); the goal tier decides what to make of them. */
  private async opportunities(snapshot: BotSnapshot): Promise<Opportunity[]> {
    const ownHome = this.places.some((place) => place.own === true);
    const unfinished = this.building.unfinished;
    let houseShortfall: Shortfall[] = [];
    if (!ownHome && unfinished === null) {
      try {
        houseShortfall = await this.houseShortfall(snapshot);
      } catch (error) {
        this.options.log(`could not work out what a house of its own needs: ${String(error)}`);
      }
    }
    return findOpportunities({ now: Date.now(), snapshot, farms: this.farms, unfinished, ownHome, houseShortfall });
  }

  /** What a small house in its own style needs beyond what it carries, each with the work that gets it. */
  private async houseShortfall(snapshot: BotSnapshot): Promise<Shortfall[]> {
    const bill = planHouse(styleOrDefault(this.options.persona.style), "small", chooseSite(snapshot.position, null)).bill;
    const missing: Shortfall[] = [];
    for (const { item, count } of shortfall(bill, snapshot.inventory)) {
      let activity = this.itemActivities.get(item);
      if (activity === undefined) {
        const how = await obtainedBy(this.options.runtime, item);
        activity = how.way === "gather"
          ? gatheringActivity(how.block, { tags: await this.tagsOf([how.block]), hostile: new Set(), foods: this.foods })
          : how.way === "craft" || how.way === "smelt" ? "crafting" : how.way === "farm" ? "farming" : how.way === "hunt" ? "hunting" : null;
        this.itemActivities.set(item, activity);
      }
      if (activity !== null) missing.push({ item, count, activity });
    }
    return missing;
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
    const limits = { places: KNOWN_PLACES, lately: OWN_MEMORY, farms: KNOWN_FARMS, times: ACTIVITY_MEMORY };
    try {
      const rows = await this.options.runtime.queryBotData(recallQuery(this.options.persona.username, limits));
      const recalled = recall(rows.map((row) => String(row[1] ?? "")), limits);
      this.places.push(...recalled.places);
      this.lately.push(...recalled.lately);
      this.farms.push(...recalled.farms);
      for (const time of recalled.times) this.spent(time, false);
      this.building.unfinished = recalled.unfinished;
      this.savedUnfinished = JSON.stringify(recalled.unfinished);
      const house = recalled.unfinished === null ? "" : `, an unfinished ${recalled.unfinished.kind}`;
      this.options.log(`remembers ${recalled.places.length} place(s), ${recalled.farms.length} farm(s), ${recalled.lately.length} own objective(s)${house}`);
    } catch (error) {
      this.options.log(`could not recall its memory: ${String(error)}`);
    }
  }

  /**
   * Deletes its activity-time notes older than its last hour of play (spec 2026-10-04-activity-time-travel-
   * terraforming: only the last hour is kept), at start and then every {@link ROTATE_EVERY_MS}.
   */
  private async rotateActivityNotes(): Promise<void> {
    this.rotatedAt = Date.now();
    try {
      const rows = await this.options.runtime.queryBotData(activityNotesQuery(this.options.persona.username));
      const stale = staleActivityNotes(rows, RECENT_MINUTES);
      for (let start = 0; start < stale.length; start += DELETE_BATCH) {
        const outcome = await this.body.act("note_delete", { note_ids: stale.slice(start, start + DELETE_BATCH) }, "Forget what is older than my last hour of play.");
        if (outcome.status !== "succeeded") {
          this.options.log(`could not forget old activity notes (${outcome.status}): ${outcome.error ?? ""}`);
          return;
        }
      }
      if (stale.length > 0) this.options.log(`forgot ${stale.length} activity note(s) older than its last hour of play`);
    } catch (error) {
      this.options.log(`could not forget old activity notes: ${String(error)}`);
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
    void this.narrate(work.objective.text, "progress", fact, work.whisperTo);
  }

  /** Has the chat tier tell the players about an order: how it ended, or what it does now. */
  private async narrate(objective: string, outcome: "done" | "failed" | "progress", detail: string, whisperTo: string | null): Promise<void> {
    if (this.runSignal.aborted) return;
    try {
      const line = await this.options.mind.narrate({ persona: this.options.persona, objective, outcome, detail, history: this.history }, this.runSignal);
      this.speak(line, undefined, undefined, whisperTo);
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
    for (const work of this.stack) work.step?.abort();
    this.stack.length = 0;
    this.journalState(null);
    this.wake?.();
  }

  /** A player's "stop": everything ends, and no goal of its own starts for the persona's rest time. */
  private stopAndRest(): void {
    this.stopAll();
    this.restUntil = Date.now() + this.options.persona.settings.restAfterStopSeconds * 1_000;
  }

  /** `since`: when the message being answered was heard (thinking time counts as typing time). */
  private speak(text: string, since = Date.now(), to?: readonly string[], whisperTo: string | null = null): void {
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

/** `14 min ago` (or `just now`) from an ISO time, for the situation the models read. */
function minutesAgo(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "some time ago";
  return minutes < 1 ? "just now" : minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}
