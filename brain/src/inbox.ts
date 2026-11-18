import { monotonicNow } from "./monotonic-clock.ts";
import type { PlayerMessage } from "./runtime-client.ts";

/** A message taken from the inbox: its lines read as one, and the mark that tells whether its speaker spoke since. */
export interface Heard {
  readonly message: PlayerMessage;
  /** How many lines were joined into it. */
  readonly lines: number;
  /** When its newest line was read (the inbox clock): a request asked after this is not answered by it. */
  readonly readAt: number;
  /** Passed to {@link Inbox.superseded}: later lines of the speaker are newer than this. */
  readonly seq: number;
  /** How many older lines were left out to keep the message within its caps (the newest are kept). */
  readonly dropped: number;
  /** The text of the newest line as the speaker typed it (before any cut): what the everyone-line claim is keyed on. */
  readonly lastLine: string;
  /** How long the message was ready and skipped because its speaker had no token (ms; 0 when never skipped). */
  readonly heldMs: number;
}

/** The caps of one waiting message (persona `settings.chat`, spec 2026-11-18-chat-flood-bounds D1). */
export interface BurstLimits {
  readonly maxLines: number;
  /** Characters of the lines joined with a space. */
  readonly maxChars: number;
  /** A message is ready this long after its first line, however fast the lines come. */
  readonly maxMs: number;
}

/** The inbox caps of a persona's `settings.chat` (seconds there, milliseconds here). */
export function burstLimitsOf(chat: { readonly burstMaxLines: number; readonly burstMaxChars: number; readonly burstMaxSeconds: number }): BurstLimits {
  return { maxLines: chat.burstMaxLines, maxChars: chat.burstMaxChars, maxMs: chat.burstMaxSeconds * 1_000 };
}

interface Burst {
  readonly speaker: string;
  /** The kept lines, oldest first (within the caps). */
  lines: PlayerMessage[];
  /** When its first line arrived. */
  readonly first: number;
  /** When its last line arrived. */
  last: number;
  /** The newest line's text as typed. */
  lastLine: string;
  dropped: number;
  /** When the lines or characters first reached their cap: the message is ready from then. */
  filledAt: number | null;
  /** When {@link Inbox.next} first skipped it for lack of a token. */
  heldSince: number | null;
}

/** The characters of lines joined with a space. */
function joinedLength(lines: readonly PlayerMessage[]): number {
  return lines.reduce((sum, line) => sum + line.message.length, 0) + Math.max(0, lines.length - 1);
}

/**
 * The lines a character hears, before the chat tier reads them (spec 2026-10-09-chat-handling, A; bounds: spec
 * 2026-11-18-chat-flood-bounds D1, D2). A speaker has at most one waiting message: their lines join it whatever the
 * pause, it is ready when the speaker paused `burstMs`, or it is full, or its first line is `maxMs` old, and it keeps
 * at most `maxLines` lines and `maxChars` characters, the newest. Pure: the clock is injected. It never reads what a
 * line says.
 */
export class Inbox {
  private readonly bursts: Burst[] = [];
  /** The sequence number of each speaker's (lower case) latest line, and the count so far. */
  private readonly latest = new Map<string, number>();
  private seq = 0;
  /** Speakers (lower case) whose line was taken and is being decided: a count each. */
  private readonly held = new Map<string, number>();

  constructor(private readonly burstMs: number, private readonly limits: BurstLimits, private readonly now: () => number = monotonicNow) {}

  push(message: PlayerMessage): void {
    const at = this.now();
    const speaker = message.username.toLowerCase();
    this.seq += 1;
    this.latest.set(speaker, this.seq);
    const waiting = this.bursts.find((burst) => burst.speaker === speaker);
    if (waiting === undefined) {
      const burst: Burst = { speaker, lines: [message], first: at, last: at, lastLine: message.message, dropped: 0, filledAt: null, heldSince: null };
      this.bursts.push(burst);
      this.keepWithinCaps(burst, at);
      return;
    }
    waiting.lines.push(message);
    waiting.last = at;
    waiting.lastLine = message.message;
    this.keepWithinCaps(waiting, at);
  }

  /** Drops the oldest lines until the burst fits (counting them), cuts a single line over the characters, and notes when it filled. */
  private keepWithinCaps(burst: Burst, at: number): void {
    const { maxLines, maxChars } = this.limits;
    while (burst.lines.length > 1 && (burst.lines.length > maxLines || joinedLength(burst.lines) > maxChars)) {
      burst.lines.shift();
      burst.dropped += 1;
    }
    const [only] = burst.lines;
    if (burst.lines.length === 1 && only!.message.length > maxChars) burst.lines = [{ ...only!, message: only!.message.slice(0, maxChars) }];
    if (burst.filledAt === null && (burst.dropped > 0 || burst.lines.length >= maxLines || joinedLength(burst.lines) >= maxChars)) burst.filledAt = at;
  }

  /** When the burst may be taken: the speaker's pause, a full burst, or its age, whichever comes first. */
  private readyAt(burst: Burst): number {
    return Math.min(burst.last + this.burstMs, burst.filledAt ?? Number.POSITIVE_INFINITY, burst.first + this.limits.maxMs);
  }

  /**
   * The first ready message (speakers in the order of their first waiting line) whose speaker `tryTake` lets through
   * (asked once per ready message, in order; absent: every speaker). A message skipped for lack of a token waits and
   * goes on taking lines; {@link Heard.heldMs} tells for how long.
   */
  next(tryTake?: (speaker: string) => boolean): Heard | null {
    const now = this.now();
    for (const [index, burst] of this.bursts.entries()) {
      if (now < this.readyAt(burst)) continue;
      if (tryTake !== undefined && !tryTake(burst.speaker)) {
        burst.heldSince ??= now;
        continue;
      }
      this.bursts.splice(index, 1);
      return this.heardFrom(burst, burst.heldSince === null ? 0 : now - burst.heldSince);
    }
    return null;
  }

  private heardFrom(burst: Burst, heldMs: number): Heard {
    const [first, ...more] = burst.lines;
    return {
      message: more.length === 0 ? first! : {
        ...first!,
        message: burst.lines.map((line) => line.message).join(" "),
        channel: burst.lines.some((line) => line.channel === "whisper") ? "whisper" : "chat",
        addressed: burst.lines.some((line) => line.addressed),
      },
      lines: burst.lines.length,
      readAt: burst.last,
      seq: this.seq,
      dropped: burst.dropped,
      lastLine: burst.lastLine,
      heldMs,
    };
  }

  /**
   * Milliseconds until a message is ready (0: now); null when nothing waits. `waitMs` is how long a speaker (lower
   * case) must still wait for a token: a message is not ready before it.
   */
  readyIn(waitMs: (speaker: string) => number = () => 0): number | null {
    if (this.bursts.length === 0) return null;
    const now = this.now();
    return Math.min(...this.bursts.map((burst) => Math.max(this.readyAt(burst) - now, waitMs(burst.speaker), 0)));
  }

  /** Marks a line of `speaker` as being decided until the returned release is called. */
  hold(speaker: string): () => void {
    const name = speaker.toLowerCase();
    this.held.set(name, (this.held.get(name) ?? 0) + 1);
    return () => {
      const left = (this.held.get(name) ?? 1) - 1;
      if (left <= 0) this.held.delete(name);
      else this.held.set(name, left);
    };
  }

  /** Whether a line of `speaker` waits to be taken or is being decided. */
  hasFrom(speaker: string): boolean {
    const name = speaker.toLowerCase();
    return this.held.has(name) || this.bursts.some((burst) => burst.speaker === name);
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
