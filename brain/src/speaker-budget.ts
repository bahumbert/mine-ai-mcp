// A token bucket per speaker, one for the whole brain: how many chat-tier decisions one player's lines may cost.
import { monotonicNow } from "./monotonic-clock.ts";

/** The most chat-tier decisions one speaker may have read in a minute and at once (spec 2026-11-18-chat-flood-bounds D3). */
export interface SpeakerBudgetLimits {
  /** Tokens that come back per minute; 0 turns the bound off. */
  readonly perMinute: number;
  /** The most tokens a speaker holds (a new speaker starts with all of them). */
  readonly burst: number;
}

interface Bucket {
  tokens: number;
  /** The clock reading the tokens were last counted at. */
  at: number;
}

/**
 * A token bucket per speaker (lower case), one for the whole brain process: a player whispering every bot spends one
 * token per message the inbox hands out, whichever bot reads it, so the chat tier's model calls for that player are
 * bounded however many bots hear them. The token is taken when the message is handed out and given back when no chat
 * model call was made for it. Runs on the monotonic clock (injected `now` in tests); in memory only.
 */
export class SpeakerBudget {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly limits: SpeakerBudgetLimits, private readonly now: () => number = monotonicNow) {}

  /** Milliseconds until `speaker` has a token (0: now). */
  waitMs(speaker: string): number {
    if (this.limits.perMinute === 0) return 0;
    const { tokens } = this.refilled(speaker);
    return tokens >= 1 ? 0 : Math.ceil(((1 - tokens) * 60_000) / this.limits.perMinute);
  }

  /** Takes a token of `speaker` when they have one: false when they have none. Synchronous, so two bots never take the same token. */
  tryTake(speaker: string): boolean {
    if (this.limits.perMinute === 0) return true;
    const bucket = this.refilled(speaker);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Gives back the token of a message that made no chat model call (never above the burst). */
  refund(speaker: string): void {
    if (this.limits.perMinute === 0) return;
    const bucket = this.refilled(speaker);
    bucket.tokens = Math.min(this.limits.burst, bucket.tokens + 1);
  }

  /** The speaker's bucket with the tokens that came back since it was last counted. */
  private refilled(speaker: string): Bucket {
    const name = speaker.toLowerCase();
    const at = this.now();
    const bucket = this.buckets.get(name) ?? { tokens: this.limits.burst, at };
    bucket.tokens = Math.min(this.limits.burst, bucket.tokens + (this.limits.perMinute * Math.max(0, at - bucket.at)) / 60_000);
    bucket.at = at;
    this.buckets.set(name, bucket);
    return bucket;
  }
}
