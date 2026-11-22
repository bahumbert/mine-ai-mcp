// The work tier's decision for the next step of one objective, and what an unusable reply costs the objective.
import { ModelUnavailable } from "../chat-model.ts";
import type { WorkDecision, WorkInput } from "../mind.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import type { AgentOptions } from "./agent-options.ts";
import type { AgentMemory } from "./agent-memory.ts";
import type { FailedSteps } from "./failed-steps.ts";
import { stageWorkValidation, type Work } from "./work.ts";

/** Unusable model replies in a row before an objective is dropped. */
const MAX_BAD_REPLIES = 2;
/** Decisions in a row that a content check kept sending back (not a format failure: those are bad replies). */
const MAX_SENT_BACKS = 4;

/** What the decision reads from the agent it belongs to. `runSignal` is a getter: `Agent.run` replaces the signal at start. */
export interface DecideStepHost {
  readonly options: AgentOptions;
  readonly stack: readonly Work[];
  readonly memory: AgentMemory;
  readonly failedSteps: FailedSteps;
  settled(): Promise<void>;
  laterInput(work: Work, snapshot: BotSnapshot): WorkInput["situation"];
  runSignal(): AbortSignal;
  resetModelFailures(): void;
  finish(work: Work, outcome: "done" | "failed", detail: string): void;
}

/**
 * The model's decision for the next step of `work`. Null when the call gave none: an unusable reply is counted
 * against the objective (two in a row, or too many send-backs, end it), or the agent is stopping.
 */
export async function decideStep(host: DecideStepHost, work: Work, snapshot: BotSnapshot): Promise<WorkDecision | null> {
  const { persona, mind, log } = host.options;
  const { stack, memory } = host;
  const validation = stageWorkValidation(work);
  try {
    const paused = stack.slice(0, -1).map((below) => below.objective);
    const decision = await mind.next({ persona, objective: work.objective, snapshot, places: memory.knownPlaces(), areas: [...memory.areas], steps: [...work.steps], paused, earlierFailures: host.failedSteps.earlier(snapshot), ownsTemporaryHouse: memory.temporaryHouse() !== null, refused: validation.refused, sentBackSteps: validation.sentBackSteps, situation: host.laterInput(work, snapshot) }, host.runSignal());
    await host.settled();
    if (host.runSignal().aborted || stack.at(-1) !== work) return null;
    validation.commit();
    work.badReplies = 0;
    work.sentBacks = 0;
    host.resetModelFailures();
    return decision;
  } catch (error) {
    // Stopped while it thought (an order stopped or the agent shutting down): nothing it did is counted or told.
    await host.settled();
    if (host.runSignal().aborted || stack.at(-1) !== work) return null;
    validation.commit();
    // The model server is away: no reply was given, so none is bad. The work loop waits and asks again.
    if (error instanceof ModelUnavailable) throw error;
    const sentBack = String(error).includes("[LLM_SENT_BACK]");
    if (sentBack) work.sentBacks += 1;
    else work.badReplies += 1;
    log(`work tier failed on ${JSON.stringify(work.objective.text)}: ${String(error)}`);
    if (work.badReplies >= MAX_BAD_REPLIES || work.sentBacks >= MAX_SENT_BACKS) {
      // What the last step ran into is the cause the players hear; without it the narration made one up (live
      // 2026-10-03: "how do I build a house exactly around you without stepping on your feet?" when the logs she
      // needed were all inside her own protected houses).
      const last = work.steps.at(-1);
      host.finish(work, "failed", last === undefined || last.outcome === "done"
        ? "could not work out what to do next"
        : `could not work out what to do next after this: ${last.step} ${last.outcome}: ${last.detail}`);
    }
    return null;
  }
}
