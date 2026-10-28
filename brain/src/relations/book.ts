// The agent's book of relations: records in memory, saved as one runtime note per partner, writes serialised per partner.
import type { Memory } from "../memory.ts";
import { describeRelation, newRelation, relationNote } from "./record.ts";
import { withScoreEvent } from "./score.ts";
import { isOpen } from "./trade.ts";
import type { GiveProgress, Relation, ScoreInput, Scoring, Trade } from "./types.ts";

export interface RelationBookDeps {
  save(memory: Memory): Promise<void>;
  /** Deletes the note whose context names this partner (`relation:<partner>`). */
  remove(context: string): Promise<void>;
  now(): number;
  log(line: string): void;
  /** The amounts and the character's temperament that turn an event into a score change. */
  scoring: Scoring;
}

const keyOf = (partner: string) => partner.toLowerCase();

export class RelationBook {
  private readonly relations = new Map<string, Relation>();
  /** Partners whose note is in the world's data (so an update replaces it). */
  private readonly stored = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: RelationBookDeps) {}

  /** What scores are made of; a caller that changes a record and scores it does both in one `update`. */
  get scoring(): Scoring {
    return this.deps.scoring;
  }

  /** Takes the records recalled from the notes. */
  load(relations: readonly Relation[]): void {
    for (const relation of relations) {
      this.relations.set(keyOf(relation.partner), relation);
      this.stored.add(keyOf(relation.partner));
    }
  }

  get(partner: string): Relation | null {
    return this.relations.get(keyOf(partner)) ?? null;
  }

  /**
   * Applies a pure change to the partner's record (a stranger starts from a new one) and replaces its note. Updates of
   * one partner run one after the other, each on the result of the one before. A failed save is logged: the record
   * stays in memory and the next update saves it again.
   */
  update(partner: string, change: (r: Relation) => Relation): Promise<Relation> {
    const key = keyOf(partner);
    const run = (this.queues.get(key) ?? Promise.resolve()).then(() => this.apply(key, partner, change));
    this.queues.set(key, run.catch(() => undefined));
    return run;
  }

  /** Drifts the partner's score to now, applies one event and saves the note; serialised with every other update of the partner. */
  score(partner: string, e: ScoreInput): Promise<Relation> {
    return this.update(partner, (r) => withScoreEvent(r, e, this.deps.now(), this.deps.scoring));
  }

  private async apply(key: string, partner: string, change: (r: Relation) => Relation): Promise<Relation> {
    const next = change(this.relations.get(key) ?? newRelation(partner, this.deps.now(), this.deps.scoring.temperament.firstImpression));
    this.relations.set(key, next);
    const memory: Memory = { kind: "relation", relation: next };
    try {
      if (this.stored.delete(key)) await this.deps.remove(relationNote(next).context);
      await this.deps.save(memory);
      this.stored.add(key);
    } catch (error) {
      this.deps.log(`could not save the relation with ${partner}: ${String(error)}`);
    }
    return next;
  }

  /** Every record the book holds. */
  records(): Relation[] {
    return [...this.relations.values()];
  }

  /** Every trade kept with every partner: the open ones and the last ended ones. */
  trades(): Trade[] {
    return [...this.relations.values()].flatMap((r) => [...r.trades]);
  }

  /** Every open trade with every partner. */
  openTrades(): Trade[] {
    return [...this.relations.values()].flatMap((r) => r.trades.filter(isOpen));
  }

  /** The prompt text for each partner (a stranger reads as not dealt with). */
  summaries(partners: readonly string[], progress?: (tradeId: string) => GiveProgress | undefined): string[] {
    return partners.map((p) => describeRelation(this.get(p), p, this.deps.now(), this.deps.scoring, progress));
  }
}
