// The clients the scheduler boots ahead of the queued trials: which trials get one, when a boot is refused, what an admitted trial reserves for its client.
import { ledgerMb, type AdmissionSample, type AdmissionTally } from "./admission.ts";
import type { ScenarioServerConfig } from "./config.ts";
import { clientAheadRefusal } from "./client-ahead-gate.ts";
import { clientTupleOf, type ClientsAhead } from "./client-ahead.ts";
import type { QueuedTrial, Submission } from "./scheduler-records.ts";
import type { SubmissionEntry } from "./scheduler-types.ts";

/** What a pass of the scheduler knows when it boots clients: the live sample, the tally so far, and the boots this pass already started. */
export interface AheadPass {
  readonly ahead: ClientsAhead;
  readonly config: ScenarioServerConfig;
  readonly sample: AdmissionSample;
  readonly tally: AdmissionTally;
  /** Clients booted in the current pass: their cpu is not in the last sample. */
  readonly bootsThisPass: number;
  /** A timing trial runs or waits for a calm machine. */
  readonly timingBusy: boolean;
  readonly isTiming: (submission: Submission, entry: SubmissionEntry) => boolean;
}

/** What the trial's client reserves at admission: the difference to a logged-in client when one booted ahead waits for it, else a whole client. */
export function clientReserveMb(config: ScenarioServerConfig, ahead: ClientsAhead | undefined, queued: QueuedTrial): number {
  const { clientMemMb, clientBootedMemMb } = config;
  const { aheadClient: client, submission } = queued;
  return client && ahead && ahead.unclaimedCount(submission.id, client) > 0 ? clientMemMb - clientBootedMemMb : clientMemMb;
}

/** Why no client may boot now for this trial, or null (`forAdmittedTrial`: its own reserve holds the client). */
function bootRefusal(pass: AheadPass, queued: QueuedTrial, forAdmittedTrial: boolean): string | null {
  const { sample, tally, config } = pass;
  return clientAheadRefusal({
    forTimingTrial: pass.isTiming(queued.submission, queued.entry), timingBusy: pass.timingBusy,
    cpuBusy: cpuWithBootsOfThisPass(pass), ledgerMb: ledgerMb(sample, tally, config), forAdmittedTrial,
  }, config);
}

/** The busy cpu plus what the clients booted in this pass will add: their boots are not in the last sample, and a pass must not boot a whole cap of them into a machine at the bound. */
function cpuWithBootsOfThisPass({ sample, config, bootsThisPass }: AheadPass): number | null {
  if (sample.cpuBusy === null) return null;
  const { clientBootCpuSeconds, sampleEveryMs } = config;
  return sample.cpuBusy + bootsThisPass * clientBootCpuSeconds / (sample.threads * sampleEveryMs / 1_000);
}

/** The pass after one more client booted; `reserved`: the client holds its booted size in the tally until it is in MemAvailable, and this pass's later decisions must see it. */
function afterBoot(pass: AheadPass, reserved: boolean): AheadPass {
  const tally = reserved ? { ...pass.tally, reservedMb: pass.tally.reservedMb + pass.config.clientBootedMemMb } : pass.tally;
  return { ...pass, tally, bootsThisPass: pass.bootsThisPass + 1 };
}

/** Boots clients for the queued trials that can start soon, in turn order, one per player, up to the caps and while the ledger holds them: they are joined to their trials when these start. Returns how many it booted. */
export function bootClientsForQueuedTrials(start: AheadPass, order: readonly QueuedTrial[]): number {
  const { ahead } = start;
  let pass = start;
  const wanted = new Map<string, number>();
  const considered = new Map<Submission, number>();
  for (const queued of order) {
    const { aheadClient: client, submission } = queued;
    if (!client || pass.isTiming(submission, queued.entry) || queued.heldBy === "hold") continue;
    // Past a `--lanes N` cap only the next wave of N can start soon: the rest would idle at their booted size.
    const seen = (considered.get(submission) ?? 0) + 1;
    considered.set(submission, seen);
    if (submission.spec.maxLanes !== null && seen > submission.spec.maxLanes) continue;
    const key = `${submission.id}|${clientTupleOf(client)}`;
    const want = (wanted.get(key) ?? 0) + queued.players;
    wanted.set(key, want);
    while (ahead.unclaimedCount(submission.id, client) < want) {
      if (ahead.isFull(submission.id) || bootRefusal(pass, queued, false) || ahead.spawn(submission.id, client) !== null) break;
      pass = afterBoot(pass, true);
    }
  }
  return pass.bootsThisPass - start.bootsThisPass;
}

/** The admitted trial keeps the clients booted for it, and boots the missing ones now: its reserve (one client's worth, as for any player count) covers them. Returns how many it booted. */
export function keepClientsFor(start: AheadPass, queued: QueuedTrial): number {
  const { ahead } = start;
  const { aheadClient: client, submission } = queued;
  if (!client) return 0;
  let pass = start;
  let kept = ahead.claim(submission.id, queued.sequence, client, queued.players);
  while (kept < queued.players && !bootRefusal(pass, queued, true)
    && ahead.spawn(submission.id, client, { trial: queued.sequence, covered: true }) === null) {
    kept += 1;
    pass = afterBoot(pass, false);
  }
  return pass.bootsThisPass - start.bootsThisPass;
}
