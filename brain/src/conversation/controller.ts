/** One character's conversation controller: the gates for opening a talk, its record and how it ends (spec 2026-10-18-conversations-design). */
import { namesWord } from "../llm-mind.ts";
import type { ChatLine, ConversationFacts, Nearby, OpeningDecision, OpeningInput } from "../mind.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";
import { sleepMs } from "../wall-timers.ts";
import { ConversationBudget, fallbackGist, maxConversations } from "./budget.ts";
import { addressed, nearby, pastTalk, playersNear } from "./nearby.ts";
import {
  addMembers, capReached, checkRange, ending, isMember, lineSaid, manhattan, openConversation, same,
  type Conversation, type ConversationKind, type EndReason, type Limits,
} from "./state.ts";
import type { CarriedIntent, ControllerDeps, ConversationEvent, ConversationMemory, ConversationRelations, OpenFacts, Talk } from "./types.ts";

// Every name this module exported before its split stays importable from here.
export { ConversationBudget, maxConversations };
export type { ControllerDeps, ConversationEvent, ConversationMemory, ConversationRelations, OpenFacts };

/** How many partners' last talks are kept. */
const PARTNERS_KEPT = 5;
/** A social call waits this long for the partner to come within earshot (spec 2026-10-18-conversations-design). */
const CALL_WAIT_MS = 60_000;
/** A gist waits this long for a model slot before the fallback is written. */
const GIST_WAIT_MS = 120_000;
/** How often a deliberate opening looks again at what blocks it (real time). */
const OPEN_POLL_MS = 1_000;

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
  /** The current conversation's lines, hers and its members', in the order they were said (the last `gistLines`), for its gist. */
  private lines: ChatLine[] = [];
  /** Her latest line of the chat history that {@link said} kept, so one line is kept once. */
  private lastOwnKept: ChatLine | null = null;
  private lastCheckAt: number | null = null;
  private readonly cooldownFrom = new Map<string, number>();
  /** The latest talk with each partner (lower case), at most {@link PARTNERS_KEPT} partners. */
  private readonly talks = new Map<string, Talk>();
  private readonly pending = new Set<Promise<void>>();
  private readonly limits: Limits;
  /** The trade a routine came to ask for: shown to her chat calls in a talk with its partner until a line asks it. */
  private carried: CarriedIntent | null = null;
  /** When a trade ask was last said to each partner (lower case), kept for the bot's life. */
  private readonly askedAt = new Map<string, number>();
  /** Why the last {@link openSocial} that returned false was blocked (null: it was not). */
  private refusal: string | null = null;

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

  /** The latest talk with `name` (gist, else topic), or null when there was none; `endedAt` is a wall time. */
  lastTalk(name: string): { readonly topic: string; readonly gist: string; readonly endedAt: number } | null {
    const talk = this.talks.get(name.toLowerCase());
    return talk === undefined ? null : { topic: talk.topic, gist: talk.gist, endedAt: talk.endedAt };
  }

  /** A routine carries a trade intent for `partner`: any talk with them shows it to her chat calls until a line asks it. One at a time. */
  carryIntent(partner: string, intent: NonNullable<OpeningInput["intent"]>): void {
    this.carried = { partner, intent, carriedAt: this.deps.now(), shown: false };
  }

  releaseIntent(): void {
    this.carried = null;
  }

  /** A trade ask was said to `partner` at or after `since` (a monotonic reading). */
  askedSince(partner: string, since: number): boolean {
    return (this.askedAt.get(partner.toLowerCase()) ?? -Infinity) >= since;
  }

  /** The carried intent, while the current talk is with its partner and it was not asked since it was carried. */
  private pendingIntent(): CarriedIntent | null {
    const carried = this.carried;
    if (carried === null || !this.isMember(carried.partner) || this.askedSince(carried.partner, carried.carriedAt)) return null;
    return carried;
  }

  facts(): ConversationFacts | undefined {
    const c = this.record;
    if (c === null) return undefined;
    const now = this.deps.now();
    const wallNow = this.deps.wallNow();
    const others = c.members.filter((name) => !same(name, this.deps.self));
    const gists = new Set<Talk>();
    for (const name of others) {
      const talk = this.talks.get(name.toLowerCase());
      if (talk !== undefined) gists.add(talk);
    }
    const pending = this.pendingIntent();
    if (pending !== null) pending.shown = true;
    return {
      kind: c.kind, others, opener: c.opener, topic: c.topic, planned: c.planned, lines: c.lines, minutes: Math.round((now - c.startedAt) / 6_000) / 10,
      iAmOpener: same(c.opener, this.deps.self), sayGoodbye: capReached(c, this.limits, now), lastGists: [...gists].map((talk) => pastTalk(talk, wallNow)),
      ...(pending !== null && { intent: { ...pending.intent, partner: pending.partner } }),
    };
  }

  /** Seeds the past talks from the memory read at start, newest first. */
  recalled(talks: readonly { readonly members: readonly string[]; readonly topic: string; readonly gist: string; readonly endedAt: string }[]): void {
    for (const talk of [...talks].reverse()) {
      const endedAt = Date.parse(talk.endedAt);
      this.remember({ with: talk.members, topic: talk.topic, gist: talk.gist, endedAt: Number.isNaN(endedAt) ? 0 : endedAt });
    }
  }

  async tick(snapshot: BotSnapshot, signal: AbortSignal): Promise<void> {
    const c = this.record;
    if (c === null) return;
    const now = this.deps.now();
    for (const member of checkRange(c, this.deps.self, snapshot.position, snapshot.players, this.limits, now)) {
      this.deps.log(`conversation: ${member} left (out of range)`);
      this.journal("left", c, { member, why: "out of range" });
    }
    const reason = ending(c, this.deps.self, this.limits, now);
    if (reason !== null) this.end(reason, signal);
  }

  /** A chance opening: only when every code gate passes, then the chance draw, then one model call. */
  async maybeOpen(o: OpenFacts & { readonly busy: boolean }, signal: AbortSignal): Promise<boolean> {
    if (this.record !== null || o.busy || !this.deps.modelFree()) return false;
    const now = this.deps.now();
    const { checkEverySeconds, openingDistance, pairCooldownMinutes, sociability } = this.limits;
    if (this.lastCheckAt !== null && now - this.lastCheckAt < checkEverySeconds * 1_000) return false;
    this.lastCheckAt = now;
    const near = playersNear(o.snapshot, this.deps.self, openingDistance)
      .filter((player) => now - (this.cooldownFrom.get(player.username.toLowerCase()) ?? -Infinity) >= pairCooldownMinutes * 60_000);
    if (near.length === 0) return false;
    const draw = this.deps.random();
    this.deps.log(`conversation: chance ${sociability.toFixed(2)} drew ${draw < sociability ? "yes" : "no"}`);
    if (draw >= sociability) return false;
    if (!this.deps.budget.tryTake()) return false;
    const wallNow = this.deps.wallNow();
    return this.open("chance", near.map((player) => nearby(this.talks, player.username, player.distance, wallNow)), o, false, null, signal);
  }

  /** Why the last deliberate opening that returned false was blocked: `model busy`, `conversation limit` or `in a talk with <names>`; null when nothing blocked it. */
  get openRefusal(): string | null {
    return this.refusal;
  }

  /**
   * A deliberate opening (the socialising and trading activities): no chance draw, no cooldown. It waits up to `waitMs`
   * of real time (`performance.now`) for what blocks it (the bot's own talk, a model slot, a conversation slot), then leaves the reason in
   * {@link openRefusal}.
   */
  async openSocial(partner: string, partnerPosition: Position | null, o: OpenFacts, signal: AbortSignal, waitMs = 0): Promise<boolean> {
    this.refusal = null;
    const deadline = performance.now() + waitMs;
    for (;;) {
      if (signal.aborted) return false;
      if (this.record !== null && isMember(this.record, partner)) return true;
      const blocked = this.openBlocker();
      if (blocked === null) break;
      const left = deadline - performance.now();
      if (left <= 0) {
        this.refusal = blocked;
        this.deps.log(`conversation: opening to ${partner} refused: ${blocked}`);
        return false;
      }
      await this.pauseWithin(Math.min(left, this.deps.openPollMs ?? OPEN_POLL_MS), blocked === "model busy", signal);
    }
    const wallNow = this.deps.wallNow();
    const calling = partnerPosition === null || manhattan(o.snapshot.position, partnerPosition) > this.limits.talkRange;
    const near = [nearby(this.talks, partner, calling || partnerPosition === null ? null : manhattan(o.snapshot.position, partnerPosition), wallNow)];
    return this.open("social", near, o, calling, partner, signal);
  }

  /** What stops a deliberate opening now; null when nothing does, and then a conversation slot is taken. */
  private openBlocker(): string | null {
    if (this.record !== null) return `in a talk with ${this.record.members.filter((name) => !same(name, this.deps.self)).join(", ")}`;
    if (!this.deps.modelFree()) return "model busy";
    return this.deps.budget.tryTake() ? null : "conversation limit";
  }

  /** Sleeps `ms` of real time, or waits that long for a model slot; ends early on abort. */
  private async pauseWithin(ms: number, forModel: boolean, signal: AbortSignal): Promise<void> {
    const started = performance.now();
    if (forModel && this.deps.waitForModel !== undefined && (await this.slotWithin(ms, signal))) return;
    // A wait that failed early must not turn the loop into a spin.
    await sleepMs(Math.max(0, ms - (performance.now() - started)), signal).catch(() => undefined);
  }

  private async open(kind: ConversationKind, near: readonly Nearby[], o: OpenFacts, calling: boolean, partner: string | null, signal: AbortSignal): Promise<boolean> {
    let decision: OpeningDecision;
    try {
      decision = await this.deps.mind.openConversation({
        persona: this.deps.persona, kind, near, activity: o.activity, lately: o.lately, lastFailed: o.lastFailed, calling,
        ...(o.intent !== undefined && { intent: o.intent }),
        ...(this.deps.relations !== undefined && { relations: this.deps.relations.openingLines(near.map((n) => n.username)) }),
      }, signal);
    } catch (error) {
      this.deps.budget.give();
      this.deps.log(`conversation: opening call failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    const now = this.deps.now();
    const wallNow = this.deps.wallNow();
    // Only the names the line holds hear it as spoken to them (a favour of ADR-017's name rule).
    const to = (partner !== null ? [partner] : addressed(decision.to, o.snapshot, this.deps.self, this.limits.talkRange)).filter((name) => namesWord(decision.say, name));
    this.deps.log(`conversation: opening answer open=${decision.open} to=${to.join(",")} length=${decision.length} say=${JSON.stringify(decision.say)}`);
    // A line heard while the model thought may have opened one already: it is the conversation now.
    if (!decision.open || decision.say === "" || to.length === 0 || this.record !== null) {
      if (decision.open && decision.say !== "" && to.length === 0) this.deps.log("conversation: opening names nobody it is for");
      this.deps.budget.give();
      return false;
    }
    const waitUntil = calling ? now + CALL_WAIT_MS : undefined;
    const c = openConversation({
      self: this.deps.self, opener: this.deps.self, kind, members: to, topic: decision.topic, planned: decision.length, whisper: false, now, wallNow,
      ...(waitUntil !== undefined && { waitUntil }),
    });
    this.begin(c, true);
    this.keep(this.deps.self, decision.say, wallNow);
    lineSaid(c, now);
    const said = this.deps.speak(decision.say, to, null, calling && this.deps.localized === true);
    const asked = (decision.asksOf ?? []).filter((name) => to.some((heard) => same(heard, name)));
    // Stamped when the line is sent, not when it is decided: a line heard while it was typed is no answer. A say that failed asks nothing.
    if (asked.length > 0) void said.then(() => this.deps.relations?.asked(asked, decision.asksWhat ?? "something", o.snapshot), () => undefined);
    if (o.intent !== undefined && partner !== null) this.askedAt.set(partner.toLowerCase(), now);
    this.journal("opened", c, { conversationKind: kind, topic: c.topic, planned: c.planned });
    return true;
  }

  /** A line another character or player said, with the names it holds as words; `near`: a player within talk range (their nameless line joins). */
  heard(speaker: string, text: string, named: readonly string[], channel: "chat" | "whisper", near = false): void {
    const { self } = this.deps;
    if (same(speaker, self)) return;
    const now = this.deps.now();
    const wallNow = this.deps.wallNow();
    const c = this.record;
    const namesHer = named.some((name) => same(name, self));
    if (c === null) {
      if (!namesHer) return;
      const opened = openConversation({ self, opener: speaker, kind: "chance", members: named, topic: "", planned: null, whisper: channel === "whisper", now, wallNow });
      this.begin(opened, false);
      this.keep(speaker, text, wallNow);
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
    this.keep(speaker, text, wallNow);
    lineSaid(c, now);
    for (const member of addMembers(c, named)) {
      this.touched.add(member);
      this.journal("joined", c, { member, why: `named by ${speaker}` });
    }
  }

  /** Her own line in the conversation: a goodbye ends it, and so does a line after the cap told her to say goodbye. */
  said(close: boolean, answering?: string | null, signal?: AbortSignal): void {
    const c = this.record;
    if (c === null) return;
    const now = this.deps.now();
    const afterCap = capReached(c, this.limits, now);
    const asked = this.pendingIntent();
    // In a group talk only a line answering the carried partner speaks to them; in a talk of two any line does.
    const toPartner = asked !== null && (c.members.length <= 2 || (answering != null && same(answering, asked.partner)));
    if (asked?.shown === true && toPartner) this.askedAt.set(asked.partner.toLowerCase(), now);
    this.keepOwnLine(c);
    lineSaid(c, now);
    if (close) this.end("goodbye", signal);
    else if (afterCap) this.end("cap", signal);
  }

  /** Ends the conversation once; the gist is asked of the model when it has a free slot (waiting for one for a while), else it is {@link fallbackGist}. */
  end(reason: EndReason, signal?: AbortSignal): void {
    const c = this.record;
    if (c === null) return;
    const now = this.deps.now();
    const endedWall = this.deps.wallNow();
    const { self } = this.deps;
    this.record = null;
    if (this.holdsBudget) this.deps.budget.give();
    this.holdsBudget = false;
    const everyone = [...this.touched];
    this.touched = new Set();
    for (const name of everyone) if (!same(name, self)) this.cooldownFrom.set(name.toLowerCase(), now);
    const others = (c.members.filter((name) => !same(name, self)).length > 0 ? c.members : everyone).filter((name) => !same(name, self));
    const lines = this.lines;
    this.lines = [];
    const finish = (gist: string): void => {
      this.deps.log(`conversation: ended ${reason} after ${c.lines} lines`);
      this.journal("ended", c, { reason, lines: c.lines, minutes: Math.round((now - c.startedAt) / 6_000) / 10, gist });
      this.deps.memorize({ kind: "conversation", talk: { id: c.id, members: others, topic: c.topic, gist, endedAt: new Date(endedWall).toISOString(), reason } });
      if (gist !== "" || c.topic !== "") this.remember({ with: others, topic: c.topic, gist, endedAt: endedWall });
    };
    const fallback = fallbackGist(c.topic, lines.filter((line) => !same(line.speaker, self)), others);
    if (c.lines === 0) {
      finish(fallback);
      return;
    }
    const stop = signal ?? new AbortController().signal;
    const { relations } = this.deps;
    const sumUp = (): Promise<void> => this.deps.mind.sumUpConversation({ persona: this.deps.persona, others, topic: c.topic, lines, ...(relations !== undefined && { relations: relations.blocksFor(others) }) }, stop)
      .then(({ gist, partners }) => {
        finish(gist === "" ? fallback : gist);
        if (partners.length > 0) relations?.ended(partners);
      }, () => finish(fallback));
    let task: Promise<void>;
    if (this.deps.modelFree()) task = sumUp();
    else if (this.deps.waitForModel === undefined) {
      finish(fallback);
      return;
    } else task = this.slotWithin(GIST_WAIT_MS, stop).then((free) => (free ? sumUp() : finish(fallback)));
    const tracked = task.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /** Whether a model slot came free within `ms`; false on time-out, abort or a failed wait. */
  private slotWithin(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) return resolve(false);
      const onAbort = (): void => resolve(false);
      signal.addEventListener("abort", onAbort, { once: true });
      this.deps.waitForModel!(ms, signal).then(resolve, () => resolve(false)).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  /** Her line just said in the conversation: the agent writes it to the chat history before it calls {@link said}. The history's line times are wall times: compared with the talk's wall start. */
  private keepOwnLine(c: Conversation): void {
    const mine = this.deps.history().findLast((line) => same(line.speaker, this.deps.self));
    if (mine === undefined || mine === this.lastOwnKept || (mine.at !== undefined && mine.at < c.startedWall)) return;
    this.lastOwnKept = mine;
    this.keep(mine.speaker, mine.text, mine.at ?? this.deps.wallNow());
  }

  /** Keeps a line of the current conversation (`at`: wall time, as the chat history's lines have), at most `gistLines` of them. */
  private keep(speaker: string, text: string, at: number): void {
    this.lines.push({ speaker, text, at });
    if (this.lines.length > this.limits.gistLines) this.lines.splice(0, this.lines.length - this.limits.gistLines);
  }

  private begin(c: Conversation, own: boolean): void {
    this.record = c;
    this.lines = [];
    this.holdsBudget = own;
    this.touched = new Set(c.members);
  }

  private journal(event: ConversationEvent["event"], c: Conversation, more: Partial<Omit<ConversationEvent, "kind" | "event" | "id" | "members">>): void {
    this.deps.journal({ kind: "conversation", event, id: c.id, members: [...c.members], ...more });
  }

  private remember(talk: Talk): void {
    for (const name of talk.with) this.talks.set(name.toLowerCase(), talk);
    while (this.talks.size > PARTNERS_KEPT) {
      const oldest = [...this.talks.entries()].reduce((a, b) => (b[1].endedAt < a[1].endedAt ? b : a));
      this.talks.delete(oldest[0]);
    }
  }
}
