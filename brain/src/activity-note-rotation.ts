// Deleting a character's activity-time notes older than its last hour of play (moved out of agent.ts to keep it under its size limit).
import type { Body } from "./body.ts";
import { activityNotesQuery, staleActivityNotes } from "./memory.ts";
import type { McpBotRuntime } from "./runtime-client.ts";
import { RECENT_MINUTES } from "./time-spent.ts";

/** At most this many notes deleted in one `note_delete`. */
const DELETE_BATCH = 500;

/**
 * Deletes `username`'s activity-time notes older than its last hour of play (spec 2026-10-04-activity-time-travel-
 * terraforming: only the last hour is kept). Never rejects: a failure is logged and the next rotation tries again.
 */
export async function forgetOldActivityNotes(runtime: Pick<McpBotRuntime, "queryBotData">, body: Pick<Body, "act">, username: string, log: (line: string) => void): Promise<void> {
  try {
    const rows = await runtime.queryBotData(activityNotesQuery(username));
    const stale = staleActivityNotes(rows, RECENT_MINUTES);
    for (let start = 0; start < stale.length; start += DELETE_BATCH) {
      const outcome = await body.act("note_delete", { note_ids: stale.slice(start, start + DELETE_BATCH) }, "Forget what is older than my last hour of play.");
      if (outcome.status !== "succeeded") {
        log(`could not forget old activity notes (${outcome.status}): ${outcome.error ?? ""}`);
        return;
      }
    }
    if (stale.length > 0) log(`forgot ${stale.length} activity note(s) older than its last hour of play`);
  } catch (error) {
    log(`could not forget old activity notes: ${String(error)}`);
  }
}
