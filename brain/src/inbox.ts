import type { PlayerMessage } from "./runtime-client.ts";

/** A message taken from the inbox: its lines read as one, and the mark that tells whether its speaker spoke since. */
export interface Heard {
  readonly message: PlayerMessage;
  /** How many lines were joined into it. */
  readonly lines: number;
  /** Passed to {@link Inbox.superseded}: later lines of the speaker are newer than this. */
  readonly seq: number;
}

interface Burst {
  readonly speaker: string;
  readonly lines: PlayerMessage[];
  /** When its last line arrived. */
  last: number;
}

/**
 * The lines a character hears, before the chat tier reads them (spec 2026-10-09-chat-handling, A). Lines from the same
 * speaker less than `burstMs` apart are one message: a player typing three quick lines gets one answer, not three.
 * Pure: the clock is injected. It never reads what a line says.
 */
export class Inbox {
  private readonly bursts: Burst[] = [];
  /** The sequence number of each speaker's (lower case) latest line, and the count so far. */
  private readonly latest = new Map<string, number>();
  private seq = 0;

  constructor(private readonly burstMs: number, private readonly now: () => number = Date.now) {}

  push(message: PlayerMessage): void {
    const at = this.now();
    const speaker = message.username.toLowerCase();
    this.seq += 1;
    this.latest.set(speaker, this.seq);
    const open = this.bursts.findLast((burst) => burst.speaker === speaker);
    if (open !== undefined && at - open.last < this.burstMs) {
      open.lines.push(message);
      open.last = at;
    } else {
      this.bursts.push({ speaker, lines: [message], last: at });
    }
  }

  /** The oldest message whose speaker has paused for the window, or null. */
  next(): Heard | null {
    const now = this.now();
    const index = this.bursts.findIndex((burst) => now - burst.last >= this.burstMs);
    if (index === -1) return null;
    const [burst] = this.bursts.splice(index, 1);
    const [first, ...more] = burst!.lines;
    return {
      message: more.length === 0 ? first! : {
        ...first!,
        message: burst!.lines.map((line) => line.message).join(" "),
        channel: burst!.lines.some((line) => line.channel === "whisper") ? "whisper" : "chat",
        addressed: burst!.lines.some((line) => line.addressed),
      },
      lines: burst!.lines.length,
      seq: this.seq,
    };
  }

  /** Milliseconds until a message is ready (0: now); null when nothing waits. */
  readyIn(): number | null {
    if (this.bursts.length === 0) return null;
    const now = this.now();
    return Math.max(0, Math.min(...this.bursts.map((burst) => burst.last + this.burstMs - now)));
  }

  /** Whether `speaker` said something after the message `since` (its {@link Heard.seq}) was taken. */
  superseded(speaker: string, since: number): boolean {
    return (this.latest.get(speaker.toLowerCase()) ?? 0) > since;
  }

  /** Whether any of `speakers` said something after the message `seq` (its {@link Heard.seq}) was taken. */
  spokeSince(speakers: readonly string[], seq: number): boolean {
    return speakers.some((speaker) => this.superseded(speaker, seq));
  }
}
