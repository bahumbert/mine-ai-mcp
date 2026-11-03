// Whom each player's lines named last, so a line naming nobody is shown to the models as following the one that did.
import type { PlayerMessage } from "./runtime-client.ts";

/** How long after a line naming a character a line naming nobody is still shown as following it. */
const TALKED_TO_MS = 60_000;

/** The character a player was lately talking to, as the chat tier gets it (`ChatInput.talkedTo`). */
export interface TalkedTo {
  readonly name: string;
  readonly secondsAgo: number;
}

/**
 * Remembers which character (this one or another agent) each speaker's line named; for a line naming none, who its
 * speaker named last when that was within {@link TALKED_TO_MS} (live 2026-10-11: "thanks, no rush" after a line to Vex
 * was answered by Ayla too). Names as words only, never what the line says.
 */
export class WhoWasNamed {
  /** Per speaker (lower case), the latest character a line of theirs named, and when. */
  private readonly lastNamed = new Map<string, { readonly name: string; readonly at: number }>();

  /** `otherAgents`: asked on every line, as the agent's own list is (a bot started from game chat joins it). */
  constructor(
    private readonly own: string,
    private readonly otherAgents: () => readonly string[],
  ) {}

  /** `at`: when the message was heard, on the monotonic clock. Returns who the speaker was lately talking to when this line names nobody. */
  note(message: PlayerMessage, at: number): TalkedTo | undefined {
    const speaker = message.username.toLowerCase();
    const otherAgents = this.otherAgents();
    const characters = [this.own, ...otherAgents];
    const named = characters.filter((name) => name.toLowerCase() !== speaker && message.message.toLowerCase().split(/[^\p{L}\p{N}_]+/u).includes(name.toLowerCase()));
    if (otherAgents.some((name) => name.toLowerCase() === speaker)) return undefined;
    if (named.length > 0) {
      this.lastNamed.set(speaker, { name: named[0]!, at });
      return undefined;
    }
    const last = this.lastNamed.get(speaker);
    return last !== undefined && last.name.toLowerCase() !== this.own.toLowerCase() && at - last.at <= TALKED_TO_MS ? { name: last.name, secondsAgo: Math.round((at - last.at) / 1_000) } : undefined;
  }
}
