import { lineDistance } from "./conversation/state.ts";
import type { BotSnapshot, PlayerMessage } from "./runtime-client.ts";

/** A line to everyone is forgotten this long after the first bot heard it. */
const FORGET_AFTER_MS = 60_000;

interface Line {
  readonly firstHeardAt: number;
  /** Each bot that heard it, with its smallest known distance to the speaker; null when unknown. */
  readonly distances: Map<string, number | null>;
  claimedBy: string | null;
}

/**
 * The lines to everyone that ask nothing ("sups boys ?") which the brain's bots heard, so that only the bot nearest the
 * speaker answers one (owner, 2026-10-19; conv5, 2026-10-18: five bots read the same greeting and the rule of 2026-10-09
 * left it unanswered by all). One instance serves every agent of the process.
 */
export class EveryoneLines {
  private readonly lines = new Map<string, Line>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Notes that `bot` heard the line and how far the speaker was (null when it cannot tell). */
  heard(speaker: string, text: string, bot: string, distance: number | null): void {
    const line = this.lineFor(speaker, text);
    const known = line.distances.get(bot);
    if (distance === null) {
      if (known === undefined) line.distances.set(bot, null);
    } else if (known === undefined || known === null || distance < known) {
      line.distances.set(bot, distance);
    }
  }

  /** True for the one bot that may answer the line: the nearest of those who heard it, when nobody claimed it yet. */
  claim(speaker: string, text: string, bot: string): boolean {
    const line = this.lineFor(speaker, text);
    if (!line.distances.has(bot)) line.distances.set(bot, null);
    if (line.claimedBy !== null) return false;
    const [first] = [...line.distances].sort(([nameA, a], [nameB, b]) => rank(a) - rank(b) || nameA.toLowerCase().localeCompare(nameB.toLowerCase()));
    if (first?.[0] !== bot) return false;
    line.claimedBy = bot;
    return true;
  }

  /**
   * What lets a bot's chat tier answer a greeting to everyone: the speaker's distance (from the positions when the line
   * carries none) goes to the record, and the returned claim, on `newestLine` (the same for every bot whatever its inbox
   * merged or dropped), is true for the nearest bot only. Undefined for a line outside public chat.
   */
  claimFor(message: PlayerMessage, snapshot: BotSnapshot, bot: string, newestLine: string): (() => boolean) | undefined {
    if (message.channel !== "chat") return undefined;
    const distance = lineDistance(message, snapshot);
    if (message.distance === undefined && distance !== undefined) this.heard(message.username, newestLine, bot, distance);
    return () => this.claim(message.username, newestLine, bot);
  }

  private lineFor(speaker: string, text: string): Line {
    const at = this.now();
    for (const [key, line] of this.lines) if (at - line.firstHeardAt > FORGET_AFTER_MS) this.lines.delete(key);
    const key = `${speaker.toLowerCase()}\n${text}`;
    let line = this.lines.get(key);
    if (line === undefined) {
      line = { firstHeardAt: at, distances: new Map(), claimedBy: null };
      this.lines.set(key, line);
    }
    return line;
  }
}

/** Unknown distances rank after every number. */
function rank(distance: number | null): number {
  return distance ?? Number.POSITIVE_INFINITY;
}
