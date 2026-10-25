// What a submission is and what the scheduler is given: the types of the scheduler's entry points (split out of scheduler.ts, which holds the queue and the loop).
import type { RunResult, Scenario } from "mine-labs";
import type { Lane } from "../arena/lanes.ts";
import type { Shifted } from "../arena/shift-scenario.ts";
import type { ScenarioServerConfig } from "./config.ts";
import type { ClientsAhead } from "./client-ahead.ts";
import type { Placement } from "./placement.ts";
import type { ServerPool } from "./pool.ts";
import type { RunIo } from "./run-io.ts";
import type { TrialRunner } from "./trial.ts";

export interface SubmissionEntry {
  readonly name: string;
  readonly scenario: Scenario;
  readonly placement: Placement;
}

export type SubmissionEvent =
  | { readonly type: "info"; readonly text: string }
  | { readonly type: "result"; readonly name: string; readonly outcome: RunResult["outcome"]; readonly elapsedMs: number; readonly detail: string; readonly error?: string; readonly runDir: string };

export interface SubmissionSpec {
  readonly entries: readonly SubmissionEntry[];
  readonly repeat: number;
  /** `--lanes N`: at most this many of this submission's trials at once. */
  readonly maxLanes: number | null;
  /** A timing batch: its trials run on servers reserved for it, start on a calm machine, and nothing else is held back for it. */
  readonly lock: boolean;
  /** A load batch (`--load`, the master's only): waits for the queue ahead of it to empty, then nothing else starts until it ends. */
  readonly hold: boolean;
  readonly outDir: string;
  readonly emit: (event: SubmissionEvent) => void;
}

export interface SubmissionSummary { readonly runs: number; readonly passed: number; readonly failed: number; readonly cancelled: number }

export interface SubmissionHandle {
  readonly id: number;
  readonly finished: Promise<SubmissionSummary>;
  cancel(reason: string): void;
}

export interface MachineReading {
  readonly cpuBusy: number | null;
  /** The share of the machine our process tree used over the same window; absent or null when it could not be read. */
  readonly ownCpu?: number | null;
  readonly load1?: number | null;
  readonly memAvailableMb: number;
  readonly threads: number;
}

export interface SchedulerDeps {
  readonly pool: ServerPool;
  readonly config: ScenarioServerConfig;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly runTrial: TrialRunner;
  readonly runIo?: RunIo;
  readonly shift?: (scenario: Scenario, lane: Lane) => Shifted;
  /** Boots a submission's scenario clients before their trials; absent for a runner that takes none (a test's fake). */
  readonly clientsAhead?: ClientsAhead;
}
