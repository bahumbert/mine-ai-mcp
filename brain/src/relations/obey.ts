// Whether an order from someone is taken: a roll weighted by how the character rates them, held for a while per speaker.
import type { Persona } from "../persona.ts";

export type ObeySettings = Persona["settings"]["relations"]["obey"];

/** One roll's outcome: whether the order is taken, the chance it had and the score it was rolled at. */
export interface ObeyMood {
  readonly obeys: boolean;
  readonly chance: number;
  readonly score: number;
}

interface Stored extends ObeyMood {
  readonly rolledAt: number;
}

/** The chance (0..1) that an order is taken: logistic in the score, 50 % at `halfAt`, gentler as `spread` grows. */
export function obeyChance(score: number, halfAt: number, spread: number): number {
  return 1 / (1 + Math.exp((halfAt - score) / spread));
}

/** The roll of each speaker, kept in memory: repeating a request inside the window does not roll again. */
export class ObeyMoods {
  private readonly moods = new Map<string, Stored>();

  constructor(private readonly settings: ObeySettings) {}

  /** The stored roll while it is young and the score has not moved far, else a new roll with `random`. */
  moodOf(speaker: string, score: number, now: number, random: () => number): ObeyMood {
    const { halfAt, spread, moodMinutes, rerollOnChange } = this.settings;
    const kept = this.moods.get(speaker.toLowerCase());
    if (kept !== undefined && now - kept.rolledAt < moodMinutes * 60_000 && Math.abs(score - kept.score) < rerollOnChange) return plain(kept);
    const chance = obeyChance(score, halfAt, spread);
    const rolled = { obeys: random() < chance, chance, score, rolledAt: now };
    this.moods.set(speaker.toLowerCase(), rolled);
    return plain(rolled);
  }

  /** The roll last made for the speaker, without looking at its age; null when none was made. */
  stored(speaker: string): ObeyMood | null {
    const kept = this.moods.get(speaker.toLowerCase());
    return kept === undefined ? null : plain(kept);
  }
}

const plain = ({ obeys, chance, score }: Stored): ObeyMood => ({ obeys, chance, score });
