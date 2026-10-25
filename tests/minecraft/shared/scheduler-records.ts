// What the scheduler keeps for a submission, a queued trial and an admitted trial: the records its modules share.
import type { ClientCommandSpec } from "mine-labs";
import type { MutexQueueMarks } from "./pool.ts";
import type { SubmissionEntry, SubmissionSpec, SubmissionSummary } from "./scheduler-types.ts";

/** Where a trial stands from admission on: what the daemon's trial line and the server's mutex queue need. */
export interface Admitted {
  readonly at: number;
  /** The trial's place in its server's arrangement queue; null on a server of its own. */
  readonly queue: MutexQueueMarks | null;
  /** Which player body a server of its own gives this scenario (0 for the first). */
  readonly body: number;
  /** What the trial's client reserved in the ledger at admission. */
  readonly clientMb: number;
}

export interface QueuedTrial {
  readonly sequence: number;
  /** The client command to boot ahead for this trial (our client host only: the others never say they booted); null: none. */
  readonly aheadClient: ClientCommandSpec | null;
  /** Clients it needs: one per player. */
  readonly players: number;
  readonly queuedAt: number;
  /** The bound that held this trial at its last turn, for the sample's count of held trials; null when it was not held. */
  heldBy: string | null;
  readonly submission: Submission;
  readonly entry: SubmissionEntry;
  refusal: string | null;
  /** Samples in a row this trial was refused for want of room for a new server. */
  roomSamples: number;
  /** A timing trial whose last refusal was the cpu bound: it holds the other trials to CPU_CALM so the load drains. */
  waitingForCalm: boolean;
  /** Its server failed to start once and it went back to the queue: a second failure is its error. */
  sentBack: boolean;
}

export interface Submission {
  readonly id: number;
  readonly spec: SubmissionSpec;
  readonly abort: AbortController;
  readonly summary: { runs: number; passed: number; failed: number; cancelled: number };
  readonly done: PromiseWithResolvers<SubmissionSummary>;
  running: number;
  queued: number;
}
