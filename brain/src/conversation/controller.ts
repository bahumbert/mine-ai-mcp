import type { BrainEvent } from "../brain-log.ts";
import type { Memory } from "../memory.ts";
import type { ChatLine, ConversationFacts, Mind, Nearby, OpeningDecision, OpeningInput, PastTalk } from "../mind.ts";
import type { Persona } from "../persona.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";
import {
  addMembers, capReached, checkRange, ending, isMember, lineSaid, manhattan, openConversation,
  type Conversation, type ConversationKind, type EndReason, type Limits,
} from "./state.ts";

/** How many partners' last talks are kept. */
const PARTNERS_KEPT = 5;
/** A social call waits this long for the partner to come within earshot (spec 2026-10-18-conversations-design). */
const CALL_WAIT_MS = 60_000;

/** Conversations this brain's characters have opened and still hold; at most `max` at a time (`--max-conversations`). */
export class ConversationBudget {
  private taken = 0;
  constructor(readonly max: number) {}

  tryTake(): boolean {
    if (this.taken >= this.max) return false;
    this.taken += 1;
    return true;
  }

  give(): void {
    this.taken = Math.max(0, this.taken - 1);
  }

  get active(): number {
    return this.taken;
  }
}

export type ConversationEvent = Extract<BrainEvent, { kind: "conversation" }>;
export type ConversationMemory = Extract<Memory, { kind: "conversation" }>;

export interface ControllerDeps {
  readonly self: string;
  readonly persona: Persona;
  readonly mind: Mind;
  readonly budget: ConversationBudget;
  /** Whether the model queue has a free slot: openings and gists are skipped, never queued. */
  readonly modelFree: () => boolean;
  /** Blocks (Manhattan) talk carries: the Localized Chat range, else the staying distance. */
  readonly talkRange: number;
  /** Whether the server limits how far talk carries (Localized Chat): only then is a call shouted. */
  readonly localized?: boolean;
  readonly random: () => number;
  readonly now: () => number;
  readonly speak: (text: string, to: readonly string[], whisperTo: string | null, shout: boolean) => void;
  readonly journal: (event: ConversationEvent) => void;
  readonly memorize: (memory: ConversationMemory) => void;
  readonly log: (line: string) => void;
  readonly history: () => readonly ChatLine[];
}

export interface OpenFacts {
  readonly snapshot: BotSnapshot;
  readonly activity: string;
  readonly lately: readonly string[];
  readonly lastFailed: OpeningInput["lastFailed"];
}

interface Talk {
  readonly with: readonly string[];
  readonly topic: string;
  readonly gist: string;
  readonly endedAt: number;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * One character's conversation (spec 2026-10-18-conversations-design): the gates for opening one, its record, and how
 * it ends. It decides nothing about words: every line is written by the model; it only gates (distances, caps,
 * cooldowns, chance draws).
 */
export class ConversationController {
  private record: Conversation | null = null;
  /** Everyone who was a member at some point of the current record. */
  private touched = new Set<string>();
  private holdsBudget = false;
  private lastCheckAt: number | null = null;
  private readonly cooldownFrom = new Map<string, number>();
  /** The latest talk with each partner (lower case), at most {@link PARTNERS_KEPT} partners. */
  private readonly talks = new Map<string, Talk>();
  private readonly pending = new Set<Promise<void>>();
  private readonly limits: Limits;

  constructor(private readonly deps: ControllerDeps) {
    this.limits = { ...deps.persona.settings.conversation, talkRange: deps.talkRange };
  }

  get current(): Conversation | null {
    return this.record;
  }

