import type { Persona } from "../persona.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";

export type ConversationKind = "chance" | "social";
export type PlannedLength = "short" | "medium" | "long";
export type EndReason = "goodbye" | "out_of_range" | "silence" | "cap" | "taken_over";

/** Lines in all (every member) a planned length stands for, [min, max]. */
export const PLANNED_LINES: Readonly<Record<PlannedLength, readonly [number, number]>> = {
  short: [2, 4],
  medium: [5, 10],
  long: [10, 20],
};

export interface Conversation {
  readonly id: string;
  readonly kind: ConversationKind;
  readonly opener: string;
  /** Always holds the character itself. */
  members: string[];
  /** The opener's, in its words; "" when someone else opened it. */
  topic: string;
  /** Only the opener has one. */
  readonly planned: PlannedLength | null;
  /** Lines said in it, all members. */
  lines: number;
  readonly startedAt: number;
  lastLineAt: number;
  /** Member -> first ms seen out of range. */
  outOfRangeSince: Record<string, number>;
  /** Opened by whisper: stays private. */
  readonly whisper: boolean;
  /** Social call: range and silence rules do not apply before this. */
  waitUntil: number | null;
  /** First ms the cap was seen reached (the character's next line then ends it). */
  capReachedAt: number | null;
}

export type Limits = Persona["settings"]["conversation"] & { readonly talkRange: number };

export function openConversation(a: {
  self: string; opener: string; kind: ConversationKind; members: readonly string[]; topic: string;
  planned: PlannedLength | null; whisper: boolean; now: number; waitUntil?: number;
}): Conversation {
  const members = [a.self];
  for (const name of [a.opener, ...a.members]) if (!members.some((m) => same(m, name))) members.push(name);
  return {
    id: `${a.opener}-${a.now}`, kind: a.kind, opener: a.opener, members, topic: a.topic, planned: a.planned, lines: 0,
    startedAt: a.now, lastLineAt: a.now, outOfRangeSince: {}, whisper: a.whisper, waitUntil: a.waitUntil ?? null,
    capReachedAt: null,
  };
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function isMember(c: Conversation, name: string): boolean {
  return c.members.some((m) => same(m, name));
}

/** Adds the names not yet in; returns the ones newly added. */
export function addMembers(c: Conversation, names: readonly string[]): string[] {
  const added: string[] = [];
  for (const name of names) {
    if (isMember(c, name)) continue;
    c.members.push(name);
    added.push(name);
  }
  return added;
}

export function lineSaid(c: Conversation, now: number): void {
  c.lines += 1;
  c.lastLineAt = now;
}

export function manhattan(a: Position, b: Position): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
}

/** Notes who is out of range; members out for `outOfRangeSeconds` are dropped from the record and returned. */
export function checkRange(c: Conversation, self: string, at: Position, players: BotSnapshot["players"], limits: Limits, now: number): string[] {
  if (c.waitUntil !== null && now < c.waitUntil) return [];
  const dropped: string[] = [];
  for (const member of [...c.members]) {
    if (same(member, self)) continue;
    const position = players.find((p) => same(p.username, member))?.position ?? null;
    if (position !== null && manhattan(at, position) <= limits.talkRange) {
      delete c.outOfRangeSince[member];
      continue;
    }
    const since = c.outOfRangeSince[member] ?? now;
    c.outOfRangeSince[member] = since;
    if (now - since >= limits.outOfRangeSeconds * 1_000) {
      c.members = c.members.filter((m) => m !== member);
      delete c.outOfRangeSince[member];
      dropped.push(member);
    }
  }
  return dropped;
}

export function ending(c: Conversation, self: string, limits: Limits, now: number): EndReason | null {
  if (c.waitUntil !== null && now < c.waitUntil) return null;
  if (!c.members.some((m) => !same(m, self))) return "out_of_range";
  if (now - c.lastLineAt >= limits.silenceSeconds * 1_000) return "silence";
  return null;
}

export function capReached(c: Conversation, limits: Limits, now: number): boolean {
  return c.lines >= limits.maxLines || now - c.startedAt >= limits.maxMinutes * 60_000;
}
