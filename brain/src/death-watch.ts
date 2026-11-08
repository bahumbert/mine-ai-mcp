// The watch that ends a running step when the bot dies during it (spec P4-02c D2).
import type { ActOutcome } from "./body.ts";
import type { LastDeath } from "./last-death.ts";
import type { BotSnapshot } from "./runtime-client.ts";

/** What the watch needs: the death as it stood when the step started and the step's own controller. */
export interface DeathWatchDeps {
  /** The `lastDeath` read at the step's start; undefined: the runtime sends none, the watch is off. */
  readonly baseline: LastDeath | null | undefined;
  /** The controller the step's skill runs under (the no-gain watch aborts the same one). */
  readonly controller: AbortController;
  readonly status: () => Promise<BotSnapshot>;
  readonly log: (line: string) => void;
}

export interface DeathWatch {
  /** An action of the step ended: when the runtime cancelled it (not the body), the status is read once. */
  readonly actionEnded: (outcome: ActOutcome | null) => void;
  /** A status read made for another reason (the no-gain watch's sample) is looked at too. */
  readonly sample: (snapshot: BotSnapshot) => void;
  /** Why this watch aborted the controller, or null (never aborted, or another abort came first). */
  readonly died: () => string | null;
}

/** The longest death cause the step's record keeps: the server's death message can carry a player's item or mob name. */
const MAX_CAUSE_CHARS = 120;

/** One line of plain text: a game text can hold a newline, which would start a fake step line in the next prompt. */
function readable(cause: string): string {
  const line = cause.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/gu, " ").trim();
  return line.length > MAX_CAUSE_CHARS ? `${line.slice(0, MAX_CAUSE_CHARS - 3)}...` : line;
}

/**
 * A death during a step cancels it at once: the runtime cancels the running action on death
 * (`src/runtime/minecraft-runtime.ts:398`), so an action that ends `cancelled` without the body having cancelled it
 * is the usual sign, and a status sample is the backstop for a death between two actions. A snapshot whose `lastDeath`
 * differs from the baseline's `observedAt` (compared as strings: a wall clock that steps cannot fire it) aborts the
 * controller once with `you died during this step at x y z (cause)`. Once the controller is aborted, by anyone, the
 * watch does nothing, so a stop for another reason is never relabelled a death.
 */
export function watchDeath({ baseline, controller, status, log }: DeathWatchDeps): DeathWatch {
  let died: string | null = null;
  const sample = (snapshot: BotSnapshot): void => {
    const death = snapshot.lastDeath;
    if (baseline === undefined || controller.signal.aborted || death === null || death === undefined || death.observedAt === baseline?.observedAt) return;
    const { x, y, z } = death.position;
    const cause = death.cause === null ? "" : readable(death.cause);
    died = `you died during this step at ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}${cause === "" ? "" : ` (${cause})`}`;
    controller.abort(new Error(died));
  };
  return {
    sample,
    actionEnded: (outcome) => {
      if (baseline === undefined || controller.signal.aborted || outcome === null || outcome.status !== "cancelled" || outcome.preempted) return;
      status().then(sample, (error: unknown) => log(`could not look for a death after a cancelled action: ${String(error)}`));
    },
    died: () => died,
  };
}