  /** Resolves when every conversation that ended has been journaled and remembered (its gist may take a model call). */
  async finished(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  isMember(name: string): boolean {
    return this.record !== null && isMember(this.record, name);
  }

  /** The latest talk with `name` (gist, else topic), or null when there was none. */
  lastTalk(name: string): { readonly topic: string; readonly gist: string } | null {
    const talk = this.talks.get(name.toLowerCase());
    return talk === undefined ? null : { topic: talk.topic, gist: talk.gist };
  }

  facts(): ConversationFacts | undefined {
    const c = this.record;
    if (c === null) return undefined;
    const now = this.deps.now();
    const others = c.members.filter((name) => !same(name, this.deps.self));
    const gists = new Set<Talk>();
    for (const name of others) {
      const talk = this.talks.get(name.toLowerCase());
      if (talk !== undefined) gists.add(talk);
    }
    return {
      kind: c.kind, others, opener: c.opener, topic: c.topic, planned: c.planned, lines: c.lines, minutes: Math.round((now - c.startedAt) / 6_000) / 10,
      iAmOpener: same(c.opener, this.deps.self), sayGoodbye: capReached(c, this.limits, now), lastGists: [...gists].map((talk) => this.pastTalk(talk, now)),
    };
  }

  /** Seeds the past talks from the memory read at start, newest first. */
  recalled(talks: readonly { readonly members: readonly string[]; readonly topic: string; readonly gist: string; readonly endedAt: string }[]): void {
    for (const talk of [...talks].reverse()) {
      const endedAt = Date.parse(talk.endedAt);
      this.remember({ with: talk.members, topic: talk.topic, gist: talk.gist, endedAt: Number.isNaN(endedAt) ? 0 : endedAt });
    }
  }

  async tick(snapshot: BotSnapshot, _signal: AbortSignal): Promise<void> {
    const c = this.record;
    if (c === null) return;
    const now = this.deps.now();
    for (const member of checkRange(c, this.deps.self, snapshot.position, snapshot.players, this.limits, now)) {
      this.deps.log(`conversation: ${member} left (out of range)`);
      this.journal("left", c, { member, why: "out of range" });
    }
    const reason = ending(c, this.deps.self, this.limits, now);
    if (reason !== null) this.end(reason);
  }

  /** A chance opening: only when every code gate passes, then the chance draw, then one model call. */
  async maybeOpen(o: OpenFacts & { readonly busy: boolean }, signal: AbortSignal): Promise<boolean> {
    if (this.record !== null || o.busy || !this.deps.modelFree()) return false;
    const now = this.deps.now();
    const { checkEverySeconds, openingDistance, pairCooldownMinutes, sociability } = this.limits;
    if (this.lastCheckAt !== null && now - this.lastCheckAt < checkEverySeconds * 1_000) return false;
    this.lastCheckAt = now;
    const near = this.playersNear(o.snapshot, openingDistance)
      .filter((player) => now - (this.cooldownFrom.get(player.username.toLowerCase()) ?? -Infinity) >= pairCooldownMinutes * 60_000);
    if (near.length === 0) return false;
    const draw = this.deps.random();
    this.deps.log(`conversation: chance ${sociability.toFixed(2)} drew ${draw < sociability ? "yes" : "no"}`);
    if (draw >= sociability) return false;
    if (!this.deps.budget.tryTake()) return false;
    return this.open("chance", near.map((player) => this.nearby(player.username, player.distance, now)), o, false, null, signal);
  }

  /** A deliberate opening (the socialising activity): no chance draw, no cooldown. */
  async openSocial(partner: string, partnerPosition: Position | null, o: OpenFacts, signal: AbortSignal): Promise<boolean> {
    if (this.record !== null) return isMember(this.record, partner);
    if (!this.deps.modelFree()) return false;
    const now = this.deps.now();
    const calling = partnerPosition === null || manhattan(o.snapshot.position, partnerPosition) > this.limits.talkRange;
    if (!this.deps.budget.tryTake()) return false;
    const near = [this.nearby(partner, calling || partnerPosition === null ? null : manhattan(o.snapshot.position, partnerPosition), now)];
    return this.open("social", near, o, calling, partner, signal);
  }

  private async open(kind: ConversationKind, near: readonly Nearby[], o: OpenFacts, calling: boolean, partner: string | null, signal: AbortSignal): Promise<boolean> {
    let decision: OpeningDecision;
    try {
      decision = await this.deps.mind.openConversation({
        persona: this.deps.persona, kind, near, activity: o.activity, lately: o.lately, lastFailed: o.lastFailed, calling,
      }, signal);
    } catch (error) {
      this.deps.budget.give();
      this.deps.log(`conversation: opening call failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    const now = this.deps.now();
    const to = partner !== null ? [partner] : this.addressed(decision.to, o.snapshot);
    this.deps.log(`conversation: opening answer open=${decision.open} to=${to.join(",")} length=${decision.length} say=${JSON.stringify(decision.say)}`);
    // A line heard while the model thought may have opened one already: it is the conversation now.
    if (!decision.open || decision.say === "" || to.length === 0 || this.record !== null) {
      this.deps.budget.give();
      return false;
    }
    const waitUntil = calling ? now + CALL_WAIT_MS : undefined;
    const c = openConversation({
      self: this.deps.self, opener: this.deps.self, kind, members: to, topic: decision.topic, planned: decision.length, whisper: false, now,
      ...(waitUntil !== undefined && { waitUntil }),
    });
    this.begin(c, true);
    lineSaid(c, now);
    this.deps.speak(decision.say, to, null, calling && this.deps.localized === true);
    this.journal("opened", c, { conversationKind: kind, topic: c.topic, planned: c.planned });
    return true;
  }

  /** A line another character or player said, with the names it holds as words; `near`: a player within talk range (their nameless line joins). */
  heard(speaker: string, text: string, named: readonly string[], channel: "chat" | "whisper", near = false): void {
    void text;
    const { self } = this.deps;
    if (same(speaker, self)) return;
    const now = this.deps.now();
    const c = this.record;
    const namesHer = named.some((name) => same(name, self));
    if (c === null) {
      if (!namesHer) return;
      const opened = openConversation({ self, opener: speaker, kind: "chance", members: named, topic: "", planned: null, whisper: channel === "whisper", now });
      this.begin(opened, false);
      lineSaid(opened, now);
      this.journal("opened", opened, { conversationKind: "chance", topic: "", planned: null });
      return;
    }
    // Two characters opened to each other at once: one conversation. The later username takes the other as opener.
    if (c.opener === self && this.holdsBudget && c.lines === 1 && isMember(c, speaker) && namesHer && speaker.toLowerCase() < self.toLowerCase()) {
      this.deps.log(`conversation: ${speaker} opened to me at the same time, so they are the opener`);
      c.opener = speaker;
      c.planned = null;
      c.topic = "";
      this.holdsBudget = false;
      this.deps.budget.give();
    }
    if (!isMember(c, speaker)) {
      if (!namesHer && !near && !named.some((name) => isMember(c, name))) return;
      addMembers(c, [speaker]);
      this.touched.add(speaker);
      this.journal("joined", c, { member: speaker, why: "spoke to the conversation" });
    }
    lineSaid(c, now);
    for (const member of addMembers(c, named)) {
      this.touched.add(member);
      this.journal("joined", c, { member, why: `named by ${speaker}` });
    }
  }

  /** Her own line in the conversation: a goodbye ends it, and so does a line after the cap told her to say goodbye. */
  said(close: boolean): void {
    const c = this.record;
    if (c === null) return;
    const now = this.deps.now();
    const afterCap = capReached(c, this.limits, now);
    lineSaid(c, now);
    if (close) this.end("goodbye");
    else if (afterCap) this.end("cap");
  }

  /** Ends the conversation once; the gist is asked of the model when it has a free slot, else it is the topic. */
  end(reason: EndReason, signal?: AbortSignal): void {
    const c = this.record;
    if (c === null) return;
    const now = this.deps.now();
    const { self } = this.deps;
    this.record = null;
    if (this.holdsBudget) this.deps.budget.give();
    this.holdsBudget = false;
    const everyone = [...this.touched];
    this.touched = new Set();
    for (const name of everyone) if (!same(name, self)) this.cooldownFrom.set(name.toLowerCase(), now);
    const others = (c.members.filter((name) => !same(name, self)).length > 0 ? c.members : everyone).filter((name) => !same(name, self));
    const lines = this.history().filter((line) => (line.at === undefined || line.at >= c.startedAt) && everyone.some((name) => same(name, line.speaker)));
    const finish = (gist: string): void => {
      this.deps.log(`conversation: ended ${reason} after ${c.lines} lines`);
      this.journal("ended", c, { reason, lines: c.lines, minutes: Math.round((now - c.startedAt) / 6_000) / 10, gist });
      this.deps.memorize({ kind: "conversation", talk: { id: c.id, members: others, topic: c.topic, gist, endedAt: new Date(now).toISOString(), reason } });
      if (gist !== "" || c.topic !== "") this.remember({ with: others, topic: c.topic, gist, endedAt: now });
    };
    const fallback = c.topic;
    if (c.lines === 0 || !this.deps.modelFree()) {
      finish(fallback);
      return;
    }
    const task = this.deps.mind.sumUpConversation({ persona: this.deps.persona, others, topic: c.topic, lines }, signal ?? new AbortController().signal)
      .then((gist) => finish(gist === "" ? fallback : gist), () => finish(fallback));
    const tracked = task.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  private history(): readonly ChatLine[] {
    return this.deps.history();
  }

  private begin(c: Conversation, own: boolean): void {
    this.record = c;
    this.holdsBudget = own;
    this.touched = new Set(c.members);
  }

  private journal(event: ConversationEvent["event"], c: Conversation, more: Partial<Omit<ConversationEvent, "kind" | "event" | "id" | "members">>): void {
    this.deps.journal({ kind: "conversation", event, id: c.id, members: [...c.members], ...more });
  }

  private playersNear(snapshot: BotSnapshot, distance: number): { readonly username: string; readonly distance: number }[] {
    const near: { username: string; distance: number }[] = [];
    for (const player of snapshot.players) {
      if (player.position === null || same(player.username, this.deps.self)) continue;
      const away = manhattan(snapshot.position, player.position);
      if (away <= distance) near.push({ username: player.username, distance: away });
    }
    return near;
  }

  /** The names an opening speaks to, as spelled by the players online; ["everyone"] is all within talk range. */
  private addressed(to: readonly string[], snapshot: BotSnapshot): string[] {
    if (to.some((name) => name.toLowerCase() === "everyone")) return this.playersNear(snapshot, this.limits.talkRange).map((player) => player.username);
    const online = snapshot.players.map((player) => player.username);
    return to.flatMap((name) => online.filter((known) => same(known, name) && !same(known, this.deps.self)));
  }

  private nearby(username: string, distance: number | null, now: number): Nearby {
    const talk = this.talks.get(username.toLowerCase());
    return { username, distance, lastTalk: talk === undefined ? null : this.pastTalk(talk, now) };
  }

  private pastTalk(talk: Talk, now: number): PastTalk {
    return { with: talk.with, topic: talk.topic, gist: talk.gist, minutesAgo: Math.max(0, Math.round((now - talk.endedAt) / 60_000)) };
  }

  private remember(talk: Talk): void {
    for (const name of talk.with) this.talks.set(name.toLowerCase(), talk);
    while (this.talks.size > PARTNERS_KEPT) {
      const oldest = [...this.talks.entries()].reduce((a, b) => (b[1].endedAt < a[1].endedAt ? b : a));
      this.talks.delete(oldest[0]);
    }
  }
}

/** The `--max-conversations` flag: a whole number of conversations at once (0 = never opens one), default 2. */
export function maxConversations(value: string | undefined): number {
  if (value === undefined) return 2;
  const count = Number(value);
  if (value.trim() === "" || !Number.isInteger(count) || count < 0) throw new Error(`[BAD_START_ARG] --max-conversations expects a whole number (0 or more), got ${value}`);
  return count;
}
