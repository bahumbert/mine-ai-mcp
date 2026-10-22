import { setTimeout as sleep } from "node:timers/promises";
import { describeStep, stepKey, targetItems, type Step } from "./actions.ts";
import { activityOf, activityTimes, gatheringActivity, parseActivity, type Activity, type ActionTime, type ActivityPhase, type ActivitySpan } from "./activities.ts";
import { activityChances, availableActivities, drawTwo } from "./activity-draw.ts";
import { Body, HUMAN_TYPING, type TypingPace } from "./body.ts";
import { BUILD_ROLES, shortfall, type MaterialCount } from "./building/blueprint.ts";
import { improvement, temporaryRoles } from "./building/materials.ts";
import type { HouseSize } from "./building/house.ts";
import { chooseSite, planHouse, styleOrDefault } from "./building/plan.ts";
import { ConversationController, type ConversationBudget } from "./conversation/controller.ts";
import type { Conversation } from "./conversation/state.ts";
import { pickPartner, socialise, type SocialiseDeps } from "./conversation/socialise.ts";
import { Inbox, type Heard } from "./inbox.ts";
import { namesWord, type LocalizedChat } from "./llm-mind.ts";
import { FULL_INVENTORY, junkHint, neededItems } from "./inventory-room.ts";
import { obtainedBy } from "./gathering.ts";
import type { BrainEvent } from "./brain-log.ts";
import { FAILED_STEP_MINUTES, MOVED_BLOCKS, sameWords, type ChatInput, type ChatLine, type EarlierFailure, type KnownPlace, type Mind, type Objective, type StepRecord, type WorkDecision } from "./mind.ts";
import { AgentRelations } from "./relations/agent-relations.ts";
import { describeLacks, itemsYieldedBy } from "./relations/chat-trade.ts";
import { describeHandoff, handoffKey, type Handoff } from "./relations/handoff.ts";
import { TradeAsks, tradeNeedsFacts, tradePlan, tradeRoutine, withTrading, withoutRefusedTrading } from "./relations/trading.ts";
import { activityNotesQuery, memoryNote, recall, recallQuery, staleActivityNotes, type KnownFarm, type Memory } from "./memory.ts";
import { findOpportunities, type Opportunity, type OpportunityFacts, type Shortfall } from "./opportunities.ts";
import { shelterForNight, underCover } from "./night-shelter.ts";
import { personaSkills, type Persona } from "./persona.ts";
import type { BlockKind, BotRuntime, BotSnapshot, PlayerMessage, Position, ProtectedArea } from "./runtime-client.ts";
import type { EveryoneLines } from "./everyone-lines.ts";
import { TillFacts } from "./farming/site.ts";
import { RESUME_RANGE, runStep, type SkillResult, type UnfinishedHouse } from "./skills.ts";
import { lastOfPlay, minutesByActivity, minutesByPurpose, RECENT_MINUTES, type ActivityTime } from "./time-spent.ts";

/** The error the runtime client throws when the body restarted under a call (see McpBotRuntime). */
const BODY_RESTARTED = "[BODY_RESTARTED]";
/** How often the agent checks for new chat. */
const DEFAULT_POLL_MS = 500;
const STARTUP_RETRY_MS = 10_000;
/** Chat lines kept as conversational context. */
const HISTORY_LINES = 12;
/** Known places shown to the models; the oldest is forgotten first. */
/** Carried full blocks named to the goal tier as materials a house could use. */
const MAX_CARRIED_BLOCKS = 5;
const KNOWN_PLACES = 8;
/** Steps kept per objective for the work tier. */
const STEP_MEMORY = 20;
/** The longest wait after the same work loop error repeated. */
const MAX_ERROR_WAIT_MS = 60_000;
/** Outcomes of its own objectives remembered for the goal tier. */
const OWN_MEMORY = 5;
/** How many failed steps are kept (live 2026-10-10). */
const FAILED_STEP_MEMORY = 8;
/** A step out to obtain items is stopped when none of them increased in the inventory for this long (owner, 2026-10-10), looked at every {@link GAIN_SAMPLE_MS}. */
const NO_GAIN_MINUTES = 5;
/** A fetch travelling to a known source that gets this much nearer counts as progress for the no-gain stop (owner, 2026-10-11). */
const NEARER_BLOCKS = 16;
const GAIN_SAMPLE_MS = 30_000;
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
/** Decisions in a row that a content check kept sending back (not a format failure: those are bad replies). */
const MAX_SENT_BACKS = 4;
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
   * Usernames of the other agents. Their lines are answered only inside a conversation (a member of it, or a line
   * naming this character or a member), so two bots cannot talk each other into an endless chatter; with
   * {@link AgentOptions.conversations} absent they are never answered.
   */
  readonly otherAgents: readonly string[];
  /** Conversations (spec 2026-10-18-conversations-design); absent: the character holds none. */
  readonly conversations?: { readonly budget: ConversationBudget; readonly modelFree: () => boolean; readonly waitForModel?: (ms: number, signal: AbortSignal) => Promise<boolean> };
  /**
   * The lines to everyone the brain's agents heard, shared by all of them: a greeting that asks nothing is answered by
   * the bot nearest the speaker only. Absent: such a line is never answered.
   */
  readonly everyone?: EveryoneLines;
  /** The server's Localized Chat, when the brain is told it runs: talk carries its range, and a call may be shouted. */
  readonly localizedChat?: LocalizedChat;
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

/** One objective on the stack and what was done for it. */
interface Work {
  readonly objective: Objective;
  /** When it was taken on (ms), for the socialising routine: a talk ended since then is the one it came for. */
  readonly startedAt: number;
  readonly steps: StepRecord[];
  /** What was carried after each of `steps` (name:count, sorted; null when unknown); not shown to the model, so prompts do not change. */
  readonly carried: (string | null)[];
  taken: number;
  badReplies: number;
  sentBacks: number;
  /** Aborts the step running now: the objective is set aside or stopped, the agent goes on. */
  step: AbortController | null;
  /** The last thing a skill said it started doing, and when a line about it was last asked for (an order's progress). */
  lastFact: string;
  spokenAt: number;
  /** The skill whose steps failed last, and how many times in a row. */
  failing: { skill: string; count: number };
  /** Who the order came from by whisper: its progress and its end are whispered back to them (spec 2026-10-09, C). */
  whisperTo: string | null;
  /** Step key -> refusals since that step last ran (rule 2: three end the objective); counted by the mind, reset here. */
  readonly refused: Map<string, number>;
  /** The items its get_items and craft_item steps went out to obtain: not junk when a full inventory is cleared. */
  readonly wanted: Set<string>;
  /** Where a level_area around each player (lower-case name) was first aimed in this objective: later steps reuse it (run 13). */
  readonly levelSites: Map<string, { readonly x: number; readonly y: number; readonly z: number }>;
  /**
   * What its time counts for: the objective's purpose, until one of its steps builds, improves a house or farms; from
   * then on that (run 11, 2026-10-14: houses were labelled crafting, mining or woodcutting by the goal tier).
   */
  purpose: Activity | null;
}

/** What is carried, as `name:count` sorted (totals per name): compared to tell whether the inventory changed. */
function carriedOf(snapshot: BotSnapshot): string {
  const totals = new Map<string, number>();
  for (const { name, count } of snapshot.inventory) totals.set(name, (totals.get(name) ?? 0) + count);
  return [...totals].map(([name, count]) => `${name}:${count}`).sort().join(",");
}

