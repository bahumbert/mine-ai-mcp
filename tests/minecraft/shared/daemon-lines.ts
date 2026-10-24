// The lines the daemon writes to its log about the trials and the samples (the evidence of a batch: where its time went).
import type { AdmissionEvent } from "./admission.ts";
import type { TrialPhases } from "./trial.ts";

export interface TrialLineInput {
  readonly name: string;
  /** Null: the scenario ran on a server of its own. */
  readonly lane: number | null;
  readonly serverId: string;
  /** Submission to admission. */
  readonly queueMs: number;
  /** Admission until the server was ready (a server still starting). */
  readonly serverWaitMs: number;
  /** Absent when the trial never ran (its server did not start, the shift failed). */
  readonly phases: TrialPhases | undefined;
  /** Admission to the lane's return. */
  readonly holdMs: number;
}

/** One line per settled trial: `trial <name> lane <k|own> server <id> queue serverWait <six phases> hold`. */
export function trialLine(trial: TrialLineInput): string {
  const { phases } = trial;
  const phaseText = phases
    ? `mutexWait=${phases.mutexWaitMs} arrange=${phases.arrangeMs} join=${phases.joinMs} trial=${phases.trialMs} restoreWait=${phases.restoreWaitMs} restore=${phases.restoreMs}`
    : "phases=none";
  return `trial ${trial.name} lane ${trial.lane ?? "own"} server ${trial.serverId} queue=${trial.queueMs} serverWait=${trial.serverWaitMs} ${phaseText} hold=${trial.holdMs}`;
}

export interface SampleReport {
  readonly cpuBusy: number | null;
  readonly ownCpu: number | null;
  readonly load1: number | null;
  readonly memAvailableMb: number;
  /** What the memory ledger had left after this sample's admissions. */
  readonly ledgerMb: number;
  readonly target: number;
  readonly running: number;
  readonly queued: number;
  readonly servers: number;
  /** Servers started since the daemon began. */
  readonly starts: number;
  /** Trials held back in this sample, by the bound that held them. */
  readonly held: Readonly<Record<string, number>>;
  /** What this sample did to the target, when it did something. */
  readonly event: AdmissionEvent | null;
}

const percent = (share: number | null): string => (share === null ? "-" : `${Math.round(share * 100)}%`);

/** The sample line: today's text first, then the key=value fields a batch is read from. */
export function sampleLine(report: SampleReport, msptP95: readonly (number | null)[]): string {
  const held = Object.entries(report.held).map(([bound, count]) => `${bound}:${count}`).join(",");
  const today = `sample: ${report.running} running, ${report.queued} queued, cpu ${percent(report.cpuBusy)}, ${report.servers} servers, p95 ms ${msptP95.map(value => value ?? "-").join("/")}`;
  const fields = `cpu=${percent(report.cpuBusy)} own=${percent(report.ownCpu)} load1=${report.load1 === null ? "-" : report.load1.toFixed(2)} mem=${report.memAvailableMb} ledger=${report.ledgerMb} target=${report.target} running=${report.running} queued=${report.queued} servers=${report.servers} starts=${report.starts} held=${held || "none"}`;
  return `${today} | ${fields}${report.event ? ` target change: ${report.event}` : ""}`;
}
