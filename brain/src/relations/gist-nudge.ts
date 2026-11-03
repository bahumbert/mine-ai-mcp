// The gist's view of a conversation, written into each other member's record.
import type { GistPartner } from "../mind.ts";
import type { RelationBook } from "./book.ts";
import { forgetOldSaid, withSaid } from "./record.ts";
import { newScoredRows, withScoreEvent } from "./score.ts";
import type { RelationEvent } from "./types.ts";

/** The gist's nudge of the score of each other member (one write with what they said they have or need). */
export async function writeGist(book: RelationBook, partners: readonly GistPartner[], now: number, forgetMinutes: number, journal: (e: RelationEvent) => void): Promise<void> {
  for (const p of partners) {
    const { nudge } = p;
    if (nudge === null && p.has.length === 0 && p.needs.length === 0) continue;
    let rows: RelationEvent[] = [];
    await book.update(p.name, (r) => {
      const said = forgetOldSaid(withSaid(r, p.has, p.needs, now), now, forgetMinutes);
      const next = nudge === null ? said : withScoreEvent(said, { kind: "nudge", nudge: nudge.value, why: nudge.why }, now, book.scoring);
      rows = newScoredRows(r, next);
      return next;
    });
    for (const row of rows) journal(row);
  }
}