/** Skills that are an end in themselves: an objective that runs one is for that work (its fetches included). */
const ENDS: ReadonlyMap<Step["skill"], Activity> = new Map([["build", "building"], ["improve_house", "building"], ["farm", "farming"]]);

function newWork(objective: Objective, whisperTo: string | null = null): Work {
  return { objective, startedAt: Date.now(), steps: [], carried: [], taken: 0, badReplies: 0, sentBacks: 0, step: null, lastFact: "", spokenAt: Date.now(), failing: { skill: "", count: 0 }, whisperTo, refused: new Map(), wanted: new Set(), levelSites: new Map(), purpose: objective.purpose };
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
  /** Per speaker (lower case), the latest character (this one or another agent) a line of theirs named, and when. */
  private readonly lastNamed = new Map<string, { readonly name: string; readonly at: number }>();
  private readonly places: KnownPlace[] = [];
  /** Its farms, oldest first, each as it was at its last tend. */
  private readonly farms: KnownFarm[] = [];
  private readonly soil: TillFacts;

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
  /** The game's data per block name, as the runtime reports it (null: no such block), read once. */
  private readonly blockKindCache = new Map<string, BlockKind | null>();
  private readonly foods = new Set<string>();
  private readonly itemActivities = new Map<string, Activity | null>();
  private readonly building: { unfinished: UnfinishedHouse | null } = { unfinished: null };
  /** The unfinished house as last saved to memory, to save it again only when it changed. */
  private savedUnfinished = "null";
  private readonly stack: Work[] = [];
  private readonly lately: string[] = [];
  /** Its last own objective, when it failed (the goal tier sends it back once if chosen again as it was). */
  private lastFailed: { readonly objective: string; readonly reason: string } | null = null;
  /** Steps that failed lately, whatever the objective, newest last: shown to the work tier, which refuses a second repeat. */
  private readonly failedSteps: { readonly objective: Objective; readonly step: string; readonly key: string; readonly detail: string; readonly at: number; readonly failures: readonly number[]; readonly carried: string | null; readonly position: Position | null }[] = [];
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

  /** Its conversations; null when the brain runs without them. */
  private readonly talks: ConversationController | null;
  /** Its relations and trades (spec 2026-10-19-relations-trading-design); null when `settings.relations.enabled` is false. */
  private readonly relations: AgentRelations | null;
  /** The items the running step is out to get: what it gains is its own work, never a partner's payment. */
  private stepYields: ReadonlySet<string> = new Set();
  /** Who was online at the last look, as spelled in the game: the names a line may hold. */
  private onlineNames: readonly string[] = [];
  /** The last look at the world by the conversation check: where players stood when a line carries no distance. */
  private lastLook: BotSnapshot | null = null;
  /** What an own objective could not get and who refused to trade it, for ten minutes (relations/trading.ts). */
  private readonly asks = new TradeAsks();
  /** When conversations were last looked at, and whether that look is still running. */
  private talksCheckedAt = 0;
  private talksLooking = false;
  /** The conversation check could not read the runtime: logged once, again only after a read worked. */
  private talksUnreadable = false;

  constructor(private readonly options: AgentOptions) {
    this.soil = options.soil ?? new TillFacts();
    this.body = new Body(options.runtime, options.log, options.typing ?? HUMAN_TYPING);
    this.inbox = new Inbox(options.persona.settings.chatBurstMs);
    const { conversations, persona, localizedChat } = options;
    this.relations = !persona.settings.relations.enabled ? null : new AgentRelations({
      persona, mind: options.mind, runtime: options.runtime, body: this.body, takeHandoff: (h) => this.takeHandoff(h),
      modelSlotFree: conversations?.modelFree ?? (() => true), inConversationWith: (name) => this.talks?.isMember(name) === true,
      lacks: (inventory) => describeLacks(this.stack.at(-1)?.wanted ?? [], inventory ?? this.lastLook?.inventory ?? []),
      journal: (event) => options.journal?.(event), log: (line) => options.log(line),
    });
    this.talks = conversations === undefined ? null : new ConversationController({
      self: persona.username,
      persona,
      mind: options.mind,
      budget: conversations.budget,
      modelFree: conversations.modelFree,
      ...(conversations.waitForModel !== undefined && { waitForModel: conversations.waitForModel }),
      talkRange: localizedChat?.range ?? persona.settings.conversation.stayingDistance,
      localized: localizedChat !== undefined,
      random: options.random ?? Math.random,
      now: Date.now,
      speak: (text, to, whisperTo, shout) => this.speak(text, undefined, to, whisperTo, shout),
      journal: (event) => options.journal?.(event),
      memorize: (talk) => this.memorize(talk),
      log: (line) => options.log(line),
      history: () => this.history,
      ...(this.relations !== null && { relations: this.relations.forConversations() }),
    });
  }

  /** The conversation it is in now, if any. */
  get conversation(): Conversation | null {
    return this.talks?.current ?? null;
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
    // Logged once while the runtime stays down, and again only after a read worked (review R17).
    let unreadable = false;
    try {
      while (!signal.aborted) {
        // Reading never waits for the chat tier: lines that come while it thinks are heard at once (and may supersede
        // its reply), so a "stop" is not stuck behind a queue of calls.
        // A runtime restarting under a poll fails the read: the next poll tries again (review B5).
        try {
          for (const message of await this.options.runtime.readMessages()) {
            // Its own line coming back is never a member's: it must not reset a silence or wake its own chat.
            if (message.username.toLowerCase() === this.options.persona.username.toLowerCase()) continue;
            this.lastHeard.set(message.username.toLowerCase(), Date.now());
            this.relations?.trades.heardLine(message.username, Date.now());
            if (message.channel === "chat") this.options.everyone?.heard(message.username, message.message, this.options.persona.username, message.distance ?? null);
            this.inbox.push(message);
            this.wakeChat?.();
          }
          unreadable = false;
        } catch (error) {
          if (!unreadable) this.options.log(`chat unreadable, retrying at the next poll (not logged again until a read works): ${String(error)}`);
          unreadable = true;
        }
        this.lookAtConversations();
        this.relations?.look(this.stepYields, new Set(this.stack.flatMap((work) => work.objective.handoff === undefined ? [] : [handoffKey(work.objective.handoff)])), signal);
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
    const talkedTo = this.noteNamed(message, heardAt);
    const named = this.namedIn(message);
    if (!this.hears(message, named)) return;
    if (!(await this.conversationGate(message, heard, named))) return;
    let decision;
    let conversation;
    let snapshot: BotSnapshot;
    try {
      snapshot = await this.options.runtime.status();
      conversation = this.talks?.facts();
      const claimEveryoneLine = this.everyoneLineClaim(message, snapshot);
      const input: ChatInput = { persona, message, history: this.history.slice(0, -1), snapshot, activity: this.activity, places: this.knownPlaces(), areas: [...this.areas], canWait: (this.stack.at(-1)?.objective.requester ?? null) !== null, knownNames: this.options.knownNames ?? [], ...(talkedTo !== undefined && { talkedTo }), ...(conversation !== undefined && { conversation }), ...(claimEveryoneLine !== undefined && { claimEveryoneLine }), ...(this.relations !== null && { relations: this.relations.chatBlock(message.username, conversation?.others ?? [], snapshot) }) };
      decision = await mind.chat(input, this.runSignal);
      if (this.relations !== null && decision.trade !== undefined) decision = await this.relations.checkedTrade(decision, input, { speaker: message.username, snapshot, signal: this.runSignal });
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
    const superseded = this.supersededBy(message, heard);
    const talkId = conversation === undefined ? undefined : this.talks?.current?.id;
    this.options.journal?.({ kind: "chat", speaker: message.username, text: message.message, channel: message.channel, lines: heard?.lines ?? 1, route, say: decision.say, superseded, ...(talkId !== undefined && { conversation: talkId }), ...(decision.to !== undefined && { to: decision.to }), ...(decision.place !== undefined && { place: decision.place }), ...(decision.startsNow !== undefined && { startsNow: decision.startsNow }) });
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
    this.speak(decision.say, heardAt, [message.username], whisperTo, decision.shout === true);
    const tradeId = decision.trade === undefined ? null : await this.relations?.decided(decision, message.username, snapshot) ?? null;
    if (conversation !== undefined) this.spokeInConversation(decision);
    // A stop ends the speaker's work and the character's own goals only, the other players' queued orders stay, with or
    // without a request (owner, 2026-10-16, review R18, SF4: "a stop ends only the speaker's work").
    if (routed === "stop" || (carriesRequest && this.stack.length > 0)) this.stopAndRest(message.username);
    // A line that made a trade is that trade's action: its hand-off is what she does, not an order on top whose give the trade never sees (live 2026-10-19, B1).
    if ((routed === "act" || routed === "later") && tradeId !== null) {
      log(`the request is trade ${tradeId}: no order taken (${JSON.stringify(decision.request)})`);
      return;
    }
    // A request already on her stack is not taken again (live 2026-10-04: "thanks, no rush" while she fetched for
    // Opus's house came back as "later" with the same request, and a second house order was queued under the first).
    // The speaker is the requester: their authority is the order's.
    const asked = { text: decision.request, requester: message.username, purpose: parseActivity(decision.work), ...(decision.place !== undefined && { place: decision.place }) };
    if ((routed === "act" || routed === "later") && this.stack.some(({ objective }) => objective.requester === asked.requester && sameWords(objective.text, asked.text))) {
      log(`already on "${asked.text}" for ${asked.requester}`);
      return;
    }
    if (routed === "act") this.take(asked, whisperTo);
    if (routed === "later") this.takeAfterOwnGoal(asked, whisperTo);
  }

  /** A "later" request: taken at once over the character's own goal, queued behind work done for someone. */
  private takeAfterOwnGoal(objective: Objective, whisperTo: string | null): void {
    // Owner rule (2026-10-01): a player's request always comes before the character's own goal. The prompt says so,
    // but qwen3 still answered "later" to a plain request while on its own goal, so the stack enforces it: "later"
    // only waits behind work done for someone.
    const top = this.stack.at(-1);
    if (top === undefined || top.objective.requester === null) this.take(objective, whisperTo);
    else this.queue(objective, whisperTo);
  }

  /** Whether the message's speaker went on, or in a conversation any member spoke, since it was taken (its reply answers a state that is gone). */
  private supersededBy(message: PlayerMessage, heard: Heard | undefined): boolean {
    if (heard === undefined) return false;
    const self = this.options.persona.username.toLowerCase();
    const members = this.talks?.current?.members.filter((name) => name.toLowerCase() !== self) ?? [];
    return this.inbox.superseded(message.username, heard.seq) || this.inbox.spokeSince(members, heard.seq);
  }

  /** Her line in a conversation counts in it; a goodbye (or a line after the cap) ends it. */
  private spokeInConversation(decision: { readonly say: string; readonly close?: boolean }): void {
    if (decision.say.trim() !== "") this.talks?.said(decision.close === true, this.runSignal);
    else if (decision.close === true) this.talks?.end("goodbye", this.runSignal);
  }

  /** Whether each speaker (lowercase) was already in the conversation when their last line was heard. */
  private readonly memberBeforeLine = new Map<string, boolean>();

  /**
   * Who the agent hears at all; whether a message is meant for it is the chat tier's call (no name needed). Another
   * agent is heard only inside a conversation: a member of it, or a line naming this character or a member (an opening
   * or a join, see {@link AgentOptions.otherAgents}).
   */
  private hears(message: PlayerMessage, named: readonly string[]): boolean {
    const { persona, otherAgents } = this.options;
    const speaker = message.username.toLowerCase();
    const agent = otherAgents.some((name) => name.toLowerCase() === speaker);
    if (!agent && !(persona.listensTo.length === 0 || persona.listensTo.some((name) => name.toLowerCase() === speaker))) return false;
    // A line naming her makes its speaker a member: whether they already were is what a request of theirs is judged by.
    this.memberBeforeLine.set(speaker, this.talks?.isMember(message.username) === true);
    this.talks?.heard(message.username, message.message, named, message.channel, !agent && this.withinTalkRange(message));
    return !agent || this.talks?.isMember(message.username) === true;
  }

  /**
   * What lets the chat tier answer a greeting to everyone: the speaker's distance, from the positions when the line
   * carries none, goes to the record shared with the other agents; the claim is true for the nearest bot only.
   */
  private everyoneLineClaim(message: PlayerMessage, snapshot: BotSnapshot): (() => boolean) | undefined {
    const { everyone, persona } = this.options;
    if (everyone === undefined || message.channel !== "chat") return undefined;
    const at = snapshot.players.find((player) => player.username.toLowerCase() === message.username.toLowerCase())?.position;
    if (message.distance === undefined && at !== undefined && at !== null) {
      everyone.heard(message.username, message.message, persona.username, Math.hypot(at.x - snapshot.position.x, at.y - snapshot.position.y, at.z - snapshot.position.z));
    }
    return () => everyone.claim(message.username, message.message, persona.username);
  }

  /** Whether a player's line came from within talk range: its distance, else where the last look put them. */
  private withinTalkRange(message: PlayerMessage): boolean {
    const range = this.options.localizedChat?.range ?? this.options.persona.settings.conversation.stayingDistance;
    if (message.distance !== undefined) return message.distance <= range;
    const at = this.lastLook?.players.find((player) => player.username.toLowerCase() === message.username.toLowerCase())?.position;
    return at !== undefined && at !== null && this.lastLook !== null && Math.abs(at.x - this.lastLook.position.x) + Math.abs(at.y - this.lastLook.position.y) + Math.abs(at.z - this.lastLook.position.z) <= range;
  }

  /** The characters and players a line holds as words (not its speaker), as spelled in the game. */
  private namedIn(message: PlayerMessage): string[] {
    const { persona, otherAgents, knownNames } = this.options;
    const candidates = [persona.username, ...otherAgents, ...(knownNames ?? []), ...this.onlineNames, ...(this.talks?.current?.members ?? [])];
    const seen = new Set<string>([message.username.toLowerCase()]);
    return candidates.filter((name) => {
      if (seen.has(name.toLowerCase()) || !namesWord(message.message, name)) return false;
      seen.add(name.toLowerCase());
      return true;
    });
  }

  /**
   * In a conversation of three or more, not every member answers every line (spec 2026-10-18): a line naming members
   * but not her is only recorded; a line naming nobody is answered after a random wait, unless a member spoke meanwhile.
   * True: go on to the chat tier.
   */
  private async conversationGate(message: PlayerMessage, heard: Heard | undefined, named: readonly string[]): Promise<boolean> {
    const talk = this.talks?.current;
    if (talk === null || talk === undefined || talk.members.length < 3) return true;
    const { persona, log } = this.options;
    const self = persona.username.toLowerCase();
    if (message.addressed || message.channel === "whisper" || named.some((name) => name.toLowerCase() === self)) return true;
    if (named.some((name) => this.talks?.isMember(name))) {
      log(`  group: ${message.username} named ${named.join(", ")}, not me: recorded, no answer`);
      return false;
    }
    const [from, to] = persona.settings.conversation.groupReplyJitterMs;
    await sleep(from + (this.options.random ?? Math.random)() * (to - from), undefined, { signal: this.runSignal }).catch(() => undefined);
    const others = (this.talks?.current?.members ?? []).filter((name) => name.toLowerCase() !== self);
    if (heard !== undefined && this.inbox.spokeSince(others, heard.seq)) {
      log("  group: a member spoke meanwhile, no answer");
      return false;
    }
    return true;
  }

  /**
   * Looks after the conversation in the background, so a slow opening call never holds up reading the chat: range and
   * silence ends while in one, else the code gate of an opening every check interval.
   */
  private lookAtConversations(): void {
    const talks = this.talks;
    if (talks === null || this.talksLooking || this.runSignal.aborted) return;
    if (talks.current === null && Date.now() - this.talksCheckedAt < this.options.persona.settings.conversation.checkEverySeconds * 1_000) return;
    this.talksCheckedAt = Date.now();
    this.talksLooking = true;
    void (async () => {
      const snapshot = await this.options.runtime.status();
      this.talksUnreadable = false;
      this.onlineNames = snapshot.players.map((player) => player.username);
      this.lastLook = snapshot;
      await talks.tick(snapshot, this.runSignal);
      // An order, a night shelter or a socialising objective on its way (it opens its own conversation) is busy enough.
      const top = this.stack.at(-1);
      const busy = (top?.objective.requester ?? null) !== null || top?.objective.purpose === "socialising" || top?.objective.purpose === "trading" || this.sheltering !== null;
      await talks.maybeOpen({ snapshot, activity: this.activity, lately: this.lately, lastFailed: this.lastFailed, busy }, this.runSignal);
    })()
      .catch((error: unknown) => {
        if (!this.talksUnreadable) this.options.log(`conversation check failed (not logged again until a read works): ${String(error)}`);
        this.talksUnreadable = true;
      })
      .finally(() => { this.talksLooking = false; });
  }

  /** Puts something the character took on above what it was doing, which is set aside (its step stopped) and resumes later. */
  private take(objective: Objective, whisperTo: string | null = null): void {
    // A member's request is worked on while the conversation goes on, as a chance conversation does; anything else takes the body.
    if (objective.requester === null || this.memberBeforeLine.get(objective.requester.toLowerCase()) !== true) this.talks?.end("taken_over", this.runSignal);
    const current = this.stack.at(-1);
    current?.step?.abort();
    this.sheltering?.abort();
    this.stack.push(newWork(objective, whisperTo));
    this.journalObjective("taken", objective);
    this.wake?.();
  }

  /** A trade's hand-off goes on top of what it does, like an order that takes the body; its own decision, so no authority is asked. */
  private takeHandoff(h: Handoff): void {
    this.stack.at(-1)?.step?.abort();
    this.sheltering?.abort();
    const objective = { text: describeHandoff(h), requester: null, purpose: null, handoff: h };
    this.stack.push(newWork(objective));
    this.journalObjective("taken", objective);
    this.wake?.();
  }

  /** The step of a hand-off objective: the routine in relations/handoff.ts; a stop or a shelter drops it and the trade stays due. */
  private async handoffStep(work: Work, h: Handoff): Promise<void> {
    const { runtime, persona } = this.options;
    const controller = new AbortController();
    work.step = controller;
    this.journalState(describeHandoff(h));
    let end = { outcome: "dropped", detail: "" };
    try {
      end = await this.relations!.runHandoff(h, { runtime, body: this.body, signal: AbortSignal.any([controller.signal, this.runSignal]), self: persona.username });
    } finally {
      work.step = null;
      this.journalState(null);
    }
    if (end.outcome !== "dropped") this.finish(work, end.outcome === "done" ? "done" : "failed", end.detail);
    // A wait that a give or a collect set aside stays below it and resumes; any other dropped hand-off leaves the stack.
    else if (this.stack.includes(work) && !(h.kind === "await" && this.stack.at(-1) !== work)) this.stack.splice(this.stack.indexOf(work), 1);
  }

  /** The step runs: its controller stops it, and the items it is out to get are its own work, never a partner's payment. */
  private startStep(work: Work, controller: AbortController, step: Step): void {
    work.step = controller;
    this.stepYields = itemsYieldedBy(step);
  }

  private endStep(work: Work): void {
    work.step = null;
    this.stepYields = new Set();
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
        if (await this.shelterIfNight(work)) continue;
        if (work !== undefined) await (work.objective.handoff === undefined ? this.advance(work) : this.handoffStep(work, work.objective.handoff));
        else if (!(await this.pickOwnObjective())) await this.idle(this.options.pollMs ?? DEFAULT_POLL_MS);
        repeated = { error: "", count: 0 };
      } catch (error) {
        if (signal.aborted) break;
        const text = String(error);
        repeated = text === repeated.error ? { error: text, count: repeated.count + 1 } : { error: text, count: 1 };
        if (Number.isInteger(Math.log10(repeated.count))) this.options.log(`work loop error${repeated.count > 1 ? ` (${repeated.count} times)` : ""}: ${text}`);
        const poll = this.options.pollMs ?? DEFAULT_POLL_MS;
        await this.idle(Math.min(poll * 2 ** (repeated.count - 1), Math.max(poll, MAX_ERROR_WAIT_MS)));
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
    this.talks?.end("taken_over", this.runSignal);
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
    const hour = lastOfPlay(this.times);
    const time = minutesByActivity(hour);
    // What it feels like doing now (spec 2026-10-09-activity-draw): two activities drawn by their chances, which count
    // the hour's time spent *for* each, not the kind of work the body did.
    const spent = new Map(minutesByPurpose(hour).map(({ activity, minutes }) => [activity, minutes]));
    // Trading is not drawn while every partner refused lately: it would only fail "no one to trade with".
    const available = withoutRefusedTrading(availableActivities(personaSkills(persona), snapshot, this.partners()), this.partners(), this.asks, Date.now());
    const chances = activityChances(available, persona.preferences, persona.settings.feelingMultipliers, (activity) => spent.get(activity) ?? 0);
    // Getting an item failed lately: trading takes the second place while someone has not refused it yet.
    this.asks.dropRefused(this.partners(), Date.now());
    const needs = this.asks.needs.current(Date.now(), snapshot.inventory);
    const drawn = withTrading(drawTwo(chances, this.options.random ?? Math.random), available, needs);
    const tradeNeeds = needs.length > 0 && drawn.includes("trading") ? tradeNeedsFacts(needs, this.partners(), this.asks, snapshot.inventory, Date.now()) : undefined;
    const opportunities = await this.opportunities(snapshot, drawn, tradeNeeds);
    const { text, purpose } = await mind.chooseObjective({ persona, snapshot, places: this.knownPlaces(), areas: [...this.areas], lately: [...this.lately], lastFailed: this.lastFailed, opportunities, time, drawn, chances, ...(this.relations !== null && { relations: this.relations.lines(this.partners()) }) }, this.runSignal);
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
    if (work.objective.requester === null && work.objective.purpose === "socialising") return this.socialiseStep(work);
    if (work.objective.requester === null && work.objective.purpose === "trading") return this.tradeStep(work);
    const snapshot = await runtime.status();
    await this.keepSettings(snapshot);
    let decision: WorkDecision;
    try {
      const paused = this.stack.slice(0, -1).map((below) => below.objective);
      decision = await mind.next({ persona, objective: work.objective, snapshot, places: this.knownPlaces(), areas: [...this.areas], steps: [...work.steps], paused, earlierFailures: this.earlierFailures(snapshot), ownsTemporaryHouse: this.temporaryHouse() !== null, refused: work.refused }, this.runSignal);
      work.badReplies = 0;
      work.sentBacks = 0;
    } catch (error) {
      if (this.runSignal.aborted) return;
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
    this.startStep(work, controller, decision.step);
    this.journalState(label);
    const started = Date.now();
    // The runtime actions the step runs, timed: what a get_items step mostly did is its activity, and its walking is
    // travelling; a skill's phases (the house's site preparation) change the activity from then on.
    const actions: ActionTime[] = [];
    // The step runs: its earlier refusals are forgotten (rule 2 counts refusals with no run in between).
    work.refused.delete(stepKey(decision.step));
    for (const { item } of targetItems(decision.step)) work.wanted.add(item);
    if (decision.step.skill === "collect_block") work.wanted.add(decision.step.block);
    const gain = this.watchGain(decision.step, snapshot, controller);
    this.body.onAction = (tool, input, ms) => {
      gain.alive();
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
        ownHouse: () => this.temporaryHouse(),
        farms: this.farms,
        rememberFarm: (farm) => this.learnFarm(farm),
        soil: this.soil,
        building: this.building,
        areas: this.areas,
        levelSites: work.levelSites,
        ...(work.objective.requester === null && { needed: (current: BotSnapshot) => this.neededFor(current, work) }),
        phase: (activity) => {
          gain.alive();
          phases.push({ activity, at: Date.now() });
        },
        heading: gain.heading,
        alive: gain.alive,
        ...(work.objective.requester !== null && { heardFrom: () => this.lastHeard.get(work.objective.requester!.toLowerCase()) ?? started }),
        // Only an order is narrated (owner, 2026-10-02); its own goals show in the monitor.
        ...(work.objective.requester !== null && { progress: (fact: string) => {
          gain.alive();
          this.progress(work, fact);
        } }),
      });
    } catch (error) {
      result = { status: "failed", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      gain.stop();
      this.endStep(work);
      this.body.onAction = null;
    }
    const ended = Date.now();
    const ms = ended - started;
    const { activity, spans, carried, position, room } = await this.activityOf(decision.step, actions, snapshot, started, ended, phases);
    // A house or a farm is what the objective turned out to be for, whatever its label said (the end decides).
    const endPurpose = ENDS.get(decision.step.skill);
    if (endPurpose !== undefined) work.purpose = endPurpose;
    const { purpose } = work;
    for (const span of spans) this.spent({ activity: span.activity, ...(purpose !== null && { purpose }), ended: new Date(ended).toISOString(), minutes: span.ms / 60_000 }, span.ms >= MIN_RECORDED_MS);
    if (Date.now() - this.rotatedAt >= ROTATE_EVERY_MS) await this.rotateActivityNotes();
    // Stopped for gaining nothing (not by an order or a "stop"): it failed, and the model is told how far it got.
    const stalled = gain.stalled();
    let record: StepRecord = stalled !== null && result.status !== "done"
      ? { step: label, outcome: "failed", detail: stalled }
      : result.status === "stopped"
        ? { step: label, outcome: "interrupted", detail: "set aside for something more urgent, or stopped" }
        : { step: label, outcome: result.status, detail: result.detail };
    // A full inventory names what to drop, with whole counts, and spares what the work needs (live 2026-10-10/11).
    if (record.outcome === "failed" && room !== null && FULL_INVENTORY.test(record.detail)) record = { ...record, detail: `${record.detail}; ${junkHint(room, this.neededFor(room, work))}` };
    work.steps.push(record);
    work.carried.push(carried);
    // The step was not wrong: the body restarted under it. It is shown as failed, but is no refusal, no repeat and no streak.
    const restarted = record.outcome === "failed" && record.detail.includes(BODY_RESTARTED);
    if (record.outcome === "failed" && !restarted) this.rememberFailedStep(work.objective, label, stepKey(decision.step), record.detail, carried, position);
    this.options.journal?.({ kind: "step", objective: work.objective.text, requester: work.objective.requester, step: label, input: decision.step, thought: decision.thought, outcome: record.outcome, detail: record.detail, ms, activity, times: spans, purpose });
    this.journalState(null);
    // A give made by any objective but the trade's own hand-off still counts for the trade with that player (B1).
    if (decision.step.skill === "give_item" && record.outcome === "done" && work.objective.handoff === undefined) {
      // Only what the partner took counts; a toss left at their feet is not a give (s1d, F6).
      const taken = result.status === "done" ? result.taken ?? decision.step.count : 0;
      if (taken > 0) this.relations?.gaveOutside(decision.step.player, decision.step.item, taken);
    }
    if (work.steps.length > STEP_MEMORY) {
      work.steps.splice(0, work.steps.length - STEP_MEMORY);
      work.carried.splice(0, work.carried.length - STEP_MEMORY);
    }
    log(`  -> ${record.outcome}: ${record.detail}`);
    const unfinished = JSON.stringify(this.building.unfinished);
    if (unfinished !== this.savedUnfinished) {
      this.savedUnfinished = unfinished;
      this.memorize({ kind: "unfinished_house", house: this.building.unfinished });
    }
    if (restarted) return;
    // A model that keeps choosing a step that ends the same way is stuck; the loop must not spin until the step cap.
    const same = persona.settings.maxSameStepInARow;
    // A step done each time but leaving the inventory different gained something (live 2026-10-09: three "collected 32
    // cobblestone" in a row ended an objective as "changed nothing"): only an unchanged inventory means it is stuck.
    const last = work.steps.slice(-same);
    const carriedLast = work.carried.slice(-same);
    // A drop is never "gaining": one that worked needs no repeat, and drop, pick up, drop moves the inventory too (live
    // 2026-10-10 run 7: one drop step 26 times in a row).
    const gaining = record.outcome === "done" && decision.step.skill !== "drop_item" && carriedLast.some((kept) => kept !== carriedLast[0]);
    if (record.outcome !== "interrupted" && !gaining && last.length === same && last.every((step) => step.step === record.step && step.outcome === record.outcome && step.detail === record.detail)) {
      this.finish(work, "failed", `${record.step} ${record.outcome === "done" ? "changed nothing" : "failed the same way"} ${same} times in a row: ${record.detail}`);
      return;
    }
    // The same step done `same` times in a row ends the objective as failed, gaining or not (a requester must not be told done) (live 2026-10-11 run 10: "collect
    // 16 dirt" 60+ times, "get 1 oak_boat" 13): a gain that never ends the objective is no progress for it. A failed or
    // another step in between resets the count.
    if (record.outcome === "done" && last.length === same && last.every((step) => step.step === record.step && step.outcome === "done")) {
      this.finish(work, "failed", `the same step (${record.step}) was done ${same} times in a row and the objective is not reached`);
      return;
    }
    // The same failure between other steps is the same loop (live 2026-10-09: Ayla's farm in a cave failed "25 not
    // tillable (air)" 20 times in 11 minutes, each time after a different step; Vex's explore for coal_ore, 9 times in
    // four ways). The detail names what failed, so a step written differently that fails the same way counts too.
    if (record.outcome === "failed" && work.steps.filter((step) => step.outcome === "failed" && step.detail === record.detail).length >= same) {
      this.finish(work, "failed", `${record.step} failed the same way ${same} times: ${record.detail}`);
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

  /** Who it could go and chat with: the other agents and the players heard in the last {@link PARTNER_HEARD_MS}, not itself. */
  private partners(): string[] {
    if (this.talks === null) return [];
    const self = this.options.persona.username.toLowerCase();
    const heard = [...this.lastHeard].filter(([, at]) => Date.now() - at <= PARTNER_HEARD_MS).map(([name]) => this.onlineNames.find((online) => online.toLowerCase() === name) ?? name);
    const seen = new Set<string>([self]);
    return [...this.options.otherAgents, ...heard].filter((name) => {
      if (seen.has(name.toLowerCase())) return false;
      seen.add(name.toLowerCase());
      return true;
    });
  }

  /**
   * The step of a `socialising` objective of its own: the code routine in conversation/socialise.ts (like the night
   * shelter, no work-tier call). An order that takes the body aborts it, and the objective ends.
   */
  private async socialiseStep(work: Work): Promise<void> {
    if (this.talks === null) return this.finish(work, "failed", "conversations are off");
    const snapshot = await this.options.runtime.status();
    const partner = pickPartner(work.objective.text, this.partners(), snapshot);
    if (partner === null) return this.finish(work, "failed", "nobody to talk to");
    const openFacts = { activity: this.activity, lately: [...this.lately], lastFailed: this.lastFailed };
    return this.routineStep(work, "socialising", `chat with ${partner}`, { skill: "socialise", partner }, (base) => socialise({ ...base, partner, openFacts }));
  }

  /** The step of a `trading` objective of its own: relations/trading.ts asks a partner for the items it lacks. */
  private async tradeStep(work: Work): Promise<void> {
    const trades = this.relations?.trades;
    if (this.talks === null || trades === undefined) return this.finish(work, "failed", "trading is off");
    const snapshot = await this.options.runtime.status();
    const plan = tradePlan(work.objective.text, this.asks.needs.current(Date.now(), snapshot.inventory), this.partners(), this.asks, snapshot, Date.now());
    if ("failed" in plan) return this.finish(work, "failed", plan.failed);
    const { want, partner } = plan;
    // What it asks for is what the chat calls of the talk are told it lacks.
    for (const item of want) work.wanted.add(item);
    const openFacts = { activity: this.activity, lately: [...this.lately], lastFailed: this.lastFailed };
    return this.routineStep(work, "trading", `trade with ${partner}`, { skill: "trade", partner }, (base) => tradeRoutine({ ...base, partner, want, asks: this.asks, trades, openFacts }));
  }

  /** Runs a conversation routine as the objective's step: journals it, counts its time for `activity`, ends the objective with its result. */
  private async routineStep(work: Work, activity: "socialising" | "trading", label: string, input: Record<string, string>, run: (base: Omit<SocialiseDeps, "partner" | "openFacts">) => Promise<SkillResult>): Promise<void> {
    const { persona, runtime, log } = this.options;
    const talks = this.talks!;
    const controller = new AbortController();
    work.step = controller;
    log(`${activity}: ${label}`);
    this.journalState(label);
    const started = Date.now();
    const signal = AbortSignal.any([controller.signal, this.runSignal]);
    const talkRange = this.options.localizedChat?.range ?? persona.settings.conversation.stayingDistance;
    let result: SkillResult;
    try {
      result = await run({
        runtime,
        signal,
        talks,
        since: work.startedAt,
        context: { runtime, body: this.body, signal, self: persona.username },
        limits: { openingDistance: persona.settings.conversation.openingDistance, talkRange, maxMinutes: persona.settings.conversation.maxMinutes },
      });
    } catch (error) {
      result = { status: "failed", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      work.step = null;
    }
    const ended = Date.now();
    const ms = ended - started;
    const outcome = result.status === "stopped" ? "interrupted" : result.status;
    const detail = result.status === "stopped" ? "an order came first" : result.detail;
    this.spent({ activity, purpose: activity, ended: new Date(ended).toISOString(), minutes: ms / 60_000 }, ms >= MIN_RECORDED_MS);
    this.options.journal?.({ kind: "step", objective: work.objective.text, requester: null, step: label, input, thought: "", outcome, detail, ms, activity, purpose: activity });
    this.journalState(null);
    log(`  -> ${label}: ${outcome}: ${detail}`);
    // Set aside (a member's favour, a night) it stays on the stack and runs again; stopped and removed, it ends here.
    if (result.status === "stopped" && this.stack.includes(work) && !this.runSignal.aborted) return;
    this.finish(work, result.status === "done" ? "done" : "failed", detail);
  }

  /**
   * A step is aborted when it shows no result and no progress for {@link NO_GAIN_MINUTES} minutes (live 2026-10-09:
   * single steps ran 10-22 minutes, a squid hunt gained nothing for 30; run 14: a step with no item target waited for
   * ever). A step out to obtain items (see `targetItems`) progresses when an item rises in the inventory or a fetch
   * gets nearer to the place it travels to; any other step, on any sign of life: an action ending, a phase or a
   * progress fact from the skill, a changed inventory, or the bot moving. The deadline is checked on every tick by the
   * monotonic clock (a wall clock that steps, as WSL's does after the host wakes, would cut the window: review V3),
   * whether or not the inventory read answers. `view_status` only reads, so the inventory is looked at while
   * the action runs. `stalled` says why it was stopped.
   */
  private watchGain(step: Step, before: BotSnapshot, controller: AbortController): { readonly stop: () => void; readonly stalled: () => string | null; readonly heading: (target: { readonly x: number; readonly z: number } | null) => void; readonly alive: () => void } {
    const targets = targetItems(step);
    const { runtime, log } = this.options;
    const { minutes, sampleMs } = this.options.noGain ?? { minutes: NO_GAIN_MINUTES, sampleMs: GAIN_SAMPLE_MS };
    const carried = (snapshot: BotSnapshot, item: string) => snapshot.inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
    const totals = (snapshot: BotSnapshot) => {
      const counts = new Map<string, number>();
      for (const stack of snapshot.inventory) counts.set(stack.name, (counts.get(stack.name) ?? 0) + stack.count);
      return counts;
    };
    const start = new Map(targets.map(({ item }) => [item, carried(before, item)]));
    // Any item rising above its best counts, not only the targets: a chain still gathering the logs for the planks for
    // the stairs is progressing (live 2026-10-10 run 8: "get 48 dark_oak_stairs" was stopped with 20 logs gathered).
    const best = totals(before);
    let lastGainAt = performance.now();
    let stalled: string | null = null;
    let sampling = false;
    let latest = before;
    // A fetch walking or sailing to a place it saw the block gains no item on the way: getting nearer is progress.
    let target: { readonly x: number; readonly z: number } | null = null;
    let nearest: number | null = null;
    // Any other step: the inventory as last seen and the place last counted as moved from.
    const signature = (snapshot: BotSnapshot) => JSON.stringify([...totals(snapshot)].sort());
    let seen = signature(before);
    let anchor = before.position;
    const stall = () => {
      if (stalled !== null || performance.now() - lastGainAt < minutes * 60_000) return;
      stalled = targets.length === 0
        ? `the action gave no sign of life for ${minutes} minutes`
        : `nothing gained in ${minutes} minutes: ${targets.map(({ item, count }) => `${Math.max(0, carried(latest, item) - (start.get(item) ?? 0))} of ${count} ${item}`).join(", ")} so far (the rest is in your inventory)`;
      controller.abort(new Error(stalled));
    };
    const timer = setInterval(() => {
      stall();
      if (sampling || stalled !== null) return;
      sampling = true;
      runtime.status().then((snapshot) => {
        const now = performance.now();
        latest = snapshot;
        for (const [item, have] of totals(snapshot)) {
          if (have > (best.get(item) ?? 0)) {
            best.set(item, have);
            lastGainAt = now;
          }
        }
        if (target !== null) {
          const away = Math.hypot(snapshot.position.x - target.x, snapshot.position.z - target.z);
          if (nearest === null) nearest = away;
          else if (away <= nearest - NEARER_BLOCKS) {
            nearest = away;
            lastGainAt = now;
          }
        }
        if (targets.length === 0) {
          const inventory = signature(snapshot);
          if (inventory !== seen || Math.hypot(snapshot.position.x - anchor.x, snapshot.position.y - anchor.y, snapshot.position.z - anchor.z) >= NEARER_BLOCKS) {
            seen = inventory;
            anchor = snapshot.position;
            lastGainAt = now;
          }
        }
        stall();
      }).catch((error: unknown) => log(`could not look at the inventory during a step: ${String(error)}`)).finally(() => { sampling = false; });
    }, sampleMs);
    return {
      stop: () => clearInterval(timer),
      stalled: () => stalled,
      heading: (next) => {
        target = next;
        nearest = null;
      },
      // A sign of life from the skill itself; a step out for items answers to its inventory and its way only.
      alive: () => {
        if (targets.length === 0) lastGainAt = performance.now();
      },
    };
  }

  /** A failed step, kept {@link FAILED_STEP_MINUTES} minutes (the latest of each step, with when it failed; at most {@link FAILED_STEP_MEMORY}). */
  private rememberFailedStep(objective: Objective, step: string, key: string, detail: string, carried: string | null, position: Position | null): void {
    const now = Date.now();
    const before = this.failedSteps.find((failure) => failure.key === key)?.failures ?? [];
    const kept = this.failedSteps.filter((failure) => failure.key !== key);
    kept.push({ objective, step, key, detail, at: now, failures: [...before.filter((at) => now - at <= FAILED_STEP_MINUTES * 60_000), now], carried, position });
    this.failedSteps.splice(0, this.failedSteps.length, ...kept.slice(-FAILED_STEP_MEMORY));
  }

  /**
   * The steps that failed lately for any objective, this one included, most recent first. `changed`: the inventory or
   * the place in `snapshot` differs from the state after the step's last failure (unknown state: not changed).
   */
  private earlierFailures(snapshot: BotSnapshot): EarlierFailure[] {
    const carried = carriedOf(snapshot);
    const now = Date.now();
    return this.failedSteps
      .filter((failure) => now - failure.at <= FAILED_STEP_MINUTES * 60_000)
      .reverse()
      .map(({ step, key, detail, objective, at, failures, carried: after, position }) => ({
        step, key, detail, objective: objective.text, minutesAgo: Math.max(1, Math.round((now - at) / 60_000)), count: failures.filter((failed) => now - failed <= FAILED_STEP_MINUTES * 60_000).length,
        changed: (after !== null && after !== carried) || (position !== null && snapshot.position !== null && Math.hypot(position.x - snapshot.position.x, position.y - snapshot.position.y, position.z - snapshot.position.z) >= MOVED_BLOCKS),
      }));
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
      // A trading objective's own failure is not a new need: the ask would never time out.
      if (outcome === "failed" && objective.purpose !== "trading") this.asks.failed(work.wanted, this.lastLook?.inventory ?? [], Date.now());
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
  private async activityOf(step: Step, actions: readonly ActionTime[], before: BotSnapshot, started: number, ended: number, phases: readonly ActivityPhase[]): Promise<{ readonly activity: Activity | null; readonly spans: readonly ActivitySpan[]; readonly carried: string | null; readonly position: Position | null; readonly room: Pick<BotSnapshot, "inventory" | "foods"> | null }> {
    try {
      const after = await this.options.runtime.status();
      for (const food of [...before.foods, ...after.foods]) this.foods.add(food.name);
      const hostile = new Set([...before.mobs, ...after.mobs].filter((mob) => mob.hostile).map((mob) => mob.name));
      const blocks = actions.flatMap((action) => action.tool === "collect_block" && typeof action.input.block_name === "string" ? [action.input.block_name] : []);
      if (step.skill === "collect_block") blocks.push(step.block);
      const facts = { tags: await this.tagsOf(blocks), hostile, foods: this.foods };
      const carried = carriedOf(after);
      return { activity: activityOf(step, actions, facts), spans: activityTimes(step, actions, facts, started, ended, phases), carried, position: after.position, room: { inventory: after.inventory, foods: after.foods } };
    } catch (error) {
      this.options.log(`could not tell what kind of work that was: ${String(error)}`);
      return { activity: null, spans: [], carried: null, position: null, room: null };
    }
  }

  /** The carried items its work needs: tools, armour, stations, foods, the unfinished house's bill and what the objective is out to get. */
  private neededFor(snapshot: Pick<BotSnapshot, "inventory" | "foods">, work: Work): Set<string> {
    const house = this.building.unfinished;
    const houseBill = house === null ? [] : planHouse(styleOrDefault(this.options.persona.style), (house.kind.split(" ")[0] ?? "small") as HouseSize, house.site, house.materials ?? {}).bill.map((entry) => entry.item);
    return neededItems(snapshot, { houseBill, wanted: work.wanted, objective: work.objective.text });
  }

  /** The game's block tags of these blocks, asked of the runtime once per name. */
  private async tagsOf(blocks: readonly string[]): Promise<Readonly<Record<string, readonly string[]>>> {
    const kinds = await this.kindsOf(blocks);
    return Object.fromEntries(blocks.map((block) => [block, kinds.get(block)?.tags ?? []]));
  }

  /** The game's data for these names (an item that is no block has none), asking the runtime only for names not yet known. */
  private async kindsOf(names: readonly string[]): Promise<ReadonlyMap<string, BlockKind | null>> {
    const unknown = [...new Set(names)].filter((name) => !this.blockKindCache.has(name));
    if (unknown.length > 0) {
      const kinds = await this.options.runtime.blockKinds(unknown);
      for (const name of unknown) this.blockKindCache.set(name, kinds[name] ?? null);
    }
    return this.blockKindCache;
  }

  /** Counts a step's time towards its activity; a long enough one is remembered across restarts. */
  private spent(time: ActivityTime, remember: boolean): void {
    this.times.push(time);
    this.times.splice(0, this.times.length, ...lastOfPlay(this.times));
    if (remember) this.memorize({ kind: "activity_time", time });
  }

  /** Things that could use doing now (the tasks a character looks for); the goal tier decides what to make of them. */
  private async opportunities(snapshot: BotSnapshot, drawn: readonly Activity[], tradeNeeds?: OpportunityFacts["tradeNeeds"]): Promise<Opportunity[]> {
    const ownHome = this.places.some((place) => place.own === true);
    const unfinished = this.building.unfinished;
    let houseShortfall: Shortfall[] = [];
    let smallHouse: OpportunityFacts["smallHouse"] = [];
    let carriedBlocks: OpportunityFacts["carriedBlocks"] = [];
    let temporaryHouse: OpportunityFacts["temporaryHouse"] = null;
    try {
      if (!ownHome && unfinished === null) {
        houseShortfall = await this.houseShortfall(snapshot);
        smallHouse = this.smallHouseRoles(snapshot);
        carriedBlocks = await this.carriedBlocks(snapshot);
      }
      temporaryHouse = await this.temporaryHouseFacts();
    } catch (error) {
      this.options.log(`could not work out what a house of its own needs: ${String(error)}`);
    }
    return findOpportunities({ now: Date.now(), snapshot, farms: this.farms, unfinished, ownHome, houseShortfall, smallHouse, carriedBlocks, temporaryHouse, ...(tradeNeeds !== undefined && { tradeNeeds }) }, drawn);
  }

  /** What the style's small house is made of: its cells per role (air excluded), in the order of the roles. */
  private smallHouseRoles(snapshot: BotSnapshot): OpportunityFacts["smallHouse"] {
    const cells = planHouse(styleOrDefault(this.options.persona.style), "small", chooseSite(snapshot.position, null)).cells;
    return BUILD_ROLES.map((role) => ({ role, count: cells.filter((cell) => cell.role === role && cell.block !== "air").length })).filter((entry) => entry.count > 0);
  }

  /** The most carried blocks that fill a whole cell (what `build` may use for a wall, floor or roof), at most five. */
  private async carriedBlocks(snapshot: BotSnapshot): Promise<OpportunityFacts["carriedBlocks"]> {
    const kinds = await this.kindsOf(snapshot.inventory.map((stack) => stack.name));
    const counts = new Map<string, number>();
    for (const stack of snapshot.inventory) if (kinds.get(stack.name)?.fullCube === true) counts.set(stack.name, (counts.get(stack.name) ?? 0) + stack.count);
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, MAX_CARRIED_BLOCKS);
  }

  /** Its temporary own house, which roles are temporary, and what improving them needs beyond what it carries. */
  private async temporaryHouseFacts(): Promise<OpportunityFacts["temporaryHouse"]> {
    const place = this.temporaryHouse();
    const house = place?.house;
    if (house === undefined) return null;
    const style = styleOrDefault(house.style);
    const roles = temporaryRoles(house.materials, style);
    const missing = shortfall(improvement(style, house, roles).bill, (await this.options.runtime.status()).inventory);
    return {
      door: house.door,
      roles: roles.map((role) => ({ role, block: house.materials[role]!, style: style.palette[role] })),
      shortfall: await this.withActivities(missing),
    };
  }

  /** What a small house in its own style needs beyond what it carries, each with the work that gets it. */
  private async houseShortfall(snapshot: BotSnapshot): Promise<Shortfall[]> {
    const bill = planHouse(styleOrDefault(this.options.persona.style), "small", chooseSite(snapshot.position, null)).bill;
    return this.withActivities(shortfall(bill, snapshot.inventory));
  }

  /** Each missing material with the work that gets it (as `get_items` would); the ones no work gets are left out. */
  private async withActivities(items: readonly MaterialCount[]): Promise<Shortfall[]> {
    const missing: Shortfall[] = [];
    for (const { item, count } of items) {
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

  /** Its latest own house that still has temporary parts: the latest note of each place name counts, an improved one no longer. */
  private temporaryHouse(): KnownPlace | null {
    const latest = new Map<string, KnownPlace>();
    for (const place of this.places) latest.set(place.name, place);
    return [...latest.values()].reverse().find((place) => place.own === true && Object.keys(place.house?.materials ?? {}).length > 0) ?? null;
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
      this.talks?.recalled(recalled.conversations);
      this.relations?.load(recalled);
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

  /**
   * "stop" from a player: the orders that player gave and the character's own goals end, the orders of
   * other players stay on the stack (review R18).
   */
  private stopWorkOf(speaker: string): void {
    const name = speaker.toLowerCase();
    const ends = ({ objective }: Work) => objective.requester === null || objective.requester.toLowerCase() === name;
    for (const work of this.stack.filter(ends)) work.step?.abort();
    const kept = this.stack.filter((work) => !ends(work));
    this.stack.splice(0, this.stack.length, ...kept);
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
    this.restUntil = Date.now() + this.options.persona.settings.restAfterStopSeconds * 1_000;
  }

  /**
   * Remembers which character (this one or another agent) the line names; for a line naming none, who its speaker named
   * last when that was within {@link TALKED_TO_MS} (live 2026-10-11: "thanks, no rush" after a line to Vex was answered by
   * Ayla too). Names as words only, never what the line says.
   */
  private noteNamed(message: PlayerMessage, at: number): { name: string; secondsAgo: number } | undefined {
    const speaker = message.username.toLowerCase();
    const characters = [this.options.persona.username, ...this.options.otherAgents];
    const named = characters.filter((name) => name.toLowerCase() !== speaker && message.message.toLowerCase().split(/[^\p{L}\p{N}_]+/u).includes(name.toLowerCase()));
    if (this.options.otherAgents.some((name) => name.toLowerCase() === speaker)) return undefined;
    if (named.length > 0) {
      this.lastNamed.set(speaker, { name: named[0]!, at });
      return undefined;
    }
    const last = this.lastNamed.get(speaker);
    return last !== undefined && last.name.toLowerCase() !== this.options.persona.username.toLowerCase() && at - last.at <= TALKED_TO_MS ? { name: last.name, secondsAgo: Math.round((at - last.at) / 1_000) } : undefined;
  }

  /** `since`: when the message being answered was heard (thinking time counts as typing time). */
  private speak(text: string, since = Date.now(), to?: readonly string[], whisperTo: string | null = null, shout = false): void {
    if (text.trim() === "") return;
    const said = this.remember(this.options.persona.username, text);
    if (to !== undefined) this.annotate(said, to);
    this.body.say(text, since, whisperTo ?? undefined, shout).catch((error: unknown) => this.options.log(`say failed: ${String(error)}`));
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

/** A player heard this recently (ms) can be gone and chat with. */
const PARTNER_HEARD_MS = 10 * 60_000;

/** How long after a line naming a character a line naming nobody is still shown as following it. */
const TALKED_TO_MS = 60_000;

/** `14 min ago` (or `just now`) from an ISO time, for the situation the models read. */
function minutesAgo(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "some time ago";
  return minutes < 1 ? "just now" : minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}
