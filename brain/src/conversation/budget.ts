/** How many conversations this brain holds at once, and what is remembered of a talk the model did not sum up. */
import type { ChatLine } from "../mind.ts";

/** The most of a member's last line the fallback gist quotes. */
const FALLBACK_GIST_CHARS = 120;

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

/** What is remembered of a talk the model did not sum up: its topic, else the last line another member said, else who it was with. Never empty. */
export function fallbackGist(topic: string, othersLines: readonly ChatLine[], others: readonly string[]): string {
  if (topic !== "") return topic;
  const last = othersLines.at(-1);
  if (last !== undefined) return `${last.speaker}: "${last.text}"`.slice(0, FALLBACK_GIST_CHARS);
  return `with ${others.join(", ")}`;
}

/** The `--max-conversations` flag: a whole number of conversations at once (0 = never opens one), default 2. */
export function maxConversations(value: string | undefined): number {
  if (value === undefined) return 2;
  const count = Number(value);
  if (value.trim() === "" || !Number.isInteger(count) || count < 0) throw new Error(`[BAD_START_ARG] --max-conversations expects a whole number (0 or more), got ${value}`);
  return count;
}
